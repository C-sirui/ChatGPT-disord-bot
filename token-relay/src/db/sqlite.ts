import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db, Param } from './types.ts';
import type { Logger } from '../lib/log.ts';

/**
 * SQLite driver for development and tests. node:sqlite is synchronous, so a
 * transaction that awaits could otherwise interleave with other requests'
 * statements on the same connection. An async mutex serializes access while
 * a transaction is open; statements inside the transaction bypass it.
 */
class Mutex {
  #tail: Promise<void> = Promise.resolve();
  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.#tail;
    this.#tail = prev.then(() => next);
    return prev.then(() => release);
  }
}

const convert = (sql: string) => sql.replace(/\$(\d+)/g, '?$1');

export function openSqlite(path: string, log: Logger): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const mutex = new Mutex();
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const prep = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(convert(sql));
      cache.set(sql, s);
    }
    return s;
  };

  const direct = {
    query<T>(sql: string, params: Param[] = []): T[] {
      log.trace('sql', { sql, params });
      return prep(sql).all(...params) as T[];
    },
    exec(sql: string, params: Param[] = []): number {
      log.trace('sql', { sql, params });
      return Number(prep(sql).run(...params).changes);
    },
  };

  const inTx: Db = {
    driver: 'sqlite',
    query: async (s, p) => direct.query(s, p),
    one: async (s, p) => direct.query(s, p)[0] as never,
    exec: async (s, p) => direct.exec(s, p),
    script: async (s) => void raw.exec(s),
    tx: (fn) => fn(inTx),
    ping: async () => {},
    close: async () => {},
  };

  const guarded = async <T>(fn: () => T): Promise<T> => {
    const release = await mutex.lock();
    try {
      return fn();
    } finally {
      release();
    }
  };

  return {
    driver: 'sqlite',
    query: (s, p) => guarded(() => direct.query(s, p)),
    one: (s, p) => guarded(() => direct.query(s, p)[0] as never),
    exec: (s, p) => guarded(() => direct.exec(s, p)),
    script: (s) => guarded(() => raw.exec(s)),
    async tx(fn) {
      const release = await mutex.lock();
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn(inTx);
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        release();
      }
    },
    ping: () => guarded(() => void raw.prepare('SELECT 1').get()),
    close: async () => raw.close(),
  };
}
