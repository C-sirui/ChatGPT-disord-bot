import type { Deps } from '../deps.ts';
import { iso } from '../deps.ts';
import { newId, newToken, sha256hex } from '../lib/crypto.ts';
import { badRequest, notFound } from '../lib/errors.ts';

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  status: string;
  last_used_at: string | null;
  created_at: string;
}

export const MAX_KEYS_PER_USER = 25;

export async function createApiKey(d: Deps, userId: string, name: string, presetKey?: string): Promise<{ key: string; row: ApiKeyRow }> {
  const count = await d.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = $1 AND status = 'active'", [userId]);
  if ((count?.n ?? 0) >= MAX_KEYS_PER_USER) throw badRequest(`At most ${MAX_KEYS_PER_USER} active keys per account`);
  const key = presetKey ?? newToken('trk');
  const row: ApiKeyRow = {
    id: newId('key'),
    user_id: userId,
    name,
    prefix: key.slice(0, 10),
    status: 'active',
    last_used_at: null,
    created_at: iso(d.now()),
  };
  await d.db.exec('INSERT INTO api_keys (id, user_id, name, prefix, key_hash, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    row.id, userId, name, row.prefix, sha256hex(key), 'active', row.created_at,
  ]);
  return { key, row };
}

export async function listApiKeys(d: Deps, userId: string): Promise<ApiKeyRow[]> {
  return d.db.query<ApiKeyRow>(
    'SELECT id, user_id, name, prefix, status, last_used_at, created_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC',
    [userId],
  );
}

export async function revokeApiKey(d: Deps, userId: string, keyId: string): Promise<void> {
  const n = await d.db.exec("UPDATE api_keys SET status = 'revoked' WHERE id = $1 AND user_id = $2 AND status = 'active'", [keyId, userId]);
  if (n === 0) throw notFound('API key not found');
}

export interface KeyPrincipal {
  keyId: string;
  userId: string;
  role: string;
}

const lastUsedWrites = new Map<string, number>();

export async function authenticateApiKey(d: Deps, key: string): Promise<KeyPrincipal | undefined> {
  if (!key.startsWith('trk_')) return undefined;
  const row = await d.db.one<{ id: string; user_id: string; role: string }>(
    `SELECT k.id, k.user_id, u.role FROM api_keys k JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.status = 'active' AND u.status = 'active'`,
    [sha256hex(key)],
  );
  if (!row) return undefined;
  // Throttle last_used_at writes to once a minute per key to keep the hot path cheap.
  const nowMs = d.now().getTime();
  if ((lastUsedWrites.get(row.id) ?? 0) < nowMs - 60_000) {
    lastUsedWrites.set(row.id, nowMs);
    await d.db.exec('UPDATE api_keys SET last_used_at = $1 WHERE id = $2', [iso(d.now()), row.id]);
  }
  return { keyId: row.id, userId: row.user_id, role: row.role };
}
