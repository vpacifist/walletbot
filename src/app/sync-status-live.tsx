"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type LatestRun = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  transactionsSeen: number;
  error: string | null;
};

type SyncStatusLiveProps = {
  initialRun: LatestRun | null;
};

function runSignature(run: LatestRun | null) {
  if (!run) return "none";
  return [run.id, run.status, run.startedAt, run.finishedAt, run.transactionsSeen, run.error ?? ""].join(":");
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function statusTimeLabel(run: LatestRun) {
  if (run.status === "running") return `Sync started ${formatDate(run.startedAt)}`;
  return `Last sync ${formatDate(run.finishedAt ?? run.startedAt)}`;
}

export function SyncStatusLive({ initialRun }: SyncStatusLiveProps) {
  const router = useRouter();
  const [latestRun, setLatestRun] = useState(initialRun);
  const signatureRef = useRef(runSignature(initialRun));
  const initialSignature = useMemo(() => runSignature(initialRun), [initialRun]);

  useEffect(() => {
    signatureRef.current = initialSignature;
    setLatestRun(initialRun);
  }, [initialRun, initialSignature]);

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch("/api/settings/status", { cache: "no-store" });
        if (!active || !response.ok) return;

        const payload = (await response.json()) as { latestRun: LatestRun | null };
        const nextRun = payload.latestRun;
        const nextSignature = runSignature(nextRun);

        setLatestRun(nextRun);
        if (nextSignature !== signatureRef.current) {
          signatureRef.current = nextSignature;
          router.refresh();
        }
      } catch {
      } finally {
        if (active) timeoutId = setTimeout(poll, 10_000);
      }
    };

    const refreshNow = () => {
      if (timeoutId) clearTimeout(timeoutId);
      void poll();
    };

    window.addEventListener("walletbot:sync-status-refresh", refreshNow);
    void poll();

    return () => {
      active = false;
      window.removeEventListener("walletbot:sync-status-refresh", refreshNow);
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [router]);

  if (!latestRun) return null;

  return (
    <p className="muted">
      {statusTimeLabel(latestRun)}
      {latestRun.error ? ` - ${latestRun.error}` : ""}
    </p>
  );
}
