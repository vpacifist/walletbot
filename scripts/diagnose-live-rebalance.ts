import { createPublicClient, getAddress, http } from "viem";
import { base } from "viem/chains";
import { buildAutopilotDryRunExecution } from "@/lib/autopilot-executor";
import type { AutopilotExecutionPreview } from "@/lib/autopilot-execution-preview";
import { positionManagerAbi } from "@/lib/abi";
import { createBaseClient } from "@/lib/chain";
import { getConfig } from "@/lib/config";
import { CONTRACTS } from "@/lib/constants";
import { quoteBestExecutableSwap } from "@/lib/swap-quote";

type AutopilotApiPlan = {
  title: string;
  state: string;
  pool: {
    currentTick: number;
    price: number;
  };
  actions: AutopilotExecutionPreview["steps"];
};

async function fetchProductionAutopilotPlan(): Promise<AutopilotApiPlan> {
  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) throw new Error("APP_PASSWORD is required");

  const loginResponse = await fetch("https://walletbot-web-production.up.railway.app/api/auth/login", {
    method: "POST",
    body: new URLSearchParams({ password: appPassword }),
    redirect: "manual"
  });
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`Login did not return a session cookie; status ${loginResponse.status}`);

  const response = await fetch("https://walletbot-web-production.up.railway.app/api/autopilot", {
    headers: {
      cookie
    }
  });
  if (!response.ok) throw new Error(`Autopilot API failed with status ${response.status}`);
  return (await response.json()) as AutopilotApiPlan;
}

async function fetchClosePositionState(tokenId: string) {
  const client = createBaseClient();
  const position = await client.readContract({
    address: CONTRACTS.nonfungiblePositionManager,
    abi: positionManagerAbi,
    functionName: "positions",
    args: [BigInt(tokenId)]
  });
  const simulated = await client.simulateContract({
    account: getAddress(getConfig().AUTOPILOT_REBALANCER_ADDRESS),
    address: CONTRACTS.nonfungiblePositionManager,
    abi: positionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: BigInt(tokenId),
        liquidity: position[7],
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120)
      }
    ]
  });

  return {
    status: "available" as const,
    tokenId,
    liquidity: position[7],
    tokensOwed0: position[10],
    tokensOwed1: position[11],
    decreaseAmount0: simulated.result[0],
    decreaseAmount1: simulated.result[1]
  };
}

async function fetchNftApproval(tokenId: string) {
  const owner = getAddress(getConfig().BASE_WALLET_ADDRESS);
  const operator = getAddress(getConfig().AUTOPILOT_REBALANCER_ADDRESS);
  const [approved, approvedForAll] = await Promise.all([
    createBaseClient().readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: positionManagerAbi,
      functionName: "getApproved",
      args: [BigInt(tokenId)]
    }),
    createBaseClient().readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: positionManagerAbi,
      functionName: "isApprovedForAll",
      args: [owner, operator]
    })
  ]);
  return {
    status: approvedForAll || approved.toLowerCase() === operator.toLowerCase() ? ("approved" as const) : ("not_approved" as const),
    tokenId,
    detail: `approved=${approved}; approvedForAll=${approvedForAll}`
  };
}

async function main() {
  const plan = await fetchProductionAutopilotPlan();
  const quoteRequest = plan.actions.find((step) => step.type === "partial_swap")?.quoteRequest;
  if (!quoteRequest) throw new Error("Current plan has no quote request");

  const quote = await quoteBestExecutableSwap(quoteRequest);
  const preview: AutopilotExecutionPreview = {
    planId: "diagnostic",
    status: "ready",
    title: plan.title,
    pool: plan.pool,
    reasons: [],
    checks: [],
    steps: plan.actions,
    quote: {
      status: "available",
      data: quote
    },
    telegramSummary: ""
  };
  const closeTokenIds = plan.actions.filter((step) => step.type === "close" && step.tokenId).map((step) => step.tokenId as string);
  const closeStates = await Promise.all(closeTokenIds.map(fetchClosePositionState));
  const approvals = await Promise.all(closeTokenIds.map(fetchNftApproval));
  const execution = buildAutopilotDryRunExecution(preview, {
    closePositions: Object.fromEntries(closeStates.map((state) => [state.tokenId, state])),
    nftApprovals: Object.fromEntries(approvals.map((state) => [state.tokenId, state])),
    rebalancerRoles: {
      status: "roles_match",
      detail: "diagnostic"
    }
  });

  console.log(
    JSON.stringify(
      {
        state: plan.state,
        tick: plan.pool.currentTick,
        price: plan.pool.price,
        quote: {
          source: quote.source,
          sourceType: quote.sourceType,
          executable: quote.executable,
          amountInRaw: quote.amountInRaw,
          amountOutRaw: quote.amountOutRaw,
          approvalTarget: quote.approvalTarget,
          transactionTarget: quote.transactionTarget,
          hasTransactionData: Boolean(quote.transactionData),
          routeSummary: quote.routeSummary
        },
        closeStates: closeStates.map((state) => ({
          tokenId: state.tokenId,
          liquidity: state.liquidity.toString(),
          decreaseAmount0: state.decreaseAmount0.toString(),
          decreaseAmount1: state.decreaseAmount1.toString(),
          tokensOwed0: state.tokensOwed0.toString(),
          tokensOwed1: state.tokensOwed1.toString()
        })),
        atomicCall: {
          status: execution.atomicCall.status,
          target: execution.atomicCall.target,
          reason: execution.atomicCall.reason,
          dataPreview: execution.atomicCall.dataPreview
        }
      },
      null,
      2
    )
  );

  if (execution.atomicCall.status !== "prepared" || !execution.atomicCall.data) {
    throw new Error(`Atomic call not prepared: ${execution.atomicCall.reason}`);
  }

  const publicClient = createPublicClient({ chain: base, transport: http(getConfig().BASE_RPC_URL) });
  try {
    await publicClient.call({
      account: getAddress(getConfig().AUTOPILOT_EXECUTOR_ADDRESS || getConfig().BASE_WALLET_ADDRESS),
      to: getAddress(execution.atomicCall.target),
      data: execution.atomicCall.data
    });
    console.log("atomic eth_call succeeded");
  } catch (error) {
    console.error("atomic eth_call failed");
    console.error(error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
