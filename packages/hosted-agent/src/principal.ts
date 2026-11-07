/**
 * Who a Bearer credential belongs to.
 *
 * A signed-in session's budget belongs to an AUTHENTICATED, stable principal,
 * never to the token string: a Bearer string is only a claim, and MCP forwards
 * it without validating it. So before a request counts as signed in, the
 * gateway is asked who the credential is. `GET /api/agent/me` is never
 * scope-gated and answers 401 for a key that does not resolve. For one that
 * does, `identity.operator` is the operator id, the same for every key of that
 * operator, which is what the daily cap must be shared across.
 *
 * Anything but a clear answer (a 401, any other status, a network failure, a
 * timeout, an unreadable or unexpected body) is "no principal". The caller
 * refuses the session open; it never falls back to anonymous.
 *
 * `/api/agent/me` resolves PCC API keys (`pcc_live_...`, `pcc_test_...`) only.
 */

export interface Principal {
  /** The operator the credential belongs to, as the gateway names it. */
  readonly operatorId: string;
}

/** Resolves a Bearer credential to its principal, or null. Injected, so tests fake it. */
export type ResolvePrincipal = (credential: string) => Promise<Principal | null>;

const MAX_OPERATOR_ID_CHARS = 256;

export function gatewayPrincipal(
  gatewayBase: string,
  opts: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {},
): ResolvePrincipal {
  const url = new URL("/api/agent/me", gatewayBase).toString();
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return async (credential) => {
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) return null;
      const body = (await res.json()) as { ok?: unknown; identity?: { operator?: unknown } } | null;
      const operator = body?.identity?.operator;
      if (body?.ok !== true || typeof operator !== "string" || operator.length === 0 || operator.length > MAX_OPERATOR_ID_CHARS) {
        return null;
      }
      return { operatorId: operator };
    } catch {
      return null;
    }
  };
}
