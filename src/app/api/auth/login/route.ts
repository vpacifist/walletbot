import { NextResponse } from "next/server";
import { setSessionCookie, verifyPassword } from "@/lib/auth";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_RATE_LIMIT_KEYS = 1_000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function redirectTo(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

function pruneAttempts(now: number) {
  for (const [key, value] of attempts) {
    if (value.resetAt <= now) attempts.delete(key);
  }

  while (attempts.size > MAX_RATE_LIMIT_KEYS) {
    const oldestKey = attempts.keys().next().value as string | undefined;
    if (!oldestKey) break;
    attempts.delete(oldestKey);
  }
}

function isRateLimited(key: string) {
  const now = Date.now();
  pruneAttempts(now);
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    pruneAttempts(now);
    return false;
  }
  current.count += 1;
  return current.count > MAX_LOGIN_ATTEMPTS;
}

export async function POST(request: Request) {
  const key = clientKey(request);
  if (isRateLimited(key)) {
    return redirectTo("/login?error=rate_limited");
  }

  const formData = await request.formData();
  const password = String(formData.get("password") ?? "");

  if (!verifyPassword(password)) {
    return redirectTo("/login?error=1");
  }

  attempts.delete(key);
  await setSessionCookie();
  return redirectTo("/");
}
