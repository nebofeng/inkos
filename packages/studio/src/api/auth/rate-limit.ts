/** In-memory failed-login limiter: N failures per key (client IP) per sliding window. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the next attempt is allowed (only when !allowed). */
  readonly retryAfterSeconds: number;
  readonly failures: number;
}

export interface LoginRateLimiterOptions {
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
  /** Upper bound on tracked keys so a flood of spoofed peers cannot exhaust memory. */
  readonly maxKeys?: number;
}

export class LoginRateLimiter {
  readonly maxFailures: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly failures = new Map<string, number[]>();

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  private recent(key: string, now: number): number[] {
    const list = this.failures.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    else if (kept.length !== list.length) this.failures.set(key, kept);
    return kept;
  }

  check(key: string): RateLimitDecision {
    const now = this.now();
    const recent = this.recent(key, now);
    if (recent.length < this.maxFailures) {
      return { allowed: true, retryAfterSeconds: 0, failures: recent.length };
    }
    // Locked until the oldest failure that keeps us at the limit leaves the window.
    const unlockAt = recent[recent.length - this.maxFailures]! + this.windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((unlockAt - now) / 1000)), failures: recent.length };
  }

  recordFailure(key: string): RateLimitDecision {
    const now = this.now();
    const recent = this.recent(key, now);
    recent.push(now);
    if (!this.failures.has(key) && this.failures.size >= this.maxKeys) this.prune();
    this.failures.set(key, recent);
    return this.check(key);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  prune(): void {
    const now = this.now();
    for (const key of [...this.failures.keys()]) this.recent(key, now);
    // Still too many: drop the oldest-touched keys.
    while (this.failures.size >= this.maxKeys) {
      const first = this.failures.keys().next();
      if (first.done) break;
      this.failures.delete(first.value);
    }
  }

  get trackedKeys(): number {
    return this.failures.size;
  }
}
