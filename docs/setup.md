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
- `APP_PASSWORD`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

The Compose Postgres service is exposed on host port `5433` to avoid conflicts with a locally installed Postgres on `5432`.

3. Install dependencies and create the database schema:

```powershell
pnpm install
docker compose up -d postgres
pnpm db:migrate
```

4. Run the web app and worker:

```powershell
pnpm dev
```

`pnpm dev` starts both the Next.js dev server and the sync/Telegram worker. The web UI is available at `http://localhost:3000`.

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
