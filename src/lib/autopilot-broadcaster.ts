import { getAddress } from "viem";
import { createAutopilotDryRunExecution } from "./autopilot-executor";
import { createBaseClient, createBaseWalletClient } from "./chain";
import { getConfig } from "./config";
import { prisma } from "./db";

export type AutopilotBroadcastResult = {
  success: boolean;
  txHash?: string;
  error?: string;
};

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

    const walletClient = createBaseWalletClient();
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
    const errorMessage = error instanceof Error ? error.message : String(error);

    await prisma.rebalancePlan.update({
      where: { id: planId },
      data: {
        status: "failed",
        decidedAt: new Date(),
        decisionNote: `On-chain execution failed: ${errorMessage}`
      }
    });

    return {
      success: false,
      error: errorMessage
    };
  }
}
