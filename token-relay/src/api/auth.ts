import type { AppContext } from '../app.ts';
import type { HttpContext } from '../lib/http.ts';
import { bearerToken } from '../lib/http.ts';
import { forbidden, notFound, unauthorized } from '../lib/errors.ts';
import { safeEqual } from '../lib/crypto.ts';
import { authenticateSession, type User } from '../domain/users.ts';
import { authenticateApiKey, type KeyPrincipal } from '../domain/apikeys.ts';
import { als } from '../lib/context.ts';

export async function requireSession(app: AppContext, ctx: HttpContext): Promise<User> {
  const token = bearerToken(ctx.req);
  if (!token?.startsWith('trs_')) throw unauthorized('A session token (trs_…) is required; log in via POST /v1/auth/login');
  const user = await authenticateSession(app.deps, token);
  if (!user) throw unauthorized('Session expired or invalid');
  const store = als.getStore();
  if (store) store.userId = user.id;
  return user;
}

export async function requireApiKey(app: AppContext, ctx: HttpContext): Promise<KeyPrincipal> {
  const token = bearerToken(ctx.req);
  if (!token) throw unauthorized('Missing API key. Use "Authorization: Bearer trk_…"');
  const p = await authenticateApiKey(app.deps, token);
  if (!p) throw unauthorized('Incorrect API key provided');
  const store = als.getStore();
  if (store) store.userId = p.userId;
  return p;
}

function adminTokenOk(app: AppContext, ctx: HttpContext): boolean {
  const configured = app.deps.cfg.security.adminToken;
  const given = ctx.req.headers['x-admin-token'];
  return !!configured && typeof given === 'string' && safeEqual(given, configured);
}

/** Admin: X-Admin-Token or a session of a user with role=admin. */
export async function requireAdmin(app: AppContext, ctx: HttpContext): Promise<void> {
  if (adminTokenOk(app, ctx)) return;
  const user = await requireSession(app, ctx);
  if (user.role !== 'admin') throw forbidden('Admin only');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Debug surface: must be enabled; then admin, or loopback when allowed (dev). 404 when disabled to avoid advertising it. */
export async function requireDebug(app: AppContext, ctx: HttpContext): Promise<void> {
  const dbg = app.deps.cfg.debug;
  if (!dbg.enabled) throw notFound();
  if (dbg.allowLocalhostWithoutToken && LOOPBACK.has(ctx.req.socket.remoteAddress ?? '') && !ctx.req.headers['x-forwarded-for']) return;
  await requireAdmin(app, ctx);
}
