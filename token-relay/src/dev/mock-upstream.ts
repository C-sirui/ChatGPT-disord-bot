import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config/types.ts';
import { createLogger, type Logger } from '../lib/log.ts';

/**
 * Deterministic OpenAI-compatible fake upstream for development and tests.
 *
 * Fault injection (per request header, forwarded by the relay for provider=mock):
 *   x-mock-fault: 429 | 500 | 503 | 401 | 400 | hang | drop | no-usage
 * or randomly via dev.mockUpstream.faultRate / faultStatus.
 *
 * Special secrets: "mock-invalid" always yields 401; "mock-fail-<status>…" always
 * yields <status> (e.g. mock-fail-500-a), which lets tests exercise failover per credential.
 */
export interface MockUpstream {
  url: string;
  requests: { auth: string | undefined; body: Record<string, unknown>; headers: IncomingMessage['headers'] }[];
  close(): Promise<void>;
}

type MockCfg = Config['dev']['mockUpstream'];

const WORDS = 'the quick relay routes tokens across honest sellers while buyers build useful software with streaming completions and fair metering'.split(' ');

function lastUserText(body: Record<string, unknown>): string {
  const msgs = (body.messages as { role: string; content: unknown }[] | undefined) ?? [];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) return last.content.map((p: { text?: string }) => p.text ?? '').join(' ');
  return '';
}

/** One "token" == one word. Output length = min(max_tokens, 12 + words in the prompt). */
export function mockCompletion(body: Record<string, unknown>): { words: string[]; promptTokens: number } {
  const prompt = JSON.stringify(body.messages ?? []);
  const promptTokens = Math.ceil(prompt.length / 4);
  const max = Number(body.max_tokens ?? body.max_completion_tokens ?? 64);
  const text = lastUserText(body);
  const n = Math.max(1, Math.min(max, 12 + text.split(/\s+/).filter(Boolean).length));
  const words = [`Echo(${text.slice(0, 40)}):`];
  for (let i = 1; i < n; i++) words.push(WORDS[i % WORDS.length]!);
  return { words, promptTokens };
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function startMockUpstream(cfg: MockCfg, log: Logger, port = cfg.port): Promise<MockUpstream> {
  const requests: MockUpstream['requests'] = [];
  const sockets = new Set<import('node:net').Socket>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization?.replace(/^Bearer /, '');
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      if (!auth || auth === 'mock-invalid') return json(res, 401, { error: { message: 'invalid key', type: 'authentication_error' } });
      return json(res, 200, { object: 'list', data: [{ id: 'mock-fast', object: 'model' }] });
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) return json(res, 404, { error: { message: 'not found' } });

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    requests.push({ auth, body, headers: req.headers });
    log.debug('mock upstream request', { model: body.model, stream: body.stream, fault: req.headers['x-mock-fault'] });

    await sleep(cfg.latencyMs);
    if (!auth || auth === 'mock-invalid') return json(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });

    let fault = req.headers['x-mock-fault'] as string | undefined;
    const keyFault = auth.match(/^mock-fail-(\d{3})/);
    if (keyFault) fault = keyFault[1];
    if (!fault && cfg.faultRate > 0 && Math.random() < cfg.faultRate) fault = String(cfg.faultStatus);
    if (fault && /^\d{3}$/.test(fault)) {
      const status = Number(fault);
      return json(res, status, { error: { message: `mock fault ${status}`, type: status === 400 ? 'invalid_request_error' : 'server_error', param: status === 400 ? 'messages' : null } },
        status === 429 ? { 'retry-after': '1' } : {});
    }
    if (fault === 'hang') return; // never respond; relay TTFB timeout must fire

    const { words, promptTokens } = mockCompletion(body);
    const id = `chatcmpl-mock-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: promptTokens, completion_tokens: words.length, total_tokens: promptTokens + words.length };
    const noUsage = fault === 'no-usage';

    if (!body.stream) {
      return json(res, 200, {
        id, object: 'chat.completion', created, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: words.join(' ') }, finish_reason: 'stop' }],
        ...(noUsage ? {} : { usage }),
      });
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    for (let i = 0; i < words.length; i++) {
      if (res.destroyed) return;
      await sleep(cfg.chunkDelayMs);
      if (fault === 'drop' && i === Math.floor(words.length / 2)) {
        await sleep(20); // let already-written chunks reach the relay first
        res.destroy();
        return;
      }
      send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: (i ? ' ' : '') + words[i] }, finish_reason: null }] });
    }
    send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    const includeUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage;
    if (includeUsage && !noUsage) send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('mock upstream error', { err });
      if (!res.headersSent) json(res, 500, { error: { message: 'mock crashed' } });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  log.info('mock upstream listening', { url });
  return {
    url,
    requests,
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

// Standalone: `npm run mock-upstream` (PORT, default 9797).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const log = createLogger({ level: 'debug', format: 'pretty' });
  await startMockUpstream({ enabled: true, port: Number(process.env.PORT ?? 9797), latencyMs: 20, chunkDelayMs: 30, faultRate: 0, faultStatus: 503 }, log);
}
