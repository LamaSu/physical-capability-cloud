/**
 * W7 A4 — Mobile-side decision POST.
 *
 * Closes the W7-A loop. After the user taps approve/decline in
 * `ApprovalSheet`, App.tsx calls `postApprovalDecision({...})` which
 * POSTs to:
 *
 *   ${baseUrl}/api/sessions/${sessionId}/approval/${approvalId}/${decision}
 *
 * with `Authorization: Bearer ${sessionToken}` and an empty JSON body.
 * The server's `awaitApprovalDecision` (W6 A2, in
 * `packages/gateway/src/routes/approval-request.ts`) resolves on receipt
 * and the parked centralized-settle continues.
 *
 * Status semantics:
 *   - 200 — gate resolved, settle proceeds (or rejects → 403 from settle)
 *   - 404 — no parked gate (e.g. mobile took longer than the timeout, or
 *     the approval was published via the W5 standalone path which doesn't
 *     register a gate). Treated as "decision delivered, no awaiter" — the
 *     caller still dismisses the sheet + ends the Live Activity.
 *   - 409 — a gate exists but the approvalId mismatches. Treated as a
 *     stale UI / replay; same UX outcome as 404.
 *   - 401 — missing/invalid bearer. Treated as a hard auth error; the
 *     caller surfaces a re-enroll prompt.
 *   - other 5xx / network — transient. Caller retries or surfaces the
 *     error in the sheet.
 *
 * DI seam: `_setFetchForTests(fn)` lets unit tests swap in a mock fetch
 * without touching `globalThis`. Must be reset to `null` in `afterEach`
 * to restore the default.
 */

export type ApprovalDecision = "approve" | "reject";

export interface PostApprovalDecisionInput {
  /** Gateway base URL, e.g. "https://capability.network". No trailing slash required. */
  baseUrl: string;
  /** Server-issued session id (the one in the SSE event payload's `id` field). */
  sessionId: string;
  /** Server-minted approvalId from the SSE event payload. */
  approvalId: string;
  /** Bearer token for the Authorization header. From `getSessionToken()`. */
  sessionToken: string;
  /** Whether the user approved or rejected. */
  decision: ApprovalDecision;
  /**
   * Optional: per-decision body. The server accepts:
   *   - approve: { signature?: string }
   *   - reject:  { reason?: string }
   * The client doesn't need either for the gate-resolve to succeed.
   */
  body?: Record<string, unknown>;
}

export interface PostApprovalDecisionResult {
  /** True when the gate was resolved (200) OR safely no-op'd (404/409). */
  success: boolean;
  /** HTTP status code from the gateway, or 0 on a network failure. */
  status: number;
  /** Server error code when present (e.g. "approval_not_found"). */
  errorCode?: string;
  /** Human-readable error message when `success === false`. */
  error?: string;
  /** True when the caller should re-enroll passkey + retry (401). */
  authError?: boolean;
}

// ── DI seam ────────────────────────────────────────────────────────────

let __fetchOverride: typeof fetch | null = null;

/** Test-only: inject a fake fetch and bypass `globalThis.fetch`. */
export function _setFetchForTests(fn: typeof fetch | null): void {
  __fetchOverride = fn;
}

function resolveFetch(): typeof fetch | null {
  if (__fetchOverride) return __fetchOverride;
  const gt = globalThis as unknown as { fetch?: typeof fetch };
  return gt.fetch ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * POST the user's decision back to the gateway. Idempotent under
 * double-invocation: a server-side "already-resolved" 404 / 409 maps to
 * `success: true` so the caller can safely dismiss the UI either way.
 */
export async function postApprovalDecision(
  input: PostApprovalDecisionInput,
): Promise<PostApprovalDecisionResult> {
  const fetchFn = resolveFetch();
  if (!fetchFn) {
    return {
      success: false,
      status: 0,
      error:
        "fetch is not available in this environment; install a polyfill or supply _setFetchForTests",
    };
  }

  const base = input.baseUrl.replace(/\/+$/, "");
  const url = `${base}/api/sessions/${encodeURIComponent(
    input.sessionId,
  )}/approval/${encodeURIComponent(input.approvalId)}/${input.decision}`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.sessionToken}`,
      },
      body: JSON.stringify(input.body ?? {}),
    });
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    return {
      success: false,
      status: 0,
      error: `network error: ${message}`,
    };
  }

  // 200: clean gate-resolve.
  if (res.status === 200) {
    return { success: true, status: 200 };
  }

  // 401: hard auth failure — caller should re-enroll.
  if (res.status === 401) {
    return {
      success: false,
      status: 401,
      authError: true,
      error: "unauthorized",
      errorCode: await safeReadErrorCode(res),
    };
  }

  // 404 / 409: idempotent / stale — server isn't waiting on us. Treat as
  // "decision delivered" so the UI dismisses cleanly. The response body
  // still carries the server's error code for diagnostics.
  if (res.status === 404 || res.status === 409) {
    const errorCode = await safeReadErrorCode(res);
    return { success: true, status: res.status, errorCode };
  }

  // 4xx / 5xx other: surface to caller.
  const errorCode = await safeReadErrorCode(res);
  return {
    success: false,
    status: res.status,
    error: `gateway returned ${res.status}`,
    errorCode,
  };
}

/**
 * Best-effort read of the error code from a JSON error response. Always
 * returns undefined on parse failure — the caller has the raw status
 * code which is the load-bearing signal.
 */
async function safeReadErrorCode(res: Response): Promise<string | undefined> {
  try {
    const json = (await res.json()) as { error?: unknown };
    return typeof json.error === "string" ? json.error : undefined;
  } catch {
    return undefined;
  }
}
