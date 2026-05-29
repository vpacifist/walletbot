import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { isApprovalTransaction, mapApprovalsToTransactions } from "@/lib/approvals";
import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const wallet = await prisma.wallet.findUnique({ where: { address: getAddress(getConfig().BASE_WALLET_ADDRESS) } });
  const transactions = await prisma.transaction.findMany({
    where: wallet ? { walletId: wallet.id } : { walletId: "__missing_wallet__" },
    orderBy: [{ blockNumber: "desc" }, { timestamp: "desc" }],
    take: 100
  });
  const approvalsByTransactionId = mapApprovalsToTransactions(transactions);

  return NextResponse.json(
    transactions.filter((transaction) => !isApprovalTransaction(transaction)).map((transaction) => ({
      ...transaction,
      blockNumber: transaction.blockNumber.toString(),
      usdEstimate: transaction.usdEstimate?.toString() ?? null,
      approvals: approvalsByTransactionId.get(transaction.id) ?? []
    }))
  );
}
