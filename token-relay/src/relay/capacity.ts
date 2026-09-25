import type { Deps } from '../deps.ts';
import { iso } from '../deps.ts';

/** Hour bucket start, e.g. 2026-09-25T13:00:00.000Z. */
export function windowStart(d: Date): string {
  const w = new Date(d);
  w.setUTCMinutes(0, 0, 0);
  return iso(w);
}

export interface Reservation {
  requestId: string;
  credentialId: string;
  window: string;
  tokens: number;
}

/**
 * Atomically reserve `tokens` of a credential's hourly budget and one
 * concurrency slot. Concurrency counts in-flight requests in the current and
 * previous window so that long streams spanning an hour boundary still count.
 */
export async function reserveCapacity(
  d: Deps,
  requestId: string,
  cred: { id: string; hourly_token_limit: number; max_concurrency: number },
  tokens: number,
): Promise<Reservation | undefined> {
  const now = d.now();
  const window = windowStart(now);
  const prevWindow = windowStart(new Date(now.getTime() - 3600_000));
  return d.db.tx(async (tx) => {
    await tx.exec('INSERT INTO credential_windows (credential_id, window_start) VALUES ($1, $2) ON CONFLICT DO NOTHING', [cred.id, window]);
    const n = await tx.exec(
      `UPDATE credential_windows
          SET reserved_tokens = reserved_tokens + $3, in_flight = in_flight + 1
        WHERE credential_id = $1 AND window_start = $2
          AND used_tokens + reserved_tokens + $3 <= $4
          AND (SELECT COALESCE(SUM(w2.in_flight), 0) FROM credential_windows w2
                WHERE w2.credential_id = $1 AND w2.window_start >= $6) < $5`,
      [cred.id, window, tokens, cred.hourly_token_limit, cred.max_concurrency, prevWindow],
    );
    if (n === 0) return undefined;
    await tx.exec(
      'INSERT INTO capacity_reservations (request_id, credential_id, window_start, tokens, created_at) VALUES ($1,$2,$3,$4,$5)',
      [requestId, cred.id, window, tokens, iso(now)],
    );
    return { requestId, credentialId: cred.id, window, tokens };
  });
}

/**
 * Finish a reservation. `usedTokens` = 0 releases it entirely (failover / error before output).
 * Idempotent: the reservation row is the guard.
 */
export async function commitCapacity(d: Deps, r: Reservation, usedTokens: number): Promise<void> {
  await d.db.tx(async (tx) => {
    const n = await tx.exec('DELETE FROM capacity_reservations WHERE request_id = $1 AND credential_id = $2', [r.requestId, r.credentialId]);
    if (n === 0) return;
    await tx.exec(
      `UPDATE credential_windows
          SET reserved_tokens = reserved_tokens - $3, used_tokens = used_tokens + $4, in_flight = in_flight - 1
        WHERE credential_id = $1 AND window_start = $2`,
      [r.credentialId, r.window, r.tokens, usedTokens],
    );
  });
}

/** Releases reservations orphaned by crashed replicas. */
export async function reapReservations(d: Deps, ttlMs: number): Promise<number> {
  const cutoff = iso(new Date(d.now().getTime() - ttlMs));
  const stale = await d.db.query<{ request_id: string; credential_id: string; window_start: string; tokens: number }>(
    'SELECT request_id, credential_id, window_start, tokens FROM capacity_reservations WHERE created_at < $1 LIMIT 500',
    [cutoff],
  );
  for (const s of stale) {
    await commitCapacity(d, { requestId: s.request_id, credentialId: s.credential_id, window: s.window_start, tokens: Number(s.tokens) }, 0);
  }
  return stale.length;
}

export interface WindowState {
  credential_id: string;
  window_start: string;
  used_tokens: number;
  reserved_tokens: number;
  in_flight: number;
}

export async function currentWindows(d: Deps): Promise<WindowState[]> {
  return d.db.query<WindowState>('SELECT * FROM credential_windows WHERE window_start = $1', [windowStart(d.now())]);
}
