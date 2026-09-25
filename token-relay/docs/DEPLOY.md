# Deploying the backend

The relay is one stateless Node service plus Postgres. GitHub can host the
code and the static preview page, but it **cannot run the backend**. You need
three things:

| Piece | Recommended | Alternatives |
|---|---|---|
| App hosting (Docker) | **Fly.io**: `fly.toml` is in this folder | Render, Railway, Google Cloud Run (set min instances ≥ 1), any VPS with `docker compose` |
| Postgres | **Neon** or **Fly Managed Postgres**, in the same region as the app | Supabase, AWS RDS, Crunchy Bridge |
| Payments | **Stripe** (Checkout for top-ups; Connect Express for payouts, Phase 2) | none |

Cost to start: roughly $10–30/month (two small app machines plus a small
Postgres).

## 1. Create the database

Create a Postgres 16 database, for example on Neon in `us-east-1`, which is
close to Fly's `iad` region. Copy the connection string with
`?sslmode=require`.

## 2. Configure and deploy (Fly.io)

```bash
cd token-relay
fly auth login
fly launch --copy-config --no-deploy            # pick a unique app name; update TR_SERVER__PUBLIC_BASE_URL

fly secrets set \
  TR_MASTER_KEY="$(openssl rand -base64 32)" \
  TR_ADMIN_TOKEN="$(openssl rand -hex 24)" \
  DATABASE_URL="postgres://…?sslmode=require" \
  STRIPE_SECRET_KEY="sk_live_…" \
  STRIPE_WEBHOOK_SECRET="whsec_…"

fly deploy                                       # builds the Dockerfile; release_command runs migrations
fly ssh console -C "node dist/cli.js create-admin you@example.com 'long-password'"
curl https://<app>.fly.dev/readyz                # {"status":"ready"}
```

**Back up `TR_MASTER_KEY` somewhere safe.** It encrypts every seller key. If
you lose it, every registered credential has to be registered again. To rotate
it, move the old key into `security.previousMasterKeys` (see DESIGN §7).

The service refuses to start if production config is unsafe. Check a config
before deploying with `TR_ENV=production node dist/cli.js check-config`.

## 3. Stripe

1. Dashboard → Developers → Webhooks → add the endpoint
   `https://<app>.fly.dev/webhooks/stripe`.
2. Select these events: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`.
3. Put that endpoint's signing secret in `STRIPE_WEBHOOK_SECRET`.

## 4. Turn on supply

Out of the box, only the `self_hosted` provider routes. It covers sellers
running their own vLLM, Ollama, TGI or llama.cpp servers. The seller
registers the server with `"attestSelfHosted": true`. The base URL must be
public HTTPS; private and internal addresses are refused.

```bash
curl -X POST https://<app>.fly.dev/v1/seller/credentials \
  -H "authorization: Bearer trs_…" -H 'content-type: application/json' \
  -d '{"provider":"self_hosted","baseUrl":"https://gpu.seller.example/v1","apiKey":"…",
       "hourlyTokenLimit":2000000,"maxConcurrency":8,"attestSelfHosted":true}'
```

Add the models you want to sell to the `models` catalog. Use a config file
passed with `TR_CONFIG_FILE`, or override the catalog through the environment.

Commercial providers (`openai`, `openai_compatible`) stay switched off until
you set `TR_PROVIDERS__<ID>__RESALE_ACKNOWLEDGED=true`, which should only
happen after a reseller agreement exists.

## 5. Operate

| Task | How |
|---|---|
| Logs | `fly logs` (JSON lines; filter by `requestId`) |
| Metrics | scrape `https://<app>.fly.dev/metrics` (Fly's built-in Prometheus, or Grafana Cloud) |
| Ledger check | `fly ssh console -C "node dist/cli.js reconcile"`; run it daily and alert on a non-zero exit |
| Debug a request | temporarily set `TR_DEBUG__ENABLED=true`, then `curl -H "x-admin-token: …" …/debug/requests/<id>` |
| Scale | `fly scale count 4`; capacity budgets and money stay correct because they live in Postgres |
| Backups | enable point-in-time recovery on the Postgres provider; the ledger is the business record |

## About "global" regions

The questionnaire answer for O8 was *global edge*. The relay performs about
6 to 8 small Postgres writes per request: hold, reserve, settle and the
request record. If a machine in Singapore talks to a database in Virginia,
each write adds about 200 ms. So:

1. **Launch in one region, next to the database.** The LLM call itself takes
   0.3 to 30 s, so the relay's own share stays small.
2. **When you need other regions:** first collapse the hot path into one
   database round-trip (a single SQL function that places the hold and
   reserves capacity together, and another for settlement). Then add regional
   app machines. At that point the extra cost is one cross-region round trip,
   not eight.
3. Regional ledgers or sharding come later, and only if volume demands it.
