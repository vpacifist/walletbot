"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SyncResult = {
  transactionsSeen: number;
  positionsSeen: number;
  toBlock: string;
};

type SyncState =
  | { status: "idle"; message: string | null }
  | { status: "running"; message: string }
  | { status: "succeeded"; message: string }
  | { status: "failed"; message: string };

function notifyStatusRefresh() {
  window.dispatchEvent(new Event("walletbot:sync-status-refresh"));
}

export function SyncNowButton() {
  const router = useRouter();
  const [syncState, setSyncState] = useState<SyncState>({ status: "idle", message: null });

  const runSync = async () => {
    setSyncState({ status: "running", message: "Sync is running..." });
    notifyStatusRefresh();

    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        cache: "no-store"
      });

      const payload = (await response.json().catch(() => null)) as (SyncResult & { error?: string }) | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? `Sync failed with HTTP ${response.status}`);
      }

      setSyncState({
        status: "succeeded",
        message: `Synced ${payload?.transactionsSeen ?? 0} tx, ${payload?.positionsSeen ?? 0} positions. Latest block ${payload?.toBlock ?? "unknown"}.`
      });
      notifyStatusRefresh();
      router.refresh();
    } catch (error) {
      setSyncState({
        status: "failed",
        message: error instanceof Error ? error.message : "Sync failed."
      });
      notifyStatusRefresh();
    }
  };

  return (
    <div className="sync-action">
      <p className={`sync-message ${syncState.status}`} aria-live="polite">
        {syncState.message ?? ""}
      </p>
      <button className="button primary" type="button" onClick={runSync} disabled={syncState.status === "running"}>
        {syncState.status === "running" ? "Syncing..." : "Sync now"}
      </button>
    </div>
  );
}
