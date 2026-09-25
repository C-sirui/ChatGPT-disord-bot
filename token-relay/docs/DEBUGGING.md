# Debugging Token Relay

## Dev build in one command

```bash
cd token-relay
npm install
npm run dev          # --watch reload, SQLite at .data/dev.sqlite, in-process mock upstream, seeded users
```

The dev seed creates these accounts. The password for all of them is
`devpass`.

| Account | Purpose |
|---|---|
| `admin@relay.dev` | admin role |
| `buyer@relay.dev` | $25 balance, relay key `trk_dev_buyer_0000000000000000000000000000000` |
| `seller@relay.dev` | one `mock` credential with a 1M token/hour budget |

To start from a clean database, run `rm -rf .data` and restart.

To attach Chrome DevTools or the VS Code debugger, run `npm run dev:debug`
(`--inspect` on port 9229).

## Point an editor at your dev relay

* Base URL: `http://localhost:8787/v1`
* API key: `trk_dev_buyer_0000000000000000000000000000000`
* Model: `mock-fast`

## Request timelines

Every relay request records a timeline:

```
auth.ok@0, request.parsed@0.2, hold.placed@1.3, route.candidates@1.6,
capacity.reserved@2.2, upstream.response@25.5, stream.first_byte@26.4,
usage.captured@44.7, settle.ok@46
```

You can see it in four places:

* **Response header**: `x-relay-debug`, when `debug.timelineHeader` is on.
  It covers the timeline up to the moment the headers were sent.
* **Logs**: one `relay request` line per request. At `debug` level every step
  is also logged as `relay: <event>`. All lines carry `requestId`.
* **`GET /debug/requests`**: recent requests. Filter with `?userId=`,
  `?outcome=error|rejected|ok|client_aborted|upstream_broken` or `?limit=`.
* **`GET /debug/requests/:id`**: the full timeline with event data, plus the
  database `requests` row and the `usage_events` row.

To follow one request end to end, send your own id:
`curl -H 'x-request-id: my-trace-123' …`. The id is echoed back and appears in
every log line.

## Other debug endpoints

| Endpoint | Shows |
|---|---|
| `/debug/config` | effective config (secrets redacted) and the **source of every value** (default.json / development.json / env var) |
| `/debug/router` | credentials, current-hour capacity windows (used/reserved/in-flight), circuit-breaker state, available models |
| `/debug/ledger/:userId` | wallet, ledger entries, holds |
| `/admin/reconcile` | ledger invariants: every txn sums to 0, and cached wallets match the ledger |
| `/metrics` | Prometheus metrics |

In dev, debug endpoints are open to localhost
(`debug.allowLocalhostWithoutToken`). Otherwise send
`x-admin-token: <security.adminToken>`. When `debug.enabled=false` they
return 404.

## Fault injection (mock upstream)

Send a header on the relay request. The relay forwards `x-mock-*` headers to
the mock provider only.

| `x-mock-fault` | Effect |
|---|---|
| `429` | upstream rate limit: credential cooldown, then failover |
| `500` / `503` | retryable: breaker failure count, then failover |
| `401` | credential marked `invalid`, then failover |
| `400` | passed through to the client; no failover and no charge |
| `hang` | never responds; exercises `relay.upstreamConnectTimeoutMs` |
| `drop` | stream cut halfway: `upstream_interrupted` SSE error, partial estimated billing |
| `no-usage` | upstream omits `usage`: estimated billing, `usage_events.estimated=1` |

For random faults use `TR_DEV__MOCK_UPSTREAM__FAULT_RATE=0.2` and
`TR_DEV__MOCK_UPSTREAM__FAULT_STATUS=503`. Seller credentials whose secret
starts with `mock-fail-<status>` always fail with that status. This is useful
for testing failover between several credentials.

The mock also runs standalone: `npm run mock-upstream` (PORT=9797).

## Configuration cheatsheet

```bash
npm run print-config -- --sources               # effective config + where each value came from
TR_ENV=production node src/cli.ts check-config  # prove a prod config is valid before deploying
TR_LOG__LEVEL=trace npm run dev                 # also logs every SQL statement
TR_LOG__FORMAT=json npm run dev                 # prod-style logs locally
TR_DB__SQLITE_PATH=:memory: npm run dev         # throwaway database
TR_CONFIG_FILE=./my-local.json npm run dev      # personal overrides file (gitignored if you like)
```

## Running tests

```bash
npm test                                   # SQLite, fast
TEST_DATABASE_URL=postgres://… npm test    # same suites on Postgres (tables are truncated)
TEST_LOG_LEVEL=debug npm test              # show app logs during tests
```
