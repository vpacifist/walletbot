"use client";

import { useEffect, useMemo, useState } from "react";
import { paddedPriceRangeMarkerPosition } from "@/lib/range-visual";

type AutopilotPlan = {
  mode: "manual" | "approve_in_telegram" | "auto_guarded" | "auto_full";
  state: "idle" | "armed" | "confirming" | "ready" | "cooldown" | "paused";
  severity: "good" | "warn" | "bad";
  title: string;
  detail: string;
  strategy: {
    preset: "triple_range" | "small_capital_test";
    label: string;
    targetWidthTicks: number;
    confirmationSeconds: number;
    maxDriftBps: number;
    maxImmediateCostUsd: number;
    maxUncoveredDebtUsd: number;
    feeCreditMustCoverCosts: boolean;
  };
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
    feeCreditUsd: number;
    collectedFeesSinceLastSwapUsd: number;
    uncollectedFeesUsd: number;
    uncoveredReversalDebtUsd: number;
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
  dbRecord?: {
    id: string;
    status: string;
    decisionNote: string | null;
    txHash: string | null;
  } | null;
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

function dbStatusTone(status?: string) {
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  if (status === "executing") return "warn";
  if (status === "approved") return "good";
  return "muted";
}

function dbStatusLabel(status?: string) {
  if (status === "completed") return "Ребалансировка успешно выполнена";
  if (status === "failed") return "Сбой трансляции транзакции";
  if (status === "executing") return "Отправка на блокчейн...";
  if (status === "approved") return "План одобрен и готов к отправке";
  if (status === "skipped") return "План пропущен";
  if (status === "paused") return "Работа приостановлена";
  return `Статус плана: ${status}`;
}

function primaryAction(data: AutopilotPlan | null) {
  return data?.actions[0] ?? null;
}

function decisionTitle(data: AutopilotPlan | null, error: string | null) {
  if (error && !data) return "Autopilot unavailable";
  if (!data) return "Loading current plan";
  if (data.state === "paused") return "Autopilot paused";
  if (data.state === "idle" && data.actions[0]?.type === "hold") return "No action needed";
  if (data.state === "confirming") return "Breakout is being confirmed";
  if (data.state === "ready") return "Approval needed";
  if (data.state === "cooldown") return "Cooldown after recent action";
  return data.title;
}

function decisionDetail(data: AutopilotPlan | null, error: string | null) {
  if (error && !data) return shortError(error);
  const action = primaryAction(data);
  if (action) return action.detail;
  return data?.detail ?? "Preparing the current rebalance plan.";
}

function pricePositionPercent(data: AutopilotPlan | null) {
  const active = data?.ladder.find((segment) => segment.role === "active");
  if (!data || !active?.lowerPrice || !active.upperPrice) return null;
  return paddedPriceRangeMarkerPosition({
    lowerPrice: active.lowerPrice,
    upperPrice: active.upperPrice,
    currentPrice: data.pool.price,
    paddingPercent: 8
  });
}

function checkTone(ok: boolean | null) {
  if (ok === null) return "";
  return ok ? "good" : "bad";
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
        if (active) timeoutId = setTimeout(poll, 15_000);
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
  const action = primaryAction(data);
  const activeRange = data?.ladder.find((segment) => segment.role === "active") ?? data?.ladder[0] ?? null;
  const pricePercent = pricePositionPercent(data);
  const costOk = data ? data.economics.immediateCostUsd <= data.strategy.maxImmediateCostUsd : null;
  const debtOk = data ? data.economics.uncoveredReversalDebtUsd <= data.strategy.maxUncoveredDebtUsd : null;
  const driftText = data ? `${data.strategy.maxDriftBps} bps max drift` : "-";

  return (
    <div className="autopilot-grid">
      {data?.dbRecord && data.dbRecord.status !== "pending" && (
        <div className={`autopilot-execution-banner ${dbStatusTone(data.dbRecord.status)}`} style={{ gridColumn: "1 / -1", marginBottom: "1rem" }}>
          <div>
            <strong>{dbStatusLabel(data.dbRecord.status)}</strong>
            <p className="muted" style={{ margin: "0.2rem 0 0 0" }}>{data.dbRecord.decisionNote}</p>
          </div>
          {data.dbRecord.txHash && (
            <a
              href={`https://base.blockscout.com/tx/${data.dbRecord.txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
              style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center" }}
            >
              Blockscout ↗
            </a>
          )}
        </div>
      )}

      <div className="autopilot-command">
        <div className={`autopilot-decision ${error && !data ? "bad" : statusTone}`}>
          <p className="metric-label">Decision</p>
          <strong>{decisionTitle(data, error)}</strong>
          <p>{decisionDetail(data, error)}</p>
          <div className="autopilot-decision-meta">
            <span className={`status ${statusTone}`}>{data?.state ?? "loading"}</span>
            <span>{data ? modeLabel(data.mode) : "Mode loading"}</span>
            <span>{data ? `${data.strategy.targetWidthTicks} ticks` : "Range loading"}</span>
            <span>{data ? `${data.strategy.confirmationSeconds}s confirm` : "Confirm loading"}</span>
          </div>
        </div>

        <div className="autopilot-current-range">
          <div className="section-title-row">
            <p className="metric-label">Current range</p>
            <span className={`status ${activeRange?.status === "ok" ? "good" : activeRange?.status === "missing" ? "bad" : "warn"}`}>
              {activeRange?.status ?? "loading"}
            </span>
          </div>
          <strong>{activeRange?.tokenId ? `#${activeRange.tokenId}` : "No active NFT"}</strong>
          <span>{activeRange ? `${formatAmount(activeRange.lowerPrice, 2)} - ${formatAmount(activeRange.upperPrice, 2)} USDC` : "-"}</span>
          <div className="autopilot-price-band" aria-hidden="true">
            <span style={{ left: `${pricePercent ?? 50}%` }} />
          </div>
          <div className="autopilot-price-row">
            <span>{formatAmount(activeRange?.lowerPrice, 2)}</span>
            <strong>{formatAmount(data?.pool.price, 2)} USDC</strong>
            <span>{formatAmount(activeRange?.upperPrice, 2)}</span>
          </div>
          <p className="muted">{activeRange?.plannedAction ?? "Waiting for range data."}</p>
        </div>
      </div>

      <div className="autopilot-checks" aria-label="Autopilot guardrails">
        <div className={`autopilot-check ${checkTone(costOk)}`}>
          <span>Immediate cost</span>
          <strong>{formatUsd(data?.economics.immediateCostUsd)}</strong>
          <small>Limit {formatUsd(data?.strategy.maxImmediateCostUsd)}</small>
        </div>
        <div className={`autopilot-check ${checkTone(debtOk)}`}>
          <span>Uncovered debt</span>
          <strong>{formatUsd(data?.economics.uncoveredReversalDebtUsd)}</strong>
          <small>Limit {formatUsd(data?.strategy.maxUncoveredDebtUsd)}</small>
        </div>
        <div className="autopilot-check">
          <span>Fee credit</span>
          <strong>{formatUsd(data?.economics.feeCreditUsd)}</strong>
          <small>
            {formatUsd(data?.economics.collectedFeesSinceLastSwapUsd)} collected / {formatUsd(data?.economics.uncollectedFeesUsd)} uncollected
          </small>
        </div>
        <div className="autopilot-check">
          <span>Drift guard</span>
          <strong>{driftText}</strong>
          <small>Used when breakout is confirming</small>
        </div>
      </div>

      <div className="autopilot-details">
        <div className="autopilot-next-action">
          <p className="metric-label">Next action</p>
          <strong>{action?.label ?? "Loading action"}</strong>
          <p className="muted">{action?.detail ?? "Waiting for current plan."}</p>
          <span>{formatUsd(action?.estimatedCostUsd)}</span>
        </div>
        <div className="autopilot-swap-reference">
          <p className="metric-label">Last directional swap</p>
          {data?.economics.lastDirectionalSwap ? (
            <>
              <strong>{swapSideLabel(data.economics.lastDirectionalSwap.side)}</strong>
              <span>
                {formatAmount(data.economics.lastDirectionalSwap.effectivePrice, 2)} USDC on {shortDateTime(data.economics.lastDirectionalSwap.timestamp)}
              </span>
            </>
          ) : (
            <>
              <strong>No swap reference</strong>
              <span>Reversal debt is inactive.</span>
            </>
          )}
        </div>
      </div>

      <div className="autopilot-process" aria-label="Autopilot process">
        {STATE_ORDER.map((state, index) => (
          <div className={`autopilot-step ${index <= activeStateIndex ? "is-active" : ""} ${data?.state === state ? "is-current" : ""}`} key={state}>
            <span />
            <strong>{state}</strong>
          </div>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
