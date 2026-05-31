# walletbot
A telegram-bot &amp; UI that helps me with my crypto wallet

## Local run modes

Use `pnpm dev` for normal local work:

```powershell
pnpm dev
```

It starts Docker Desktop on Windows when needed, waits for the Docker daemon, starts the local Docker Compose Postgres service, applies migrations, then starts both the web UI and the sync/Telegram worker.

If Docker does not come up automatically, start Docker Desktop manually and verify `docker info` succeeds all the way through the `Server` section before retrying `pnpm dev`.

If you use an external database instead of the local Compose Postgres service, disable the Docker startup step:

```powershell
$env:WALLETBOT_DEV_DOCKER = "0"; pnpm dev
```

Use `pnpm dev:no-sync` only for UI-only work. Telegram commands, including `/autopilot`, require the worker:

```powershell
pnpm worker
```

After `pnpm build`, restart `pnpm dev` or `pnpm worker` before testing Telegram commands.
