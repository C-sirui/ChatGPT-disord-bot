import type { Deps } from '../deps.ts';
import { iso } from '../deps.ts';
import type { ModelConfig } from '../config/types.ts';
import type { HttpContext } from '../lib/http.ts';
import { field } from '../lib/http.ts';
import { ApiError, badRequest } from '../lib/errors.ts';
import type { KeyPrincipal } from '../domain/apikeys.ts';
import { placeHold, releaseHold, settleUsage } from '../domain/wallet.ts';
import { costMicros, fmtUsd } from '../domain/money.ts';
import { decryptSecret, setCredentialStatus, type CredentialRow } from '../domain/credentials.ts';
import { commitCapacity, reserveCapacity, windowStart, type Reservation } from './capacity.ts';
import { getAdapter, type ProviderAdapter } from './providers/index.ts';
import { Breakers } from './breaker.ts';
import { Trace, TraceRing } from './trace.ts';
import { ConcurrencyLimiter, TokenBuckets } from '../lib/ratelimit.ts';
import { SseLineSplitter } from './sse.ts';

interface Candidate extends CredentialRow {
  load: number;
}

interface Usage {
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
}

interface ProxyResult extends Usage {
  gotBytes: boolean;
  clientAborted: boolean;
  upstreamBroken: boolean;
}

const MAX_ERROR_BODY = 64 * 1024;

/**
 * The relay request pipeline (DESIGN.md §4.1):
 * auth (caller) → rate limit → model → estimate → hold → route/reserve →
 * upstream (with pre-first-byte failover) → proxy → meter → settle.
 */
export class Relay {
  readonly breakers: Breakers;
  readonly ring: TraceRing | undefined;
  readonly #d: Deps;
  readonly #rpm: TokenBuckets;
  readonly #concurrency: ConcurrencyLimiter;
  #inFlight = 0;

  constructor(d: Deps) {
    this.#d = d;
    this.breakers = new Breakers(d.cfg.relay.breaker.failureThreshold, d.cfg.relay.breaker.cooldownMs);
    this.ring = d.cfg.debug.enabled ? new TraceRing(d.cfg.debug.ringSize) : undefined;
    this.#rpm = new TokenBuckets(d.cfg.relay.perKeyRequestsPerMinute);
    this.#concurrency = new ConcurrencyLimiter(d.cfg.relay.perUserConcurrency);
  }

  get inFlight() {
    return this.#inFlight;
  }

  /** Models a buyer can call right now: catalog entries whose provider is enabled and resale-gated open. */
  availableModels(): ModelConfig[] {
    return this.#d.cfg.models.filter((m) => this.#providerGate(m.provider) === undefined);
  }

  #providerGate(providerId: string): string | undefined {
    const p = this.#d.cfg.providers[providerId];
    const adapter = getAdapter(providerId);
    if (!p || !adapter || !p.enabled) return 'provider disabled';
    if (adapter.resalePolicy === 'prohibited') return 'provider prohibits resale';
    if (adapter.resalePolicy === 'requires_agreement' && !p.resaleAcknowledged) {
      return `provider "${providerId}" requires a reseller agreement (set providers.${providerId}.resaleAcknowledged after legal review)`;
    }
    return undefined;
  }

  async handleChat(ctx: HttpContext, principal: KeyPrincipal): Promise<void> {
    const d = this.#d;
    const trace = new Trace(ctx.requestId, d.log.child({ component: 'relay' }));
    trace.record.userId = principal.userId;
    trace.event('auth.ok', { keyId: principal.keyId });

    let outcome = 'error';
    let httpStatus = 500;
    let releaseSlot: (() => void) | undefined;
    let holdPlaced = false;
    let requestRow = false;
    let attempts = 0;
    let credentialId: string | null = null;
    let errorCode: string | null = null;
    let modelId = 'unknown';
    let reservation: Reservation | undefined;
    let usedTokens = 0;
    // The response is completed only after money and capacity are settled, so a
    // client that fires its next request immediately sees consistent balances.
    let reply: { status: number; headers: Record<string, string>; body: string } | undefined;
    this.#inFlight++;
    d.metrics.inFlight.inc();

    try {
      // ---- rate limits
      const waitMs = this.#rpm.take(principal.keyId);
      if (waitMs > 0) {
        throw new ApiError(429, 'rate_limit_exceeded', 'Too many requests for this API key', { headers: { 'retry-after': String(Math.ceil(waitMs / 1000)) } });
      }
      releaseSlot = this.#concurrency.tryAcquire(principal.userId);
      if (!releaseSlot) throw new ApiError(429, 'concurrency_limit_exceeded', `At most ${d.cfg.relay.perUserConcurrency} concurrent requests per account`);

      // ---- parse & validate
      const body = field.object(await ctx.json());
      const requestedModel = field.string(body, 'model')!;
      if (!Array.isArray(body.messages) || body.messages.length === 0) throw badRequest('"messages" must be a non-empty array', 'messages');
      const model = d.cfg.models.find((m) => m.id === requestedModel);
      if (!model) throw new ApiError(404, 'model_not_found', `The model \`${requestedModel}\` does not exist`, { param: 'model' });
      modelId = model.id;
      const gate = this.#providerGate(model.provider);
      if (gate) throw new ApiError(503, 'provider_unavailable', `Model ${model.id} is unavailable: ${gate}`);
      const adapter = getAdapter(model.provider)!;

      const stream = body.stream === true;
      const clientWantsUsage = stream && (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
      const requestedMax = (body.max_completion_tokens ?? body.max_tokens) as number | undefined;
      if (requestedMax !== undefined && (typeof requestedMax !== 'number' || requestedMax < 1)) throw badRequest('max_tokens must be a positive integer', 'max_tokens');
      const maxOut = Math.min(requestedMax ?? model.defaultMaxOutput, model.maxOutput);
      if (body.max_completion_tokens !== undefined) body.max_completion_tokens = maxOut;
      else if (body.max_tokens !== undefined) body.max_tokens = maxOut;

      const estIn = this.estimatePromptTokens(body);
      const holdAmount = Math.max(1, costMicros(model, estIn, maxOut));
      trace.record.model = model.id;
      trace.record.stream = stream;
      trace.event('request.parsed', { model: model.id, stream, estPromptTokens: estIn, maxOutput: maxOut });
      if (d.cfg.log.logBodies) trace.event('request.body', { body });

      await d.db.exec(
        "INSERT INTO requests (id, user_id, api_key_id, model, stream, status, created_at) VALUES ($1,$2,$3,$4,$5,'pending',$6)",
        [ctx.requestId, principal.userId, principal.keyId, model.id, stream ? 1 : 0, iso(d.now())],
      );
      requestRow = true;

      // ---- hold funds
      if (!(await placeHold(d, principal.userId, ctx.requestId, holdAmount))) {
        trace.event('hold.insufficient', { needed: holdAmount });
        throw new ApiError(402, 'insufficient_quota', `Insufficient balance: this request may cost up to ${fmtUsd(holdAmount)}. Top up your account to continue.`);
      }
      holdPlaced = true;
      trace.event('hold.placed', { micros: holdAmount });

      // ---- route with failover
      const routed = await this.#route(ctx, trace, model, adapter, body, stream, maxOut, estIn);
      attempts = routed.attempts;
      if (!routed.ok) {
        httpStatus = routed.status;
        errorCode = routed.code;
        throw routed.error;
      }
      credentialId = routed.cred.id;
      reservation = routed.reservation;
      trace.record.summary = { credentialId: routed.cred.id, provider: model.provider };

      // ---- proxy
      let usage: ProxyResult;
      if (stream) {
        usage = await this.#proxyStream(ctx, trace, routed.res, routed.abort, estIn, clientWantsUsage);
      } else {
        const json = await this.#proxyJson(trace, routed.res, routed.abort, estIn);
        reply = { status: 200, headers: { 'content-type': 'application/json' }, body: json.text };
        usage = json;
      }
      httpStatus = 200;
      outcome = usage.clientAborted ? 'client_aborted' : usage.upstreamBroken ? 'upstream_broken' : 'ok';

      // ---- meter & settle
      usedTokens = usage.promptTokens + usage.completionTokens;
      const billable = usage.gotBytes;
      if (billable) {
        const settled = await this.#settleWithRetry({
          requestId: ctx.requestId,
          buyerId: principal.userId,
          sellerId: routed.cred.seller_id,
          credentialId: routed.cred.id,
          model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          estimated: usage.estimated,
        }, trace);
        holdPlaced = !settled;
      }
      d.metrics.tokens.inc({ model: model.id, direction: 'prompt' }, usage.promptTokens);
      d.metrics.tokens.inc({ model: model.id, direction: 'completion' }, usage.completionTokens);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(500, 'internal_error', 'Internal relay error', { cause: err });
      if (!(err instanceof ApiError)) d.log.error('relay internal error', { err });
      httpStatus = apiErr.status;
      errorCode ??= apiErr.code;
      outcome = apiErr.status >= 500 ? 'error' : 'rejected';
      trace.event('error', { status: apiErr.status, code: apiErr.code, message: apiErr.message });
      reply = { status: apiErr.status, headers: { 'content-type': 'application/json', ...apiErr.headers }, body: JSON.stringify(apiErr.toJSON()) };
    } finally {
      releaseSlot?.();
      if (reservation) await commitCapacity(d, reservation, usedTokens).catch((err) => d.log.error('capacity commit failed; reaper will retry', { err }));
      if (holdPlaced) {
        await releaseHold(d, ctx.requestId).catch((err) => d.log.error('hold release failed; reaper will retry', { err }));
        trace.event('hold.released');
      }
      this.#inFlight--;
      d.metrics.inFlight.dec();
      if (!ctx.res.headersSent && reply) {
        this.#debugHeaders(ctx, trace);
        ctx.res.writeHead(reply.status, { ...reply.headers, 'content-length': String(Buffer.byteLength(reply.body)) });
        ctx.res.end(reply.body);
      } else if (!ctx.res.writableEnded) {
        ctx.res.end(); // stream: terminate after settlement
      }
      const durationMs = trace.elapsed();
      if (requestRow) {
        await d.db
          .exec(
            'UPDATE requests SET status = $1, http_status = $2, attempts = $3, credential_id = $4, error_code = $5, latency_ms = $6, finished_at = $7 WHERE id = $8',
            [outcome, httpStatus, attempts, credentialId, errorCode, durationMs, iso(d.now()), ctx.requestId],
          )
          .catch((err) => d.log.error('request finalize failed', { err }));
      }
      Object.assign(trace.record, { outcome, httpStatus, durationMs });
      d.metrics.relayRequests.inc({ model: modelId, outcome });
      d.log.info('relay request', {
        userId: principal.userId, model: modelId, outcome, status: httpStatus, attempts, credentialId, durationMs, errorCode,
        ...(d.log.enabled('debug') ? { timeline: trace.compact() } : {}),
      });
      this.ring?.push(trace.record);
    }
  }

  estimatePromptTokens(body: Record<string, unknown>): number {
    const text = JSON.stringify(body.messages ?? '') + (body.tools ? JSON.stringify(body.tools) : '');
    return Math.ceil(text.length / this.#d.cfg.relay.charsPerToken);
  }

  async #candidates(model: ModelConfig): Promise<Candidate[]> {
    const rows = await this.#d.db.query<Candidate>(
      `SELECT c.*, COALESCE(w.used_tokens, 0) + COALESCE(w.reserved_tokens, 0) AS load
         FROM credentials c
         JOIN users u ON u.id = c.seller_id AND u.status = 'active'
         LEFT JOIN credential_windows w ON w.credential_id = c.id AND w.window_start = $2
        WHERE c.provider = $1 AND c.status = 'active' AND c.models LIKE $3`,
      [model.provider, windowStart(this.#d.now()), `%"${model.id}"%`],
    );
    // Least-loaded (by fraction of hourly budget) first; random tiebreak spreads load.
    return rows
      .filter((r) => (JSON.parse(r.models) as string[]).includes(model.id))
      .map((r) => ({ r, k: Number(r.load) / Math.max(1, Number(r.hourly_token_limit)) + Math.random() * 0.05 }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.r);
  }

  async #route(
    ctx: HttpContext, trace: Trace, model: ModelConfig, adapter: ProviderAdapter,
    body: Record<string, unknown>, stream: boolean, maxOut: number, estIn: number,
  ): Promise<
    | { ok: true; res: Response; abort: AbortController; cred: Candidate; reservation: Reservation; attempts: number }
    | { ok: false; status: number; code: string; error: ApiError; attempts: number }
  > {
    const d = this.#d;
    const candidates = await this.#candidates(model);
    trace.event('route.candidates', { count: candidates.length });
    let attempts = 0;
    let sawCapacityFull = false;
    let lastUpstreamStatus: number | undefined;
    const passthrough: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.req.headers)) if (k.startsWith('x-mock-') && typeof v === 'string') passthrough[k] = v;

    for (const cred of candidates) {
      if (attempts >= d.cfg.relay.maxAttempts) break;
      if (ctx.res.destroyed) break;
      if (!this.breakers.allow(cred.id)) {
        trace.event('route.skip', { credentialId: cred.id, reason: 'breaker_open' });
        continue;
      }
      const reservation = await reserveCapacity(d, ctx.requestId, cred, estIn + maxOut);
      if (!reservation) {
        sawCapacityFull = true;
        trace.event('route.skip', { credentialId: cred.id, reason: 'capacity_full' });
        continue;
      }
      attempts++;
      trace.event('capacity.reserved', { credentialId: cred.id, tokens: reservation.tokens, attempt: attempts });

      let secret: string;
      try {
        secret = decryptSecret(d, cred);
      } catch (err) {
        d.log.error('credential decrypt failed', { credentialId: cred.id, err });
        await commitCapacity(d, reservation, 0);
        await setCredentialStatus(d, cred.id, 'invalid', 'secret could not be decrypted');
        continue;
      }
      const req = adapter.buildChatRequest({ cfg: d.cfg, model, secret, baseUrl: cred.base_url, body, stream, maxOutput: maxOut, passthroughHeaders: passthrough });
      const abort = new AbortController();
      const ttfbTimer = setTimeout(() => abort.abort(new Error('upstream connect/TTFB timeout')), d.cfg.relay.upstreamConnectTimeoutMs);
      const onClientClose = () => abort.abort(new Error('client disconnected'));
      ctx.res.once('close', onClientClose);
      const t0 = performance.now();
      let res: Response;
      try {
        res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: abort.signal });
      } catch (err) {
        clearTimeout(ttfbTimer);
        ctx.res.off('close', onClientClose);
        const reason = (abort.signal.reason as Error | undefined)?.message ?? (err as Error).message;
        trace.event('upstream.network_error', { credentialId: cred.id, reason });
        d.metrics.upstreamAttempts.inc({ provider: model.provider, result: 'network_error' });
        this.breakers.failure(cred.id, reason);
        await commitCapacity(d, reservation, 0);
        continue;
      }
      clearTimeout(ttfbTimer);
      const ttfb = Math.round(performance.now() - t0);
      d.metrics.upstreamLatency.observe({ provider: model.provider }, ttfb);
      trace.event('upstream.response', { credentialId: cred.id, status: res.status, ttfbMs: ttfb });

      if (res.ok) {
        ctx.res.off('close', onClientClose);
        d.metrics.upstreamAttempts.inc({ provider: model.provider, result: 'ok' });
        this.breakers.success(cred.id);
        // Re-arm client-close abort for the proxy phase.
        ctx.res.once('close', () => { if (!ctx.res.writableFinished) abort.abort(new Error('client disconnected')); });
        return { ok: true, res, abort, cred, reservation, attempts };
      }

      ctx.res.off('close', onClientClose);
      lastUpstreamStatus = res.status;
      const errText = await readLimited(res, MAX_ERROR_BODY).catch(() => '');
      const cls = adapter.classifyError(res.status);
      d.metrics.upstreamAttempts.inc({ provider: model.provider, result: cls });
      await commitCapacity(d, reservation, 0);
      trace.event('upstream.error', { credentialId: cred.id, status: res.status, class: cls, ...(d.cfg.debug.enabled ? { body: errText.slice(0, 500) } : {}) });

      if (cls === 'client') {
        // The buyer's request is at fault; pass the upstream error through verbatim-ish.
        this.breakers.success(cred.id);
        return { ok: false, status: res.status, code: 'upstream_rejected_request', attempts, error: upstreamClientError(res.status, errText) };
      }
      if (cls === 'auth') {
        await setCredentialStatus(d, cred.id, 'invalid', `upstream returned ${res.status}`);
        continue;
      }
      if (cls === 'rate_limited') {
        const retryAfter = Number(res.headers.get('retry-after'));
        const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : d.cfg.relay.rateLimitCooldownMs;
        this.breakers.cooldown(cred.id, ms, 'upstream 429');
        continue;
      }
      this.breakers.failure(cred.id, `upstream ${res.status}`);
    }

    if (attempts === 0) {
      const msg = candidates.length === 0
        ? `No sellers currently offer ${model.id}`
        : sawCapacityFull ? `All capacity for ${model.id} is in use; retry shortly` : `No healthy capacity for ${model.id}; retry shortly`;
      return { ok: false, status: 503, code: 'no_capacity', attempts, error: new ApiError(503, 'no_capacity', msg, { headers: { 'retry-after': '5' } }) };
    }
    return {
      ok: false, status: 502, code: 'upstream_unavailable', attempts,
      error: new ApiError(502, 'upstream_unavailable', `Upstream failed after ${attempts} attempt(s)${lastUpstreamStatus ? ` (last status ${lastUpstreamStatus})` : ''}`),
    };
  }

  async #proxyJson(trace: Trace, res: Response, abort: AbortController, estIn: number): Promise<ProxyResult & { text: string }> {
    const d = this.#d;
    let text: string;
    const idle = setTimeout(() => abort.abort(new Error('upstream idle timeout')), d.cfg.relay.upstreamIdleTimeoutMs);
    try {
      text = await res.text();
    } catch (err) {
      trace.event('upstream.body_error', { reason: (abort.signal.reason as Error | undefined)?.message ?? (err as Error).message });
      throw new ApiError(502, 'upstream_unavailable', 'Upstream connection failed while reading the response');
    } finally {
      clearTimeout(idle);
    }
    let usage: Usage = { promptTokens: estIn, completionTokens: 0, estimated: true };
    try {
      const parsed = JSON.parse(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { message?: { content?: string } }[] };
      if (parsed.usage && typeof parsed.usage.prompt_tokens === 'number') {
        usage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens ?? 0, estimated: false };
      } else {
        const out = parsed.choices?.map((c) => c.message?.content ?? '').join('') ?? '';
        usage.completionTokens = Math.ceil(out.length / d.cfg.relay.charsPerToken);
      }
    } catch {
      usage.completionTokens = Math.ceil(text.length / d.cfg.relay.charsPerToken);
    }
    trace.event('usage.captured', { ...usage });
    return { ...usage, gotBytes: true, clientAborted: false, upstreamBroken: false, text };
  }

  async #proxyStream(
    ctx: HttpContext, trace: Trace, res: Response, abort: AbortController, estIn: number, clientWantsUsage: boolean,
  ): Promise<ProxyResult> {
    const d = this.#d;
    this.#debugHeaders(ctx, trace);
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    ctx.res.flushHeaders();

    let captured: { prompt_tokens: number; completion_tokens: number } | undefined;
    let outChars = 0;
    let gotBytes = false;
    let upstreamBroken = false;
    let skipBlank = false;
    const splitter = new SseLineSplitter();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const handleLine = (line: string): string | null => {
      if (line === '') {
        if (skipBlank) {
          skipBlank = false;
          return null;
        }
        return '';
      }
      if (!line.startsWith('data:')) return line;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return line;
      try {
        const chunk = JSON.parse(data) as {
          usage?: { prompt_tokens: number; completion_tokens: number } | null;
          choices?: { delta?: { content?: string | null; tool_calls?: unknown; reasoning_content?: string | null } }[];
        };
        if (chunk.usage && typeof chunk.usage.prompt_tokens === 'number') captured = chunk.usage;
        for (const c of chunk.choices ?? []) {
          outChars += (c.delta?.content?.length ?? 0) + (c.delta?.reasoning_content?.length ?? 0);
          if (c.delta?.tool_calls) outChars += JSON.stringify(c.delta.tool_calls).length;
        }
        if (!clientWantsUsage && chunk.usage && (chunk.choices?.length ?? 0) === 0) {
          skipBlank = true;
          return null;
        }
      } catch {
        // Not JSON: forward untouched.
      }
      return line;
    };

    const writeOut = (s: string) => {
      if (!ctx.res.destroyed) ctx.res.write(s);
    };

    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort.abort(new Error('upstream idle timeout')), d.cfg.relay.upstreamIdleTimeoutMs);
    };
    armIdle();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armIdle();
        if (!gotBytes) {
          gotBytes = true;
          trace.event('stream.first_byte');
        }
        let out = '';
        for (const line of splitter.push(decoder.decode(value, { stream: true }))) {
          const kept = handleLine(line);
          if (kept !== null) out += kept + '\n';
        }
        if (out) writeOut(out);
      }
      let tail = '';
      for (const line of splitter.flush(decoder.decode())) {
        const kept = handleLine(line);
        if (kept !== null) tail += kept + '\n';
      }
      if (tail) writeOut(tail);
    } catch (err) {
      const reason = (abort.signal.reason as Error | undefined)?.message ?? (err as Error).message;
      upstreamBroken = reason !== 'client disconnected';
      trace.event(upstreamBroken ? 'stream.upstream_error' : 'stream.client_aborted', { reason });
      if (upstreamBroken) {
        writeOut(`data: ${JSON.stringify({ error: { message: 'Upstream stream interrupted', type: 'api_error', code: 'upstream_interrupted' } })}\n\n`);
      }
    } finally {
      clearTimeout(idleTimer);
      reader.releaseLock();
    }
    const clientAborted = ctx.res.destroyed && !ctx.res.writableFinished;

    const usage: Usage = captured
      ? { promptTokens: captured.prompt_tokens, completionTokens: captured.completion_tokens, estimated: false }
      : { promptTokens: estIn, completionTokens: Math.ceil(outChars / d.cfg.relay.charsPerToken), estimated: true };
    trace.event('usage.captured', { ...usage });
    return { ...usage, gotBytes, clientAborted, upstreamBroken };
  }

  async #settleWithRetry(input: Parameters<typeof settleUsage>[1], trace: Trace): Promise<boolean> {
    const d = this.#d;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await settleUsage(d, input);
        trace.event('settle.ok', { cost: r.cost, seller: r.sellerCredit, platform: r.platformFee, estimated: input.estimated });
        d.metrics.revenue.inc({ model: input.model.id, recipient: 'seller' }, r.sellerCredit);
        d.metrics.revenue.inc({ model: input.model.id, recipient: 'platform' }, r.platformFee);
        return true;
      } catch (err) {
        trace.event('settle.retry', { attempt: i + 1, error: (err as Error).message });
        await new Promise((r) => setTimeout(r, 50 * 2 ** i));
      }
    }
    // Leave a loud, structured record for manual reconciliation. The hold is released (buyer not charged).
    d.log.error('settle.failed', { ...input, model: input.model.id });
    return false;
  }

  #debugHeaders(ctx: HttpContext, trace: Trace) {
    if (this.#d.cfg.debug.timelineHeader && !ctx.res.headersSent) ctx.res.setHeader('x-relay-debug', trace.compact().slice(0, 4000));
  }
}

async function readLimited(res: Response, limit: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= limit) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, limit);
}

function upstreamClientError(status: number, text: string): ApiError {
  let message = `Upstream rejected the request (HTTP ${status})`;
  let param: string | undefined;
  try {
    const e = (JSON.parse(text) as { error?: { message?: string; param?: string } }).error;
    if (e?.message) message = e.message;
    if (e?.param) param = e.param;
  } catch {
    /* keep default */
  }
  return new ApiError(status, 'upstream_rejected_request', message, param ? { param } : {});
}
