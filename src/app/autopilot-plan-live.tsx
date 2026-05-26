"use client";

import { useEffect, useMemo, useState } from "react";

type AutopilotPlan = {
  mode: "manual" | "approve_in_telegram" | "auto_guarded" | "auto_full";
  state: "idle" | "armed" | "confirming" | "ready" | "cooldown" | "paused";
  severity: "good" | "warn" | "bad";
  title: string;
  detail: string;
  pool: {
    currentTick: number;
    baseTick: number;
    price: number;
    triggerBufferPercent: number;
    reverseBufferPercent: number;
    confirmationMinutes: number;
    cooldownMinutes: number;
  };
  economics: {
    immediateCostUsd: number;
    estimatedSlippageUsd: number;
    estimatedGasUsd: number;
    reversalDebtUsd: number;
    feesNeededToReverseUsd: number;
    lastDirectionalSwap: {
      timestamp: string;
      side: "buy_weth" | "sell_weth";
      wethAmount: number;
      usdcAmount: number;
      effectivePrice: number;
      protocol: string | null;
    } | null;
  };
  ladder: Array<{
    role: "lower" | "active" | "upper";
    range: string;
    lowerPrice: number | null;
    upperPrice: number | null;
    tokenId: string | null;
    status: string;
    plannedAction: string;
  }>;
  actions: Array<{
    type: "hold" | "wait" | "close" | "partial_swap" | "mint" | "pause";
    label: string;
    detail: string;
    estimatedCostUsd: number;
  }>;
  updatedAt: string;
};

const STATE_ORDER: AutopilotPlan["state"][] = ["idle", "armed", "confirming", "ready", "cooldown"];

function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatAmount(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function modeLabel(mode: AutopilotPlan["mode"]) {
  if (mode === "approve_in_telegram") return "Approve in Telegram";
  if (mode === "auto_guarded") return "Auto guarded";
  if (mode === "auto_full") return "Auto full";
  return "Manual";
}

function stateClass(state: AutopilotPlan["state"], severity: AutopilotPlan["severity"]) {
  if (state === "idle") return "good";
  if (state === "paused") return "bad";
  return severity;
}

function actionClass(type: AutopilotPlan["actions"][number]["type"]) {
  if (type === "hold") return "good";
  if (type === "pause") return "bad";
  if (type === "partial_swap" || type === "close") return "warn";
  return "";
}

function swapSideLabel(side: "buy_weth" | "sell_weth") {
  return side === "buy_weth" ? "Bought WETH" : "Sold WETH";
}

function shortDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function shortError(message: string) {
  if (message.length <= 180) return message;
  return `${message.slice(0, 177)}...`;
}

export function AutopilotPlanLive() {
  const [data, setData] = useState<AutopilotPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const controller = new AbortController();
      const abortId = window.setTimeout(() => controller.abort(), 20_000);

      try {
        const response = await fetch("/api/autopilot", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal
        });
        const payload = (await response.json()) as AutopilotPlan | { error?: string };
        if (!active) return;

        if (!response.ok) {
          setError("error" in payload && payload.error ? payload.error : "Unable to load autopilot plan");
          return;
        }

        setData(payload as AutopilotPlan);
        setError(null);
      } catch (requestError) {
        if (active) {
          setError(requestError instanceof DOMException && requestError.name === "AbortError" ? "Autopilot request timed out" : "Unable to load autopilot plan");
        }
      } finally {
        window.clearTimeout(abortId);
        if (active) timeoutId = setTimeout(poll, 60_000);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  const activeStateIndex = useMemo(() => {
    if (!data) return -1;
    return STATE_ORDER.indexOf(data.state);
  }, [data]);
  const statusTone = data ? stateClass(data.state, data.severity) : "";

  return (
    <div className="autopilot-grid">
      <div className="rebalance-primary">
        <div className={`hero-metric ${error && !data ? "bad" : statusTone}`}>
          <p className="metric-label">Autopilot state</p>
          <strong>{error && !data ? "Autopilot unavailable" : (data?.title ?? "Loading")}</strong>
          <p className="muted">{error && !data ? shortError(error) : (data?.detail ?? "Preparing the current rebalance plan.")}</p>
        </div>
        <div className="hero-metric">
          <p className="metric-label">Mode</p>
          <strong>{data ? modeLabel(data.mode) : "-"}</strong>
          <p className="muted">
            {data
              ? `Confirm ${data.pool.confirmationMinutes}m, cooldown ${data.pool.cooldownMinutes}m, reverse buffer ${formatAmount(data.pool.reverseBufferPercent, 2)}%.`
              : "Execution mode and risk gates will appear here."}
          </p>
        </div>
      </div>

      <div className="autopilot-timeline" aria-label="Autopilot decision state">
        {STATE_ORDER.map((state, index) => (
          <div className={`autopilot-step ${index <= activeStateIndex ? "is-active" : ""} ${data?.state === state ? "is-current" : ""}`} key={state}>
            <span />
            <strong>{state}</strong>
          </div>
        ))}
      </div>

      <div className="autopilot-economics">
        <div className="asset-metric">
          <p className="metric-label">Current price</p>
          <span className="metric-value">{formatAmount(data?.pool.price, 2)} USDC</span>
          <span>Tick {data?.pool.currentTick ?? "-"}</span>
        </div>
        <div className="asset-metric">
          <p className="metric-label">Immediate cost</p>
          <span className="metric-value">{formatUsd(data?.economics.immediateCostUsd)}</span>
          <span>{formatUsd(data?.economics.estimatedSlippageUsd)} slippage - {formatUsd(data?.economics.estimatedGasUsd)} gas</span>
        </div>
        <div className="asset-metric">
          <p className="metric-label">Reversal debt</p>
          <span className="metric-value">{formatUsd(data?.economics.reversalDebtUsd)}</span>
          <span>{formatUsd(data?.economics.feesNeededToReverseUsd)} fees needed before reversal</span>
        </div>
        <div className="asset-metric">
          <p className="metric-label">Last directional swap</p>
          {data?.economics.lastDirectionalSwap ? (
            <>
              <span className="metric-value">{swapSideLabel(data.economics.lastDirectionalSwap.side)}</span>
              <span>
                {formatAmount(data.economics.lastDirectionalSwap.effectivePrice, 2)} - {shortDateTime(data.economics.lastDirectionalSwap.timestamp)}
              </span>
            </>
          ) : (
            <>
              <span className="metric-value">No swap reference</span>
              <span>Reversal debt is inactive.</span>
            </>
          )}
        </div>
      </div>

      <div className="autopilot-ladder" aria-label="Planned ladder">
        {data?.ladder.map((segment) => (
          <div className={`autopilot-range ${segment.role}`} key={segment.role}>
            <div>
              <p className="metric-label">{segment.role}</p>
              <strong>{segment.tokenId ? `#${segment.tokenId}` : "Missing"}</strong>
            </div>
            <div>
              <span>{segment.range}</span>
              <span>
                {formatAmount(segment.lowerPrice, 2)} - {formatAmount(segment.upperPrice, 2)}
              </span>
            </div>
            <span className={`status ${segment.status === "ok" ? "good" : segment.status === "missing" ? "bad" : "warn"}`}>{segment.status}</span>
            <p className="muted">{segment.plannedAction}</p>
          </div>
        )) ?? (
          <>
            <div className="autopilot-range skeleton" />
            <div className="autopilot-range skeleton" />
            <div className="autopilot-range skeleton" />
          </>
        )}
      </div>

      <div className="autopilot-actions">
        {data?.actions.map((action) => (
          <div className={`autopilot-action ${actionClass(action.type)}`} key={`${action.type}:${action.label}`}>
            <div>
              <strong>{action.label}</strong>
              <p className="muted">{action.detail}</p>
            </div>
            <span>{formatUsd(action.estimatedCostUsd)}</span>
          </div>
        )) ?? <div className="autopilot-action">Loading current action plan</div>}
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
