# Token Relay — Design Draft (v0.1)

Status: **draft, Phase 1 implemented on this branch** · Last updated: 2026-09-25

## 1. What we are building

Token Relay is a marketplace plus an API gateway for LLM capacity.

* **Sellers** have LLM capacity they do not use, such as an hourly or
  per-minute quota on an API key they own. They register that capacity. We
  pay them for the tokens that other people use through it.
* **Buyers** register, top up a prepaid balance and create a relay API key.
  They paste the key and our base URL into any editor or tool that speaks the
  OpenAI API: Cursor ("Override OpenAI Base URL"), VS Code with Continue, Cline
  or Roo, JetBrains AI "custom OpenAI", aider, and others. The editor chats and
  runs agents as usual. Each request is sent through a seller's capacity and
  billed per token.
* **The platform** routes each request, meters it, holds and settles the money,
  and keeps a take rate.

```
 ┌───────────┐  OpenAI-compatible HTTPS   ┌────────────────────────────────────┐   provider API   ┌──────────┐
 │  Cursor / │ ─────────────────────────▶ │            Token Relay             │ ───────────────▶ │ Upstream │
 │  VS Code  │ ◀───── SSE stream ──────── │ auth → hold → route → proxy →      │ ◀─────────────── │ provider │
 └───────────┘                            │ meter → settle (ledger)            │  (seller's key)  └──────────┘
                                          └────────────────────────────────────┘
      buyer: account, API keys, wallet            seller: credentials, capacity, earnings, payouts
```

## 2. Goals and non-goals

Goals (for the MVP in this branch):

1. Drop-in **OpenAI-compatible** endpoints: `POST /v1/chat/completions`
   (streaming and non-streaming) and `GET /v1/models`. These are enough for
   Cursor and VS Code extensions.
2. **Correct money.** Every token that is billed is a double-entry ledger
   transaction. Buyers cannot spend more than their prepaid balance, except for
   one overage that is bounded and documented (§6.3). Sellers are credited only
   for tokens that were delivered.
3. **Capacity-aware routing.** A seller credential is never pushed past the
   hourly token budget or concurrency cap that the seller declared. When a
   credential fails, the request moves to another credential before the first
   byte goes to the client.
4. **Production shape.** Postgres, stateless app nodes, secrets encrypted at
   rest, structured logs, Prometheus metrics, health and readiness probes,
   graceful shutdown, migrations, and a Docker image.
5. **Configurable, debuggable development build.** One command starts the full
   stack offline, with SQLite, a mock upstream, seeded users, pretty logs, a
   request timeline inspector and redacted config dumps. See §9.

Non-goals for now: a web UI (the API comes first; the dashboard is phase 2),
fine-tuning or embeddings passthrough, a native Anthropic `/v1/messages`
surface (phase 2), and crypto payments.

## 3. Obstacles and risks (read this first)

These are the hard problems. The top items are **existential**: engineering
alone cannot solve them.

| # | Obstacle | Severity | Mitigation in this design |
|---|----------|----------|---------------------------|
| O1 | **Provider terms of service.** Most LLM providers (OpenAI, Anthropic, Google, and also Cursor, Copilot and ChatGPT subscriptions) do not allow account sharing, credential sharing or resale of access. Free, trial and consumer-plan quotas ("free hourly usage") are almost always personal and non-transferable. Selling them can get sellers' accounts banned and can expose the platform to legal claims. | **Existential** | Every provider adapter has a `resalePolicy` (`permitted` / `requires_agreement` / `prohibited`). The router refuses to route through a provider unless the operator has set `providers.<id>.resaleAcknowledged=true` in config after a legal review. We support **API-key credentials only**. We will never scrape consumer web sessions or IDE subscription tokens, because that is circumvention and not a relay. The realistic legitimate supply is: providers or resellers with explicit reseller programs, self-hosted open-weight models (vLLM/Ollama endpoints owned by the seller), and enterprise contracts that allow redistribution. |
| O2 | **Supply is fraud-prone.** People can list stolen or leaked API keys ("key laundering"). Card-testing fraud can happen on the buyer side. | High | Seller KYC before payout. Payout hold period (default 14 days) so chargebacks and provider disputes land before money leaves. Anomaly flags on credentials that suddenly start working after they were leaked. We validate each credential when it is registered and store a fingerprint so the same key cannot be listed twice. |
| O3 | **Privacy of prompts.** Buyer code and prompts go to a third party's account, so the seller can see them in their provider dashboard or logs. The relay operator can also see them. | High | Disclose this clearly in the buyer terms. We never log bodies in production (`debug.logBodies` is forced off and validated). Optional "trusted supply only" routing tier. Longer term: only self-hosted or attested supply for sensitive tiers. |
| O4 | **Metering accuracy.** Upstream `usage` is the source of truth, but streams can end without a usage chunk (client disconnect, upstream crash). Tokenizers differ between models. | Medium | We force `stream_options.include_usage=true` upstream. When there is no usage, we fall back to a conservative estimate of about 3 chars per token and mark the event `estimated=true` for later reconciliation. |
| O5 | **Money correctness under concurrency.** Many parallel streams from one buyer race on the same balance. Settlement can fail halfway through. | High | We reserve a *hold* up front with an atomic conditional `UPDATE`. We settle in a single database transaction with a double-entry ledger where each transaction sums to zero. Holds are keyed by the request and are idempotent. A reaper job releases orphaned holds. `/admin/reconcile` checks that cached balances equal the ledger sums. |
| O6 | **Capacity accounting across nodes.** An hourly budget must hold even with N relay instances. | Medium | Capacity windows are rows in the database (`credential_windows`), reserved with an atomic conditional `UPDATE`. In-memory state is only a cache for circuit breakers. Redis is optional later for lower latency. |
| O7 | **Upstream heterogeneity and quirks.** Error shapes, rate-limit headers and streaming formats differ. Tool-calling support differs by model. Cursor sends some non-standard fields. | Medium | Provider adapter interface. We pass unknown fields through. Per-model capability flags. A contract test suite that runs against the mock upstream. |
| O8 | **Latency overhead.** Editors are latency-sensitive (autocomplete). | Medium | Streaming pass-through with no buffering. Hot paths use two indexed single-row UPDATEs (hold and capacity) before the upstream call. Keep-alive upstream agents. |
| O9 | **Payments and payouts.** Paying out to individuals in many countries needs KYC, tax forms (1099-K / DAC7) and a money-transmitter posture. | High (business) | Buyer top-ups use Stripe Checkout. Payouts use Stripe Connect Express, so KYC and tax forms are delegated to Stripe. Prepaid, non-refundable credits reduce chargeback exposure. The MVP records payout requests for manual or admin approval. |
| O10 | **Abuse by buyers.** Buyers may use a seller's account for disallowed content, which gets the *seller* banned. | High | Buyer usage policy. Optional moderation pass (phase 2). Per-buyer rate limits. We can trace which buyer caused a seller's ban from the usage events. |
| O11 | **Seller credential revocation mid-flight.** A seller can rotate or revoke a key at any time. | Low | A 401 or 403 from upstream disables that credential and fails over. The seller is notified through `credential.status=invalid`. |
| O12 | **Pricing model.** Sellers' costs differ, and buyers want predictable prices. | Medium | MVP: the platform sets a buyer price per model, and sellers earn `(1 - takeRate)` of it. Phase 2: seller asks with an order-book style router. |

**Recommendation:** do not launch publicly with O1 unresolved. Build and run
the platform against (a) self-hosted open-weight model supply and (b)
providers with a signed reseller agreement. The code enforces this through the
resale policy gate.

## 4. Architecture

A single deployable Node.js (22 LTS, TypeScript) service. It is stateless, so
it scales horizontally behind a load balancer. Postgres is the only required
stateful dependency.

```
src/
  main.ts                  bootstrap, graceful shutdown
  cli.ts                   migrate | create-admin | print-config | seed-dev
  config/                  layered config loader + validation (§8)
  lib/                     logger, errors, crypto, http router, metrics, trace context, rate limiter
  db/                      Db interface; sqlite (dev/test) + postgres (prod) drivers; migrator
  domain/                  users, sessions, api keys, credentials, ledger, usage, payments, payouts
  relay/                   request pipeline, router (capacity + breaker), metering, provider adapters
  payments/                PaymentProvider interface: fake (dev), stripe (prod)
  api/                     HTTP handlers: auth, account, seller, billing, admin, debug, openai, health
  dev/                     mock upstream (OpenAI-compatible fake), seed data
```

### 4.1 Request pipeline (`POST /v1/chat/completions`)

1. **Authenticate** the buyer API key (`trk_…`). Look it up by SHA-256 hash.
   It must be active and belong to an active user.
2. **Rate-limit** with a token bucket per key (requests/min) and a concurrency
   cap per user.
3. **Resolve the model** from the catalog (config). Reject unknown models
   with 404 and an OpenAI-shaped error.
4. **Estimate cost**: `est_in = ceil(chars/3)`,
   `est_out = min(max_tokens ?? model.defaultMaxOutput, model.maxOutput)`,
   and `hold = price(est_in, est_out)`.
5. **Place a hold**:
   `UPDATE wallets SET available=available-$h, held=held+$h WHERE user=$u AND available >= $h`.
   If no row is updated, return 402 `insufficient_quota`.
6. **Route**: list the eligible credentials for the model's provider (active,
   provider resale-gated, breaker closed) and order them by least-used window
   plus a random tiebreak. For each candidate, **reserve capacity** atomically
   in `credential_windows` for the current hour bucket. Then call upstream.
   * If upstream returns 429, 5xx or a network error **before any byte is sent
     to the client**, release the reservation, record the breaker failure and
     try the next credential (maximum `router.maxAttempts`).
   * On 401 or 403, mark the credential `invalid` and try the next one.
   * On 4xx client errors (400, 404, 422), pass the error through without
     failover. The client's request is at fault.
7. **Proxy**. Non-streaming requests go straight through. For streaming, we
   pass SSE through line by line, parse `data:` JSON to capture `usage` and
   count output characters, and strip the usage chunk if the client did not ask
   for it.
8. **Meter**: use upstream usage when it exists, otherwise the estimate.
9. **Settle** in one transaction: release the hold, debit the actual cost,
   credit the seller `(1-take)`, credit platform revenue, write the
   `usage_events` row, adjust the capacity window (reserved → used) and
   finalize the request record.
10. **Trace**: every step appends to the request timeline. The timeline goes
    to logs, metrics and the debug ring buffer when that is enabled.

### 4.2 Provider adapters

```ts
interface ProviderAdapter {
  id: string;                         // "openai", "openai_compatible", "mock"
  resalePolicy: 'permitted' | 'requires_agreement' | 'prohibited';
  buildRequest(cred, body, opts): { url, headers, body };
  classifyError(status, body): 'retryable' | 'auth' | 'client' | 'rate_limited';
  validateCredential(cred): Promise<{ ok: boolean; detail?: string }>;
}
```

Shipped: `openai` (api.openai.com), `openai_compatible` (a base URL per
credential; covers vLLM, Ollama, OpenRouter, Together, Groq, DeepSeek and
similar), and `mock` (dev and test). Anthropic and Gemini translation adapters
are phase 2.

## 5. Data model

All money is stored as **integer micro-USD** (1 USD = 1,000,000). Token
counts are integers. Timestamps are ISO-8601 UTC strings, which works in both
SQLite and Postgres.

| Table | Purpose |
|-------|---------|
| `users` | id, email (unique, lower-cased), password_hash (scrypt), role (`user`/`admin`), status, created_at |
| `sessions` | id, user_id, token_hash, expires_at (dashboard/API session bearer `trs_…`) |
| `api_keys` | id, user_id, name, prefix (display), key_hash (sha256, unique), status, last_used_at |
| `wallets` | user_id PK, available_micros, held_micros, earned_micros (seller side, withdrawable after hold period) |
| `ledger_txns` / `ledger_entries` | double-entry; each txn's entries sum to 0; accounts are `user:<id>:available`, `user:<id>:earnings`, `platform:revenue`, `platform:clearing` |
| `holds` | request_id PK, user_id, amount, status (`open`/`settled`/`released`), created_at |
| `credentials` | id, seller_id, provider, base_url, secret_ciphertext (AES-256-GCM, key id), fingerprint (sha256 of secret, unique), models (JSON), hourly_token_limit, max_concurrency, status (`active`/`paused`/`invalid`), created_at |
| `credential_windows` | (credential_id, window_start) PK, used_tokens, reserved_tokens, in_flight |
| `requests` | id, user_id, api_key_id, model, credential_id, status, http_status, attempts, stream, latency_ms, error, created_at |
| `usage_events` | request_id, buyer_id, seller_id, credential_id, model, prompt_tokens, completion_tokens, estimated, buyer_cost, seller_credit, platform_fee |
| `payments` | id, user_id, provider, external_id (unique → idempotent webhooks), amount, status |
| `payouts` | id, seller_id, amount, status (`requested`/`approved`/`paid`/`rejected`) |

## 6. Money

### 6.1 Prices

The config catalog gives buyer prices per 1M input and output tokens for each
model. The seller share is `1 - pricing.takeRate` (default 0.20). Rounding
favors neither side: we compute in micro-USD with `Math.round` at the end,
and the platform fee is `cost - seller_credit`, so the entries always sum
exactly.

### 6.2 Flows

* Top-up: `platform:clearing → user:available`. This is written only after
  the payment provider confirms payment (webhook, idempotent on the external
  id).
* Usage: `user:available(held) → seller:earnings + platform:revenue`.
* Payout: `seller:earnings → platform:clearing` when it is approved and paid.

### 6.3 Overage

If the actual cost is greater than the hold (the buyer set no `max_tokens` and
the upstream ignored our cap, or the estimate was too low), we charge the
actual cost. The buyer's `available` can go negative by at most one request's
overage. After that, new holds fail until the buyer tops up. We always inject
`max_tokens` upstream when the client did not set it, which keeps this rare.

## 7. Security

* Passwords are hashed with scrypt (N=16384, r=8, p=1, 16-byte salt). Login
  compares hashes in constant time.
* API keys and session tokens: 32 random bytes, base64url, typed prefix. Only
  the SHA-256 is stored. Keys are shown once.
* Seller secrets use AES-256-GCM with the master key from `TR_MASTER_KEY`
  (32 bytes, base64). The ciphertext records the key id, which allows rotation
  (`security.masterKeys` keyring). Secrets are decrypted only in the relay
  hot path and are never returned by the API. The API shows `sk-…abcd` masks.
* Admin and debug endpoints need `role=admin`, or an `X-Admin-Token` in debug
  builds. Production refuses to start when the debug surface is enabled
  without an admin token.
* Request body limit (default 4 MiB), header timeout and upstream timeout.
* Stripe webhook signature check with a 5-minute tolerance. Duplicate events
  are ignored because `external_id` is unique.

## 8. Configuration

Layered, with later layers winning:

1. `config/default.json` (all keys, safe defaults)
2. `config/<TR_ENV>.json` (`development` | `test` | `production`)
3. an optional file from `TR_CONFIG_FILE`
4. environment variables `TR_<SECTION>__<KEY>` (double underscore = nesting,
   values parsed as JSON when possible), for example
   `TR_SERVER__PORT=9000` or `TR_DEBUG__ENABLED=true`.
5. the well-known secrets `TR_MASTER_KEY`, `TR_ADMIN_TOKEN`, `DATABASE_URL`,
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.

The result is validated at startup. Unknown keys and bad types fail fast with
the path of the offending key. **Production invariants**: the master key is
set and is not the dev key, the database is postgres, `debug.logBodies=false`,
the fake payment provider is off, and the mock provider is off.
`npm run print-config` (or `GET /debug/config`) prints the effective config
with secrets redacted and the source of each value.

## 9. Development build and debuggability

| Feature | Dev (`npm run dev`) | Prod (`npm run build && npm start`) |
|---------|--------------------|-------------------------------------|
| Runtime | TS source via Node type-stripping, `--watch` reload | compiled `dist/` |
| DB | SQLite file `./.data/dev.sqlite` (or `:memory:`) | Postgres (`DATABASE_URL`) |
| Upstream | in-process **mock upstream** (deterministic, streaming, configurable latency and fault injection) | real providers |
| Seed | demo buyer, seller and admin with printed API keys, $25 balance | none |
| Logs | pretty, colored, `debug` level, bodies optional | JSON lines, `info`, no bodies |
| Payments | `fake` provider: checkout credits instantly | `stripe` |
| Debug API | `/debug/config`, `/debug/requests`, `/debug/requests/:id` (full timeline), `/debug/router`, `/debug/ledger/:userId` | off, or admin-only |
| Headers | `x-request-id` always; `x-relay-debug` timeline summary | `x-request-id` only |
| Fault injection | `dev.mockUpstream.faults` (e.g. `{ "rate": 0.1, "status": 429 }`) or the per-request header `x-mock-fault: 429` | n/a |

The request timeline is the main debugging tool. Each request records ordered
events with millisecond offsets, for example: `auth.ok`, `hold.placed`,
`route.candidate`, `capacity.reserved`, `upstream.response`,
`stream.first_byte`, `usage.captured`, `settle.ok`. The timeline is written as
one structured log line when the request ends. In dev it is kept in an
in-memory ring buffer (`debug.ringSize`).

## 10. Observability and operations

* `GET /healthz` (process alive) and `GET /readyz` (database reachable,
  migrations applied, not draining).
* `GET /metrics` in Prometheus text format: `tr_http_requests_total`,
  `tr_relay_requests_total{model,outcome}`, `tr_relay_upstream_latency_ms`
  histogram, `tr_tokens_total{direction}`, `tr_revenue_micros_total`,
  `tr_breaker_open{credential}`, `tr_holds_open`.
* Graceful shutdown on SIGTERM: stop accepting connections, let in-flight
  streams finish (up to `server.shutdownGraceMs`), then close the database.
* A background reaper releases holds older than `relay.holdTtlMs` and resets
  stale `in_flight` counts.

## 11. API surface (MVP)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/logout` | – / session | accounts |
| `GET /v1/me` | session | profile + wallet |
| `POST/GET/DELETE /v1/keys[/:id]` | session | buyer relay keys |
| `POST /v1/billing/checkout`, `GET /v1/billing/ledger`, `GET /v1/billing/usage` | session | top-up, statements |
| `POST /webhooks/stripe` | signature | payment confirmation |
| `POST/GET/PATCH/DELETE /v1/seller/credentials[/:id]` | session | supply |
| `GET /v1/seller/earnings`, `POST /v1/seller/payouts` | session | earnings |
| `GET /v1/models`, `POST /v1/chat/completions` | relay key | editor-facing |
| `GET /admin/users`, `POST /admin/payouts/:id/(approve|reject|paid)`, `POST /admin/credentials/:id/disable`, `GET /admin/reconcile` | admin | ops |
| `/debug/*` | admin/debug | §9 |
| `/healthz`, `/readyz`, `/metrics` | – | ops |

## 12. Editor setup (buyer docs)

* **Cursor**: Settings → Models → OpenAI API Key = `trk_…`, then enable
  "Override OpenAI Base URL" and set it to `https://<host>/v1`. Add the model
  names from `GET /v1/models`.
* **VS Code / Continue**: `provider: openai`, `apiBase: https://<host>/v1`,
  `apiKey: trk_…`.
* **Cline / Roo**: API provider "OpenAI Compatible", with the same base URL
  and key.

## 13. Implementation status and known limitations (Phase 1)

Implemented and tested (33 tests, run on both SQLite and Postgres):
everything in §4 to §11 except the items below.

Engineering limitations that came up during the build:

| # | Limitation | Impact | Planned fix |
|---|---|---|---|
| L1 | Rate limits, per-user concurrency and circuit breakers are in memory **per replica**. | With N replicas the limits are up to N× looser, and breaker state is not shared. | Redis token bucket and a shared breaker (Phase 2). Capacity budgets are already exact across replicas because they live in the database. |
| L2 | The SSRF check on seller `baseUrl` runs when the credential is registered. | A DNS-rebinding seller could point a host at internal IPs later. | Pin the resolved IP per request through a custom undici dispatcher, and deploy relay nodes in an egress-only network segment. |
| L3 | Holds are estimated from characters, not from the model's tokenizer. | Holds are conservative (they overestimate), which can reject requests near a zero balance. | Per-model tokenizer (tiktoken / HF) in the estimate path. |
| L4 | Settlement happens before the response ends. This gives consistent balances for back-to-back requests. | Adds about 1 to 5 ms to the tail of each response. | Acceptable. Revisit if p99 matters. |
| L5 | Concurrency is counted over the current and previous hour windows. | A stream longer than 2 h would drop out of the in-flight count. | This does not happen in practice, because of `upstreamIdleTimeoutMs`. |
| L6 | Estimated usage (no upstream `usage`) is billed as-is. | It can drift from the provider's own count. | Nightly reconciliation job that compares against seller-exported provider usage. |
| L7 | Payouts are recorded and approved by an admin. No money actually moves. | Operations work. | Stripe Connect Express payouts plus KYC gating (O9). |

## 14. Roadmap

* **Phase 1 (this branch):** gateway, ledger, capacity router, dev build,
  Postgres, Docker.
* **Phase 2:** web dashboard, Stripe Connect payouts, Anthropic
  `/v1/messages` and Gemini adapters, seller-set pricing, Redis for rate
  limits, moderation hook.
* **Phase 3:** reputation and quality scoring of supply, attested
  self-hosted supply tier, organization accounts.
