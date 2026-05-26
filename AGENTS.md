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
