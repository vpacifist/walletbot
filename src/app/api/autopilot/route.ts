import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getCurrentAutopilotPlan, autopilotPlanKey } from "@/lib/autopilot-service";
import { prisma } from "@/lib/db";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const plan = await getCurrentAutopilotPlan();
    const planKey = autopilotPlanKey(plan);
    const latestDbRecord = await prisma.rebalancePlan.findFirst({
      where: { planKey },
      orderBy: { createdAt: "desc" }
    });
    const recentDbRecords = await prisma.rebalancePlan.findMany({
      where: { status: { not: "pending" } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        status: true,
        mode: true,
        title: true,
        state: true,
        decisionNote: true,
        createdAt: true,
        updatedAt: true,
        decidedAt: true
      }
    });

    let txHash: string | null = null;
    if (latestDbRecord && latestDbRecord.decisionNote) {
      const match = latestDbRecord.decisionNote.match(/Tx Hash: (0x[a-fA-F0-9]{64})/i);
      if (match) txHash = match[1];
    }

    return NextResponse.json({
      ...plan,
      dbRecord: latestDbRecord ? {
        id: latestDbRecord.id,
        status: latestDbRecord.status,
        decisionNote: latestDbRecord.decisionNote,
        txHash
      } : null,
      executionAudit: recentDbRecords.map((record) => ({
        id: record.id,
        status: record.status,
        mode: record.mode,
        title: record.title,
        state: record.state,
        decisionNote: record.decisionNote,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
        decidedAt: record.decidedAt?.toISOString() ?? null,
        txHash: record.decisionNote?.match(/Tx Hash: (0x[a-fA-F0-9]{64})/i)?.[1] ?? null
      }))
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to calculate autopilot plan" }, { status: 500 });
  }
}
