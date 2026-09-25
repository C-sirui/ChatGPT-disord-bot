import type { Db, Param } from './types.ts';
import type { Logger } from '../lib/log.ts';
import type { Pool, PoolClient } from 'pg';

/** Production driver. BIGINT/NUMERIC columns are parsed to JS numbers (all values < 2^53). */
export async function openPostgres(url: string, poolMax: number, log: Logger): Promise<Db> {
  const pg = (await import('pg')).default;
  const types = {
    getTypeParser: (oid: number, format?: 'text' | 'binary') =>
      oid === 20 || oid === 1700 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, format as 'text'),
  };
  const pool: Pool = new pg.Pool({ connectionString: url, max: poolMax, types, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => log.error('postgres pool error', { err }));

  const wrap = (runner: Pool | PoolClient, inTx: boolean): Db => {
    const db: Db = {
      driver: 'postgres',
      async query<T>(sql: string, params: Param[] = []) {
        log.trace('sql', { sql, params });
        return (await runner.query(sql, params)).rows as T[];
      },
      async one<T>(sql: string, params: Param[] = []) {
        return (await runner.query(sql, params)).rows[0] as T | undefined;
      },
      async exec(sql, params = []) {
        log.trace('sql', { sql, params });
        return (await runner.query(sql, params)).rowCount ?? 0;
      },
      async script(sql) {
        await runner.query(sql);
      },
      async tx(fn) {
        if (inTx) return fn(db);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn(wrap(client, true));
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      async ping() {
        await runner.query('SELECT 1');
      },
      async close() {
        if (!inTx) await pool.end();
      },
    };
    return db;
  };
  return wrap(pool, false);
}
