export type Env = 'development' | 'test' | 'production';
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface ModelConfig {
  id: string;
  provider: string;
  upstreamModel: string;
  /** Buyer price in USD per 1M tokens. Because 1 USD/1M tok == 1 micro-USD/tok, this is also micros per token. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  maxOutput: number;
  defaultMaxOutput: number;
}

export interface ProviderConfig {
  enabled: boolean;
  baseUrl: string;
  resaleAcknowledged: boolean;
}

export interface Config {
  env: Env;
  server: {
    host: string;
    port: number;
    publicBaseUrl: string;
    bodyLimitBytes: number;
    headersTimeoutMs: number;
    keepAliveTimeoutMs: number;
    shutdownGraceMs: number;
    trustProxy: boolean;
  };
  db: {
    driver: 'sqlite' | 'postgres';
    sqlitePath: string;
    url: string;
    poolMax: number;
    autoMigrate: boolean;
  };
  log: { level: LogLevel; format: 'json' | 'pretty'; logBodies: boolean };
  security: {
    masterKey: string;
    masterKeyId: string;
    previousMasterKeys: Record<string, string>;
    adminToken: string;
    sessionTtlHours: number;
    passwordMinLength: number;
    scryptCost: number;
  };
  pricing: { takeRate: number };
  models: ModelConfig[];
  relay: {
    maxAttempts: number;
    upstreamConnectTimeoutMs: number;
    upstreamIdleTimeoutMs: number;
    holdTtlMs: number;
    charsPerToken: number;
    reaperIntervalMs: number;
    perKeyRequestsPerMinute: number;
    perUserConcurrency: number;
    rateLimitCooldownMs: number;
    breaker: { failureThreshold: number; cooldownMs: number };
  };
  providers: Record<string, ProviderConfig>;
  credentials: { validateOnCreate: boolean; allowPrivateBaseUrls: boolean };
  payments: {
    provider: 'fake' | 'stripe';
    minTopupUsd: number;
    maxTopupUsd: number;
    stripe: { secretKey: string; webhookSecret: string; successUrl: string; cancelUrl: string; apiBase: string };
  };
  payouts: { minUsd: number; holdDays: number };
  debug: { enabled: boolean; ringSize: number; timelineHeader: boolean; allowLocalhostWithoutToken: boolean };
  dev: {
    seed: boolean;
    mockUpstream: {
      enabled: boolean;
      port: number;
      latencyMs: number;
      chunkDelayMs: number;
      faultRate: number;
      faultStatus: number;
    };
  };
}
