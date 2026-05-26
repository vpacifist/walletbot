import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getCurrentAutopilotPlan } from "@/lib/autopilot-service";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json(await getCurrentAutopilotPlan());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to calculate autopilot plan" }, { status: 500 });
  }
}
