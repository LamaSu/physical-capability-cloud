/**
 * SSE approval listener — Week 5 mobile side.
 *
 * Replaces the Week 3 dev-mode `setTimeout` fake trigger with a real
 * EventSource that subscribes to
 * `${baseUrl}/sse/stream/approval/${sessionId}`
 * and dispatches incoming `approval-request` events to a caller-provided
 * `onApproval` handler.
 *
 * Auth note (browser EventSource constraint):
 *   - Native browser `EventSource` does NOT support custom headers, so
 *     we cannot send `Authorization: Bearer ...` here. The gateway's
 *     `resolveSSEAuth` helper supports a `?token=` query-string fallback
 *     that accepts SIWE/passkey session tokens (long-lived API keys are
 *     refused in `?token=` to avoid leaking via proxy/CDN access logs).
 *   - We pass the Week-4 passkey-mint session token (returned from
 *     `POST /api/passkey/verify`) as `?token=` because it is short-lived
 *     and opaque — exactly what the helper expects.
 *   - In gateway-side production deployments where SSE_AUTH_REQUIRED=1
 *     and a token is required: the listener still attempts the connection
 *     even without a token (the caller's responsibility to ensure one is
 *     present); the SSE route returns 401 and the listener emits an
 *     `onAuthError` callback so the UI can surface a re-enroll prompt.
 *
 * Reconnect behavior:
 *   - On `error` event, the listener tears down the EventSource and waits
 *     `nextDelay()` ms before opening a new one. Backoff is exponential
 *     with jitter, starting at `INITIAL_BACKOFF_MS` and capped at
 *     `MAX_BACKOFF_MS`. On a successful `open`, the backoff resets.
 *   - On reconnect we attempt to resume from the last seen event via the
 *     `lastEventId` query parameter (the gateway's `streamHub` accepts
 *     last-event-id via header AND replays from the buffer; since we
 *     can't set headers in browser EventSource, we send it as a query
 *     param `&lastEventId=<id>` which the gateway DOES NOT yet read for
 *     resume — see "Limitation" below).
 *
 * Limitation:
 *   - The Last-Event-ID query-param resume path is not yet wired into
 *     `topic-sse.ts` (it currently reads `req.headers["last-event-id"]`
 *     only). For v1 mobile this means: if the SSE drops mid-flight,
 *     reconnects will start fresh from the live tail, not replay missed
 *     events. The streamHub buffer still holds the missed events and a
 *     Week 6 follow-up will plumb `?lastEventId=` into `setupSSE`. We
 *     pass it now so server-side wiring is mechanical when ready.
 *
 * Test surface:
 *   - `startApprovalListener(opts)` returns a `{ stop }` handle.
 *   - The implementation reads `globalThis.EventSource`, so tests can
 *     swap in a mock by assigning a constructor to that global.
 */

/** Tunable timing knobs (exported so tests can poke them). */
export const INITIAL_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
/** Multiplier per failed attempt. Standard exponential backoff. */
export const BACKOFF_MULTIPLIER = 2;

export interface ApprovalListenerOptions {
  /** The session id you want to listen on. Topic = approval:<sessionId>. */
  sessionId: string;
  /**
   * The Week-4 passkey-mint session token. Sent as `?token=`. May be null;
   * if so the listener still attempts the connection (works when
   * SSE_AUTH_REQUIRED is not enforced server-side).
   */
  sessionToken: string | null;
  /** Gateway base URL, e.g. "https://capability.network". No trailing slash. */
  baseUrl: string;
  /**
   * Called with the parsed payload of every `approval-request` event.
   * Errors thrown from this callback do NOT tear down the listener; they
   * are caught and routed to `onError` if provided.
   */
  onApproval: (payload: unknown) => void;
  /**
   * Optional: called on connection open. Useful for clearing a
   * "reconnecting…" UI affordance.
   */
  onOpen?: () => void;
  /**
   * Optional: called on parse / network errors. The listener does NOT
   * stop on these — it backs off + reconnects automatically.
   */
  onError?: (err: Error) => void;
  /**
   * Optional: called when the gateway returns 401 on the SSE handshake.
   * EventSource doesn't surface the HTTP status directly; we infer auth
   * failure by counting consecutive open-then-immediate-close cycles
   * with no `open` event firing. Strict-mode auth servers can also signal
   * 401 by closing immediately. The listener still backs off + retries
   * after this fires — the callback is informational so the UI can
   * surface a re-enroll prompt.
   */
  onAuthError?: () => void;
  /**
   * For tests + non-browser environments: pass an explicit EventSource
   * constructor instead of pulling from `globalThis`.
   */
  eventSourceCtor?: typeof EventSource;
}

export interface ApprovalListenerHandle {
  /** Stop the listener and close any underlying EventSource. */
  stop: () => void;
  /**
   * Read-only diagnostics. Useful for tests to assert on attempt count
   * + current backoff without poking internals.
   */
  readonly state: {
    readonly attempt: number;
    readonly running: boolean;
    readonly lastEventId: string | null;
  };
}

interface ListenerInternalState {
  attempt: number;
  running: boolean;
  current: EventSource | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastEventId: string | null;
  /**
   * Tracks consecutive failed attempts where no `open` event fired.
   * Used to heuristically detect 401 auth failures. (EventSource doesn't
   * surface response status to JS, so this is the best we can do.)
   */
  consecutiveOpenlessFailures: number;
}

/**
 * Compute the next reconnect delay using exponential backoff with full
 * jitter. Each attempt is in [0, base] where base is min(MAX, INITIAL *
 * MULT^attempt). The "full jitter" pattern (AWS architecture blog) gives
 * the best convergence behavior for many reconnecting clients.
 */
export function computeBackoff(attempt: number): number {
  const exp = Math.min(
    INITIAL_BACKOFF_MS * Math.pow(BACKOFF_MULTIPLIER, attempt),
    MAX_BACKOFF_MS,
  );
  // Full jitter: random in [0, exp]. Never block-storm at the cap.
  return Math.floor(Math.random() * exp);
}

function buildUrl(opts: {
  baseUrl: string;
  sessionId: string;
  sessionToken: string | null;
  lastEventId: string | null;
}): string {
  // Trim trailing slash for stability.
  const base = opts.baseUrl.replace(/\/+$/, "");
  const path = `/sse/stream/approval/${encodeURIComponent(opts.sessionId)}`;
  const params: string[] = [];
  if (opts.sessionToken) {
    params.push(`token=${encodeURIComponent(opts.sessionToken)}`);
  }
  if (opts.lastEventId) {
    // Note: gateway-side wiring not yet honored — see module docstring.
    params.push(`lastEventId=${encodeURIComponent(opts.lastEventId)}`);
  }
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${base}${path}${query}`;
}

/**
 * Resolve the EventSource constructor: prefer caller-provided, then
 * `globalThis.EventSource`. Returns null when none is available (e.g.
 * Node without polyfill).
 */
function resolveEventSourceCtor(
  override?: typeof EventSource,
): typeof EventSource | null {
  if (override) return override;
  const gt = globalThis as unknown as { EventSource?: typeof EventSource };
  return gt.EventSource ?? null;
}

/**
 * Start an approval listener. Returns a handle with a `stop()` method.
 *
 * The listener auto-reconnects on errors. To shut it down cleanly call
 * `handle.stop()` — usually from a React `useEffect` cleanup.
 */
export function startApprovalListener(
  opts: ApprovalListenerOptions,
): ApprovalListenerHandle {
  const Ctor = resolveEventSourceCtor(opts.eventSourceCtor);

  const state: ListenerInternalState = {
    attempt: 0,
    running: true,
    current: null,
    reconnectTimer: null,
    lastEventId: null,
    consecutiveOpenlessFailures: 0,
  };

  function safeReportError(message: string, cause?: unknown): void {
    if (!opts.onError) return;
    try {
      // Always synthesize a fresh Error so the descriptive message is
      // visible (e.g. "approval-request parse failed: …"). The original
      // is attached as `cause` for tooling that wants the underlying
      // stack.
      const causeStr =
        cause instanceof Error
          ? `: ${cause.message}`
          : cause === undefined
            ? ""
            : `: ${String(cause)}`;
      const err = new Error(`${message}${causeStr}`);
      if (cause instanceof Error) {
        (err as Error & { cause?: unknown }).cause = cause;
      }
      opts.onError(err);
    } catch {
      // Caller's error handler threw — swallow; nothing to do.
    }
  }

  function clearTimer(): void {
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function teardown(): void {
    if (state.current) {
      try {
        state.current.close();
      } catch {
        /* ignore */
      }
      state.current = null;
    }
  }

  function scheduleReconnect(): void {
    if (!state.running) return;
    const delay = computeBackoff(state.attempt);
    state.attempt += 1;
    clearTimer();
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.running) connect();
    }, delay);
  }

  function connect(): void {
    if (!state.running) return;
    if (!Ctor) {
      safeReportError(
        "EventSource is not available in this environment; install eventsource polyfill or supply opts.eventSourceCtor",
      );
      // No retry — there's nothing to retry against.
      state.running = false;
      return;
    }
    teardown();

    const url = buildUrl({
      baseUrl: opts.baseUrl,
      sessionId: opts.sessionId,
      sessionToken: opts.sessionToken,
      lastEventId: state.lastEventId,
    });

    let openFired = false;
    const es = new Ctor(url);
    state.current = es;

    es.onopen = (): void => {
      openFired = true;
      state.attempt = 0; // reset backoff on success
      state.consecutiveOpenlessFailures = 0;
      if (opts.onOpen) {
        try { opts.onOpen(); } catch (err) { safeReportError("onOpen threw", err); }
      }
    };

    /**
     * The gateway sends the `approval-request` event using a named SSE
     * event (`event: approval-request`), so we listen for it specifically.
     * Fallback: many SSE servers also send a default `message` event;
     * we listen there too in case of test harnesses that don't honor
     * named events.
     */
    const dispatch = (evt: MessageEvent): void => {
      // Track the event id so we can resume from it on reconnect.
      if (typeof evt.lastEventId === "string" && evt.lastEventId.length > 0) {
        state.lastEventId = evt.lastEventId;
      }
      try {
        const parsed = JSON.parse(String(evt.data));
        opts.onApproval(parsed);
      } catch (err) {
        safeReportError("approval-request parse failed", err);
      }
    };

    es.addEventListener("approval-request", dispatch as EventListener);
    // Default message event fallback (some test harnesses).
    es.onmessage = dispatch;

    es.onerror = (): void => {
      // EventSource errors are opaque — we can't see HTTP status. Treat
      // every error as "connection lost, retry" and use the
      // consecutive-failure heuristic to flag possible auth failures.
      if (!openFired) {
        state.consecutiveOpenlessFailures += 1;
        // Two consecutive failures with no open is very likely auth.
        if (
          state.consecutiveOpenlessFailures >= 2 &&
          opts.onAuthError
        ) {
          try { opts.onAuthError(); } catch { /* ignore */ }
        }
      } else {
        state.consecutiveOpenlessFailures = 0;
      }
      teardown();
      scheduleReconnect();
    };
  }

  // Kick off the first connection.
  connect();

  return {
    stop: () => {
      state.running = false;
      clearTimer();
      teardown();
    },
    get state() {
      return {
        attempt: state.attempt,
        running: state.running,
        lastEventId: state.lastEventId,
      };
    },
  };
}
