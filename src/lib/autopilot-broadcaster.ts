import { getAddress } from "viem";
import { createAutopilotDryRunExecution } from "./autopilot-executor";
import { createAutopilotExecutorWalletClient, createBaseClient } from "./chain";
import { getConfig } from "./config";
import { prisma } from "./db";

export type AutopilotBroadcastResult = {
  success: boolean;
  txHash?: string;
  error?: string;
};

export type AutopilotBroadcastOptions = {
  allowUncoveredDebt?: boolean;
  allowBoundaryDrift?: boolean;
};

const MAX_DECISION_NOTE_LENGTH = 1_500;
const ATOMIC_GAS_BUFFER_BPS = 15_000;
const ATOMIC_GAS_HARD_CAP = 12_000_000n;
const OUT_OF_GAS_THRESHOLD_BPS = 9_800n;

function bufferedGasLimit(estimatedGas: bigint) {
  const gas = (estimatedGas * BigInt(ATOMIC_GAS_BUFFER_BPS)) / 10_000n;
  if (gas > ATOMIC_GAS_HARD_CAP) {
    throw new Error(
      `Atomic rebalance gas estimate is too high for live execution: estimated ${estimatedGas.toString()}, buffered ${gas.toString()}, cap ${ATOMIC_GAS_HARD_CAP.toString()}.`
    );
  }
  return gas;
}

function functionNameFromSelector(input?: string) {
  const selector = input?.slice(0, 10).toLowerCase();
  if (selector === "0x88316456") return "mint_position";
  if (selector === "0x0c49ccbe") return "close_position.decreaseLiquidity";
  if (selector === "0xfc6f7865") return "close_position.collect";
  if (selector === "0x2213bc0b") return "swap_exact_input";
  if (selector === "0x04e45aaf" || selector === "0x414bf389") return "swap_exact_input";
  return null;
}

function findOutOfGasCall(call: Record<string, unknown>): string | null {
  const error = typeof call.error === "string" ? call.error : "";
  if (/out of gas/i.test(error)) {
    return functionNameFromSelector(typeof call.input === "string" ? call.input : undefined) ?? "atomic rebalance";
  }

  const calls = Array.isArray(call.calls) ? call.calls : [];
  for (const child of calls) {
    if (child && typeof child === "object") {
      const result = findOutOfGasCall(child as Record<string, unknown>);
      if (result) return result;
    }
  }
  return null;
}

async function explainRevertedReceipt(hash: `0x${string}`, gasUsed: bigint, gasLimit: bigint) {
  if ((gasUsed * 10_000n) / gasLimit < OUT_OF_GAS_THRESHOLD_BPS) return `On-chain transaction reverted. Hash: ${hash}`;

  const baseUrl = getConfig().BLOCKSCOUT_BASE_URL.replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/api/v2/transactions/${hash}/raw-trace`);
    const trace = (await response.json()) as Record<string, unknown>;
    const step = findOutOfGasCall(trace);
    if (step) {
      return `Out of gas during ${step}. Gas used ${gasUsed.toString()} / limit ${gasLimit.toString()}. Tx Hash: ${hash}`;
    }
  } catch {
    // Blockscout traces are best-effort and can lag immediately after mining.
  }

  return `Out of gas during atomic rebalance. Gas used ${gasUsed.toString()} / limit ${gasLimit.toString()}. Tx Hash: ${hash}`;
}

function conciseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const firstUsefulLine =
    message
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("Raw Call Arguments:") && !line.startsWith("Contract Call:")) ?? message;

  if (/execution reverted/i.test(message)) {
    const reason = message.match(/execution reverted(?::| with reason:)?\s*([^\n.]*)/i)?.[1]?.trim();
    if (/price slippage check/i.test(reason ?? message)) {
      return "Swap price moved beyond slippage tolerance during preflight simulation. No transaction was sent; retry with a fresh plan or wider AUTOPILOT_SWAP_SLIPPAGE_BPS.";
    }
    return reason ? `Execution reverted: ${reason}` : "Execution reverted during preflight simulation. No transaction was sent.";
  }

  if (/insufficient funds/i.test(message)) return "Insufficient executor wallet funds for gas.";
  if (/nonce too low/i.test(message)) return "Executor nonce is too low; retry with a fresh live review.";
  if (/replacement transaction underpriced/i.test(message)) return "Replacement transaction underpriced; retry after the pending executor transaction clears.";
  if (/too many requests|status:\s*429/i.test(message)) return "RPC rate limit during live execution; retry after a short pause.";
  if (/timeout/i.test(message)) return "Timed out while waiting for the transaction receipt; check the executor wallet on Base before retrying.";

  return firstUsefulLine.length > 700 ? `${firstUsefulLine.slice(0, 697)}...` : firstUsefulLine;
}

function decisionNote(message: string) {
  return message.length > MAX_DECISION_NOTE_LENGTH ? `${message.slice(0, MAX_DECISION_NOTE_LENGTH - 3)}...` : message;
}

function executionDecisionNote(options: AutopilotBroadcastOptions) {
  const accepted = [
    options.allowUncoveredDebt ? "user-accepted uncovered debt" : null,
    options.allowBoundaryDrift ? "user-accepted boundary drift" : null
  ].filter(Boolean);
  return accepted.length > 0
    ? `Initiating on-chain transaction execution with ${accepted.join(" and ")}...`
    : "Initiating on-chain transaction execution...";
}

export async function broadcastAutopilotRebalance(
  planId: string,
  options: AutopilotBroadcastOptions = {}
): Promise<AutopilotBroadcastResult> {
  if (!getConfig().AUTOPILOT_LIVE_EXECUTION_ENABLED) {
    return { success: false, error: "Live execution is disabled. Set AUTOPILOT_LIVE_EXECUTION_ENABLED=true to enable it." };
  }

  const locked = await prisma.rebalancePlan.updateMany({
    where: { id: planId, status: "approved" },
    data: {
      status: "executing",
      decisionNote: executionDecisionNote(options)
    }
  });
  if (locked.count !== 1) {
    const plan = await prisma.rebalancePlan.findUnique({ where: { id: planId } });
    if (!plan) {
      return { success: false, error: `Rebalance plan #${planId} not found.` };
    }
    return { success: false, error: `Plan status is ${plan.status}; live execution requires an approved plan.` };
  }

  try {
    const execution = await createAutopilotDryRunExecution(planId, options);
    if (execution.status === "blocked") {
      const failedChecks = execution.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.label}: ${c.detail}`)
        .join("; ");
      throw new Error(`Dry-run validation blocked: ${failedChecks}`);
    }

    if (execution.atomicCall.status === "blocked" || !execution.atomicCall.data) {
      throw new Error(`Atomic rebalance calldata preparation failed: ${execution.atomicCall.reason}`);
    }

    const rebalancerAddress = getAddress(execution.atomicCall.target);
    const data = execution.atomicCall.data;

    const walletClient = createAutopilotExecutorWalletClient();
    const publicClient = createBaseClient();

    await publicClient.call({
      account: walletClient.account.address,
      to: rebalancerAddress,
      data
    });

    const estimatedGas = await publicClient.estimateGas({
      account: walletClient.account.address,
      to: rebalancerAddress,
      data
    });
    const gas = bufferedGasLimit(estimatedGas);

    const hash = await walletClient.sendTransaction({
      to: rebalancerAddress,
      data,
      gas,
      chain: walletClient.chain,
      account: walletClient.account
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 60_000
    });

    if (receipt.status !== "success") {
      throw new Error(await explainRevertedReceipt(hash, receipt.gasUsed, gas));
    }

    await prisma.rebalancePlan.update({
      where: { id: planId },
      data: {
        status: "completed",
        decidedAt: new Date(),
        decisionNote: `Successfully executed on-chain. Tx Hash: ${hash}`
      }
    });

    return {
      success: true,
      txHash: hash
    };
  } catch (error) {
    const errorMessage = conciseError(error);

    await prisma.rebalancePlan.update({
      where: { id: planId },
      data: {
        status: "failed",
        decidedAt: new Date(),
        decisionNote: decisionNote(`On-chain execution failed: ${errorMessage}`)
      }
    });

    return {
      success: false,
      error: errorMessage
    };
  }
}
