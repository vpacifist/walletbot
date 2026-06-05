# WalletBot setup

## Local development

1. Enable pnpm through Corepack:

```powershell
corepack enable
corepack prepare pnpm@10.12.1 --activate
```

2. Copy `.env.example` to `.env` and fill:

- `BASE_WALLET_ADDRESS`
- `BASE_RPC_URL`
- `BASE_RPC_ADD_URLS` optionally, as comma/space/newline separated fallback RPC URLs
- `AUTOPILOT_PRESET`, either `triple_range` or `small_capital_test`
- `AUTOPILOT_MODE`, usually `approve_in_telegram`; set `auto_guarded` only when guarded live execution should auto-submit clean out-of-range rebalances
- `AUTOPILOT_SWAP_PROVIDER`, usually `odos` for guarded/live execution; use `zeroex` or `uniswap_v3` only for explicit fallback testing
- `AUTOPILOT_MAX_GAS_COST_USD`, defaults to `0.5`; live execution is blocked when the estimated atomic rebalance gas cost is above this USD cap
- `AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS`, defaults to `5`; fast auto mode ignores smaller boundary micro-breakouts
- `ODOS_API_KEY`, required when `AUTOPILOT_SWAP_PROVIDER=odos`
- `AUTOPILOT_BASELINE_AT` optionally, as an ISO timestamp for ignoring old autopilot fee/debt history
- `AUTOPILOT_REBALANCER_ADDRESS` for atomic rebalance dry-run/live review
- `APP_PASSWORD`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

If `TELEGRAM_BOT_TOKEN` is configured, `TELEGRAM_CHAT_ID` is required. In production, do not use a default or placeholder `APP_PASSWORD`; startup validation rejects known weak values.

Live execution is off by default. To enable it, set both:

- `AUTOPILOT_LIVE_EXECUTION_ENABLED=true`
- `BASE_WALLET_PRIVATE_KEY`, for the hot wallet only; it must match `BASE_WALLET_ADDRESS`

The bot still requires a validated dry-run and a second Telegram confirmation before broadcasting a live transaction. Do not use a cold-wallet private key here.

The Compose Postgres service is exposed on host port `5433` to avoid conflicts with a locally installed Postgres on `5432`.

3. Install dependencies:

```powershell
pnpm install
```

4. Run the web app and worker:

```powershell
pnpm dev
```

`pnpm dev` starts Docker Desktop on Windows when needed, waits for the Docker daemon, starts the local Docker Compose Postgres service, applies migrations, and starts both the Next.js dev server and the sync/Telegram worker. The web UI is available at `http://localhost:3000`.

If Docker does not come up automatically, start Docker Desktop manually and verify `docker info` succeeds all the way through the `Server` section before retrying `pnpm dev`.

If you use an external database instead of the local Compose Postgres service, disable the Docker startup step:

```powershell
$env:WALLETBOT_DEV_DOCKER = "0"; pnpm dev
```

For UI-only work, this command starts only Next.js:

```powershell
pnpm dev:no-sync
```

When using `dev:no-sync`, Telegram commands will not answer unless the worker is running separately:

```powershell
pnpm worker
```

Production-build verification runs the safe Prisma generate path and may stop local WalletBot Next/worker processes before building. After `pnpm build`, restart `pnpm dev` or start `pnpm worker` again before testing Telegram commands such as `/autopilot`.

## VPS deployment shape

Use the same `.env` contract on Hetzner and run:

```bash
docker compose up -d --build
```

Put nginx or Caddy in front of the `web` service, terminate HTTPS there, and keep Postgres unexposed to the public internet.

## Source references

- Uniswap official Base deployments: `https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments`
- Circle USDC on Base: `https://www.circle.com/multi-chain-usdc/base`
