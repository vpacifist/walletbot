import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { readWethUsdcPoolSnapshot } from "@/lib/weth-usdc-pool";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const pool = await readWethUsdcPoolSnapshot();
    return NextResponse.json({
      pool: {
        currentTick: pool.currentTick,
        price: pool.price
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to read WETH/USDC pool price" }, { status: 500 });
  }
}
