import { NextResponse } from "next/server";
import { setSessionCookie, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  const formData = await request.formData();
  const password = String(formData.get("password") ?? "");

  if (!verifyPassword(password)) {
    return NextResponse.redirect(new URL("/login?error=1", request.url), { status: 303 });
  }

  await setSessionCookie();
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
