/**
 * Transient-error classification for chain / RPC / network failures.
 *
 * WHY (finding E2): the base facade turns every thrown error into a Result
 * error, and the escrow activities wrap every Result error as a
 * non-retryable FacadeError. That made a 1-second RPC blip permanent — the
 * activity's `maximumAttempts` retry policy could never engage, and the
 * failed idempotency row poisoned the on-chain semantic key for 30 days.
 *
 * The fix has two halves that must be read together:
 *   1. base.facade.ts classifies a caught error here and, when transient,
 *      returns `err(TRANSIENT_ERROR_CODE, ...)` instead of a generic 500.
 *   2. activities/escrow.ts sees that code and throws a *retryable*-named
 *      error so the activity retry loop (and short failed-row TTL) engages.
 *
 * MONEY-SAFE INVARIANT: this classifier is POSITIVE-MATCH ONLY. It returns
 * `true` solely for clearly-transient transport/RPC/mempool failures. A
 * contract revert, insufficient-funds, validation, or any business error
 * never matches, so an on-chain write that would revert is NOT retried
 * (retrying a revert wastes gas). When in doubt, we classify as permanent.
 */

/** Result error code that signals "transient — safe to retry". */
export const TRANSIENT_ERROR_CODE = "TRANSIENT_ERROR";

/** viem / transport error class names that are always transient. */
const TRANSIENT_ERROR_NAMES = new Set<string>([
  "HttpRequestError",
  "TimeoutError",
  "RpcRequestError",
  "WebSocketRequestError",
  "SocketClosedError",
]);

/** Node syscall error codes that are always transient. */
const TRANSIENT_NODE_CODES = new Set<string>([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

/**
 * Message substrings that indicate a transient transport / RPC / mempool
 * condition. Kept deliberately narrow: none of these appear in a contract
 * revert or a business-rule error message.
 */
const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /timed out/i,
  /socket hang ?up/i,
  /network error/i,
  /http request failed/i,
  /fetch failed/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /enotfound/i,
  /eai_again/i,
  /connection (?:reset|refused|closed|error|terminated|timed out)/i,
  /too many requests/i,
  /rate[ -]?limit/i,
  /\b(?:429|502|503|504)\b/,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /temporarily unavailable/i,
  // mempool / nonce transients — a resend generally clears these
  /nonce too low/i,
  /nonce is too low/i,
  /nonce has already been used/i,
  /replacement transaction underpriced/i,
  /transaction underpriced/i,
  /already known/i,
  /could not coalesce/i,
  /request timed out/i,
];

function matchesTransientText(name: string, message: string): boolean {
  const haystack = `${name}: ${message}`;
  return TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(haystack));
}

/**
 * Classify a raw thrown error as transient (retryable) or not.
 *
 * Walks the `cause` chain (viem nests the real transport error under a
 * higher-level TransactionExecutionError/ContractFunctionExecutionError),
 * bounded to avoid cycles.
 */
export function isTransientError(error: unknown, depth = 0): boolean {
  if (error == null || depth > 5) return false;

  if (error instanceof Error) {
    if (TRANSIENT_ERROR_NAMES.has(error.name)) return true;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_NODE_CODES.has(code)) return true;
    if (matchesTransientText(error.name, error.message)) return true;
    const cause = (error as { cause?: unknown }).cause;
    if (cause != null && cause !== error) return isTransientError(cause, depth + 1);
    return false;
  }

  // Non-Error throw (string / object): scan its string form.
  return matchesTransientText("", String(error));
}
