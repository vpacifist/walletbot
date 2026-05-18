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

4. Run the web app and worker in two terminals:

```powershell
pnpm dev
pnpm worker
```

The web UI is available at `http://localhost:3000`.

## VPS deployment shape

Use the same `.env` contract on Hetzner and run:

```bash
docker compose up -d --build
```

Put nginx or Caddy in front of the `web` service, terminate HTTPS there, and keep Postgres unexposed to the public internet.

## Source references

- Uniswap official Base deployments: `https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments`
- Circle USDC on Base: `https://www.circle.com/multi-chain-usdc/base`
