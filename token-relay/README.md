# Token Relay

Token Relay is an OpenAI-compatible LLM gateway and a capacity marketplace.
Sellers list LLM capacity they do not use. Buyers get one relay API key that
works in Cursor, VS Code (Continue / Cline / Roo), aider or any other OpenAI
client, and they pay per token from a prepaid balance.

> ⚠️ Read [docs/DESIGN.md §3 "Obstacles"](docs/DESIGN.md#3-obstacles-and-risks-read-this-first)
> before you deploy. Reselling provider capacity is usually against the
> provider's terms. The relay refuses to route to a provider until an operator
> sets `providers.<id>.resaleAcknowledged=true` after a legal review.

* **Design draft and obstacles:** [docs/DESIGN.md](docs/DESIGN.md)
* **Dev build and debugging guide:** [docs/DEBUGGING.md](docs/DEBUGGING.md)
* **Obstacle questionnaire (fill in your decisions):** [docs/OBSTACLE_QUESTIONNAIRE.md](docs/OBSTACLE_QUESTIONNAIRE.md)

## Quick start (dev build)

```bash
cd token-relay && npm install && npm run dev
curl -s localhost:8787/v1/chat/completions \
  -H 'authorization: Bearer trk_dev_buyer_0000000000000000000000000000000' \
  -H 'content-type: application/json' \
  -d '{"model":"mock-fast","messages":[{"role":"user","content":"hello"}],"stream":true}'
open http://localhost:8787/debug/requests
```

The dev build runs offline. It uses SQLite, an in-process mock upstream,
seeded buyer, seller and admin accounts, pretty logs, request timelines and
fault injection.

## Production

```bash
npm ci && npm run build
export TR_ENV=production TR_MASTER_KEY=$(node dist/cli.js gen-master-key) DATABASE_URL=postgres://…
export STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=…
node dist/cli.js migrate
node dist/cli.js create-admin ops@example.com '<password>'
node dist/main.js
```

You can also run `docker compose up --build`, which starts Postgres, runs
the migrations and then starts the relay. See `.env.example`.

Production **refuses to start** in these cases:

* dev keys are in use
* SQLite is the database
* the fake payment provider or the mock provider is enabled
* prompt body logging is on
* private base URLs are allowed
* the debug surface is enabled without a strong admin token

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `dev:debug` | dev build with watch mode; `dev:debug` adds the Node inspector |
| `npm run build` / `start` | compile to `dist/` / run the compiled build in production mode |
| `npm test` | unit and end-to-end suites (`TEST_DATABASE_URL` switches them to Postgres) |
| `npm run typecheck` | strict TypeScript check |
| `npm run migrate` | apply database migrations (Postgres uses an advisory lock, so this is safe with several replicas) |
| `npm run print-config -- --sources` | effective config, with secrets redacted |
| `npm run cli -- reconcile` | ledger integrity check (exits non-zero on mismatch) |
| `npm run mock-upstream` | standalone fake OpenAI server |

## API overview

| Area | Endpoints |
|---|---|
| Editor-facing (relay key `trk_…`) | `GET /v1/models`, `POST /v1/chat/completions` (streaming and non-streaming) |
| Account (session `trs_…`) | `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/me`, `POST/GET/DELETE /v1/keys` |
| Billing | `POST /v1/billing/checkout {amountUsd}`, `GET /v1/billing/ledger`, `GET /v1/billing/usage`, `POST /webhooks/stripe` |
| Seller | `POST/GET/PATCH/DELETE /v1/seller/credentials`, `GET /v1/seller/earnings`, `POST /v1/seller/payouts` |
| Admin | `/admin/users`, `/admin/users/:id/status`, `/admin/users/:id/adjust`, `/admin/payouts[/:id/paid\|rejected]`, `/admin/credentials/:id/disable`, `/admin/reconcile` |
| Ops | `/healthz`, `/readyz`, `/metrics`, `/debug/*` |

Errors use the OpenAI error envelope
(`{"error":{"message","type","code","param"}}`), so editors show them
properly.

## Layout

```
config/       default.json + development/test/production overlays
migrations/   portable SQL (SQLite and Postgres)
src/config    layered loader, strict validation, production safety rails
src/db        Db interface, sqlite (dev/test), postgres (prod), migrator
src/domain    users, api keys, credentials (encrypted), wallet/holds, ledger, billing/payouts
src/relay     pipeline, capacity windows, circuit breaker, SSE proxy, provider adapters, timelines
src/payments  fake (dev) and Stripe Checkout + webhook verification
src/api       HTTP routes and auth guards
src/dev       mock upstream and seed data
test/         unit and e2e suites
```
