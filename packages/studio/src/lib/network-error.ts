export const MAX_NETWORK_RETRIES = 3;

export function isNetworkErrorMessage(message: string): boolean {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
}

export function isHttpServerErrorMessage(message: string): boolean {
  return /^5\d{2}\b/.test(message.trim());
}

export function isHttpClientErrorMessage(message: string): boolean {
  return /^4\d{2}\b/.test(message.trim());
}

/** Network failures and HTTP 5xx auto-retry; 4xx and other copy do not. */
export function isRetryableApiError(message: string): boolean {
  if (isHttpClientErrorMessage(message)) return false;
  return isNetworkErrorMessage(message) || isHttpServerErrorMessage(message);
}

/** Ensure 5xx responses carry a leading status so retry classification cannot miss JSON payloads. */
export function annotateHttpError(status: number, message: string): string {
  const trimmed = message.trim();
  if (status >= 500 && status <= 599 && !isHttpServerErrorMessage(trimmed)) {
    return `${status} ${trimmed}`.trim();
  }
  return trimmed;
}

export function networkRetryDelayMs(retries: number): number {
  return 1000 * 2 ** retries;
}

export function planNetworkRetry(
  isRetryableError: boolean,
  retries: number,
  maxRetries = MAX_NETWORK_RETRIES,
): { readonly delayMs: number } | null {
  if (!isRetryableError || retries >= maxRetries) return null;
  return { delayMs: networkRetryDelayMs(retries) };
}

export function planApiRetry(
  message: string | null | undefined,
  retries: number,
  maxRetries = MAX_NETWORK_RETRIES,
): { readonly delayMs: number } | null {
  return planNetworkRetry(Boolean(message && isRetryableApiError(message)), retries, maxRetries);
}

export function resetBackoffRetriesOn(
  event: "success" | "manual-retry" | "failure",
): number | null {
  if (event === "success" || event === "manual-retry") return 0;
  return null;
}
