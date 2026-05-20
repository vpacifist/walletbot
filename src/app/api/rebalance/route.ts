import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { getNarrowRangeRebalance, isWethUsdcRangeWidthMultiplier } from "@/lib/narrow-range-rebalance";

export async function GET(request: Request) {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = new URL(request.url);
    const widthMultiplier = Number(searchParams.get("widthMultiplier") ?? 1);
    if (!isWethUsdcRangeWidthMultiplier(widthMultiplier)) {
      return NextResponse.json({ error: "Invalid range width multiplier" }, { status: 400 });
    }

    const data = await getNarrowRangeRebalance(getAddress(getConfig().BASE_WALLET_ADDRESS), widthMultiplier);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to calculate rebalance" }, { status: 500 });
  }
}
