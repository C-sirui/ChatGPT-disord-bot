# Obstacle questionnaire

For each obstacle in [DESIGN.md §3](DESIGN.md#3-obstacles-and-risks-read-this-first):

1. Tick an option (`[x]`). Options marked *(suggested)* are the recommended
   defaults.
2. Write your plan under **How would you solve it?**
3. Set the **Status**.

There is also an interactive version that saves answers automatically:
https://claude.ai/artifact/1cLDHNMqbBSPqo5qPwsugT (private until shared).

---

## O1 · Provider terms of service · EXISTENTIAL
Most providers forbid sharing or reselling access. Free and hourly quotas are
personal. Sellers risk bans; the platform risks legal claims.
*In the code today:* every provider is blocked until an operator sets
`resaleAcknowledged` after a legal review. Credentials are API keys only.

**Which supply will you launch with?** (pick any)
- [ ] Sellers' own self-hosted open models (vLLM / Ollama / TGI) *(suggested)*
- [ ] Providers with a signed reseller agreement
- [ ] Aggregators whose terms allow resale (verified in writing)
- [ ] Free or consumer-plan quotas (violates most terms)

**Legal review**
- [ ] Counsel reviews each provider before it is enabled *(suggested)*
- [ ] Launch self-hosted only, review providers later
- [ ] Not decided

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O2 · Stolen and leaked keys · HIGH
People can list leaked API keys. Buyers can use stolen cards.
*In the code today:* the same key can't be listed twice, keys are validated
on registration, and payouts wait a hold period.

**When do sellers verify their identity?**
- [ ] Before listing any key
- [ ] Before the first payout (Stripe Identity / Connect) *(suggested)*
- [ ] Not during a closed beta

**Payout hold period (days):** ____ (default 14)

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O3 · Prompt privacy · HIGH
Buyer code and prompts go through a stranger's account, where the seller can
see them. The operator can see them too.
*In the code today:* prompt logging is forced off in production.

**How will you protect buyers?** (pick any)
- [ ] Clear disclosure in buyer terms, shown at signup *(suggested)*
- [ ] Trusted-supply tier (vetted sellers only)
- [ ] Sensitive tier routes only to attested self-hosted supply
- [ ] Sellers must agree not to log or read prompts

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O4 · Metering accuracy · MEDIUM
Some responses arrive without a usage count. Tokenizers differ by model.
*In the code today:* when usage is missing, the relay estimates at 3
characters per token and flags the charge as an estimate.

**When the provider reports no usage**
- [ ] Bill the estimate, flagged *(suggested)*
- [ ] Bill the prompt only
- [ ] Don't bill; the platform absorbs it

**Real tokenizers per model**
- [ ] Add before launch
- [ ] Later; estimates are good enough for now *(suggested)*

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O5 · Money under concurrency · HIGH
Parallel streams race on one balance. Settlement can fail halfway through.
*In the code today:* atomic holds, one-transaction settlement, double-entry
ledger, a reaper for orphaned holds, and a reconcile check.

**When a request costs more than its hold**
- [ ] Charge it; the balance may go slightly negative once *(suggested; current behavior)*
- [ ] Cap max_tokens so the cost can never exceed the balance
- [ ] Require a minimum balance buffer

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O6 · Capacity across servers · MEDIUM
Hourly budgets must hold with many relay servers.
*In the code today:* budgets live in the database; rate limits and breakers
are per server.

**Launch topology**
- [ ] One server at launch
- [ ] Several servers, database-backed budgets only *(suggested)*
- [ ] Add Redis for shared rate limits and breakers

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O7 · Provider differences · MEDIUM
Error formats, rate-limit headers, streaming and tool calling differ.
*In the code today:* adapters for OpenAI, any OpenAI-compatible server, and
the fake provider.

**Which adapters come next?** (pick any)
- [ ] Anthropic Messages API
- [ ] Google Gemini
- [ ] Aggregators (OpenRouter-style)
- [ ] More self-hosted runtimes (TGI, LM Studio)

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O8 · Latency overhead · MEDIUM
Editors are latency-sensitive, especially for autocomplete.
*In the code today:* streaming passthrough with no buffering.

**Acceptable added latency at p99 (ms):** ____

**Hosting regions**
- [ ] One US region *(suggested)*
- [ ] US and EU
- [ ] Global edge

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O9 · Payments and payouts · HIGH
Paying individuals needs identity checks, tax forms and possibly
money-transmitter licensing.
*In the code today:* Stripe Checkout for top-ups; payouts are recorded and
approved by an admin, and no money moves yet.

**How do sellers get paid?**
- [ ] Stripe Connect Express *(suggested)*
- [ ] Manual transfers (PayPal, Wise)
- [ ] No cash: sellers earn usage credits only

**Where can sellers be paid?**
- [ ] US only at launch
- [ ] US and EU
- [ ] Wherever the payout provider supports

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O10 · Buyer abuse · HIGH
Buyers can send disallowed content through a seller's account, which gets
the seller banned.
*In the code today:* per-key rate limits, and usage records show which buyer
used which key.

**Content screening**
- [ ] Screen prompts with a moderation model before routing
- [ ] Self-hosted guard model (e.g. Llama Guard)
- [ ] Usage policy plus abuse reports; suspend on violation *(suggested)*
- [ ] None for now

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O11 · Seller key revoked mid-flight · LOW
A seller can rotate or revoke a key at any time.
*In the code today:* an unauthorized response marks the key invalid and the
request moves to another seller.

**How are sellers told?** (pick any)
- [ ] Email
- [ ] Dashboard notice *(suggested)*
- [ ] Webhook to the seller's endpoint

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided

---

## O12 · Pricing model · MEDIUM
Sellers' costs differ, and buyers want predictable prices.
*In the code today:* the platform sets a buyer price per model; sellers earn
the price minus a 20% take rate.

**Who sets prices?**
- [ ] The platform, per model *(suggested; current behavior)*
- [ ] Sellers set asks; cheapest capacity wins
- [ ] Platform price with seller discounts

**Take rate (%):** ____ (default 20)

**How would you solve it?**

> 

**Status:** Undecided / Needs research / Decided
