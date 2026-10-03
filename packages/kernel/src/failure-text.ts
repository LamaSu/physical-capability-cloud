/**
 * A failure's reason as text, for a latch, a log line or a result's error. It never throws: a
 * reason with no text form (an object with no prototype, a toString or message getter that
 * throws, a message that is not a string) gets a fixed text instead. A catch block on the
 * evidence path uses it, so the failure it reports is never replaced by a throw of its own
 * (astra pack 200, where PrinterLog's latch was skipped; steward #5541 and #5547).
 */
export function failureText(err: unknown): string {
  try {
    const text: unknown = err instanceof Error ? err.message : String(err);
    if (typeof text === "string") return text;
  } catch {
    // No text form: the fixed text below.
  }
  return "a reason with no text form";
}

/**
 * An event's type, for a latch's message, read without throwing: an event whose type cannot be
 * read, or is not a string, is "(unreadable)" (astra pack 209).
 */
export function eventType(event: unknown): string {
  try {
    const type: unknown = (event as { type?: unknown }).type;
    if (typeof type === "string") return type;
  } catch {
    // Unreadable: the fixed label below.
  }
  return "(unreadable)";
}
