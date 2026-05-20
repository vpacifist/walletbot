import { NextResponse } from "next/server";
import { setSessionCookie, verifyPassword } from "@/lib/auth";

function redirectTo(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const password = String(formData.get("password") ?? "");

  if (!verifyPassword(password)) {
    return redirectTo("/login?error=1");
  }

  await setSessionCookie();
  return redirectTo("/");
}
