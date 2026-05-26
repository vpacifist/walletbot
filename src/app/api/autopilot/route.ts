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
      } : null
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to calculate autopilot plan" }, { status: 500 });
  }
}
