import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";

export async function POST() {
  await clearSessionCookie();
  return new NextResponse(null, { status: 303, headers: { Location: "/login" } });
}
