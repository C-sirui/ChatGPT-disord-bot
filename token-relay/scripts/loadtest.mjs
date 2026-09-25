// Load test: many concurrent streaming chat requests against a running relay.
//
//   node scripts/loadtest.mjs [relayPid]
//
// Env: RELAY_URL (default http://127.0.0.1:8787), RELAY_KEY (default dev buyer key),
//      MODEL (mock-fast), LEVELS (e.g. "50,200,500"), SECONDS (20), MAX_TOKENS (60).
// Pass the relay's PID to also report its CPU (% of one core) and peak memory (Linux only).
import { readFileSync } from 'node:fs';

const pid = process.argv[2];
const base = process.env.RELAY_URL ?? 'http://127.0.0.1:8787';
const key = process.env.RELAY_KEY ?? 'trk_dev_buyer_0000000000000000000000000000000';
const model = process.env.MODEL ?? 'mock-fast';
const levels = (process.env.LEVELS ?? '50,200,500').split(',').map(Number);
const seconds = Number(process.env.SECONDS ?? 20);
const maxTokens = Number(process.env.MAX_TOKENS ?? 60);

const cpuSeconds = () => {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return (Number(f[11]) + Number(f[12])) / 100;
};
const rssMb = () => Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024;

async function one() {
  const t0 = performance.now();
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_tokens: maxTokens, messages: [{ role: 'user', content: 'write a function that sorts a list of numbers please' }] }),
  });
  await r.text();
  return { ok: r.status === 200, ms: performance.now() - t0 };
}

for (const conc of levels) {
  const end = Date.now() + seconds * 1000;
  let ok = 0, fail = 0, peak = 0;
  const lat = [];
  const c0 = pid ? cpuSeconds() : 0;
  const t0 = Date.now();
  const mon = pid ? setInterval(() => { peak = Math.max(peak, rssMb()); }, 250) : undefined;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) {
      try { const r = await one(); r.ok ? ok++ : fail++; lat.push(r.ms); } catch { fail++; }
    }
  }));
  clearInterval(mon);
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  console.log(JSON.stringify({
    concurrentStreams: conc,
    reqPerSec: +(ok / secs).toFixed(1),
    fail,
    ...(pid ? { relayCpuPctOfOneCore: Math.round(((cpuSeconds() - c0) / secs) * 100), peakRssMB: Math.round(peak) } : {}),
    p50ms: Math.round(lat[lat.length >> 1] ?? 0),
    p99ms: Math.round(lat[Math.floor(lat.length * 0.99)] ?? 0),
  }));
}
