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

## Prisma generate on Windows

Do not run raw `prisma generate` while the WalletBot dev server or worker is running. Windows can keep Prisma's query engine DLL locked through active Node processes.

Use the safe project script instead:

```powershell
pnpm db:generate
```

For production-build verification, use `pnpm build`; it already runs the safe Prisma generate path with `-NoRestart` before `next build`.
