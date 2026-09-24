/**
 * The one gateway this dashboard talks to, and the only origin that may be
 * sent the user's API key.
 *
 * In production the gateway serves the dashboard, so the base is "" and every
 * request is same-origin (/api/...). A build can point at a separate gateway
 * with VITE_PCC_URL, the same variable the auth store uses to validate the
 * key. Nothing else may receive the Authorization header. In particular, a
 * hard-coded http://localhost:3200 must not: that sends a signed-in user's key
 * to whatever process listens on that port on their own machine.
 */

export const GATEWAY_BASE: string = (
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PCC_URL ?? ""
).replace(/\/+$/, "");

/** An absolute-or-relative URL on the configured gateway. */
export function gatewayUrl(path: string): string {
  return `${GATEWAY_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
