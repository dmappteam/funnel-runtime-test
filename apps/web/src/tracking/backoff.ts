const BASE_MS = 1000;
const MAX_MS = 30_000;

/** Retry delay for the n-th consecutive failure (0-based): 1 s doubling up to 30 s, ±20% jitter so tabs do not retry in lockstep. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_MS, BASE_MS * 2 ** attempt);
  return Math.min(MAX_MS, Math.round(ceiling * (0.8 + 0.4 * random())));
}

/** Network errors, timeouts, rate limiting and server errors can succeed later. Other 4xx cannot. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
