import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getConfig } from "./config";

const COOKIE_NAME = "walletbot_session";

function sessionSignature() {
  const { APP_PASSWORD, BASE_WALLET_ADDRESS } = getConfig();
  return createHmac("sha256", APP_PASSWORD).update(`walletbot:${BASE_WALLET_ADDRESS.toLowerCase()}`).digest("hex");
}

export async function isAuthenticated() {
  const jar = await cookies();
  const actual = jar.get(COOKIE_NAME)?.value;
  const expected = sessionSignature();
  if (!actual) return false;

  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function setSessionCookie() {
  const jar = await cookies();
  jar.set(COOKIE_NAME, sessionSignature(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export function verifyPassword(password: string) {
  const expected = getConfig().APP_PASSWORD;
  try {
    return timingSafeEqual(Buffer.from(password), Buffer.from(expected));
  } catch {
    return false;
  }
}
