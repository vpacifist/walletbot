import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sortPositionsForDisplay } from "@/lib/position-order";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const positions = await prisma.position.findMany({ orderBy: [{ tokenId: "desc" }, { createdAt: "desc" }] });
  return NextResponse.json(sortPositionsForDisplay(positions));
}
