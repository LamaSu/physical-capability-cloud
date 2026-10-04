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
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
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
