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
 * TELEMETRY only — never a typed error's own `.message` (NotFoundError interpolates
 * the caller-controlled id into it; see the constructor above). Checked via
 * `instanceof` (never `.name` — see the file doc comment), and every branch returns
 * one literal from this fixed list. Deliberately does NOT read `error.code` (the
 * optional, sometimes caller-influenced override BaseFacade.execute() uses for the
 * HTTP response's `code` field, e.g. ConflictError's "settlement_owned_status") — the
 * response is the same caller's own boundary and may keep that richer code and the
 * typed message; the shared telemetry/SSE stream (consumed across tenants/dashboards)
 * gets only the fixed class-level code below, recognized by the sink scanner as a
 * formatter by declaration.
 */
export function facadeErrorTelemetryCode(error: unknown): string {
  if (error instanceof NotFoundError) return "NOT_FOUND";
  if (error instanceof BadRequestError) return "BAD_REQUEST";
  if (error instanceof ForbiddenError) return "FORBIDDEN";
  if (error instanceof ConflictError) return "CONFLICT";
  if (error instanceof WriteDisabledError) return "WRITE_DISABLED";
  if (error instanceof BatchDisabledError) return "BATCH_DISABLED";
  return "INTERNAL_ERROR";
}
