import type { AppContext } from '../app.ts';
import { Router, field, bearerToken } from '../lib/http.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { redactConfig } from '../config/load.ts';
import { requireAdmin, requireApiKey, requireDebug, requireSession } from './auth.ts';
import { login, logout, registerUser } from '../domain/users.ts';
import { createApiKey, listApiKeys, revokeApiKey } from '../domain/apikeys.ts';
import { getWallet } from '../domain/wallet.ts';
import { applyPaymentEvent, adjustBalance, requestPayout, resolvePayout, startCheckout, withdrawable } from '../domain/billing.ts';
import { createCredential, deleteCredential, listCredentials, setCredentialStatus, updateCredential } from '../domain/credentials.ts';
import { reconcile, acct } from '../domain/ledger.ts';
import { currentWindows } from '../relay/capacity.ts';
import { pendingMigrations } from '../db/index.ts';
import { usdToMicros } from '../domain/money.ts';

const clampLimit = (v: string | null, def = 50, max = 500) => Math.min(max, Math.max(1, Number(v) || def));

export function buildRouter(app: AppContext): Router {
  const r = new Router();
  const d = app.deps;

  // ---------------- ops ----------------
  r.get('/healthz', () => ({ status: 'ok' }));
  r.get('/readyz', async (ctx) => {
    if (app.draining) {
      ctx.res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'draining' }));
      return;
    }
    try {
      await d.db.ping();
      const pending = await pendingMigrations(d.db);
      if (pending.length) throw new Error(`pending migrations: ${pending.join(',')}`);
      return { status: 'ready' };
    } catch (err) {
      ctx.res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'not_ready', reason: (err as Error).message }));
      return;
    }
  });
  r.get('/metrics', (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(d.metrics.registry.render());
  });

  // ---------------- accounts ----------------
  r.post('/v1/auth/register', async (ctx) => {
    const b = field.object(await ctx.json());
    const user = await registerUser(d, field.string(b, 'email')!, field.string(b, 'password')!);
    const session = await login(d, user.email, b.password as string);
    ctx.res.statusCode = 201;
    return { user, token: session.token, expiresAt: session.expiresAt };
  });
  r.post('/v1/auth/login', async (ctx) => {
    const b = field.object(await ctx.json());
    const s = await login(d, field.string(b, 'email')!, field.string(b, 'password')!);
    return { user: s.user, token: s.token, expiresAt: s.expiresAt };
  });
  r.post('/v1/auth/logout', async (ctx) => {
    await requireSession(app, ctx);
    await logout(d, bearerToken(ctx.req)!);
    return { ok: true };
  });
  r.get('/v1/me', async (ctx) => {
    const user = await requireSession(app, ctx);
    return { user, wallet: await getWallet(d, user.id) };
  });

  // ---------------- buyer keys ----------------
  r.post('/v1/keys', async (ctx) => {
    const user = await requireSession(app, ctx);
    const b = field.object(await ctx.json().catch(() => ({})));
    const { key, row } = await createApiKey(d, user.id, field.string(b, 'name', { optional: true, max: 100 }) ?? 'default');
    ctx.res.statusCode = 201;
    return { ...row, key, note: 'Store this key now; it will not be shown again.' };
  });
  r.get('/v1/keys', async (ctx) => ({ data: await listApiKeys(d, (await requireSession(app, ctx)).id) }));
  r.delete('/v1/keys/:id', async (ctx) => {
    const user = await requireSession(app, ctx);
    await revokeApiKey(d, user.id, ctx.params.id!);
    return { ok: true };
  });

  // ---------------- billing ----------------
  r.post('/v1/billing/checkout', async (ctx) => {
    const user = await requireSession(app, ctx);
    const b = field.object(await ctx.json());
    return startCheckout(d, app.payments, user, field.number(b, 'amountUsd', { min: 0 })!);
  });
  r.get('/v1/billing/ledger', async (ctx) => {
    const user = await requireSession(app, ctx);
    const rows = await d.db.query(
      `SELECT t.id AS txn_id, t.kind, t.ref, t.memo, e.account, e.amount_micros, e.created_at
         FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id
        WHERE e.account IN ($1, $2) ORDER BY e.created_at DESC LIMIT $3`,
      [acct.available(user.id), acct.earnings(user.id), clampLimit(ctx.url.searchParams.get('limit'))],
    );
    return { data: rows };
  });
  r.get('/v1/billing/usage', async (ctx) => {
    const user = await requireSession(app, ctx);
    const rows = await d.db.query(
      `SELECT request_id, model, prompt_tokens, completion_tokens, estimated, buyer_cost_micros, created_at
         FROM usage_events WHERE buyer_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [user.id, clampLimit(ctx.url.searchParams.get('limit'))],
    );
    return { data: rows };
  });
  r.post('/webhooks/stripe', async (ctx) => {
    if (app.payments.id !== 'stripe') throw notFound();
    const ev = app.payments.parseWebhook(await ctx.raw(), ctx.req.headers);
    if (ev) await applyPaymentEvent(d, ev);
    return { received: true };
  });

  // ---------------- seller ----------------
  r.post('/v1/seller/credentials', async (ctx) => {
    const user = await requireSession(app, ctx);
    const b = field.object(await ctx.json());
    const models = b.models;
    if (models !== undefined && (!Array.isArray(models) || models.some((m) => typeof m !== 'string'))) throw badRequest('"models" must be an array of strings', 'models');
    const cred = await createCredential(d, user.id, {
      provider: field.string(b, 'provider')!,
      label: field.string(b, 'label', { optional: true, max: 100 }),
      apiKey: field.string(b, 'apiKey', { min: 8, max: 512 })!,
      baseUrl: field.string(b, 'baseUrl', { optional: true, max: 512 }),
      models: models as string[] | undefined,
      hourlyTokenLimit: field.number(b, 'hourlyTokenLimit', { min: 1000, max: 1_000_000_000, int: true })!,
      maxConcurrency: field.number(b, 'maxConcurrency', { min: 1, max: 256, int: true, optional: true }),
      attestSelfHosted: b.attestSelfHosted === true,
    });
    ctx.res.statusCode = 201;
    return cred;
  });
  r.get('/v1/seller/credentials', async (ctx) => ({ data: await listCredentials(d, (await requireSession(app, ctx)).id) }));
  r.patch('/v1/seller/credentials/:id', async (ctx) => {
    const user = await requireSession(app, ctx);
    const b = field.object(await ctx.json());
    const status = field.string(b, 'status', { optional: true });
    if (status !== undefined && status !== 'active' && status !== 'paused') throw badRequest('status must be active|paused', 'status');
    return updateCredential(d, user.id, ctx.params.id!, {
      status,
      label: field.string(b, 'label', { optional: true, max: 100 }),
      hourlyTokenLimit: field.number(b, 'hourlyTokenLimit', { min: 1000, max: 1_000_000_000, int: true, optional: true }),
      maxConcurrency: field.number(b, 'maxConcurrency', { min: 1, max: 256, int: true, optional: true }),
    });
  });
  r.delete('/v1/seller/credentials/:id', async (ctx) => {
    await deleteCredential(d, (await requireSession(app, ctx)).id, ctx.params.id!);
    return { ok: true };
  });
  r.get('/v1/seller/earnings', async (ctx) => {
    const user = await requireSession(app, ctx);
    const byModel = await d.db.query(
      `SELECT model, COUNT(*) AS requests, SUM(prompt_tokens) AS prompt_tokens, SUM(completion_tokens) AS completion_tokens,
              SUM(seller_credit_micros) AS earned_micros
         FROM usage_events WHERE seller_id = $1 GROUP BY model`,
      [user.id],
    );
    const payouts = await d.db.query('SELECT id, amount_micros, status, note, created_at FROM payouts WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 50', [user.id]);
    return { ...(await withdrawable(d, user.id)), holdDays: d.cfg.payouts.holdDays, byModel, payouts };
  });
  r.post('/v1/seller/payouts', async (ctx) => {
    const user = await requireSession(app, ctx);
    const b = field.object(await ctx.json());
    ctx.res.statusCode = 201;
    return requestPayout(d, user.id, field.number(b, 'amountUsd', { min: 0 })!);
  });

  // ---------------- OpenAI-compatible (editors) ----------------
  r.get('/v1/models', async (ctx) => {
    await requireApiKey(app, ctx);
    const created = Math.floor(Date.parse('2026-01-01') / 1000);
    return {
      object: 'list',
      data: app.relay.availableModels().map((m) => ({
        id: m.id, object: 'model', created, owned_by: 'token-relay',
        pricing: { input_usd_per_mtok: m.inputUsdPerMTok, output_usd_per_mtok: m.outputUsdPerMTok },
      })),
    };
  });
  r.post('/v1/chat/completions', async (ctx) => {
    const principal = await requireApiKey(app, ctx);
    await app.relay.handleChat(ctx, principal);
  });

  // ---------------- admin ----------------
  r.get('/admin/users', async (ctx) => {
    await requireAdmin(app, ctx);
    const rows = await d.db.query(
      `SELECT u.id, u.email, u.role, u.status, u.created_at, w.available_micros, w.held_micros, w.earned_micros
         FROM users u LEFT JOIN wallets w ON w.user_id = u.id ORDER BY u.created_at DESC LIMIT $1`,
      [clampLimit(ctx.url.searchParams.get('limit'), 100, 1000)],
    );
    return { data: rows };
  });
  r.post('/admin/users/:id/status', async (ctx) => {
    await requireAdmin(app, ctx);
    const status = field.string(field.object(await ctx.json()), 'status');
    if (status !== 'active' && status !== 'suspended') throw badRequest('status must be active|suspended', 'status');
    const n = await d.db.exec('UPDATE users SET status = $1 WHERE id = $2', [status, ctx.params.id!]);
    if (!n) throw notFound('User not found');
    return { ok: true };
  });
  r.post('/admin/users/:id/adjust', async (ctx) => {
    await requireAdmin(app, ctx);
    const b = field.object(await ctx.json());
    const posted = await adjustBalance(d, ctx.params.id!, usdToMicros(field.number(b, 'amountUsd')!), field.string(b, 'ref', { min: 1 })!, field.string(b, 'memo', { optional: true }) ?? 'admin adjustment');
    return { posted };
  });
  r.get('/admin/payouts', async (ctx) => {
    await requireAdmin(app, ctx);
    return { data: await d.db.query("SELECT * FROM payouts WHERE status = $1 ORDER BY created_at", [ctx.url.searchParams.get('status') ?? 'requested']) };
  });
  r.post('/admin/payouts/:id/:action', async (ctx) => {
    await requireAdmin(app, ctx);
    const action = ctx.params.action;
    if (action !== 'paid' && action !== 'rejected') throw notFound();
    const b = field.object(await ctx.json().catch(() => ({})));
    return resolvePayout(d, ctx.params.id!, action, field.string(b, 'note', { optional: true }));
  });
  r.post('/admin/credentials/:id/disable', async (ctx) => {
    await requireAdmin(app, ctx);
    const b = field.object(await ctx.json().catch(() => ({})));
    await setCredentialStatus(d, ctx.params.id!, 'disabled', field.string(b, 'reason', { optional: true }) ?? 'disabled by admin');
    return { ok: true };
  });
  r.get('/admin/reconcile', async (ctx) => {
    await requireAdmin(app, ctx);
    return reconcile(d.db);
  });

  // ---------------- debug (dev build / admin) ----------------
  r.get('/debug/config', async (ctx) => {
    await requireDebug(app, ctx);
    return { config: redactConfig(d.cfg), sources: app.configSources };
  });
  r.get('/debug/requests', async (ctx) => {
    await requireDebug(app, ctx);
    const q = ctx.url.searchParams;
    const list = app.relay.ring?.list({ userId: q.get('userId') ?? undefined, outcome: q.get('outcome') ?? undefined, limit: clampLimit(q.get('limit')) }) ?? [];
    return { data: list.map(({ events, ...rest }) => ({ ...rest, events: events.length })) };
  });
  r.get('/debug/requests/:id', async (ctx) => {
    await requireDebug(app, ctx);
    const rec = app.relay.ring?.get(ctx.params.id!);
    if (!rec) throw notFound('Request not in debug ring (it may have been evicted)');
    const dbRow = await d.db.one('SELECT * FROM requests WHERE id = $1', [ctx.params.id!]);
    const usage = await d.db.one('SELECT * FROM usage_events WHERE request_id = $1', [ctx.params.id!]);
    return { trace: rec, request: dbRow ?? null, usage: usage ?? null };
  });
  r.get('/debug/router', async (ctx) => {
    await requireDebug(app, ctx);
    const creds = await d.db.query('SELECT id, seller_id, provider, label, models, hourly_token_limit, max_concurrency, status, status_reason FROM credentials');
    return {
      inFlight: app.relay.inFlight,
      availableModels: app.relay.availableModels().map((m) => m.id),
      credentials: creds,
      windows: await currentWindows(d),
      breakers: app.relay.breakers.snapshot(),
    };
  });
  r.get('/debug/ledger/:userId', async (ctx) => {
    await requireDebug(app, ctx);
    const id = ctx.params.userId!;
    const entries = await d.db.query(
      `SELECT t.kind, t.ref, t.memo, e.account, e.amount_micros, e.created_at FROM ledger_entries e JOIN ledger_txns t ON t.id = e.txn_id
        WHERE e.account LIKE $1 ORDER BY e.created_at DESC LIMIT 200`,
      [`user:${id}:%`],
    );
    return { wallet: await getWallet(d, id), entries, holds: await d.db.query('SELECT * FROM holds WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [id]) };
  });

  return r;
}
