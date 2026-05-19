import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { syncWalletOnce } from "@/lib/sync";

export async function POST() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await syncWalletOnce();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
