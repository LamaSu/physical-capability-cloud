import { createHash } from "node:crypto";

/** Correlate identifiers without exporting operator-supplied identifier text. */
export function observationId(value: unknown): string {
  return typeof value === "string"
    ? `id:${createHash("sha256").update(value).digest("hex")}`
    : "[invalid id]";
}

/** Format bounded numeric attributes even when runtime input bypasses its type. */
export function logSafeSmallInt(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** Only fixed built-in categories cross the diagnostic boundary. */
export function knownErrorClassName(value: unknown): string {
  if (value instanceof TypeError) return "TypeError";
  if (value instanceof RangeError) return "RangeError";
  if (value instanceof SyntaxError) return "SyntaxError";
  if (value instanceof ReferenceError) return "ReferenceError";
  if (value instanceof URIError) return "URIError";
  if (value instanceof EvalError) return "EvalError";
  return "Error";
}
