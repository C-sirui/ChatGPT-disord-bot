import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, parseSse, type TestApp } from './helpers.ts';
import { reconcile } from '../src/domain/ledger.ts';
import { split } from '../src/domain/money.ts';

// mock-fast: $1/M input, $2/M output → cost micros = prompt + 2*completion.
const expectedCost = (u: { prompt_tokens: number; completion_tokens: number }) => u.prompt_tokens + 2 * u.completion_tokens;

async function assertReconciled(t: TestApp) {
  const r = await reconcile(t.deps.db);
  assert.ok(r.ok, JSON.stringify(r));
}

describe('relay end-to-end', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test('health, readiness, metrics', async () => {
    assert.equal((await t.req('GET', '/healthz')).status, 200);
    assert.deepEqual((await t.req('GET', '/readyz')).body, { status: 'ready' });
    assert.match((await t.req('GET', '/metrics')).text, /tr_http_requests_total/);
  });

  test('auth errors are OpenAI-shaped', async () => {
    const r = await t.chat('trk_nope', {});
    assert.equal(r.status, 401);
    assert.equal(r.body.error.type, 'authentication_error');
    assert.equal((await t.req('GET', '/v1/me')).status, 401);
  });

  test('non-streaming request is billed exactly from upstream usage', async () => {
    const seller = await t.seller('s1@test.dev');
    const buyer = await t.buyer('b1@test.dev', 10);
    const before = await t.wallet(buyer.token);
    assert.equal(before.available_micros, 10_000_000);

    const r = await t.chat(buyer.key, {});
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.choices[0].message.content, /Echo\(hello world\)/);
    assert.ok(r.headers.get('x-request-id'));
    assert.match(r.headers.get('x-relay-debug') ?? '', /hold\.placed/);

    const cost = expectedCost(r.body.usage);
    const after = await t.wallet(buyer.token);
    assert.equal(after.available_micros, 10_000_000 - cost);
    assert.equal(after.held_micros, 0);
    assert.equal((await t.wallet(seller.token)).earned_micros, split(cost, 0.2).seller);

    // Upstream saw the seller's secret and our injected max_tokens, not the buyer's key.
    const up = t.mock.requests.at(-1)!;
    assert.equal(up.auth, 'mock-secret-1');
    assert.equal(up.body.max_tokens, 64);
    await assertReconciled(t);
  });

  test('streaming: passthrough, usage chunk hidden unless requested, billed', async () => {
    const buyer = await t.buyer('b2@test.dev', 10);
    const r = await t.chat(buyer.key, { stream: true });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const sse = parseSse(r.text);
    assert.ok(sse.done);
    assert.ok(sse.data.every((c) => c.choices.length > 0), 'usage-only chunk should be stripped');
    const text = sse.data.map((c) => c.choices[0].delta.content ?? '').join('');
    assert.match(text, /^Echo\(hello world\):/);
    // Upstream was asked for usage even though the client was not.
    assert.equal((t.mock.requests.at(-1)!.body.stream_options as { include_usage: boolean }).include_usage, true);

    const r2 = await t.chat(buyer.key, { stream: true, stream_options: { include_usage: true } });
    const usageChunk = parseSse(r2.text).data.find((c) => c.usage);
    assert.ok(usageChunk, 'client asked for usage');
    const w = await t.wallet(buyer.token);
    assert.equal(w.held_micros, 0);
    assert.ok(w.available_micros < 10_000_000 - expectedCost(usageChunk.usage));
    await assertReconciled(t);
  });

  test('insufficient balance → 402 before any upstream call', async () => {
    const buyer = await t.buyer('broke@test.dev', 0);
    const n = t.mock.requests.length;
    const r = await t.chat(buyer.key, {});
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, 'insufficient_quota');
    assert.equal(t.mock.requests.length, n);
  });

  test('unknown model → 404; provider without resale agreement is gated', async () => {
    const buyer = await t.buyer('b3@test.dev', 1);
    assert.equal((await t.chat(buyer.key, { model: 'nope' })).status, 404);
    const gated = await t.chat(buyer.key, { model: 'gpt-4o-mini' });
    assert.equal(gated.status, 503);
    assert.match(gated.body.error.message, /reseller agreement/);
    const models = await t.req('GET', '/v1/models', { token: buyer.key });
    assert.deepEqual(models.body.data.map((m: { id: string }) => m.id), ['mock-fast']);
  });

  test('client 400 is passed through without failover or charge', async () => {
    const buyer = await t.buyer('b4@test.dev', 1);
    const r = await t.chat(buyer.key, {}, { 'x-mock-fault': '400' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.param, 'messages');
    const w = await t.wallet(buyer.token);
    assert.equal(w.available_micros, 1_000_000);
    assert.equal(w.held_micros, 0);
  });

  test('no usage from upstream → estimated billing, flagged', async () => {
    const buyer = await t.buyer('b5@test.dev', 1);
    const r = await t.chat(buyer.key, {}, { 'x-mock-fault': 'no-usage' });
    assert.equal(r.status, 200);
    const usage = await t.req('GET', '/v1/billing/usage', { token: buyer.token });
    assert.equal(usage.body.data[0].estimated, 1);
    assert.ok(usage.body.data[0].buyer_cost_micros > 0);
    await assertReconciled(t);
  });

  test('upstream drops mid-stream → error event, partial usage billed as estimate', async () => {
    const buyer = await t.buyer('b6@test.dev', 1);
    const r = await t.chat(buyer.key, { stream: true }, { 'x-mock-fault': 'drop' });
    assert.equal(r.status, 200);
    assert.match(r.text, /upstream_interrupted/);
    const u = (await t.req('GET', '/v1/billing/usage', { token: buyer.token })).body.data[0];
    assert.equal(u.estimated, 1);
    const trace = await t.admin(`/debug/requests/${r.headers.get('x-request-id')}`);
    assert.equal(trace.body.trace.outcome, 'upstream_broken');
    await assertReconciled(t);
  });

  test('rejects malformed input', async () => {
    const buyer = await t.buyer('b7@test.dev', 1);
    assert.equal((await t.chat(buyer.key, { messages: [] })).status, 400);
    assert.equal((await t.chat(buyer.key, { max_tokens: -1 })).status, 400);
    const bad = await fetch(t.url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${buyer.key}` }, body: '{nope' });
    assert.equal(bad.status, 400);
  });

  test('debug surface requires admin token outside localhost-dev mode', async () => {
    assert.equal((await t.req('GET', '/debug/config')).status, 401);
    const cfg = await t.admin('/debug/config');
    assert.equal(cfg.status, 200);
    assert.match(cfg.body.config.security.masterKey, /^\*\*\*/);
    assert.equal(cfg.body.sources['db.driver'], process.env.TEST_DATABASE_URL ? 'overrides' : 'test.json');
    const list = await t.admin('/debug/requests?limit=5');
    assert.ok(list.body.data.length > 0);
    const router = await t.admin('/debug/router');
    assert.ok(Array.isArray(router.body.windows));
  });
});

describe('routing, failover and capacity', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test('fails over from 500 and 401 credentials; 401 marks credential invalid', async () => {
    const seller = await t.seller('s@test.dev', [
      { apiKey: 'mock-fail-500-a', hourlyTokenLimit: 1_000_000 },
      { apiKey: 'mock-invalid', hourlyTokenLimit: 1_000_000 },
    ]);
    // Only bad credentials → 502 after trying both.
    const buyer = await t.buyer('b@test.dev', 5);
    const bad = await t.chat(buyer.key, {});
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error.code, 'upstream_unavailable');
    let w = await t.wallet(buyer.token);
    assert.equal(w.available_micros, 5_000_000, 'failed request must not be charged');

    const creds = (await t.req('GET', '/v1/seller/credentials', { token: seller.token })).body.data;
    assert.deepEqual(creds.map((c: { status: string }) => c.status).sort(), ['active', 'invalid']);

    // Add a good credential; request now succeeds on a later attempt.
    await t.req('POST', '/v1/seller/credentials', { token: seller.token, body: { provider: 'mock', apiKey: 'mock-good-secret', hourlyTokenLimit: 1_000_000 } });
    const ok = await t.chat(buyer.key, {});
    assert.equal(ok.status, 200, ok.text);
    w = await t.wallet(buyer.token);
    assert.equal(w.available_micros, 5_000_000 - expectedCost(ok.body.usage));
    assert.equal(t.mock.requests.at(-1)!.auth, 'mock-good-secret');
  });

  test('hourly capacity limit is enforced atomically', async () => {
    const t2 = await startTestApp();
    try {
      // Each request reserves est_prompt + max_output(64) tokens; limit fits exactly one in flight at a time.
      await t2.seller('cap@test.dev', [{ apiKey: 'mock-cap', hourlyTokenLimit: 1000, maxConcurrency: 1 }]);
      const buyer = await t2.buyer('capb@test.dev', 5);
      const results = await Promise.all(Array.from({ length: 6 }, () => t2.chat(buyer.key, {})));
      const codes = results.map((r) => r.status);
      assert.ok(codes.includes(200));
      assert.ok(codes.includes(503), `expected some 503 no_capacity, got ${codes}`);
      const windows = (await t2.admin('/debug/router')).body.windows;
      assert.equal(windows[0].in_flight, 0);
      assert.equal(windows[0].reserved_tokens, 0);
      assert.ok(windows[0].used_tokens <= 1000);
      await assertReconciled(t2);
    } finally {
      await t2.close();
    }
  });

  test('parallel load: balance never double-spent, ledger reconciles', async () => {
    const t3 = await startTestApp({ relay: { perUserConcurrency: 64, perKeyRequestsPerMinute: 1000 } });
    try {
      await t3.seller('p@test.dev', [{ apiKey: 'mock-par-1' }, { apiKey: 'mock-par-2' }]);
      const buyer = await t3.buyer('pb@test.dev', 5);
      // Shrink balance so only some requests fit: set available to ~3 holds.
      await t3.admin(`/admin/users/${buyer.id}/adjust`, 'POST', { amountUsd: -4.9993, ref: 'shrink' });
      const results = await Promise.all(Array.from({ length: 20 }, () => t3.chat(buyer.key, {})));
      const ok = results.filter((r) => r.status === 200).length;
      const denied = results.filter((r) => r.status === 402).length;
      assert.equal(ok + denied, 20);
      assert.ok(ok >= 1 && denied >= 1, `ok=${ok} denied=${denied}`);
      const w = await t3.wallet(buyer.token);
      assert.equal(w.held_micros, 0);
      assert.ok(w.available_micros >= 0);
      await assertReconciled(t3);
    } finally {
      await t3.close();
    }
  });

  test('per-key rate limit → 429 with retry-after', async () => {
    const t4 = await startTestApp({ relay: { perKeyRequestsPerMinute: 2 } });
    try {
      await t4.seller('rl@test.dev');
      const buyer = await t4.buyer('rlb@test.dev', 1);
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await t4.chat(buyer.key, {})).status);
      assert.deepEqual(codes, [200, 200, 429]);
    } finally {
      await t4.close();
    }
  });

  test('breaker opens on repeated 5xx and skips the credential', async () => {
    const t5 = await startTestApp({ relay: { maxAttempts: 1 } });
    try {
      await t5.seller('br@test.dev', [{ apiKey: 'mock-fail-503-z' }]);
      const buyer = await t5.buyer('brb@test.dev', 1);
      assert.equal((await t5.chat(buyer.key, {})).status, 502);
      assert.equal((await t5.chat(buyer.key, {})).status, 502);
      const n = t5.mock.requests.length;
      const third = await t5.chat(buyer.key, {});
      assert.equal(third.status, 503, 'breaker open → no attempt');
      assert.equal(t5.mock.requests.length, n);
    } finally {
      await t5.close();
    }
  });
});

describe('marketplace money flows', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(() => t.close());

  test('seller earnings → payout request → reject reverses → paid', async () => {
    const seller = await t.seller('earn@test.dev');
    const buyer = await t.buyer('spend@test.dev', 50);
    // Generate earnings: big outputs.
    for (let i = 0; i < 3; i++) assert.equal((await t.chat(buyer.key, { max_tokens: 4000, messages: [{ role: 'user', content: 'x '.repeat(3000) }] })).status, 200);
    const e = await t.req('GET', '/v1/seller/earnings', { token: seller.token });
    assert.ok(e.body.earned > 0);
    assert.equal(e.body.withdrawable, e.body.earned); // holdDays=0 in test

    // Below minimum
    assert.equal((await t.req('POST', '/v1/seller/payouts', { token: seller.token, body: { amountUsd: 1 } })).status, 400);
    // Top the seller's earnings up via admin adjustment path is not allowed (adjust credits available, not earnings) → use real earnings only.
    const over = await t.req('POST', '/v1/seller/payouts', { token: seller.token, body: { amountUsd: 10_000 } });
    assert.equal(over.status, 402);
    await assertReconciled(t);
  });

  test('payout lifecycle with sufficient earnings', async () => {
    const t2 = await startTestApp({ payouts: { minUsd: 0 } });
    try {
      const seller = await t2.seller('pay@test.dev');
      const buyer = await t2.buyer('payb@test.dev', 5);
      await t2.chat(buyer.key, {});
      const earned = (await t2.wallet(seller.token)).earned_micros;
      const amountUsd = Math.floor(earned / 2) / 1_000_000;
      const p = await t2.req('POST', '/v1/seller/payouts', { token: seller.token, body: { amountUsd } });
      assert.equal(p.status, 201, p.text);
      assert.equal((await t2.wallet(seller.token)).earned_micros, earned - p.body.amountMicros);
      assert.equal((await t2.admin(`/admin/payouts/${p.body.id}/rejected`, 'POST', { note: 'kyc' })).status, 200);
      assert.equal((await t2.wallet(seller.token)).earned_micros, earned);
      assert.equal((await t2.admin(`/admin/payouts/${p.body.id}/paid`, 'POST')).status, 409);

      const p2 = await t2.req('POST', '/v1/seller/payouts', { token: seller.token, body: { amountUsd } });
      assert.equal((await t2.admin(`/admin/payouts/${p2.body.id}/paid`, 'POST')).body.status, 'paid');
      const rec = await t2.admin('/admin/reconcile');
      assert.equal(rec.body.ok, true, JSON.stringify(rec.body));
    } finally {
      await t2.close();
    }
  });

  test('admin guards and key revocation', async () => {
    const u = await t.buyer('guard@test.dev', 1);
    assert.equal((await t.req('GET', '/admin/users', { token: u.token })).status, 403);
    const keys = await t.req('GET', '/v1/keys', { token: u.token });
    assert.equal((await t.req('DELETE', `/v1/keys/${keys.body.data[0].id}`, { token: u.token })).status, 200);
    assert.equal((await t.chat(u.key, {})).status, 401);
  });

  test('credential registration: duplicate rejected, secrets never returned', async () => {
    const s = await t.user('dup@test.dev');
    const body = { provider: 'mock', apiKey: 'mock-dup-secret-123', hourlyTokenLimit: 5000 };
    const a = await t.req('POST', '/v1/seller/credentials', { token: s.token, body });
    assert.equal(a.status, 201);
    assert.ok(!JSON.stringify(a.body).includes('mock-dup-secret-123'));
    assert.equal(a.body.secret_mask, 'mock-d…-123');
    assert.equal((await t.req('POST', '/v1/seller/credentials', { token: s.token, body })).status, 409);
    const row = await t.deps.db.one<{ secret_ciphertext: string }>('SELECT secret_ciphertext FROM credentials WHERE id = $1', [a.body.id]);
    assert.ok(row!.secret_ciphertext.startsWith('v1.test.'));
    assert.equal((await t.req('POST', '/v1/seller/credentials', { token: s.token, body: { ...body, apiKey: 'x'.repeat(20), provider: 'openai_compatible', baseUrl: 'ftp://x' } })).status, 400);
  });

  test('register validation and login', async () => {
    assert.equal((await t.req('POST', '/v1/auth/register', { body: { email: 'bad', password: 'pw-123456' } })).status, 400);
    await t.user('login@test.dev', 'pw-abcdef');
    assert.equal((await t.req('POST', '/v1/auth/register', { body: { email: 'LOGIN@test.dev', password: 'pw-abcdef' } })).status, 409);
    assert.equal((await t.req('POST', '/v1/auth/login', { body: { email: 'login@test.dev', password: 'nope' } })).status, 401);
    const ok = await t.req('POST', '/v1/auth/login', { body: { email: 'Login@Test.dev', password: 'pw-abcdef' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token.startsWith('trs_'));
  });
});
