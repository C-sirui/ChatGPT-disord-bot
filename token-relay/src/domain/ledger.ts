import type { Db } from '../db/types.ts';
import { newId } from '../lib/crypto.ts';
import { ApiError } from '../lib/errors.ts';

export const acct = {
  available: (userId: string) => `user:${userId}:available`,
  earnings: (userId: string) => `user:${userId}:earnings`,
  revenue: 'platform:revenue',
  clearing: 'platform:clearing',
};

export type TxnKind = 'topup' | 'usage' | 'payout' | 'payout_reversal' | 'adjustment';

export interface Entry {
  account: string;
  amount: number;
}

/**
 * Posts a balanced double-entry transaction. (kind, ref) is unique, so
 * posting the same business event twice is a no-op that returns false —
 * this is what makes webhook retries and settlement retries idempotent.
 * Must be called inside a transaction together with the wallet updates.
 */
export async function postTxn(tx: Db, kind: TxnKind, ref: string, entries: Entry[], memo: string | null, at: string): Promise<boolean> {
  const nonZero = entries.filter((e) => e.amount !== 0);
  const sum = nonZero.reduce((s, e) => s + e.amount, 0);
  if (sum !== 0) throw new ApiError(500, 'ledger_unbalanced', `ledger txn ${kind}:${ref} does not balance (${sum})`);
  if (nonZero.some((e) => !Number.isSafeInteger(e.amount))) throw new ApiError(500, 'ledger_non_integer', 'ledger amounts must be integers');
  const existing = await tx.one('SELECT id FROM ledger_txns WHERE kind = $1 AND ref = $2', [kind, ref]);
  if (existing) return false;
  const txnId = newId('txn');
  await tx.exec('INSERT INTO ledger_txns (id, kind, ref, memo, created_at) VALUES ($1,$2,$3,$4,$5)', [txnId, kind, ref, memo, at]);
  for (const e of nonZero) {
    await tx.exec('INSERT INTO ledger_entries (id, txn_id, account, amount_micros, created_at) VALUES ($1,$2,$3,$4,$5)', [
      newId('le'), txnId, e.account, e.amount, at,
    ]);
  }
  return true;
}

export async function accountBalance(db: Db, account: string): Promise<number> {
  const r = await db.one<{ s: number | null }>('SELECT SUM(amount_micros) AS s FROM ledger_entries WHERE account = $1', [account]);
  return Number(r?.s ?? 0);
}

export interface ReconcileReport {
  ok: boolean;
  unbalancedTxns: string[];
  walletMismatches: { userId: string; field: string; wallet: number; ledger: number }[];
  totals: Record<string, number>;
}

/** Verifies ledger invariants and that cached wallet balances match ledger sums. */
export async function reconcile(db: Db): Promise<ReconcileReport> {
  const unbalanced = await db.query<{ txn_id: string }>(
    'SELECT txn_id FROM ledger_entries GROUP BY txn_id HAVING SUM(amount_micros) <> 0',
  );
  const sums = await db.query<{ account: string; s: number }>('SELECT account, SUM(amount_micros) AS s FROM ledger_entries GROUP BY account');
  const byAccount = new Map(sums.map((r) => [r.account, Number(r.s)]));
  const wallets = await db.query<{ user_id: string; available_micros: number; held_micros: number; earned_micros: number }>('SELECT * FROM wallets');
  const mismatches: ReconcileReport['walletMismatches'] = [];
  for (const w of wallets) {
    const avail = byAccount.get(acct.available(w.user_id)) ?? 0;
    // Holds are reservations on the cached wallet only; the ledger sees money when it settles.
    if (avail !== Number(w.available_micros) + Number(w.held_micros)) {
      mismatches.push({ userId: w.user_id, field: 'available+held', wallet: Number(w.available_micros) + Number(w.held_micros), ledger: avail });
    }
    const earn = byAccount.get(acct.earnings(w.user_id)) ?? 0;
    if (earn !== Number(w.earned_micros)) mismatches.push({ userId: w.user_id, field: 'earned', wallet: Number(w.earned_micros), ledger: earn });
  }
  const totals: Record<string, number> = {
    revenue: byAccount.get(acct.revenue) ?? 0,
    clearing: byAccount.get(acct.clearing) ?? 0,
    grand: [...byAccount.values()].reduce((a, b) => a + b, 0),
  };
  return {
    ok: unbalanced.length === 0 && mismatches.length === 0 && totals.grand === 0,
    unbalancedTxns: unbalanced.map((r) => r.txn_id),
    walletMismatches: mismatches,
    totals,
  };
}
