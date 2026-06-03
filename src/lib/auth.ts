import { cookies } from "next/headers";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig } from "./config";

const COOKIE_NAME = "walletbot_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

type SessionPayload = {
  wallet: string;
  iat: number;
  exp: number;
  nonce: string;
};

function sign(value: string) {
  const { APP_PASSWORD, BASE_WALLET_ADDRESS } = getConfig();
  return createHmac("sha256", APP_PASSWORD).update(`walletbot:${BASE_WALLET_ADDRESS.toLowerCase()}:${value}`).digest("hex");
}

function encodePayload(payload: SessionPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(value: string): SessionPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof parsed.wallet !== "string" || typeof parsed.iat !== "number" || typeof parsed.exp !== "number" || typeof parsed.nonce !== "string") return null;
    return parsed as SessionPayload;
  } catch {
    return null;
  }
}

function createSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = encodePayload({
    wallet: getConfig().BASE_WALLET_ADDRESS.toLowerCase(),
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    nonce: randomBytes(16).toString("hex")
  });
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token: string) {
  const [payload, actualSignature] = token.split(".");
  if (!payload || !actualSignature) return false;
  const expectedSignature = sign(payload);

  try {
    if (!timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expectedSignature))) return false;
  } catch {
    return false;
  }

  const decoded = decodePayload(payload);
  if (!decoded) return false;
  if (decoded.wallet !== getConfig().BASE_WALLET_ADDRESS.toLowerCase()) return false;
  return decoded.exp > Math.floor(Date.now() / 1000);
}

export async function isAuthenticated() {
  const jar = await cookies();
  const actual = jar.get(COOKIE_NAME)?.value;
  if (!actual) return false;
  return verifySessionToken(actual);
}

export async function setSessionCookie() {
  const jar = await cookies();
  jar.set(COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS
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
