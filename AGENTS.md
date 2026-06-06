# Local Codex Instructions

## Windows process launches

When starting package-manager scripts in the background with `Start-Process`, do not use bare `pnpm`, `npm`, or `yarn` as the executable. On Windows this can resolve through file associations differently than an interactive shell.

Use the command shim explicitly:

```powershell
Start-Process -FilePath "pnpm.cmd" -ArgumentList "dev" -WorkingDirectory "C:\projects\walletbot" -WindowStyle Hidden
```

Alternatively, run through `cmd.exe`:

```powershell
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "pnpm dev" -WorkingDirectory "C:\projects\walletbot" -WindowStyle Hidden
```

## Local server readiness

Do not use the dashboard root `/` as a local dev-server readiness check. It requires an authenticated session and server-renders data from the database/RPC, so it can be slower than server startup or redirect to `/login`.

Use the lightweight health endpoint instead:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/api/health" -UseBasicParsing -TimeoutSec 10
```

## Telegram bot and worker

Telegram commands such as `/status`, `/positions`, and `/autopilot` are handled by the worker process, not by the Next.js dev server.

`pnpm dev` starts both the Next.js dev server and the worker. `pnpm dev:no-sync` starts only the web UI and will not answer Telegram commands. If `pnpm build` was run, the safe Prisma generate path may stop existing WalletBot Next/worker Node processes; restart the worker before testing Telegram commands:

```powershell
Start-Process -FilePath "pnpm.cmd" -ArgumentList "worker" -WorkingDirectory "C:\projects\walletbot" -WindowStyle Hidden
```

When testing any Telegram command or notification behavior, verify a worker is running in addition to the web health check.

For production Telegram/live-execution incidents, first reconstruct the exact user flow and timeline before changing code. Do not assume repeated Telegram messages came from a duplicate callback; distinguish duplicate callbacks from separate user cycles such as `/autopilot -> approve -> live review/confirm`.

Production incident investigation checklist:

1. Reconstruct the timeline first from Telegram export, production API/database state, transaction hashes, pool tick/price, and Berlin local time.
2. Separate event types before drawing conclusions: auto trigger, auto retry, manual `/autopilot`, approve callback, live review, final execute, failed/reverted transaction, and mined transaction.
3. Do not treat repeated Telegram messages as duplicates until the timeline proves they came from the same callback or worker cycle.
4. Verify the on-chain result before explaining impact: whether a transaction was sent, mined, reverted, which NFT was closed, and which NFT was minted.
5. Compare ranges by ticks first, then prices/UI labels. For anchored-vs-centered questions, use the old and new tick boundaries as the source of truth.
6. Classify the actual blocking reason precisely: slippage/preflight, live plan freshness, boundary drift, uncovered debt, NFT approval, role mismatch, contract revert, RPC/rate limit, or Telegram delivery.
7. Before saying "autopilot did not work", distinguish no trigger from triggered-but-blocked-by-guardrail.
8. Before coding a fix, state the incident hypothesis and the intended user-facing behavior change, then wait for explicit approval.

Data access during incident investigations:

1. Prefer existing production API endpoints first, such as `/api/autopilot`, `/api/positions`, and `/api/transactions`, when they contain enough evidence.
2. For production API reads that require authentication, use the normal authenticated web session/cookie flow and only call read-only endpoints unless the user explicitly asks to mutate production state.
3. Never print or expose `APP_PASSWORD`, cookies, `DATABASE_URL`, private keys, RPC keys, or other secrets while investigating.
4. If direct database facts are needed and the production `DATABASE_URL` points to Railway's private hostname such as `postgres.railway.internal`, do not keep retrying from the local machine. Use a Railway-side command/shell or a safe read-only diagnostic endpoint instead.
5. If direct SQL is available from the current environment, use SQL from the resolved production database URL instead of importing the app Prisma client into one-off `tsx` diagnostics.
6. Do not infer that Prisma, the app database layer, or production sync is broken from a failure in a one-off diagnostic import.
7. If Prisma access is required, use existing project entrypoints or scripts that already load env, aliases, and the generated client correctly.

Before coding product or UI behavior changes, describe the intended change in user-facing/UI terms without deep implementation detail and wait for explicit user approval. Do not start coding until the user confirms what exactly should be changed.

## Dev before production

For production-bound changes, first do the implementation and verification on the dev/local path before switching to production. Treat production as the final promotion step after code, env expectations, tests, and user-facing behavior are already clear.

When switching from dev/local work to production:

1. Confirm the exact commit or branch to deploy.
2. Confirm required production env changes for each Railway service.
3. Deploy only after tests/build or the relevant verification has passed.
4. After deploy, run read-only production checks before considering the promotion complete.

## UI verification tools

For browser/UI verification, first try to use the Codex Browser plugin / in-app browser when it is callable. If the Browser MCP tools are not exposed in the current session, do not stop to ask the user to reconfigure plugins. Use Playwright from the local project as the fallback and state that fallback briefly in the work log or final answer.

For data assertions in rendered pages, Playwright is acceptable even when Browser is available. For visual QA, screenshots, layout checks, and manual interaction flows, prefer Browser when callable.

## Prisma generate on Windows

Do not run raw `prisma generate` while the WalletBot dev server or worker is running. Windows can keep Prisma's query engine DLL locked through active Node processes.

Use the safe project script instead:

```powershell
pnpm db:generate
```

For production-build verification, use `pnpm build`; it already runs the safe Prisma generate path with `-NoRestart` before `next build`.
