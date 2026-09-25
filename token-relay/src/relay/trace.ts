import type { Logger } from '../lib/log.ts';

export interface TraceEvent {
  t: number; // ms since request start
  name: string;
  data?: Record<string, unknown>;
}

export interface TraceRecord {
  requestId: string;
  startedAt: string;
  userId?: string;
  model?: string;
  stream?: boolean;
  outcome?: string;
  httpStatus?: number;
  durationMs?: number;
  events: TraceEvent[];
  summary?: Record<string, unknown>;
}

/**
 * Request timeline. Each step of the relay pipeline appends an event; the full
 * timeline is logged once at the end and (when debug is enabled) retained in
 * a ring buffer served by /debug/requests/:id.
 */
export class Trace {
  readonly record: TraceRecord;
  readonly #t0: number;
  readonly #log: Logger;

  constructor(requestId: string, log: Logger) {
    this.#t0 = performance.now();
    this.#log = log;
    this.record = { requestId, startedAt: new Date().toISOString(), events: [] };
  }

  event(name: string, data?: Record<string, unknown>): void {
    const ev: TraceEvent = { t: Math.round((performance.now() - this.#t0) * 10) / 10, name, ...(data ? { data } : {}) };
    this.record.events.push(ev);
    this.#log.debug(`relay: ${name}`, data);
  }

  elapsed(): number {
    return Math.round(performance.now() - this.#t0);
  }

  /** Compact `name@ms` list, used for the x-relay-debug header. */
  compact(): string {
    return this.record.events.map((e) => `${e.name}@${e.t}`).join(',');
  }
}

export class TraceRing {
  readonly #buf: TraceRecord[] = [];
  readonly #size: number;
  constructor(size: number) {
    this.#size = size;
  }
  push(r: TraceRecord) {
    this.#buf.push(r);
    if (this.#buf.length > this.#size) this.#buf.shift();
  }
  list(filter: { userId?: string; outcome?: string; limit?: number } = {}): TraceRecord[] {
    return this.#buf
      .filter((r) => (!filter.userId || r.userId === filter.userId) && (!filter.outcome || r.outcome === filter.outcome))
      .slice(-(filter.limit ?? 50))
      .reverse();
  }
  get(id: string) {
    return this.#buf.find((r) => r.requestId === id);
  }
}
