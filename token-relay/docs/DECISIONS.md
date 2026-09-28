# Decisions from the obstacle questionnaire (2026-09-25)

These answers come from the
[interactive questionnaire](https://claude.ai/artifact/1cLDHNMqbBSPqo5qPwsugT).
Every item is still marked *Undecided* there. The table records your current
leaning and what it means for the code.

| # | Your answer | Effect on the code |
|---|---|---|
| O1 Terms of service | All supply types, including free and consumer quotas; plan: "no legal bonds" | See the O1 note below. **Added a `self_hosted` provider**: sellers attest they run the model server themselves, so no third-party terms or agreements are involved. It routes out of the box. Commercial providers stay gated. |
| O2 Stolen keys | Identity check before the first payout | Fits Stripe Connect onboarding (O9). Hold period stays at the default of 14 days. |
| O3 Privacy | Disclosure in buyer terms | A signup disclosure is needed when the dashboard is built (Phase 2). |
| O4 Metering | Bill the estimate, flagged; tokenizers later | Already the behavior. |
| O5 Overage | Allow one-request overage | Already the behavior. |
| O6 Topology | Several servers, database-backed budgets | Already supported. `fly.toml` runs 2 machines. |
| O7 Adapters | Anthropic, Gemini, aggregators, more local runtimes | Phase 2 backlog, in that order. |
| O8 Regions | Global | Start in one region next to the database; see DEPLOY.md, "About global regions". |
| O9 Payouts | Stripe Connect Express, global | Phase 2. Stripe Connect covers about 45 countries, which is "global" in practice. |
| O10 Abuse | Usage policy plus abuse reports | A report endpoint and suspend flow are needed; admin suspend already exists. |
| O11 Revoked key | Dashboard notice; "keep the history context and switch model" | Editors resend the full conversation on every request, so failover before the first token already keeps context. Continuing a stream on another seller *mid-answer* is on the Phase 2 backlog. |
| O12 Pricing | Platform sets prices (**decided**) | Already the behavior. |

## O1 note

Reselling free or consumer-plan quotas cannot be done without legal ties.
Examples are Cursor free usage, ChatGPT or Claude subscriptions, and free API
tiers. Those plans are personal, their terms forbid sharing and resale, and
routing strangers' traffic through them gets the sellers' accounts banned.
Doing it would also mean handling people's session credentials. Token Relay
therefore **does not support consumer or free-tier quotas**, and the resale
gate stays in place.

The path that matches "no legal bonds" is **self-hosted supply**. Sellers
run open-weight models (Llama, Qwen, DeepSeek, Mistral) on their own GPUs or
rented GPUs and sell that capacity. No provider terms apply, so no agreements
are needed. This is now the default route.

Any provider whose terms explicitly allow resale (a reseller program) can be
enabled per provider later, once the agreement exists.
