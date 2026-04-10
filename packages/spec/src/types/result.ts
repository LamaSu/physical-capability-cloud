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
} as const;
