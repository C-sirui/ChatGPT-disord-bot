import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { LoadedConfig, Sources } from './config/load.ts';
import type { Config } from './config/types.ts';
import type { Deps } from './deps.ts';
import { createLogger, type Logger } from './lib/log.ts';
import { createMetrics } from './lib/metrics.ts';
import { Vault } from './lib/crypto.ts';
import { ApiError } from './lib/errors.ts';
import { readBody, parseJson, sendJson, type HttpContext } from './lib/http.ts';
import { als } from './lib/context.ts';
import { openDb, migrate, pendingMigrations } from './db/index.ts';
import { Relay } from './relay/pipeline.ts';
import { reapReservations } from './relay/capacity.ts';
import { reapHolds } from './domain/wallet.ts';
import { createPaymentProvider, type PaymentProvider } from './payments/index.ts';
import { buildRouter } from './api/routes.ts';
import { startMockUpstream, type MockUpstream } from './dev/mock-upstream.ts';
import { seedDev } from './dev/seed.ts';

export interface AppContext {
  deps: Deps;
  relay: Relay;
  payments: PaymentProvider;
  configSources: Sources;
  draining: boolean;
}

export interface App {
  ctx: AppContext;
  server: Server;
  mock?: MockUpstream;
  url: string;
  close(): Promise<void>;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export async function createApp(loaded: LoadedConfig, opts: { logger?: Logger } = {}): Promise<App> {
  const cfg: Config = loaded.config;
  const log = opts.logger ?? createLogger({ level: cfg.log.level, format: cfg.log.format });
  log.info('starting token-relay', { env: cfg.env, db: cfg.db.driver, payments: cfg.payments.provider, debug: cfg.debug.enabled });

  // Dev: in-process mock upstream so the whole stack works offline.
  let mock: MockUpstream | undefined;
  if (cfg.dev.mockUpstream.enabled && cfg.providers.mock) {
    mock = await startMockUpstream(cfg.dev.mockUpstream, log.child({ component: 'mock-upstream' }));
    cfg.providers.mock.baseUrl = mock.url;
    loaded.sources['providers.mock.baseUrl'] = 'runtime:dev.mockUpstream';
  }

  const db = await openDb(cfg, log);
  if (cfg.db.autoMigrate) {
    const applied = await migrate(db, log);
    if (applied.length) log.info('migrations applied', { applied });
  } else {
    const pending = await pendingMigrations(db);
    if (pending.length) log.warn('database has pending migrations; run `npm run migrate`', { pending });
  }

  const deps: Deps = {
    cfg, db, log,
    metrics: createMetrics(),
    vault: new Vault(cfg.security.masterKeyId, cfg.security.masterKey, cfg.security.previousMasterKeys),
    now: () => new Date(),
  };
  const ctx: AppContext = {
    deps,
    relay: new Relay(deps),
    payments: createPaymentProvider(cfg),
    configSources: loaded.sources,
    draining: false,
  };
  const router = buildRouter(ctx);

  if (cfg.dev.seed) await seedDev(deps, log);

  const server = createServer(async (req, res) => {
    const headerId = req.headers['x-request-id'];
    const requestId = typeof headerId === 'string' && REQUEST_ID_RE.test(headerId) ? headerId : `req_${randomUUID().replace(/-/g, '')}`;
    res.setHeader('x-request-id', requestId);
    const url = new URL(req.url ?? '/', 'http://relay.local');
    const startedAt = performance.now();
    let bodyBuf: Promise<Buffer> | undefined;
    const raw = () => (bodyBuf ??= readBody(req, cfg.server.bodyLimitBytes));
    const clientIp = (cfg.server.trustProxy && typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',')[0]!.trim()
      : req.socket.remoteAddress) ?? 'unknown';
    const hctx: HttpContext = { req, res, requestId, url, params: {}, raw, json: async <T>() => parseJson<T>(await raw()), clientIp, startedAt };

    let routeLabel = 'unmatched';
    await als.run({ requestId }, async () => {
      try {
        const m = router.match(req.method ?? 'GET', url.pathname);
        if (m === undefined) throw new ApiError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
        if (m === 'method_not_allowed') throw new ApiError(405, 'method_not_allowed', `Method ${req.method} not allowed on ${url.pathname}`);
        routeLabel = m.pattern;
        hctx.params = m.params;
        const out = await m.handler(hctx);
        if (out !== undefined && !res.headersSent) sendJson(res, res.statusCode || 200, out);
        else if (!res.writableEnded && !res.headersSent) res.writeHead(204).end();
      } catch (err) {
        const apiErr = err instanceof ApiError ? err : new ApiError(500, 'internal_error', 'Internal server error', { cause: err });
        if (apiErr.status >= 500) log.error('request failed', { err, route: routeLabel });
        if (!res.headersSent) sendJson(res, apiErr.status, apiErr.toJSON(), apiErr.headers);
        else if (!res.writableEnded) res.end();
      } finally {
        const ms = performance.now() - startedAt;
        deps.metrics.httpRequests.inc({ route: routeLabel, method: req.method ?? '', status: res.statusCode });
        deps.metrics.httpLatency.observe({ route: routeLabel }, ms);
        if (routeLabel !== '/healthz' && routeLabel !== '/metrics') {
          log.debug('http', { method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(ms), ip: clientIp });
        }
      }
    });
  });
  server.headersTimeout = cfg.server.headersTimeoutMs;
  server.keepAliveTimeout = cfg.server.keepAliveTimeoutMs;
  server.requestTimeout = 0; // streams can be long; upstream idle timeout bounds them instead.

  await new Promise<void>((resolve) => server.listen(cfg.server.port, cfg.server.host, resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`;
  log.info('listening', { url });

  // Background reaper for orphaned holds/reservations (crashed replicas, lost settles).
  const reaper = cfg.relay.reaperIntervalMs > 0
    ? setInterval(async () => {
        try {
          const holds = await reapHolds(deps);
          const res = await reapReservations(deps, cfg.relay.holdTtlMs);
          if (holds || res) log.warn('reaper released orphaned state', { holds, reservations: res });
          deps.metrics.holdsReaped.inc({}, holds);
        } catch (err) {
          log.error('reaper failed', { err });
        }
      }, cfg.relay.reaperIntervalMs)
    : undefined;
  reaper?.unref();

  let closed = false;
  return {
    ctx, server, mock, url,
    async close() {
      if (closed) return;
      closed = true;
      ctx.draining = true;
      clearInterval(reaper);
      log.info('draining', { inFlight: ctx.relay.inFlight, graceMs: cfg.server.shutdownGraceMs });
      const done = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      const deadline = Date.now() + cfg.server.shutdownGraceMs;
      while (ctx.relay.inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      server.closeAllConnections();
      await done;
      await mock?.close();
      await db.close();
      log.info('shutdown complete');
    },
  };
}
