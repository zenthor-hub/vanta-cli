export type BackoffConfig = {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
};

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  maxRetries: 3,
};

/** Status codes that are safe to retry for idempotent GET-style requests. */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function computeBackoffMs(
  attempt: number,
  retryAfterHeader: string | null,
  config: BackoffConfig = DEFAULT_BACKOFF,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, config.maxDelayMs);
    }
  }
  const exponential = config.baseDelayMs * 2 ** attempt;
  return Math.min(exponential, config.maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for methods that are safe to automatically retry. */
export function isIdempotentMethod(method: string): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}
