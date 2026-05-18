import { formatUnits } from "viem";

export function shortAddress(value?: string | null) {
  if (!value) return "-";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function decimalAmount(raw: bigint, decimals: number) {
  return Number(formatUnits(raw, decimals));
}

export function formatNumber(value?: number | string | null, maximumFractionDigits = 6) {
  if (value === undefined || value === null || value === "") return "-";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(parsed);
}
