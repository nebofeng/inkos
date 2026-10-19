import { describe, expect, it } from "vitest";
import { isNetworkErrorMessage, MAX_NETWORK_RETRIES, planNetworkRetry } from "./network-error";

describe("isNetworkErrorMessage", () => {
  it("matches fetch/network failures", () => {
    expect(isNetworkErrorMessage("TypeError: Failed to fetch")).toBe(true);
    expect(isNetworkErrorMessage("NetworkError when attempting to fetch resource.")).toBe(true);
    expect(isNetworkErrorMessage("Load failed")).toBe(true);
    expect(isNetworkErrorMessage("Network request failed")).toBe(true);
  });

  it("does not treat API 4xx/5xx copy as a network error", () => {
    expect(isNetworkErrorMessage("500 Internal Server Error")).toBe(false);
    expect(isNetworkErrorMessage("Bad request")).toBe(false);
  });
});

describe("planNetworkRetry", () => {
  it("uses exponential delay and a hard cap of 3 retries", () => {
    expect(planNetworkRetry(true, 0)).toEqual({ delayMs: 1000 });
    expect(planNetworkRetry(true, 1)).toEqual({ delayMs: 2000 });
    expect(planNetworkRetry(true, 2)).toEqual({ delayMs: 4000 });
    expect(planNetworkRetry(true, MAX_NETWORK_RETRIES)).toBeNull();
    expect(planNetworkRetry(true, 99)).toBeNull();
  });

  it("does not retry when the error is not a network failure", () => {
    expect(planNetworkRetry(false, 0)).toBeNull();
  });
});
