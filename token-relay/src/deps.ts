import type { Config } from './config/types.ts';
import type { Db } from './db/types.ts';
import type { Logger } from './lib/log.ts';
import type { Metrics } from './lib/metrics.ts';
import type { Vault } from './lib/crypto.ts';

/** Shared service dependencies, passed explicitly (no globals) so tests can build isolated apps. */
export interface Deps {
  cfg: Config;
  db: Db;
  log: Logger;
  metrics: Metrics;
  vault: Vault;
  now: () => Date;
}

export const iso = (d: Date) => d.toISOString();
