import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "./rate-limit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("LoginRateLimiter", () => {
  it("locks an IP after 5 failures within 15 minutes and reports Retry-After", () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    for (let i = 1; i <= 4; i += 1) {
      expect(limiter.recordFailure("203.0.113.9").allowed).toBe(true);
      c.advance(1000);
    }
    const fifth = limiter.recordFailure("203.0.113.9");
    expect(fifth.allowed).toBe(false);
    expect(fifth.failures).toBe(5);
    // oldest failure was 4s ago → unlock in 15min - 4s
    expect(fifth.retryAfterSeconds).toBe(15 * 60 - 4);
    expect(limiter.check("203.0.113.9").allowed).toBe(false);
  });

  it("keys are independent per IP", () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure("198.51.100.1");
    expect(limiter.check("198.51.100.1").allowed).toBe(false);
    expect(limiter.check("198.51.100.2").allowed).toBe(true);
  });

  it("unlocks once failures slide out of the window", () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure("192.0.2.7");
    c.advance(15 * 60 * 1000 - 1);
    expect(limiter.check("192.0.2.7").allowed).toBe(false);
    c.advance(2);
    expect(limiter.check("192.0.2.7")).toMatchObject({ allowed: true, failures: 0 });
  });

  it("a successful login clears the counter", () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now });
    for (let i = 0; i < 4; i += 1) limiter.recordFailure("192.0.2.8");
    limiter.recordSuccess("192.0.2.8");
    expect(limiter.check("192.0.2.8").failures).toBe(0);
  });

  it("bounds memory", () => {
    const c = clock();
    const limiter = new LoginRateLimiter({ now: c.now, maxKeys: 10 });
    for (let i = 0; i < 50; i += 1) limiter.recordFailure(`10.0.0.${i}`);
    expect(limiter.trackedKeys).toBeLessThanOrEqual(10);
  });
});
