import type { Deps } from '../deps.ts';
import { iso } from '../deps.ts';
import type { ModelConfig } from '../config/types.ts';
import { ApiError } from '../lib/errors.ts';
import { acct, postTxn } from './ledger.ts';
import { costMicros, split } from './money.ts';

export interface Wallet {
  user_id: string;
  available_micros: number;
  held_micros: number;
  earned_micros: number;
}

export async function getWallet(d: Deps, userId: string): Promise<Wallet> {
  const w = await d.db.one<Wallet>('SELECT user_id, available_micros, held_micros, earned_micros FROM wallets WHERE user_id = $1', [userId]);
  if (!w) throw new ApiError(500, 'wallet_missing', 'wallet not found');
  return w;
}

/** Atomically reserve funds for an in-flight request. Returns false when funds are insufficient. */
export async function placeHold(d: Deps, userId: string, requestId: string, amount: number): Promise<boolean> {
  const now = iso(d.now());
  return d.db.tx(async (tx) => {
    const n = await tx.exec(
      'UPDATE wallets SET available_micros = available_micros - $1, held_micros = held_micros + $1, updated_at = $3 WHERE user_id = $2 AND available_micros >= $1',
      [amount, userId, now],
    );
    if (n === 0) return false;
    await tx.exec("INSERT INTO holds (request_id, user_id, amount_micros, status, created_at) VALUES ($1,$2,$3,'open',$4)", [requestId, userId, amount, now]);
    return true;
  });
}

/** Release an open hold without charging (request failed before any billable output). Idempotent. */
export async function releaseHold(d: Deps, requestId: string): Promise<boolean> {
  const now = iso(d.now());
  return d.db.tx(async (tx) => {
    const hold = await tx.one<{ user_id: string; amount_micros: number }>(
      "SELECT user_id, amount_micros FROM holds WHERE request_id = $1 AND status = 'open'",
      [requestId],
    );
    if (!hold) return false;
    await tx.exec("UPDATE holds SET status = 'released', closed_at = $2 WHERE request_id = $1 AND status = 'open'", [requestId, now]);
    await tx.exec(
      'UPDATE wallets SET available_micros = available_micros + $1, held_micros = held_micros - $1, updated_at = $3 WHERE user_id = $2',
      [hold.amount_micros, hold.user_id, now],
    );
    return true;
  });
}

export interface SettleInput {
  requestId: string;
  buyerId: string;
  sellerId: string;
  credentialId: string;
  model: ModelConfig;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
}

export interface SettleResult {
  cost: number;
  sellerCredit: number;
  platformFee: number;
  duplicate: boolean;
}

/**
 * Converts the hold into a charge in one transaction: closes the hold,
 * debits the buyer's actual cost (may exceed the hold — bounded overage),
 * credits seller earnings and platform revenue, and records the usage event.
 * Idempotent per request id.
 */
export async function settleUsage(d: Deps, s: SettleInput): Promise<SettleResult> {
  const cost = costMicros(s.model, s.promptTokens, s.completionTokens);
  const { seller, platform } = split(cost, d.cfg.pricing.takeRate);
  const now = iso(d.now());
  return d.db.tx(async (tx) => {
    const posted = await postTxn(
      tx,
      'usage',
      s.requestId,
      [
        { account: acct.available(s.buyerId), amount: -cost },
        { account: acct.earnings(s.sellerId), amount: seller },
        { account: acct.revenue, amount: platform },
      ],
      `${s.model.id} ${s.promptTokens}+${s.completionTokens} tok`,
      now,
    );
    if (!posted) return { cost, sellerCredit: seller, platformFee: platform, duplicate: true };

    const hold = await tx.one<{ amount_micros: number }>("SELECT amount_micros FROM holds WHERE request_id = $1 AND status = 'open'", [s.requestId]);
    const held = hold ? Number(hold.amount_micros) : 0;
    if (hold) await tx.exec("UPDATE holds SET status = 'settled', closed_at = $2 WHERE request_id = $1", [s.requestId, now]);
    await tx.exec(
      'UPDATE wallets SET available_micros = available_micros + $1 - $2, held_micros = held_micros - $1, updated_at = $4 WHERE user_id = $3',
      [held, cost, s.buyerId, now],
    );
    await tx.exec('UPDATE wallets SET earned_micros = earned_micros + $1, updated_at = $3 WHERE user_id = $2', [seller, s.sellerId, now]);
    await tx.exec(
      `INSERT INTO usage_events (request_id, buyer_id, seller_id, credential_id, model, prompt_tokens, completion_tokens, estimated,
         buyer_cost_micros, seller_credit_micros, platform_fee_micros, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [s.requestId, s.buyerId, s.sellerId, s.credentialId, s.model.id, s.promptTokens, s.completionTokens, s.estimated ? 1 : 0, cost, seller, platform, now],
    );
    return { cost, sellerCredit: seller, platformFee: platform, duplicate: false };
  });
}

/** Credits a confirmed payment. Idempotent on the payment id. */
export async function creditTopup(d: Deps, userId: string, paymentRef: string, amount: number, memo: string): Promise<boolean> {
  const now = iso(d.now());
  return d.db.tx(async (tx) => {
    const posted = await postTxn(tx, 'topup', paymentRef, [
      { account: acct.clearing, amount: -amount },
      { account: acct.available(userId), amount },
    ], memo, now);
    if (!posted) return false;
    await tx.exec('UPDATE wallets SET available_micros = available_micros + $1, updated_at = $3 WHERE user_id = $2', [amount, userId, now]);
    return true;
  });
}

/** Releases holds older than the TTL — e.g. left behind by a crashed replica. */
export async function reapHolds(d: Deps): Promise<number> {
  const cutoff = iso(new Date(d.now().getTime() - d.cfg.relay.holdTtlMs));
  const stale = await d.db.query<{ request_id: string }>("SELECT request_id FROM holds WHERE status = 'open' AND created_at < $1 LIMIT 500", [cutoff]);
  let n = 0;
  for (const h of stale) if (await releaseHold(d, h.request_id)) n++;
  return n;
}
