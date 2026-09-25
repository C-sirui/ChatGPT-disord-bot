import { loadConfig } from '../src/config/load.ts';
import { createApp, type App } from '../src/app.ts';
import { createLogger } from '../src/lib/log.ts';
import { migrate } from '../src/db/index.ts';
import type { Config } from '../src/config/types.ts';

type Obj = Record<string, unknown>;

/**
 * Boots an isolated app (in-memory SQLite + in-process mock upstream) on a
 * random port. Set TEST_DATABASE_URL to run the same suites against Postgres
 * (each app truncates all tables first).
 */
export async function startTestApp(overrides: Obj = {}): Promise<TestApp> {
  const pgUrl = process.env.TEST_DATABASE_URL;
  const dbOverride = pgUrl ? { db: { driver: 'postgres', url: pgUrl, autoMigrate: true } } : {};
  const loaded = loadConfig({ env: { TR_ENV: 'test' }, overrides: deepMerge(dbOverride, overrides) as never });
  const logger = createLogger({ level: (process.env.TEST_LOG_LEVEL as never) ?? 'silent', format: 'pretty' });
  if (pgUrl) await resetPostgres(loaded.config, logger);
  const app = await createApp(loaded, { logger });
  return new TestApp(app);
}

async function resetPostgres(cfg: Config, log: ReturnType<typeof createLogger>) {
  const { openDb } = await import('../src/db/index.ts');
  const db = await openDb(cfg, log);
  await migrate(db, log);
  const tables = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
  if (tables.length) await db.script(`TRUNCATE ${tables.map((t) => t.tablename).join(', ')} CASCADE`);
  await db.close();
}

function deepMerge(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? deepMerge(cur as Obj, v as Obj) : v;
  }
  return out;
}

export interface Res<T = any> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export class TestApp {
  readonly app: App;
  constructor(app: App) {
    this.app = app;
  }
  get url() {
    return this.app.url;
  }
  get deps() {
    return this.app.ctx.deps;
  }
  get mock() {
    return this.app.mock!;
  }
  close() {
    return this.app.close();
  }

  async req<T = any>(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res<T>> {
    const res = await fetch(this.url + path, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON (SSE, metrics) */
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  /** Registers a user, returns session token + id. */
  async user(email: string, password = 'pw-123456') {
    const r = await this.req('POST', '/v1/auth/register', { body: { email, password } });
    if (r.status !== 201) throw new Error(`register failed: ${r.text}`);
    return { token: r.body.token as string, id: r.body.user.id as string };
  }

  /** Buyer with `usd` balance and a relay key. */
  async buyer(email = 'buyer@test.dev', usd = 10) {
    const u = await this.user(email);
    if (usd > 0) {
      const c = await this.req('POST', '/v1/billing/checkout', { token: u.token, body: { amountUsd: usd } });
      if (c.status !== 200) throw new Error(`checkout failed: ${c.text}`);
    }
    const k = await this.req('POST', '/v1/keys', { token: u.token, body: { name: 'test' } });
    return { ...u, key: k.body.key as string };
  }

  async seller(email = 'seller@test.dev', creds: { apiKey: string; hourlyTokenLimit?: number; maxConcurrency?: number }[] = [{ apiKey: 'mock-secret-1' }]) {
    const u = await this.user(email);
    const ids: string[] = [];
    for (const c of creds) {
      const r = await this.req('POST', '/v1/seller/credentials', {
        token: u.token,
        body: { provider: 'mock', apiKey: c.apiKey, hourlyTokenLimit: c.hourlyTokenLimit ?? 1_000_000, maxConcurrency: c.maxConcurrency ?? 8 },
      });
      if (r.status !== 201) throw new Error(`credential failed: ${r.text}`);
      ids.push(r.body.id);
    }
    return { ...u, credentialIds: ids };
  }

  chat(key: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return this.req('POST', '/v1/chat/completions', { token: key, body: { model: 'mock-fast', messages: [{ role: 'user', content: 'hello world' }], ...body }, headers });
  }

  async wallet(token: string) {
    return (await this.req('GET', '/v1/me', { token })).body.wallet as { available_micros: number; held_micros: number; earned_micros: number };
  }

  admin(path: string, method = 'GET', body?: unknown) {
    return this.req(method, path, { headers: { 'x-admin-token': this.deps.cfg.security.adminToken }, body });
  }
}

export function parseSse(text: string): { data: any[]; done: boolean } {
  const data: any[] = [];
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const v = line.slice(5).trim();
    if (v === '[DONE]') done = true;
    else data.push(JSON.parse(v));
  }
  return { data, done };
}
