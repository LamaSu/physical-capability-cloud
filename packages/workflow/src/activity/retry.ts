/**
 * Retry policy math — pure, deterministic with injected randomness.
 *
 * See design §7.3.
 */

import type { RetryPolicy } from '../shared/types.js';
import { applyRetryPolicyDefaults, DEFAULT_RETRY_POLICY } from '../shared/types.js';

/**
 * Compute the interval before attempt N (1-indexed).
 *   attempt === 1 → 0 ms (first try has no wait)
 *   attempt === 2 → initialIntervalMs (±jitter, capped at maxIntervalMs)
 *   attempt === N → initialIntervalMs × backoff^(N-2)
 *
 * The random source is injectable so tests can pin jitter.
 */
export function computeBackoffMs(
  policy: Required<RetryPolicy>,
  attempt: number,
  rand: () => number = Math.random,
): number {
  if (attempt <= 1) return 0;
  const raw = policy.initialIntervalMs * Math.pow(policy.backoffCoefficient, attempt - 2);
  const clamped = Math.min(raw, policy.maxIntervalMs);
  const jitterRange = clamped * policy.jitterFactor;
  const jitter = (rand() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(clamped + jitter));
}

/** Does the error name/message match any non-retryable regex pattern? */
export function isNonRetryable(policy: Required<RetryPolicy>, error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const haystack = `${error.name}: ${error.message}`;
  return policy.nonRetryableErrorPatterns.some((pat) => new RegExp(pat).test(haystack));
}

/** Should the engine retry after attempt N failed with the given error? */
export function shouldRetry(
  policy: Required<RetryPolicy>,
  attempt: number,
  error: unknown,
): boolean {
  if (isNonRetryable(policy, error)) return false;
  if (policy.maximumAttempts === 0) return true; // infinite
  return attempt < policy.maximumAttempts;
}

export { applyRetryPolicyDefaults, DEFAULT_RETRY_POLICY };
