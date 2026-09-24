/**
 * PCC_DEMO_ROUTES: the ONE switch for routes that can only answer with simulated data
 * (board N34, the server side of PX-3).
 *
 * Off by default. With it off, a route that has no real source (an unconfigured payment
 * provider, a mock-only catalog) answers honestly: 503 `not_configured` or 501
 * `not_available`. It never answers with provider-shaped or plausible data. With it on,
 * simulated responses are allowed, and every one of them says so (`mock: true`,
 * `demo: true`).
 *
 * Only the literal "true" enables it (same convention as TENANT_ENFORCE), and NEVER under
 * NODE_ENV=production (coord-watch #2934): production never serves a simulated answer, so a
 * stray variable cannot turn one on. It is read per call, so tests and a runtime change see
 * the current value.
 */
export function isDemoRoutesOn(): boolean {
  return process.env.PCC_DEMO_ROUTES === "true" && process.env.NODE_ENV !== "production";
}

/** Marks a simulated response. Live responses pass through unchanged. */
export function markDemo<T extends object>(mode: "live" | "demo", body: T): T | (T & { mock: true; demo: true }) {
  return mode === "demo" ? { ...body, mock: true as const, demo: true as const } : body;
}
