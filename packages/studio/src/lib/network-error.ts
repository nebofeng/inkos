export const MAX_NETWORK_RETRIES = 3;

export function isNetworkErrorMessage(message: string): boolean {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
}

export function networkRetryDelayMs(retries: number): number {
  return 1000 * 2 ** retries;
}

export function planNetworkRetry(
  isNetworkError: boolean,
  retries: number,
  maxRetries = MAX_NETWORK_RETRIES,
): { readonly delayMs: number } | null {
  if (!isNetworkError || retries >= maxRetries) return null;
  return { delayMs: networkRetryDelayMs(retries) };
}
