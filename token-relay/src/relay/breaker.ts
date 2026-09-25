/**
 * Per-node circuit breaker per credential. Consecutive failures open the
 * breaker for `cooldownMs`; upstream 429s open it for the rate-limit cooldown
 * immediately. One trial request is let through after cooldown (half-open).
 */
export interface BreakerState {
  failures: number;
  openUntil: number;
  lastError?: string;
  halfOpenInFlight: boolean;
}

export class Breakers {
  readonly #states = new Map<string, BreakerState>();
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  constructor(threshold: number, cooldownMs: number, now: () => number = Date.now) {
    this.#threshold = threshold;
    this.#cooldownMs = cooldownMs;
    this.#now = now;
  }

  #get(id: string): BreakerState {
    let s = this.#states.get(id);
    if (!s) this.#states.set(id, (s = { failures: 0, openUntil: 0, halfOpenInFlight: false }));
    return s;
  }

  /** True if a request may be attempted. Marks half-open trial when cooling down. */
  allow(id: string): boolean {
    const s = this.#states.get(id);
    if (!s || s.openUntil === 0) return true;
    if (this.#now() < s.openUntil) return false;
    if (s.halfOpenInFlight) return false;
    s.halfOpenInFlight = true;
    return true;
  }

  success(id: string): void {
    const s = this.#states.get(id);
    if (s) {
      s.failures = 0;
      s.openUntil = 0;
      s.halfOpenInFlight = false;
    }
  }

  failure(id: string, reason: string): void {
    const s = this.#get(id);
    s.failures++;
    s.lastError = reason;
    s.halfOpenInFlight = false;
    if (s.failures >= this.#threshold) s.openUntil = this.#now() + this.#cooldownMs;
  }

  cooldown(id: string, ms: number, reason: string): void {
    const s = this.#get(id);
    s.lastError = reason;
    s.halfOpenInFlight = false;
    s.openUntil = Math.max(s.openUntil, this.#now() + ms);
  }

  isOpen(id: string): boolean {
    const s = this.#states.get(id);
    return !!s && s.openUntil > this.#now();
  }

  snapshot(): Record<string, BreakerState & { open: boolean }> {
    return Object.fromEntries([...this.#states].map(([k, v]) => [k, { ...v, open: v.openUntil > this.#now() }]));
  }
}
