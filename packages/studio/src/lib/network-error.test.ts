import { describe, expect, it } from "vitest";
import {
  annotateHttpError,
  isHttpClientErrorMessage,
  isRetryableApiError,
  isNetworkErrorMessage,
  MAX_NETWORK_RETRIES,
  planApiRetry,
  planNetworkRetry,
  resetBackoffRetriesOn,
} from "./network-error";

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

describe("isRetryableApiError", () => {
  it("retries network failures and HTTP 5xx", () => {
    expect(isRetryableApiError("TypeError: Failed to fetch")).toBe(true);
    expect(isRetryableApiError("500 Internal Server Error")).toBe(true);
    expect(isRetryableApiError("502 Bad Gateway")).toBe(true);
    expect(isRetryableApiError("503 Service Unavailable")).toBe(true);
  });

  it("does not retry HTTP 4xx", () => {
    expect(isRetryableApiError("400 Bad request")).toBe(false);
    expect(isRetryableApiError("401 Unauthorized")).toBe(false);
    expect(isRetryableApiError("404 Not Found")).toBe(false);
    expect(isHttpClientErrorMessage("422 Unprocessable Entity")).toBe(true);
    expect(isRetryableApiError("422 Unprocessable Entity")).toBe(false);
  });
});

describe("annotateHttpError", () => {
  it("prefixes 5xx JSON payloads that omit the status code", () => {
    expect(annotateHttpError(500, "database down")).toBe("500 database down");
    expect(annotateHttpError(503, "503 Service Unavailable")).toBe("503 Service Unavailable");
  });

  it("leaves 4xx copy unchanged so it stays non-retryable", () => {
    expect(annotateHttpError(400, "Bad request")).toBe("Bad request");
    expect(isRetryableApiError(annotateHttpError(400, "Bad request"))).toBe(false);
    expect(isRetryableApiError(annotateHttpError(500, "boom"))).toBe(true);
  });
});

describe("planNetworkRetry / planApiRetry", () => {
  it("uses exponential delay and a hard cap of 3 retries", () => {
    expect(planNetworkRetry(true, 0)).toEqual({ delayMs: 1000 });
    expect(planNetworkRetry(true, 1)).toEqual({ delayMs: 2000 });
    expect(planNetworkRetry(true, 2)).toEqual({ delayMs: 4000 });
    expect(planNetworkRetry(true, MAX_NETWORK_RETRIES)).toBeNull();
    expect(planNetworkRetry(true, 99)).toBeNull();
  });

  it("retries HTTP 5xx up to 3 times and never schedules a 4th", () => {
    const scheduled: number[] = [];
    for (let retries = 0; retries < 8; retries += 1) {
      const plan = planApiRetry("500 Internal Server Error", retries);
      if (plan) scheduled.push(retries);
    }
    expect(scheduled).toEqual([0, 1, 2]);
    expect(scheduled).toHaveLength(MAX_NETWORK_RETRIES);
    expect(planApiRetry("502 Bad Gateway", MAX_NETWORK_RETRIES)).toBeNull();
  });

  it("does not retry HTTP 4xx", () => {
    expect(planApiRetry("400 Bad request", 0)).toBeNull();
    expect(planApiRetry("404 Not Found", 0)).toBeNull();
    expect(planNetworkRetry(false, 0)).toBeNull();
  });

  it("resets the retry count after success or a manual retry, not after another failure", () => {
    let retries = 0;
    for (let i = 0; i < MAX_NETWORK_RETRIES; i += 1) {
      expect(planApiRetry("500 Internal Server Error", retries)).not.toBeNull();
      retries += 1;
    }
    expect(planApiRetry("500 Internal Server Error", retries)).toBeNull();

    retries = resetBackoffRetriesOn("success") ?? retries;
    expect(retries).toBe(0);
    expect(planApiRetry("500 Internal Server Error", retries)).toEqual({ delayMs: 1000 });

    retries = 3;
    retries = resetBackoffRetriesOn("manual-retry") ?? retries;
    expect(retries).toBe(0);
    expect(resetBackoffRetriesOn("failure")).toBeNull();
  });
});
