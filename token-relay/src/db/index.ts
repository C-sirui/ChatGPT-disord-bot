import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/types.ts';
import type { Logger } from '../lib/log.ts';
import { PROJECT_ROOT } from '../config/load.ts';
import type { Db } from './types.ts';

export type { Db, Param } from './types.ts';

export async function openDb(cfg: Config, log: Logger): Promise<Db> {
  const dblog = log.child({ component: 'db' });
  if (cfg.db.driver === 'sqlite') {
    const path = cfg.db.sqlitePath === ':memory:' ? ':memory:' : join(PROJECT_ROOT, cfg.db.sqlitePath);
    dblog.info('opening sqlite', { path });
    const { openSqlite } = await import('./sqlite.ts');
    return openSqlite(path, dblog);
  }
  dblog.info('opening postgres', { host: safeHost(cfg.db.url) });
  const { openPostgres } = await import('./postgres.ts');
  return openPostgres(cfg.db.url, cfg.db.poolMax, dblog);
}

function safeHost(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return 'unparseable';
  }
}

const MIGRATIONS_DIR = join(PROJECT_ROOT, 'migrations');

export function listMigrations(): { version: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));
}

/** Applies pending migrations in order. On Postgres an advisory lock makes this safe across replicas. */
export async function migrate(db: Db, log: Logger): Promise<string[]> {
  await db.script('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied: string[] = [];
  await db.tx(async (tx) => {
    if (tx.driver === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(727274)');
    const done = new Set((await tx.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
    for (const m of listMigrations()) {
      if (done.has(m.version)) continue;
      log.info('applying migration', { version: m.version });
      await tx.script(m.sql);
      await tx.exec('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [m.version, new Date().toISOString()]);
      applied.push(m.version);
    }
  });
  return applied;
}

export async function pendingMigrations(db: Db): Promise<string[]> {
  try {
    const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
    return listMigrations().map((m) => m.version).filter((v) => !done.has(v));
  } catch {
    return listMigrations().map((m) => m.version);
  }
}
