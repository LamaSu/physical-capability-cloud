/**
 * Standardized Result pattern for all PCC Facade operations.
 *
 * Replaces the 357 inconsistent error returns across 54 route files
 * with a single, typed, discriminated union. Every Facade method returns
 * Result<T> — routes just serialize it.
 */

/** Standardized PCC error descriptor */
export interface PCCError {
  /** Machine-readable error code (e.g., "CAPABILITY_NOT_FOUND", "ESCROW_INSUFFICIENT_FUNDS") */
  code: string;
  /** Human-readable message */
  message: string;
  /** Additional structured details for debugging */
  details?: Record<string, unknown>;
  /** Whether the caller should retry */
  retryable: boolean;
  /** HTTP status code hint for the route layer */
  httpStatus: number;
  /**
   * Trace identifier (correlation ID) stamped by the route boundary.
   * Lets an agent quote it back when filing a `pcc_report` feedback entry,
   * and lets PCC operators look up the full request journey in the
   * observability sink.
   *
   * Format: `tr_<16-32 hex>` minted by `middleware/trace-id.ts` on entry
   * routes or echoed from the incoming `x-pcc-trace-id` header.
   *
   * OPTIONAL for backward compatibility — never required on `err()` calls.
   */
  trace_id?: string;
  /**
   * Human-readable suggestion telling the agent what to do next.
   * Examples:
   *   - "Try `list_capability_types` first to see valid types."
   *   - "Fund the escrow before submitting the job."
   *   - "Provide either `email` or `walletAddress`, not both."
   *
   * Agents are encouraged to surface this verbatim to the LLM
   * reasoning loop.
   *
   * OPTIONAL.
   */
  hint?: string;
  /**
   * Documentation URL or path that explains the error class.
   * Relative paths are resolved against the gateway origin, e.g.
   * `/docs/AGENT_INTEGRATION.md#auth`. Absolute URLs are also allowed.
   *
   * OPTIONAL.
   */
  docs?: string;
}

/** Successful result */
export interface Ok<T> {
  success: true;
  data: T;
  timestamp: number;
}

/** Failed result */
export interface Err {
  success: false;
  error: PCCError;
  timestamp: number;
}

/** Discriminated union: every Facade method returns this */
export type Result<T> = Ok<T> | Err;

// ── Factory Functions ──────────────────────────────────────────────────────

/** Create a success result */
export function ok<T>(data: T): Result<T> {
  return { success: true, data, timestamp: Date.now() };
}

/** Create a failure result */
export function err(
  code: string,
  message: string,
  httpStatus = 500,
  opts?: { details?: Record<string, unknown>; retryable?: boolean },
): Result<never> {
  return {
    success: false,
    error: {
      code,
      message,
      httpStatus,
      retryable: opts?.retryable ?? false,
      details: opts?.details,
    },
    timestamp: Date.now(),
  };
}

/**
 * Create a failure result with agent-readable extras (hint, docs, trace_id).
 *
 * Use this for ERRORS that an LLM-driven agent will see — onboarding,
 * discovery, build/contract, escrow. The `hint` should be a 1-sentence
 * suggestion the agent can act on; the `docs` should point at a guide
 * section that explains the broader context.
 *
 * Backward-compat note: a caller that destructures
 * `result.error.{code, message, httpStatus}` keeps working — `hint`,
 * `docs`, `trace_id` are additive optional fields.
 */
export function errRich(
  code: string,
  message: string,
  httpStatus = 500,
  opts?: {
    details?: Record<string, unknown>;
    retryable?: boolean;
    hint?: string;
    docs?: string;
    trace_id?: string;
  },
): Result<never> {
  return {
    success: false,
    error: {
      code,
      message,
      httpStatus,
      retryable: opts?.retryable ?? false,
      details: opts?.details,
      hint: opts?.hint,
      docs: opts?.docs,
      trace_id: opts?.trace_id,
    },
    timestamp: Date.now(),
  };
}

/**
 * Stamp a `trace_id` onto an existing `Err`. Used at the route boundary
 * by the result-serializer helper after the trace-id middleware has
 * minted/echoed the trace_id onto the request.
 *
 * Returns a NEW Err — does not mutate. Safe to call on any Result; if
 * it is `ok`, it is returned unchanged.
 */
export function stampTrace<T>(result: Result<T>, trace_id: string): Result<T> {
  if (result.success) return result;
  return {
    success: false,
    error: { ...result.error, trace_id },
    timestamp: result.timestamp,
  };
}

// ── Common Error Constructors ──────────────────────────────────────────────

export const Errors = {
  notFound: (entity: string, id: string) =>
    err(`${entity.toUpperCase()}_NOT_FOUND`, `${entity} '${id}' not found`, 404),

  badRequest: (message: string, details?: Record<string, unknown>) =>
    err("BAD_REQUEST", message, 400, { details }),

  unauthorized: (message = "Authentication required") =>
    err("UNAUTHORIZED", message, 401),

  forbidden: (message = "Insufficient permissions") =>
    err("FORBIDDEN", message, 403),

  conflict: (message: string, details?: Record<string, unknown>) =>
    err("CONFLICT", message, 409, { details }),

  internal: (message = "Internal error", details?: Record<string, unknown>) =>
    err("INTERNAL_ERROR", message, 500, { details, retryable: true }),

  serviceUnavailable: (service: string) =>
    err("SERVICE_UNAVAILABLE", `${service} is not available`, 503, { retryable: true }),

  rateLimited: (retryAfterMs?: number) =>
    err("RATE_LIMITED", "Too many requests", 429, {
      retryable: true,
      details: retryAfterMs ? { retryAfterMs } : undefined,
    }),

  // ── Rich variants (with hint + docs) ─────────────────────────────────────
  // These are the preferred constructors for any error an LLM-driven agent
  // will see. Use the plain variants above for internal-only errors.

  notFoundWithHint: (entity: string, id: string, hint: string, docs?: string) =>
    errRich(
      `${entity.toUpperCase()}_NOT_FOUND`,
      `${entity} '${id}' not found`,
      404,
      { hint, docs },
    ),

  badRequestWithHint: (
    message: string,
    hint: string,
    docs?: string,
    details?: Record<string, unknown>,
  ) => errRich("BAD_REQUEST", message, 400, { hint, docs, details }),

  unauthorizedWithHint: (hint: string, docs?: string) =>
    errRich("UNAUTHORIZED", "Authentication required", 401, { hint, docs }),

  forbiddenWithHint: (message: string, hint: string, docs?: string) =>
    errRich("FORBIDDEN", message, 403, { hint, docs }),
} as const;
