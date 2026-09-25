import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redactConfig } from '../src/config/load.ts';
import { ConfigError } from '../src/config/validate.ts';
import { Vault, hashPassword, verifyPassword, hmacSha256hex } from '../src/lib/crypto.ts';
import { split, costMicros } from '../src/domain/money.ts';
import { SseLineSplitter } from '../src/relay/sse.ts';
import { Breakers } from '../src/relay/breaker.ts';
import { TokenBuckets } from '../src/lib/ratelimit.ts';
import { isPrivateAddress } from '../src/lib/netguard.ts';
import { stripePayments } from '../src/payments/stripe.ts';
import { windowStart } from '../src/relay/capacity.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');

test('config: layering, env overrides and source tracking', () => {
  const { config, sources } = loadConfig({ env: { TR_ENV: 'test', TR_RELAY__MAX_ATTEMPTS: '5', TR_LOG__LEVEL: 'debug' } });
  assert.equal(config.env, 'test');
  assert.equal(config.relay.maxAttempts, 5);
  assert.equal(sources['relay.maxAttempts'], 'env:TR_RELAY__MAX_ATTEMPTS');
  assert.equal(sources['db.driver'], 'test.json');
  assert.equal(sources['relay.holdTtlMs'], 'default.json');
  assert.equal(config.log.level, 'debug');
});

test('config: unknown keys and bad types fail fast with paths', () => {
  assert.throws(() => loadConfig({ env: { TR_ENV: 'test', TR_RELAY__MAX_ATEMPTS: '5' } }), (e: ConfigError) => e.problems.some((p) => p.includes('relay.maxAtempts: unknown')));
  assert.throws(() => loadConfig({ env: { TR_ENV: 'test', TR_SERVER__PORT: '"abc"' } }), (e: ConfigError) => e.problems.some((p) => p.startsWith('server.port')));
});

test('config: production refuses dev conveniences', () => {
  try {
    loadConfig({ env: { TR_ENV: 'production', TR_DEBUG__ENABLED: 'true', TR_LOG__LOG_BODIES: 'true', TR_PAYMENTS__PROVIDER: 'fake' } });
    assert.fail('should throw');
  } catch (e) {
    const probs = (e as ConfigError).problems.join('\n');
    for (const needle of ['masterKey', 'logBodies', 'payments.provider=fake', 'debug.enabled requires', 'db.url']) assert.match(probs, new RegExp(needle));
  }
  const ok = loadConfig({
    env: { TR_ENV: 'production', TR_MASTER_KEY: KEY, DATABASE_URL: 'postgres://u:secretpw@db:5432/relay', STRIPE_SECRET_KEY: 'sk_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' },
  });
  const red = JSON.stringify(redactConfig(ok.config));
  assert.ok(!red.includes('secretpw') && !red.includes(KEY) && !red.includes('sk_x'));
  assert.ok(red.includes('db:5432'));
});

test('vault: round trip, AAD binding, key rotation', () => {
  const v1 = new Vault('k1', KEY);
  const blob = v1.encrypt('sk-secret', 'credential:a');
  assert.equal(v1.decrypt(blob, 'credential:a'), 'sk-secret');
  assert.throws(() => v1.decrypt(blob, 'credential:b'));
  const v2 = new Vault('k2', Buffer.alloc(32, 9).toString('base64'), { k1: KEY });
  assert.equal(v2.decrypt(blob, 'credential:a'), 'sk-secret');
  assert.equal(v2.keyIdOf(v2.encrypt('x')), 'k2');
});

test('passwords: scrypt verify', async () => {
  const h = await hashPassword('correct horse', 1024);
  assert.ok(await verifyPassword('correct horse', h));
  assert.ok(!(await verifyPassword('wrong horse', h)));
});

test('money: split always sums to cost; cost uses per-token micros', () => {
  for (const c of [0, 1, 7, 99, 1_000_001]) {
    const s = split(c, 0.2);
    assert.equal(s.seller + s.platform, c);
    assert.ok(s.platform >= 0);
  }
  const m = { id: 'm', provider: 'mock', upstreamModel: 'm', inputUsdPerMTok: 1, outputUsdPerMTok: 2, maxOutput: 10, defaultMaxOutput: 5 };
  assert.equal(costMicros(m, 1_000_000, 0), 1_000_000); // $1 per 1M input tokens
  assert.equal(costMicros(m, 10, 10), 30);
});

test('sse splitter handles split lines and CRLF', () => {
  const s = new SseLineSplitter();
  assert.deepEqual(s.push('data: {"a"'), []);
  assert.deepEqual(s.push(':1}\r\n\r\ndata: [DO'), ['data: {"a":1}', '']);
  assert.deepEqual(s.flush('NE]'), ['data: [DONE]']);
});

test('breaker: opens after threshold, half-open trial, cooldown on 429', () => {
  let now = 0;
  const b = new Breakers(2, 1000, () => now);
  b.failure('c', 'x');
  assert.ok(b.allow('c'));
  b.failure('c', 'x');
  assert.ok(!b.allow('c'));
  now = 1001;
  assert.ok(b.allow('c')); // half-open trial
  assert.ok(!b.allow('c')); // only one trial
  b.success('c');
  assert.ok(b.allow('c'));
  b.cooldown('c', 500, '429');
  assert.ok(!b.allow('c'));
});

test('token bucket rate limiter', () => {
  let now = 0;
  const tb = new TokenBuckets(2, () => now);
  assert.equal(tb.take('k'), 0);
  assert.equal(tb.take('k'), 0);
  assert.ok(tb.take('k') > 0);
  now += 30_000;
  assert.equal(tb.take('k'), 0);
});

test('SSRF guard classifies private ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('capacity windows are hour buckets', () => {
  assert.equal(windowStart(new Date('2026-09-25T13:47:12.345Z')), '2026-09-25T13:00:00.000Z');
});

test('stripe webhook: signature, tolerance, event mapping', () => {
  const secret = 'whsec_test';
  const now = 1_800_000_000;
  const p = stripePayments({ secretKey: 'sk', webhookSecret: secret, successUrl: '', cancelUrl: '', apiBase: '' }, () => now);
  const body = Buffer.from(JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 1000, metadata: { payment_id: 'pay_1' } } },
  }));
  const sig = (t: number, s = secret) => `t=${t},v1=${hmacSha256hex(s, `${t}.${body.toString()}`)}`;
  assert.deepEqual(p.parseWebhook(body, { 'stripe-signature': sig(now) }), { type: 'payment_succeeded', paymentId: 'pay_1', externalId: 'cs_1', amountMicros: 10_000_000 });
  assert.throws(() => p.parseWebhook(body, { 'stripe-signature': sig(now, 'wrong') }), /mismatch/);
  assert.throws(() => p.parseWebhook(body, { 'stripe-signature': sig(now - 1000) }), /tolerance/);
  assert.throws(() => p.parseWebhook(body, {}), /Missing/);
});
