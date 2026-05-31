import { getConfig } from "./config";

function withProtocol(value: string) {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

export function getWebAppUrl() {
  const config = getConfig();
  const explicitUrl = String(config.WEB_APP_URL ?? "").trim();
  if (explicitUrl) return explicitUrl.replace(/\/+$/, "");

  const railwayDomain =
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.RAILWAY_STATIC_URL ||
    process.env.RAILWAY_SERVICE_WALLETBOT_WEB_URL ||
    "";
  if (railwayDomain) return withProtocol(railwayDomain).replace(/\/+$/, "");

  return "http://localhost:3000";
}
