import { decodeAbiParameters, getAddress } from "viem";
import { poolAbi } from "./abi";
import { createAutopilotDryRunExecution } from "./autopilot-executor";
import { createAutopilotExecutorWalletClient, createBaseClient } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS } from "./constants";
import { prisma } from "./db";
import { priceFromTick } from "./narrow-range-rebalance";

export type AutopilotBroadcastResult = {
  success: boolean;
  txHash?: string;
  error?: string;
  broadcasted?: boolean;
};

export type AutopilotBroadcastOptions = {
  allowUncoveredDebt?: boolean;
  allowBoundaryDrift?: boolean;
  allowEquivalentPlanFreshness?: boolean;
};

const MAX_DECISION_NOTE_LENGTH = 1_500;
const ATOMIC_GAS_BUFFER_BPS = 15_000;
const OUT_OF_GAS_THRESHOLD_BPS = 9_800n;

function bufferedGasLimit(estimatedGas: bigint) {
  return (estimatedGas * BigInt(ATOMIC_GAS_BUFFER_BPS)) / 10_000n;
}

async function currentWethUsdPrice() {
  const client = createBaseClient();
  const [slot0, token0, token1] = await Promise.all([
    client.readContract({ address: CONTRACTS.wethUsdcUniswapV3Pool, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: CONTRACTS.wethUsdcUniswapV3Pool, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: CONTRACTS.wethUsdcUniswapV3Pool, abi: poolAbi, functionName: "token1" })
  ]);
  const price = priceFromTick({
    tick: Number(slot0[1]),
    token0,
    token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });
  if (!price || !Number.isFinite(price) || price <= 0) {
    throw new Error("Could not estimate WETH/USDC price for gas-cost guard.");
  }
  return price;
}

function gasCostUsd(gas: bigint, gasPriceWei: bigint, ethUsd: number) {
  return (Number(gas * gasPriceWei) / 1e18) * ethUsd;
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
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

function callLabel(call: Record<string, unknown>) {
  const to = typeof call.to === "string" ? call.to : "";
  const selector = typeof call.input === "string" ? call.input.slice(0, 10).toLowerCase() : "";
  if (to.toLowerCase() === CONTRACTS.odosSmartOrderRouterV3.toLowerCase()) return "Odos router";
  if (to.toLowerCase() === CONTRACTS.zeroExAllowanceHolder.toLowerCase()) return "0x AllowanceHolder";
  return functionNameFromSelector(typeof call.input === "string" ? call.input : undefined) ?? (selector || "internal call");
}

function findRevertedCall(call: Record<string, unknown>): string | null {
  const error = typeof call.error === "string" ? call.error : "";
  const revertReason = typeof call.revertReason === "string" ? call.revertReason.trim() : "";
  if ((/execution reverted/i.test(error) || revertReason) && revertReason) {
    return `${callLabel(call)}: ${revertReason}`;
  }

  const calls = Array.isArray(call.calls) ? call.calls : [];
  for (const child of calls) {
    if (child && typeof child === "object") {
      const result = findRevertedCall(child as Record<string, unknown>);
      if (result) return result;
    }
  }

  if (/execution reverted/i.test(error)) return `${callLabel(call)} reverted`;
  return null;
}

function findRevertData(value: unknown, seen = new Set<unknown>()): `0x${string}` | null {
  if (!value || seen.has(value)) return null;
  seen.add(value);

  if (typeof value === "string") {
    return /^0x[0-9a-fA-F]{8,}$/.test(value) ? (value as `0x${string}`) : null;
  }

  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["data", "error", "cause"]) {
    const result = findRevertData(record[key], seen);
    if (result) return result;
  }

  return null;
}

function decodeRevertData(data: `0x${string}`) {
  const selector = data.slice(0, 10).toLowerCase();
  try {
    if (selector === "0x08c379a0") {
      const [reason] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`);
      return `reason: ${reason}`;
    }
    if (selector === "0x4e487b71") {
      const [code] = decodeAbiParameters([{ type: "uint256" }], `0x${data.slice(10)}`);
      return `panic code ${code.toString()}`;
    }
  } catch {
    // Fall through to selector output.
  }

  return `custom error selector ${selector}${data.length > 10 ? `, data ${data.slice(0, 42)}...` : ""}`;
}

async function explainRevertedReceipt(hash: `0x${string}`, gasUsed: bigint, gasLimit: bigint) {
  const baseUrl = getConfig().BLOCKSCOUT_BASE_URL.replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/api/v2/transactions/${hash}/raw-trace`);
    const trace = (await response.json()) as Record<string, unknown>;
    const reverted = findRevertedCall(trace);
    if (reverted) {
      return `On-chain transaction reverted: ${reverted}. Tx Hash: ${hash}`;
    }
    const step = findOutOfGasCall(trace);
    if (step) {
      return `Out of gas during ${step}. Gas used ${gasUsed.toString()} / limit ${gasLimit.toString()}. Tx Hash: ${hash}`;
    }
  } catch {
    // Blockscout traces are best-effort and can lag immediately after mining.
  }

  if ((gasUsed * 10_000n) / gasLimit < OUT_OF_GAS_THRESHOLD_BPS) return `On-chain transaction reverted. Hash: ${hash}`;

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
    const meaningfulReason = reason && !/^(for an unknown reason|unknown reason|unknown)$/i.test(reason) ? reason : null;
    if (meaningfulReason) return `Execution reverted: ${meaningfulReason}`;
    const revertData = findRevertData(error);
    if (revertData) {
      const decoded = decodeRevertData(revertData);
      if (/price slippage check/i.test(decoded)) {
        return "Swap price moved beyond slippage tolerance during preflight simulation. No transaction was sent; retry with a fresh plan or wider AUTOPILOT_SWAP_SLIPPAGE_BPS.";
      }
      return `Execution reverted during preflight simulation with ${decoded}. No transaction was sent.`;
    }
    return "Execution reverted during preflight simulation without a decoded reason from RPC. No transaction was sent.";
  }

  if (/insufficient funds/i.test(message)) return "Insufficient executor wallet funds for gas.";
  if (/nonce too low/i.test(message)) return "Executor nonce is too low; retry with a fresh live review.";
  if (/replacement transaction underpriced/i.test(message)) return "Replacement transaction underpriced; retry after the pending executor transaction clears.";
  if (/too many requests|status:\s*429/i.test(message)) return "RPC rate limit during live execution; retry after a short pause.";
  if (/timeout/i.test(message)) return "Timed out while waiting for the transaction receipt; check the executor wallet on Base before retrying.";

  return firstUsefulLine.length > 700 ? `${firstUsefulLine.slice(0, 697)}...` : firstUsefulLine;
}

function diagnosticLines(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || seen.has(error)) return [];
  seen.add(error);

  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [String(error)];

  const record = error as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.split("\n").map((line) => line.trim()).find(Boolean) : null;
  const lines = [
    typeof record.name === "string" && message ? `${record.name}: ${message}` : null,
    typeof record.shortMessage === "string" ? record.shortMessage : null,
    typeof record.details === "string" ? record.details : null,
    typeof record.metaMessages === "object" && Array.isArray(record.metaMessages) ? record.metaMessages.filter((line): line is string => typeof line === "string").join(" ") : null
  ].filter((line): line is string => Boolean(line && line.trim()));

  return [
    ...lines,
    ...diagnosticLines(record.cause, seen),
    ...diagnosticLines(record.error, seen)
  ];
}

function diagnosticError(error: unknown) {
  const uniqueLines = [...new Set(diagnosticLines(error).map((line) => line.trim()).filter(Boolean))].filter(
    (line) =>
      !line.startsWith("Raw Call Arguments:") &&
      !line.startsWith("Contract Call:") &&
      !line.startsWith("from:") &&
      !line.startsWith("to:") &&
      !line.startsWith("data:") &&
      !/execution reverted for an unknown reason/i.test(line)
  );
  return uniqueLines.join(" | ");
}

function executionFailureNote(errorMessage: string, error: unknown) {
  const diagnostics = diagnosticError(error);
  const normalize = (value: string) => value.replace(/^Error:\s*/i, "").trim();
  if (!diagnostics || normalize(diagnostics) === normalize(errorMessage)) return `On-chain execution failed: ${errorMessage}`;
  const suffix = diagnostics.length > 900 ? `${diagnostics.slice(0, 897)}...` : diagnostics;
  return `On-chain execution failed: ${errorMessage}\nDiagnostics: ${suffix}`;
}

function decisionNote(message: string) {
  return message.length > MAX_DECISION_NOTE_LENGTH ? `${message.slice(0, MAX_DECISION_NOTE_LENGTH - 3)}...` : message;
}

function executionDecisionNote(options: AutopilotBroadcastOptions) {
  const accepted = [
    options.allowUncoveredDebt ? "user-accepted uncovered debt" : null,
    options.allowBoundaryDrift ? "user-accepted boundary drift" : null,
    options.allowEquivalentPlanFreshness ? "auto freshness envelope" : null
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

  let submittedHash: `0x${string}` | undefined;
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
    const [gasPriceWei, ethUsd] = await Promise.all([publicClient.getGasPrice(), currentWethUsdPrice()]);
    const estimatedCostUsd = gasCostUsd(gas, gasPriceWei, ethUsd);
    const maxGasCostUsd = getConfig().AUTOPILOT_MAX_GAS_COST_USD;
    if (estimatedCostUsd > maxGasCostUsd) {
      throw new Error(
        `Atomic rebalance gas cost is too high for live execution: estimated ${formatUsd(estimatedCostUsd)}, cap ${formatUsd(maxGasCostUsd)}.`
      );
    }

    const hash = await walletClient.sendTransaction({
      to: rebalancerAddress,
      data,
      gas,
      chain: walletClient.chain,
      account: walletClient.account
    });
    submittedHash = hash;

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
    console.error("autopilot live execution failed", {
      planId,
      broadcasted: Boolean(submittedHash),
      txHash: submittedHash,
      error
    });

    await prisma.rebalancePlan.update({
      where: { id: planId },
      data: {
        status: "failed",
        decidedAt: new Date(),
        decisionNote: decisionNote(executionFailureNote(errorMessage, error))
      }
    });

    return {
      success: false,
      error: errorMessage,
      txHash: submittedHash,
      broadcasted: Boolean(submittedHash)
    };
  }
}
