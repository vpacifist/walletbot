import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { getNarrowRangeRebalance } from "@/lib/narrow-range-rebalance";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const data = await getNarrowRangeRebalance(getAddress(getConfig().BASE_WALLET_ADDRESS));
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to calculate rebalance" }, { status: 500 });
  }
}
