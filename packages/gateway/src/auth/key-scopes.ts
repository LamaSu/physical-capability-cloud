// Self-service authority derives from rules listing operator, minus money-write and admin rules.
export const SELF_SERVICE_OPERATOR_SCOPE = "operator:basic";
export const SELF_SERVICE_KEY_SCOPES = Object.freeze([SELF_SERVICE_OPERATOR_SCOPE]);

/** Stored scope formats share one parser; unreadable scope sets grant nothing. */
export function parseStoredScopes(raw: unknown): string[] {
  let scopesRaw: unknown;
  try {
    scopesRaw = JSON.parse(raw as string);
  } catch {
    scopesRaw = raw;
  }

  if (Array.isArray(scopesRaw)) {
    return scopesRaw.filter((s) => typeof s === "string");
  }
  if (typeof scopesRaw === "string" && scopesRaw.length > 0) {
    return scopesRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
