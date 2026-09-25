import type { Deps } from '../deps.ts';
import { iso } from '../deps.ts';
import { newId } from '../lib/crypto.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import type { PaymentEvent, PaymentProvider } from '../payments/index.ts';
import { acct, postTxn } from './ledger.ts';
import { usdToMicros } from './money.ts';
import { creditTopup, getWallet } from './wallet.ts';
import type { User } from './users.ts';

export async function startCheckout(d: Deps, payments: PaymentProvider, user: User, amountUsd: number) {
  const { minTopupUsd, maxTopupUsd } = d.cfg.payments;
  if (!(amountUsd >= minTopupUsd && amountUsd <= maxTopupUsd)) {
    throw badRequest(`amountUsd must be between ${minTopupUsd} and ${maxTopupUsd}`, 'amountUsd');
  }
  const amountMicros = usdToMicros(Math.round(amountUsd * 100) / 100);
  const paymentId = newId('pay');
  const now = iso(d.now());
  await d.db.exec(
    "INSERT INTO payments (id, user_id, provider, amount_micros, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'pending',$5,$5)",
    [paymentId, user.id, payments.id, amountMicros, now],
  );
  const result = await payments.createCheckout({ paymentId, userId: user.id, email: user.email, amountMicros });
  await d.db.exec('UPDATE payments SET external_id = $1, updated_at = $2 WHERE id = $3', [result.externalId, iso(d.now()), paymentId]);
  if (result.settled) await applyPaymentEvent(d, { type: 'payment_succeeded', paymentId, externalId: result.externalId, amountMicros });
  return { paymentId, checkoutUrl: result.url ?? null, status: result.settled ? 'succeeded' : 'pending', amountMicros };
}

/** Idempotent: repeated webhook deliveries credit exactly once (ledger (kind, ref) uniqueness). */
export async function applyPaymentEvent(d: Deps, ev: PaymentEvent): Promise<void> {
  const payment = await d.db.one<{ id: string; user_id: string; amount_micros: number; status: string }>('SELECT * FROM payments WHERE id = $1', [ev.paymentId]);
  if (!payment) {
    d.log.warn('payment event for unknown payment', { paymentId: ev.paymentId });
    return;
  }
  if (ev.type === 'payment_failed') {
    await d.db.exec("UPDATE payments SET status = 'failed', updated_at = $1 WHERE id = $2 AND status = 'pending'", [iso(d.now()), payment.id]);
    return;
  }
  // Trust our recorded amount, but flag a mismatch loudly.
  if (ev.amountMicros !== undefined && ev.amountMicros !== Number(payment.amount_micros)) {
    d.log.error('payment amount mismatch', { paymentId: payment.id, expected: payment.amount_micros, got: ev.amountMicros });
    throw new ApiError(409, 'amount_mismatch', 'Payment amount mismatch');
  }
  const credited = await creditTopup(d, payment.user_id, payment.id, Number(payment.amount_micros), `topup ${payment.id}`);
  await d.db.exec("UPDATE payments SET status = 'succeeded', updated_at = $1 WHERE id = $2", [iso(d.now()), payment.id]);
  d.log.info(credited ? 'topup credited' : 'topup already credited', { paymentId: payment.id, userId: payment.user_id });
}

// ---------------- payouts ----------------

/** Earnings younger than the hold period are not yet withdrawable (chargeback / dispute buffer). */
export async function withdrawable(d: Deps, sellerId: string): Promise<{ earned: number; pending: number; withdrawable: number }> {
  const w = await getWallet(d, sellerId);
  const cutoff = iso(new Date(d.now().getTime() - d.cfg.payouts.holdDays * 86_400_000));
  const recent = await d.db.one<{ s: number | null }>(
    'SELECT SUM(seller_credit_micros) AS s FROM usage_events WHERE seller_id = $1 AND created_at > $2',
    [sellerId, cutoff],
  );
  const earned = Number(w.earned_micros);
  const pending = Math.min(earned, Number(recent?.s ?? 0));
  return { earned, pending, withdrawable: Math.max(0, earned - pending) };
}

export async function requestPayout(d: Deps, sellerId: string, amountUsd: number) {
  if (amountUsd < d.cfg.payouts.minUsd) throw badRequest(`Minimum payout is $${d.cfg.payouts.minUsd}`, 'amountUsd');
  const amount = usdToMicros(amountUsd);
  const { withdrawable: avail } = await withdrawable(d, sellerId);
  if (amount > avail) throw new ApiError(402, 'insufficient_earnings', 'Amount exceeds withdrawable earnings');
  const id = newId('po');
  const now = iso(d.now());
  await d.db.tx(async (tx) => {
    const n = await tx.exec('UPDATE wallets SET earned_micros = earned_micros - $1, updated_at = $3 WHERE user_id = $2 AND earned_micros >= $1', [amount, sellerId, now]);
    if (n === 0) throw new ApiError(402, 'insufficient_earnings', 'Amount exceeds withdrawable earnings');
    await postTxn(tx, 'payout', id, [
      { account: acct.earnings(sellerId), amount: -amount },
      { account: acct.clearing, amount },
    ], 'payout requested', now);
    await tx.exec("INSERT INTO payouts (id, seller_id, amount_micros, status, created_at, updated_at) VALUES ($1,$2,$3,'requested',$4,$4)", [id, sellerId, amount, now]);
  });
  return { id, amountMicros: amount, status: 'requested' };
}

export async function resolvePayout(d: Deps, id: string, action: 'paid' | 'rejected', note?: string) {
  const now = iso(d.now());
  return d.db.tx(async (tx) => {
    const p = await tx.one<{ seller_id: string; amount_micros: number; status: string }>('SELECT * FROM payouts WHERE id = $1', [id]);
    if (!p) throw new ApiError(404, 'not_found', 'Payout not found');
    if (p.status !== 'requested') throw new ApiError(409, 'conflict', `Payout already ${p.status}`);
    if (action === 'rejected') {
      await postTxn(tx, 'payout_reversal', id, [
        { account: acct.clearing, amount: -Number(p.amount_micros) },
        { account: acct.earnings(p.seller_id), amount: Number(p.amount_micros) },
      ], note ?? 'payout rejected', now);
      await tx.exec('UPDATE wallets SET earned_micros = earned_micros + $1, updated_at = $3 WHERE user_id = $2', [p.amount_micros, p.seller_id, now]);
    }
    await tx.exec('UPDATE payouts SET status = $1, note = $2, updated_at = $3 WHERE id = $4', [action, note ?? null, now, id]);
    return { id, status: action };
  });
}

/** Admin balance adjustment (support credits / corrections). Idempotent on `ref`. */
export async function adjustBalance(d: Deps, userId: string, amountMicros: number, ref: string, memo: string) {
  const now = iso(d.now());
  return d.db.tx(async (tx) => {
    const posted = await postTxn(tx, 'adjustment', ref, [
      { account: acct.clearing, amount: -amountMicros },
      { account: acct.available(userId), amount: amountMicros },
    ], memo, now);
    if (posted) await tx.exec('UPDATE wallets SET available_micros = available_micros + $1, updated_at = $3 WHERE user_id = $2', [amountMicros, userId, now]);
    return posted;
  });
}
