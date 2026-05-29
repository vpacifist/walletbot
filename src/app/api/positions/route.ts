import { NextResponse } from "next/server";
import { getAddress } from "viem";
import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { sortPositionsForDisplay } from "@/lib/position-order";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const wallet = await prisma.wallet.findUnique({ where: { address: getAddress(getConfig().BASE_WALLET_ADDRESS) } });
  const positions = wallet
    ? await prisma.position.findMany({ where: { walletId: wallet.id }, orderBy: [{ tokenId: "desc" }, { createdAt: "desc" }] })
    : [];
  return NextResponse.json(sortPositionsForDisplay(positions));
}
