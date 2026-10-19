import { useCallback, useEffect, useState } from "react";
import { MAX_NETWORK_RETRIES, planNetworkRetry, resetBackoffRetriesOn } from "../lib/network-error";

export function useNetworkBackoffRetry(opts: {
  readonly isRetryableError: boolean;
  readonly hasData: boolean;
  readonly refetch: () => void | Promise<void>;
  readonly maxRetries?: number;
}): { readonly retries: number; readonly resetRetries: () => void } {
  const maxRetries = opts.maxRetries ?? MAX_NETWORK_RETRIES;
  const [retries, setRetries] = useState(0);
  const resetRetries = useCallback(() => {
    const next = resetBackoffRetriesOn("manual-retry");
    if (next != null) setRetries(next);
  }, []);

  useEffect(() => {
    const plan = planNetworkRetry(opts.isRetryableError, retries, maxRetries);
    if (!plan) return;
    const timer = window.setTimeout(() => {
      setRetries((n) => n + 1);
      void opts.refetch();
    }, plan.delayMs);
    return () => window.clearTimeout(timer);
  }, [opts.isRetryableError, opts.refetch, retries, maxRetries]);

  useEffect(() => {
    if (!opts.hasData) return;
    const next = resetBackoffRetriesOn("success");
    if (next != null) setRetries(next);
  }, [opts.hasData]);

  return { retries, resetRetries };
}
