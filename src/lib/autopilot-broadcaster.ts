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

const MAX_DECISION_NOTE_LENGTH = 1_500;

function conciseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const firstUsefulLine =
    message
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("Raw Call Arguments:") && !line.startsWith("Contract Call:")) ?? message;

  if (/execution reverted/i.test(message)) {
    const reason = message.match(/execution reverted(?::| with reason:)?\s*([^\n.]*)/i)?.[1]?.trim();
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

export async function broadcastAutopilotRebalance(planId: string): Promise<AutopilotBroadcastResult> {
  if (!getConfig().AUTOPILOT_LIVE_EXECUTION_ENABLED) {
    return { success: false, error: "Live execution is disabled. Set AUTOPILOT_LIVE_EXECUTION_ENABLED=true to enable it." };
  }

  const plan = await prisma.rebalancePlan.findUnique({ where: { id: planId } });
  if (!plan) {
    return { success: false, error: `Rebalance plan #${planId} not found.` };
  }

  if (plan.status !== "approved") {
    return { success: false, error: `Plan status is ${plan.status}; live execution requires an approved plan.` };
  }

  try {
    const execution = await createAutopilotDryRunExecution(planId);
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

    const locked = await prisma.rebalancePlan.updateMany({
      where: { id: planId, status: "approved" },
      data: {
        status: "executing",
        decisionNote: "Initiating on-chain transaction execution..."
      }
    });
    if (locked.count !== 1) {
      return { success: false, error: "Plan was already executed or changed before transaction submission." };
    }

    const walletClient = createAutopilotExecutorWalletClient();
    const publicClient = createBaseClient();

    await publicClient.call({
      account: walletClient.account.address,
      to: rebalancerAddress,
      data
    });

    const hash = await walletClient.sendTransaction({
      to: rebalancerAddress,
      data,
      chain: walletClient.chain,
      account: walletClient.account
    });

    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 60_000
    });

    if (receipt.status !== "success") {
      throw new Error(`On-chain transaction reverted. Hash: ${hash}`);
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
