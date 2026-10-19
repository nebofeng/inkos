import { useCallback, useEffect, useState } from "react";
import { MAX_NETWORK_RETRIES, planNetworkRetry } from "../lib/network-error";

export function useNetworkBackoffRetry(opts: {
  readonly isNetworkError: boolean;
  readonly hasData: boolean;
  readonly refetch: () => void | Promise<void>;
  readonly maxRetries?: number;
}): { readonly retries: number; readonly resetRetries: () => void } {
  const maxRetries = opts.maxRetries ?? MAX_NETWORK_RETRIES;
  const [retries, setRetries] = useState(0);
  const resetRetries = useCallback(() => setRetries(0), []);

  useEffect(() => {
    const plan = planNetworkRetry(opts.isNetworkError, retries, maxRetries);
    if (!plan) return;
    const timer = window.setTimeout(() => {
      setRetries((n) => n + 1);
      void opts.refetch();
    }, plan.delayMs);
    return () => window.clearTimeout(timer);
  }, [opts.isNetworkError, opts.refetch, retries, maxRetries]);

  useEffect(() => {
    if (opts.hasData) setRetries(0);
  }, [opts.hasData]);

  return { retries, resetRetries };
}
