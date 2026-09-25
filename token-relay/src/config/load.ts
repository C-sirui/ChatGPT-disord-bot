import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Env } from './types.ts';
import { validateConfig } from './validate.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

/** Where each leaf value came from — surfaced by `print-config` and `/debug/config`. */
export type Sources = Record<string, string>;

export interface LoadedConfig {
  config: Config;
  sources: Sources;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Works both from src/config (dev) and dist/config (prod build). */
export const PROJECT_ROOT = resolve(here, '..', '..');

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(path: string): Obj {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Json;
    if (!isObj(parsed)) throw new Error('top level must be an object');
    return parsed;
  } catch (err) {
    throw new Error(`config: failed to read ${path}: ${(err as Error).message}`);
  }
}

/** Deep merge; arrays and scalars replace. Records every leaf's source. */
function merge(target: Obj, src: Obj, source: string, sources: Sources, prefix = ''): void {
  for (const [k, v] of Object.entries(src)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const cur = target[k];
    if (isObj(v) && isObj(cur)) {
      merge(cur, v, source, sources, path);
    } else {
      target[k] = structuredClone(v);
      markSources(v, path, source, sources);
    }
  }
}

function markSources(v: Json, path: string, source: string, sources: Sources): void {
  for (const key of Object.keys(sources)) {
    if (key === path || key.startsWith(path + '.')) delete sources[key];
  }
  if (isObj(v) && Object.keys(v).length > 0) {
    for (const [k, child] of Object.entries(v)) markSources(child, `${path}.${k}`, source, sources);
  } else {
    sources[path] = source;
  }
}

const norm = (s: string) => s.replace(/_/g, '').toLowerCase();

/**
 * TR_SERVER__PORT=9000 -> server.port. Segments match existing keys case- and
 * underscore-insensitively, so TR_RELAY__MAX_ATTEMPTS -> relay.maxAttempts.
 */
function applyEnv(target: Obj, env: NodeJS.ProcessEnv, sources: Sources): void {
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith('TR_') || raw === undefined) continue;
    if (name === 'TR_ENV' || name === 'TR_CONFIG_FILE' || name === 'TR_MASTER_KEY' || name === 'TR_ADMIN_TOKEN') continue;
    const segs = name.slice(3).split('__');
    let node: Obj = target;
    const path: string[] = [];
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const existing = Object.keys(node).find((k) => norm(k) === norm(seg));
      const key = existing ?? seg.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      path.push(key);
      if (i === segs.length - 1) {
        node[key] = parseEnvValue(raw);
        markSources(node[key]!, path.join('.'), `env:${name}`, sources);
      } else {
        const next = node[key];
        if (next === undefined) node[key] = {};
        else if (!isObj(next)) { ok = false; break; }
        node = node[key] as Obj;
      }
    }
    if (!ok) throw new Error(`config: env ${name} addresses a non-object path`);
  }
}

function parseEnvValue(raw: string): Json {
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return raw;
  }
}

function setPath(target: Obj, path: string, value: Json, source: string, sources: Sources): void {
  const segs = path.split('.');
  let node = target;
  for (const s of segs.slice(0, -1)) {
    if (!isObj(node[s])) node[s] = {};
    node = node[s] as Obj;
  }
  node[segs.at(-1)!] = value;
  markSources(value, path, source, sources);
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  /** Applied last; used by tests to tweak individual settings. */
  overrides?: Obj;
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const configDir = opts.configDir ?? join(PROJECT_ROOT, 'config');
  const tierRaw = env.TR_ENV ?? (env.NODE_ENV === 'production' ? 'production' : 'development');
  if (!['development', 'test', 'production'].includes(tierRaw)) {
    throw new Error(`config: TR_ENV must be development|test|production, got "${tierRaw}"`);
  }
  const tier = tierRaw as Env;
  const sources: Sources = {};
  const cfg: Obj = {};

  merge(cfg, readJson(join(configDir, 'default.json')), 'default.json', sources);
  const tierFile = join(configDir, `${tier}.json`);
  if (existsSync(tierFile)) merge(cfg, readJson(tierFile), `${tier}.json`, sources);
  if (env.TR_CONFIG_FILE) merge(cfg, readJson(resolve(env.TR_CONFIG_FILE)), `file:${env.TR_CONFIG_FILE}`, sources);

  applyEnv(cfg, env, sources);

  // Well-known secrets / conventional names.
  if (env.TR_MASTER_KEY) setPath(cfg, 'security.masterKey', env.TR_MASTER_KEY, 'env:TR_MASTER_KEY', sources);
  if (env.TR_ADMIN_TOKEN) setPath(cfg, 'security.adminToken', env.TR_ADMIN_TOKEN, 'env:TR_ADMIN_TOKEN', sources);
  if (env.DATABASE_URL) setPath(cfg, 'db.url', env.DATABASE_URL, 'env:DATABASE_URL', sources);
  if (env.PORT) setPath(cfg, 'server.port', Number(env.PORT), 'env:PORT', sources);
  if (env.STRIPE_SECRET_KEY) setPath(cfg, 'payments.stripe.secretKey', env.STRIPE_SECRET_KEY, 'env:STRIPE_SECRET_KEY', sources);
  if (env.STRIPE_WEBHOOK_SECRET) setPath(cfg, 'payments.stripe.webhookSecret', env.STRIPE_WEBHOOK_SECRET, 'env:STRIPE_WEBHOOK_SECRET', sources);

  if (opts.overrides) merge(cfg, opts.overrides, 'overrides', sources);

  cfg.env = tier;
  sources.env = env.TR_ENV ? 'env:TR_ENV' : 'derived';

  const config = validateConfig(cfg);
  return { config, sources };
}

const SECRET_KEYS = /^(masterKey|previousMasterKeys|adminToken|secretKey|webhookSecret|password)$/;
const URL_KEYS = /url$/i;

/** Deep copy with secrets replaced; URLs keep scheme/host but drop embedded passwords. */
export function redactConfig(config: Config): unknown {
  const walk = (v: unknown, key: string, secret: boolean): unknown => {
    const isSecret = secret || SECRET_KEYS.test(key);
    if (Array.isArray(v)) return v.map((x) => walk(x, '', isSecret));
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k, isSecret)]));
    if (typeof v === 'string' && v) {
      if (isSecret) return `***(${v.length} chars)`;
      if (URL_KEYS.test(key)) {
        try {
          const u = new URL(v);
          if (u.password) u.password = '***';
          return u.toString();
        } catch {
          return v;
        }
      }
    }
    return v;
  };
  return walk(config, '', false);
}
