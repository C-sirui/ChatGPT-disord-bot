import type { Config } from './types.ts';

/**
 * Minimal declarative validator. Every key in the config must be described
 * here; unknown keys are rejected so typos in env vars / files fail fast.
 */
type Check = (v: unknown, path: string, errs: string[]) => void;
type Spec = Check | { [k: string]: Spec };

const str = (opts: { enum?: readonly string[]; allowEmpty?: boolean } = {}): Check => (v, p, e) => {
  if (typeof v !== 'string') return void e.push(`${p}: expected string, got ${typeof v}`);
  if (opts.enum && !opts.enum.includes(v)) e.push(`${p}: must be one of ${opts.enum.join('|')}, got "${v}"`);
  if (opts.allowEmpty === false && !v) e.push(`${p}: must not be empty`);
};
const num = (opts: { min?: number; max?: number; int?: boolean } = {}): Check => (v, p, e) => {
  if (typeof v !== 'number' || Number.isNaN(v)) return void e.push(`${p}: expected number, got ${JSON.stringify(v)}`);
  if (opts.int && !Number.isInteger(v)) e.push(`${p}: expected integer`);
  if (opts.min !== undefined && v < opts.min) e.push(`${p}: must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) e.push(`${p}: must be <= ${opts.max}`);
};
const bool: Check = (v, p, e) => {
  if (typeof v !== 'boolean') e.push(`${p}: expected boolean, got ${JSON.stringify(v)}`);
};
const record = (inner: Spec): Check => (v, p, e) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return void e.push(`${p}: expected object`);
  for (const [k, x] of Object.entries(v)) run(inner, x, `${p}.${k}`, e);
};
const array = (inner: Spec, opts: { minLength?: number } = {}): Check => (v, p, e) => {
  if (!Array.isArray(v)) return void e.push(`${p}: expected array`);
  if (opts.minLength && v.length < opts.minLength) e.push(`${p}: needs at least ${opts.minLength} item(s)`);
  v.forEach((x, i) => run(inner, x, `${p}[${i}]`, e));
};

function run(spec: Spec, v: unknown, path: string, errs: string[]): void {
  if (typeof spec === 'function') return spec(v, path, errs);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return void errs.push(`${path || '<root>'}: expected object`);
  const obj = v as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in spec)) errs.push(`${path ? path + '.' : ''}${key}: unknown config key`);
  }
  for (const [key, sub] of Object.entries(spec)) {
    const p = path ? `${path}.${key}` : key;
    if (!(key in obj)) errs.push(`${p}: missing`);
    else run(sub, obj[key], p, errs);
  }
}

const ms = num({ min: 0, int: true });

const SPEC: Spec = {
  env: str({ enum: ['development', 'test', 'production'] }),
  server: {
    host: str(),
    port: num({ min: 0, max: 65535, int: true }),
    publicBaseUrl: str(),
    bodyLimitBytes: num({ min: 1024, int: true }),
    headersTimeoutMs: ms,
    keepAliveTimeoutMs: ms,
    shutdownGraceMs: ms,
    trustProxy: bool,
  },
  db: {
    driver: str({ enum: ['sqlite', 'postgres'] }),
    sqlitePath: str(),
    url: str(),
    poolMax: num({ min: 1, int: true }),
    autoMigrate: bool,
  },
  log: {
    level: str({ enum: ['silent', 'error', 'warn', 'info', 'debug', 'trace'] }),
    format: str({ enum: ['json', 'pretty'] }),
    logBodies: bool,
  },
  security: {
    masterKey: str(),
    masterKeyId: str({ allowEmpty: false }),
    previousMasterKeys: record(str()),
    adminToken: str(),
    sessionTtlHours: num({ min: 1 }),
    passwordMinLength: num({ min: 1, int: true }),
    scryptCost: num({ min: 1024, int: true }),
  },
  pricing: { takeRate: num({ min: 0, max: 1 }) },
  models: array(
    {
      id: str({ allowEmpty: false }),
      provider: str({ allowEmpty: false }),
      upstreamModel: str({ allowEmpty: false }),
      inputUsdPerMTok: num({ min: 0 }),
      outputUsdPerMTok: num({ min: 0 }),
      maxOutput: num({ min: 1, int: true }),
      defaultMaxOutput: num({ min: 1, int: true }),
    },
    { minLength: 1 },
  ),
  relay: {
    maxAttempts: num({ min: 1, max: 10, int: true }),
    upstreamConnectTimeoutMs: ms,
    upstreamIdleTimeoutMs: ms,
    holdTtlMs: num({ min: 1000, int: true }),
    charsPerToken: num({ min: 1 }),
    reaperIntervalMs: ms,
    perKeyRequestsPerMinute: num({ min: 1, int: true }),
    perUserConcurrency: num({ min: 1, int: true }),
    rateLimitCooldownMs: ms,
    breaker: { failureThreshold: num({ min: 1, int: true }), cooldownMs: ms },
  },
  providers: record({ enabled: bool, baseUrl: str(), resaleAcknowledged: bool }),
  credentials: { validateOnCreate: bool, allowPrivateBaseUrls: bool },
  payments: {
    provider: str({ enum: ['fake', 'stripe'] }),
    minTopupUsd: num({ min: 0 }),
    maxTopupUsd: num({ min: 1 }),
    stripe: { secretKey: str(), webhookSecret: str(), successUrl: str(), cancelUrl: str(), apiBase: str() },
  },
  payouts: { minUsd: num({ min: 0 }), holdDays: num({ min: 0 }) },
  debug: { enabled: bool, ringSize: num({ min: 1, int: true }), timelineHeader: bool, allowLocalhostWithoutToken: bool },
  dev: {
    seed: bool,
    mockUpstream: {
      enabled: bool,
      port: num({ min: 0, max: 65535, int: true }),
      latencyMs: ms,
      chunkDelayMs: ms,
      faultRate: num({ min: 0, max: 1 }),
      faultStatus: num({ min: 100, max: 599, int: true }),
    },
  },
};

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function validateConfig(raw: unknown): Config {
  const errs: string[] = [];
  run(SPEC, raw, '', errs);
  if (errs.length) throw new ConfigError(errs);
  const cfg = raw as Config;

  // Cross-field rules.
  const ids = new Set<string>();
  for (const m of cfg.models) {
    if (ids.has(m.id)) errs.push(`models: duplicate id "${m.id}"`);
    ids.add(m.id);
    if (!cfg.providers[m.provider]) errs.push(`models[${m.id}].provider: unknown provider "${m.provider}"`);
    if (m.defaultMaxOutput > m.maxOutput) errs.push(`models[${m.id}]: defaultMaxOutput > maxOutput`);
  }
  if (cfg.payments.minTopupUsd > cfg.payments.maxTopupUsd) errs.push('payments: minTopupUsd > maxTopupUsd');
  if (cfg.security.masterKey) {
    const len = Buffer.from(cfg.security.masterKey, 'base64').length;
    if (len !== 32) errs.push(`security.masterKey: must be 32 bytes base64-encoded (got ${len} bytes)`);
  }
  for (const [id, k] of Object.entries(cfg.security.previousMasterKeys)) {
    if (Buffer.from(k, 'base64').length !== 32) errs.push(`security.previousMasterKeys.${id}: must be 32 bytes base64`);
  }
  if (cfg.db.driver === 'postgres' && !cfg.db.url) errs.push('db.url: required when db.driver=postgres (set DATABASE_URL)');

  if (cfg.env === 'production') errs.push(...productionProblems(cfg));
  else if (!cfg.security.masterKey) errs.push('security.masterKey: required (set TR_MASTER_KEY)');

  if (errs.length) throw new ConfigError(errs);
  return cfg;
}

/** Hard safety rails: production must not boot with dev conveniences switched on. */
function productionProblems(cfg: Config): string[] {
  const p: string[] = [];
  const DEV_KEYS = ['ZGV2LW9ubHktbWFzdGVyLWtleS1kby1ub3QtdXNlISE=', 'dGVzdC1vbmx5LW1hc3Rlci1rZXktMzItYnl0ZXMhISE='];
  if (!cfg.security.masterKey) p.push('production: security.masterKey is required (TR_MASTER_KEY)');
  if (DEV_KEYS.includes(cfg.security.masterKey)) p.push('production: security.masterKey is a well-known dev/test key');
  if (cfg.db.driver !== 'postgres') p.push('production: db.driver must be postgres');
  if (cfg.log.logBodies) p.push('production: log.logBodies must be false (buyer prompt privacy)');
  if (cfg.payments.provider === 'fake') p.push('production: payments.provider=fake is not allowed');
  if (cfg.providers.mock?.enabled) p.push('production: providers.mock.enabled must be false');
  if (cfg.dev.seed || cfg.dev.mockUpstream.enabled) p.push('production: dev.seed / dev.mockUpstream must be disabled');
  if (cfg.credentials.allowPrivateBaseUrls) p.push('production: credentials.allowPrivateBaseUrls must be false (SSRF)');
  if (cfg.debug.enabled && cfg.security.adminToken.length < 24) {
    p.push('production: debug.enabled requires security.adminToken of >= 24 chars');
  }
  if (cfg.debug.allowLocalhostWithoutToken) p.push('production: debug.allowLocalhostWithoutToken must be false');
  if (cfg.payments.provider === 'stripe' && (!cfg.payments.stripe.secretKey || !cfg.payments.stripe.webhookSecret)) {
    p.push('production: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required for payments.provider=stripe');
  }
  return p;
}
