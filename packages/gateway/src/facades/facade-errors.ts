/**
 * Shared, unforgeable flow-control error classes for BaseFacade.execute()'s catch block.
 *
 * N71 round 4 (astra pack 83c, HIGH #3): BaseFacade used to recognize a facade's own
 * flow-control throw by `error.name === "NotFoundError"` (etc.) — a string property ANY
 * Error can carry, including one thrown by an untrusted dependency
 * (`Object.assign(new Error("password=..."), {name: "NotFoundError"})`). Once matched,
 * the error's own arbitrary `.message` was disclosed in the response AND telemetry,
 * because the facade treated "name matches" as proof the message was authored by the
 * facade itself ("safe by construction"). It is not proof — `.name` is just a writable
 * string, and "NotFoundError" / "ConflictError" are common enough class names that an
 * ordinary dependency could collide with them by accident, not just by attack.
 *
 * `instanceof` against one of THESE exported classes IS proof: `Object.assign` (or any
 * other property write) cannot rewrite an object's prototype chain, so a forged plain
 * `Error` can set `.name` to "NotFoundError" but can never become `instanceof
 * NotFoundError` unless it is actually constructed with `new NotFoundError(...)` from
 * this module. Every facade throws ONE of these for a recognized flow-control category;
 * `BaseFacade.execute()` checks `instanceof`, never `.name`.
 *
 * `.name` is still set on each class (unchanged) for callers outside this trust
 * boundary that pattern-match on it for non-security purposes (e.g.
 * activities/escrow.ts's Temporal retry classification, which decides retryability —
 * not disclosure).
 */

import { isTransientError, TRANSIENT_ERROR_CODE } from "./transient-error.js";

export class NotFoundError extends Error {
  readonly code?: string;
  constructor(entity: string, id: string, code?: string) {
    super(`${entity} '${id}' not found`);
    this.name = "NotFoundError";
    if (code) this.code = code;
  }
}

export class BadRequestError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BadRequestError";
    if (code) this.code = code;
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ConflictError";
    if (code) this.code = code;
  }
}

export class WriteDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteDisabledError";
  }
}

export class BatchDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchDisabledError";
  }
}

/**
 * N71 round 7 (astra pack 83f, CRITICAL #1): a closed, fixed error-code map for
 * TELEMETRY AND THE SPAN — never a typed error's own `.message` (NotFoundError
 * interpolates the caller-controlled id into it; see the constructor above), and
 * never the richer `code` local BaseFacade.execute() computes for the HTTP response
 * (which may carry an attached override, e.g. ConflictError's
 * "settlement_owned_status" — not provably literal across every throw site this
 * round can verify). Checked via `instanceof` (never `.name` — see the file doc
 * comment) plus the SAME two non-instanceof classifications execute()'s catch block
 * uses (isTransientError; the SQLite UNIQUE-constraint duck-type), so every branch
 * returns one literal from this fixed list, with NO branch falling through to a
 * different one than execute() itself would select. The response is the same
 * caller's own boundary and may keep the richer code/message; the shared
 * telemetry/SSE/span streams (consumed across tenants/dashboards, OTLP-exported)
 * get only the fixed class-level code below, recognized by the sink scanner as a
 * formatter by declaration.
 */
export function facadeErrorTelemetryCode(error: unknown): string {
  if (error instanceof NotFoundError) return "NOT_FOUND";
  if (error instanceof BadRequestError) return "BAD_REQUEST";
  if (error instanceof ForbiddenError) return "FORBIDDEN";
  if (error instanceof ConflictError) return "CONFLICT";
  if (error instanceof WriteDisabledError) return "WRITE_DISABLED";
  if (error instanceof BatchDisabledError) return "BATCH_DISABLED";
  if (isTransientError(error)) return TRANSIENT_ERROR_CODE;
  if ((error as { code?: unknown } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE") return "CONFLICT";
  if (error instanceof Error && /^UNIQUE constraint failed:/i.test(error.message)) return "CONFLICT";
  return "internal_error";
}
