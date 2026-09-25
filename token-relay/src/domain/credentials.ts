import type { Deps } from '../deps.ts';
import { iso } from '../deps.ts';
import { maskSecret, newId, sha256hex } from '../lib/crypto.ts';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { assertPublicHttpsUrl } from '../lib/netguard.ts';
import { getAdapter } from '../relay/providers/index.ts';

export type CredentialStatus = 'active' | 'paused' | 'invalid' | 'disabled';

export interface CredentialRow {
  id: string;
  seller_id: string;
  provider: string;
  label: string;
  base_url: string | null;
  secret_ciphertext: string;
  secret_mask: string;
  fingerprint: string;
  models: string;
  hourly_token_limit: number;
  max_concurrency: number;
  status: CredentialStatus;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type PublicCredential = Omit<CredentialRow, 'secret_ciphertext' | 'fingerprint' | 'models'> & { models: string[] };

export const toPublic = (r: CredentialRow): PublicCredential => {
  const { secret_ciphertext: _c, fingerprint: _f, models, ...rest } = r;
  return { ...rest, models: JSON.parse(models) as string[] };
};

/** AAD binds ciphertext to its row, so swapping ciphertexts between rows fails to decrypt. */
const aad = (id: string) => `credential:${id}`;

export interface CreateCredentialInput {
  provider: string;
  label?: string;
  apiKey: string;
  baseUrl?: string;
  models?: string[];
  hourlyTokenLimit: number;
  maxConcurrency?: number;
}

export async function createCredential(d: Deps, sellerId: string, input: CreateCredentialInput): Promise<PublicCredential> {
  const providerCfg = d.cfg.providers[input.provider];
  const adapter = getAdapter(input.provider);
  if (!providerCfg || !adapter || !providerCfg.enabled) throw badRequest(`Provider "${input.provider}" is not supported`, 'provider');
  if (adapter.resalePolicy === 'prohibited') {
    throw new ApiError(422, 'provider_resale_prohibited', `Provider "${input.provider}" does not permit capacity resale`);
  }
  const catalog = d.cfg.models.filter((m) => m.provider === input.provider).map((m) => m.id);
  const models = input.models ?? catalog;
  if (models.length === 0) throw badRequest('No catalog models for this provider', 'models');
  for (const m of models) if (!catalog.includes(m)) throw badRequest(`Model "${m}" is not offered for provider ${input.provider}`, 'models');

  let baseUrl: string | null = null;
  if (adapter.requiresBaseUrl) {
    if (!input.baseUrl) throw badRequest('baseUrl is required for this provider', 'baseUrl');
    baseUrl = (await assertPublicHttpsUrl(input.baseUrl, d.cfg.credentials.allowPrivateBaseUrls)).toString().replace(/\/$/, '');
  }

  // Same secret may only be listed once platform-wide (prevents double-selling a key).
  const fingerprint = sha256hex(`${input.provider}\n${baseUrl ?? ''}\n${input.apiKey}`);
  if (await d.db.one('SELECT id FROM credentials WHERE fingerprint = $1', [fingerprint])) throw conflict('This credential is already registered');

  if (d.cfg.credentials.validateOnCreate) {
    const res = await adapter.validate({ cfg: d.cfg, secret: input.apiKey, baseUrl });
    if (!res.ok) throw new ApiError(422, 'credential_invalid', `Upstream rejected the credential: ${res.detail ?? 'unknown error'}`);
  }

  const id = newId('crd');
  const now = iso(d.now());
  const row: CredentialRow = {
    id,
    seller_id: sellerId,
    provider: input.provider,
    label: input.label ?? `${input.provider} key`,
    base_url: baseUrl,
    secret_ciphertext: d.vault.encrypt(input.apiKey, aad(id)),
    secret_mask: maskSecret(input.apiKey),
    fingerprint,
    models: JSON.stringify(models),
    hourly_token_limit: input.hourlyTokenLimit,
    max_concurrency: input.maxConcurrency ?? 4,
    status: 'active',
    status_reason: null,
    created_at: now,
    updated_at: now,
  };
  await d.db.exec(
    `INSERT INTO credentials (id, seller_id, provider, label, base_url, secret_ciphertext, secret_mask, fingerprint, models,
       hourly_token_limit, max_concurrency, status, status_reason, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [row.id, row.seller_id, row.provider, row.label, row.base_url, row.secret_ciphertext, row.secret_mask, row.fingerprint, row.models,
      row.hourly_token_limit, row.max_concurrency, row.status, row.status_reason, row.created_at, row.updated_at],
  );
  d.log.info('credential registered', { credentialId: id, sellerId, provider: input.provider });
  return toPublic(row);
}

export async function listCredentials(d: Deps, sellerId: string): Promise<PublicCredential[]> {
  const rows = await d.db.query<CredentialRow>("SELECT * FROM credentials WHERE seller_id = $1 AND status <> 'disabled' ORDER BY created_at DESC", [sellerId]);
  return rows.map(toPublic);
}

export async function getCredential(d: Deps, id: string): Promise<CredentialRow | undefined> {
  return d.db.one<CredentialRow>('SELECT * FROM credentials WHERE id = $1', [id]);
}

export async function updateCredential(
  d: Deps,
  sellerId: string,
  id: string,
  patch: { status?: 'active' | 'paused'; hourlyTokenLimit?: number; maxConcurrency?: number; label?: string },
): Promise<PublicCredential> {
  const row = await getCredential(d, id);
  if (!row || row.seller_id !== sellerId || row.status === 'disabled') throw notFound('Credential not found');
  if (patch.status === 'active' && row.status === 'invalid') {
    throw badRequest('Credential was rejected by the provider; delete it and register a new key', 'status');
  }
  const next = {
    status: patch.status ?? row.status,
    hourly_token_limit: patch.hourlyTokenLimit ?? row.hourly_token_limit,
    max_concurrency: patch.maxConcurrency ?? row.max_concurrency,
    label: patch.label ?? row.label,
  };
  await d.db.exec(
    'UPDATE credentials SET status = $1, hourly_token_limit = $2, max_concurrency = $3, label = $4, updated_at = $5 WHERE id = $6',
    [next.status, next.hourly_token_limit, next.max_concurrency, next.label, iso(d.now()), id],
  );
  return toPublic({ ...row, ...next });
}

/** Soft delete: keeps the row for usage history, wipes the secret. */
export async function deleteCredential(d: Deps, sellerId: string, id: string): Promise<void> {
  const n = await d.db.exec(
    "UPDATE credentials SET status = 'disabled', status_reason = 'deleted by seller', secret_ciphertext = '', updated_at = $3 WHERE id = $1 AND seller_id = $2 AND status <> 'disabled'",
    [id, sellerId, iso(d.now())],
  );
  if (n === 0) throw notFound('Credential not found');
}

export async function setCredentialStatus(d: Deps, id: string, status: CredentialStatus, reason: string): Promise<void> {
  await d.db.exec('UPDATE credentials SET status = $1, status_reason = $2, updated_at = $3 WHERE id = $4', [status, reason, iso(d.now()), id]);
  d.log.warn('credential status changed', { credentialId: id, status, reason });
}

export function decryptSecret(d: Deps, row: CredentialRow): string {
  return d.vault.decrypt(row.secret_ciphertext, aad(row.id));
}
