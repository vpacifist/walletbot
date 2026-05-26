# walletbot
A telegram-bot &amp; UI that helps me with my crypto wallet

## Local run modes

Use `pnpm dev` for normal local work. It starts both the web UI and the sync/Telegram worker.

Use `pnpm dev:no-sync` only for UI-only work. Telegram commands, including `/autopilot`, require the worker:

```powershell
pnpm worker
```

After `pnpm build`, restart `pnpm dev` or `pnpm worker` before testing Telegram commands.
