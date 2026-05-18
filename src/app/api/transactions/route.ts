import { NextResponse } from "next/server";
import { isApprovalTransaction, mapApprovalsToTransactions } from "@/lib/approvals";
import { isAuthenticated } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const transactions = await prisma.transaction.findMany({
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
