import type { Deps } from '../deps.ts';
import { iso } from '../deps.ts';
import { ApiError, badRequest, conflict, unauthorized } from '../lib/errors.ts';
import { hashPassword, newId, newToken, sha256hex, verifyPassword } from '../lib/crypto.ts';

export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  created_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Precomputed hash used to equalize timing when the email does not exist.
let dummyHash: string | undefined;

export async function registerUser(d: Deps, email: string, password: string, role: 'user' | 'admin' = 'user'): Promise<User> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized) || normalized.length > 254) throw badRequest('Invalid email', 'email');
  if (password.length < d.cfg.security.passwordMinLength) {
    throw badRequest(`Password must be at least ${d.cfg.security.passwordMinLength} characters`, 'password');
  }
  if (password.length > 1024) throw badRequest('Password too long', 'password');
  const hash = await hashPassword(password, d.cfg.security.scryptCost);
  const now = iso(d.now());
  const user: User = { id: newId('usr'), email: normalized, role, status: 'active', created_at: now };
  try {
    await d.db.tx(async (tx) => {
      await tx.exec('INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
        user.id, user.email, hash, role, 'active', now,
      ]);
      await tx.exec('INSERT INTO wallets (user_id, updated_at) VALUES ($1, $2)', [user.id, now]);
    });
  } catch (e) {
    if (/unique|duplicate/i.test(String((e as Error).message))) throw conflict('An account with this email already exists');
    throw e;
  }
  d.log.info('user registered', { userId: user.id, role });
  return user;
}

export async function login(d: Deps, email: string, password: string): Promise<{ user: User; token: string; expiresAt: string }> {
  const row = await d.db.one<User & { password_hash: string }>('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
  if (!row) {
    dummyHash ??= await hashPassword('dummy-password', d.cfg.security.scryptCost);
    await verifyPassword(password, dummyHash);
    throw unauthorized('Invalid email or password');
  }
  if (!(await verifyPassword(password, row.password_hash))) throw unauthorized('Invalid email or password');
  if (row.status !== 'active') throw new ApiError(403, 'account_suspended', 'Account is suspended');
  const token = newToken('trs');
  const expiresAt = iso(new Date(d.now().getTime() + d.cfg.security.sessionTtlHours * 3600_000));
  await d.db.exec('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5)', [
    newId('ses'), row.id, sha256hex(token), expiresAt, iso(d.now()),
  ]);
  const { password_hash: _ph, ...user } = row;
  return { user, token, expiresAt };
}

export async function logout(d: Deps, token: string): Promise<void> {
  await d.db.exec('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(token)]);
}

export async function authenticateSession(d: Deps, token: string): Promise<User | undefined> {
  const row = await d.db.one<User & { expires_at: string }>(
    `SELECT u.id, u.email, u.role, u.status, u.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [sha256hex(token)],
  );
  if (!row || row.expires_at < iso(d.now()) || row.status !== 'active') return undefined;
  const { expires_at: _e, ...user } = row;
  return user;
}

export async function getUser(d: Deps, id: string): Promise<User | undefined> {
  return d.db.one<User>('SELECT id, email, role, status, created_at FROM users WHERE id = $1', [id]);
}
