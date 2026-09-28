# Token Relay: session handoff

Snapshot as of 2026-09-28. Start here when continuing the work in a new
session.

## Where things are

| What | Where |
|---|---|
| Code | GitHub `C-sirui/ChatGPT-disord-bot`, branch **`token-relay`**, folder `token-relay/` |
| Design + obstacles | `docs/DESIGN.md` (§3 obstacles O1–O12, §13 known limits L1–L7) |
| Decisions so far | `docs/DECISIONS.md`, with raw answers in `docs/questionnaire-answers.json` |
| Live questionnaire (claude.ai, private) | https://claude.ai/artifact/1cLDHNMqbBSPqo5qPwsugT. Answers are in its database, collection `answers`, docs `O1`…`O12`; read them with the ArtifactData tool (`list`, collection `answers`). |
| Static preview (GitHub Pages) | `/docs/index.html` at the repo root. To enable: Settings → Pages → branch `token-relay`, folder `/docs`. |
| Deploying | `docs/DEPLOY.md` (Fly.io + Postgres + Stripe), `docs/RASPBERRY_PI.md` (Pi 5 8 GB, measured sizing) |
| Debugging / dev build | `docs/DEBUGGING.md` |

## What it is

An OpenAI-compatible LLM relay and capacity marketplace:

* Buyers top up a balance and get a `trk_…` key to use in Cursor or VS Code.
* Sellers register capacity with an hourly token budget.
* The relay routes each request, meters it, and settles it through a
  double-entry ledger.

Stack: Node 22 + TypeScript (run by type stripping in dev, `tsc` build for
prod), Postgres in prod, SQLite in dev and tests. The only runtime dependency
is `pg`.

## State

* Phase 1 is done, with 34 tests passing on SQLite and Postgres:
  * streaming and non-streaming `/v1/chat/completions`, `/v1/models`
  * accounts and keys
  * Stripe Checkout top-ups
  * seller credentials (AES-GCM), capacity windows, failover, circuit breakers
  * ledger with holds, payouts recorded for admin approval
  * config validation with production safety rails
  * debug timelines and fault-injecting mock upstream
  * Docker, Fly and Pi compose files
* Supply: the `self_hosted` provider (seller attests they run the model
  server) routes without any agreement. `openai` and `openai_compatible` are
  gated behind `providers.<id>.resaleAcknowledged`.
* Load test (one x86 core, Postgres): about 120 short streams/s, about 250 MB
  RSS at 1,000 concurrent streams. Details in `docs/RASPBERRY_PI.md`.

## Standing decisions and constraints

* **Do not build support for reselling free or consumer-plan quotas** (Cursor,
  ChatGPT or Claude subscriptions, free API tiers) or anything that handles
  users' session credentials. It violates those providers' terms and gets
  sellers banned. The user asked about it (O1: "no legal bonds"). The agreed
  path is self-hosted supply. Keep the resale gate.
* Money is integer micro-USD. Every ledger transaction sums to 0.
  `/admin/reconcile` must stay green.
* The response ends only after settlement, so back-to-back requests see
  consistent balances. This matters on Postgres; see commit e20fda2.
* Production refuses unsafe config. Don't weaken `src/config/validate.ts`
  production rules.

## Questionnaire answers (O12 decided; the rest still leaning)

O1 self-hosted and more, no legal review → self-hosted only (see above) ·
O2 identity check before first payout · O3 disclosure · O4 bill estimate,
tokenizers later · O5 allow one-request overage · O6 several servers,
database budgets · O7 next adapters: Anthropic, Gemini, aggregators, local
runtimes · O8 global (advice: one region next to the database first) ·
O9 Stripe Connect, global · O10 usage policy + abuse reports · O11 dashboard
notice; "keep history context and switch model" · O12 **decided**: platform
sets prices.

## Suggested next steps (Phase 2)

1. Stripe Connect Express payouts plus identity gating before the first
   payout (O2, O9).
2. Anthropic Messages and Gemini adapters (O7). Map them to and from the
   OpenAI chat format in `src/relay/providers/`.
3. Abuse report endpoint and suspend flow (O10). Signup disclosure (O3).
4. Mid-stream failover to another seller (O11). Today failover happens only
   before the first byte.
5. Web dashboard for buyers and sellers.
6. For multi-region later: collapse hold + reserve and settle into single
   SQL round-trips (see DEPLOY.md, "About global regions").

## Commands

```bash
cd token-relay && npm install
npm run dev                  # offline dev stack; buyer key trk_dev_buyer_0000000000000000000000000000000
npm test                     # SQLite; TEST_DATABASE_URL=postgres://… npm test for Postgres
npm run typecheck && npm run build
npm run loadtest             # against a running relay
```
