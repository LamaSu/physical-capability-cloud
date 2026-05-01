import { useEffect, useState, type ReactElement } from "react";
import { RoleSwitch } from "./RoleSwitch.js";
import { UserMobilePage } from "./UserMobilePage.js";
import {
  getRole,
  getSessionToken,
  migrateLegacyApiKey,
  type Role,
} from "./storage/secure-api-key.js";
import { registerServiceWorker } from "./sw/service-worker.js";
import {
  ApprovalSheet,
  type ApprovalSession,
  type SignedReceipt,
} from "./components/ApprovalSheet.js";
import {
  startApprovalListener,
  type ApprovalListenerHandle,
} from "./sse/approval-listener.js";
import { postApprovalDecision } from "./sse/approval-decision.js";
import {
  startApprovalActivity,
  endApprovalActivity,
  updateApprovalActivity,
  onApprovalActivityTap,
  onApprovalActivityDismiss,
  type ApprovalActivityHandle,
} from "./live-activity/approval-activity.js";

/**
 * Phase 5 (W8) — sessionStorage cache key for the in-flight approval.
 * Survives browser tab reload + Capacitor cold-start so a Live Activity tap
 * can re-hydrate the ApprovalSheet for the right session even when the JS
 * process has been recycled.
 */
const APPROVAL_CACHE_KEY = "pcc-pending-approval";

/** Stash an approval payload into sessionStorage. No-op outside browsers. */
function cacheApproval(payload: ApprovalSession): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(APPROVAL_CACHE_KEY, JSON.stringify(payload));
    }
  } catch {
    /* sessionStorage unavailable / quota — non-fatal */
  }
}

/** Read + parse cached approval; returns null if absent or malformed. */
function readCachedApproval(): ApprovalSession | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(APPROVAL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ApprovalSession;
    }
    return null;
  } catch {
    return null;
  }
}

/** Clear the cached approval (call after resolution or expiry). */
function clearCachedApproval(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(APPROVAL_CACHE_KEY);
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Parse a deep-link URL of the form `pcc-mobile://approval/<sessionId>` or
 * a same-origin `?approval=<sessionId>` query param. Returns the session id
 * when present; null otherwise. Used by the Phase 5 cold-start handler.
 */
function parseApprovalDeepLink(): string | null {
  try {
    if (typeof window === "undefined" || !window.location) return null;
    // Query-string form (works for any host, including local dev).
    const search = window.location.search;
    if (search) {
      const params = new URLSearchParams(search);
      const v = params.get("approval");
      if (v) return v;
    }
    // Custom-scheme form. Some platforms surface it via window.location.href.
    const href = window.location.href;
    const m = href.match(/pcc-mobile:\/\/approval\/([^/?#]+)/);
    if (m) return decodeURIComponent(m[1]);
    return null;
  } catch {
    return null;
  }
}

/**
 * App-shell entry point for the Capacitor wrap.
 *
 * Boot sequence:
 *   1. Migrate any legacy localStorage API key into native secure storage.
 *   2. Register the service worker (no-op when running in a Capacitor
 *      WebView that already loads from server.url — the SW will be picked
 *      up by the dashboard's HTML when navigating to /operator/mobile).
 *   3. Resolve the persisted role (defaults to "user").
 *   4. operator → load /operator/mobile in the same window (Capacitor's
 *      WebView is already pointed at server.url; we just navigate).
 *      user     → render <UserMobilePage> in this React shell.
 *
 * The shell keeps the user-mode UI inside the React app for now because
 * v1 dashboard is operator-only mobile. As user-mode flows mature we can
 * either move them into the dashboard at /user/mobile (and just navigate
 * there) or keep them React-shell-resident. See ARCHITECTURE.md § 2.
 */
/**
 * Channel-id resolution — Week 6 A3.
 *
 * On boot the mobile POSTs to `/api/sessions/<sessionToken>/subscribe`
 * with `Authorization: Bearer <sessionToken>` to mint an opaque
 * channelId. The listener then opens
 * `/sse/stream/approval/<channelId>?token=<sessionToken>`.
 *
 * If the subscribe call fails for any reason (network error, server not
 * yet upgraded, anything), we fall back to using the sessionToken AS
 * the channelId — that's the W5 token-as-channel-id behavior. Servers
 * upgraded to W6 still publish to BOTH topics (session-id AND
 * channel-id) when a subscription exists, so this is a clean
 * opt-in upgrade with no flag day.
 */
async function fetchChannelId(
  sessionToken: string,
  baseUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/api/sessions/${encodeURIComponent(
        sessionToken,
      )}/subscribe`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { channelId?: unknown };
    return typeof body.channelId === "string" && body.channelId.length > 0
      ? body.channelId
      : null;
  } catch {
    return null;
  }
}

/** Resolve the gateway base URL for SSE. Falls back to capability.network. */
function getGatewayBaseUrl(): string {
  // Build-time env injected by Vite, e.g. VITE_PCC_GATEWAY_URL.
  // In jsdom unit tests `import.meta.env` is undefined; we treat that as
  // production gateway since the unit tests mock EventSource anyway.
  try {
    const meta = (import.meta as { env?: { VITE_PCC_GATEWAY_URL?: string } })
      .env;
    if (meta?.VITE_PCC_GATEWAY_URL) return meta.VITE_PCC_GATEWAY_URL;
  } catch {
    /* ignore */
  }
  return "https://capability.network";
}

export function App(): ReactElement {
  const [role, setRole] = useState<Role | null>(null);
  // Week 3: holds the session proposed for the user's approval, or null
  // when there is nothing to approve. Week 5 wires this to a real SSE
  // listener that subscribes to the gateway's approval-request topic.
  // The dev-mode fake trigger is preserved as a fallback for test/dev
  // when no token is configured.
  const [pendingApproval, setPendingApproval] =
    useState<ApprovalSession | null>(null);
  // The persisted Week-4 passkey session token. Loaded asynchronously
  // alongside role; used as both the SSE channel id and the ?token= auth
  // param.
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  // Week 6 B5: the in-flight Live Activity handle, if any. Stored so the
  // approve/decline handlers can cleanly end the activity with the right
  // outcome.
  const [liveActivity, setLiveActivity] =
    useState<ApprovalActivityHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1. Migrate legacy API key (no-op outside Capacitor)
      try {
        await migrateLegacyApiKey();
      } catch (err) {
        console.warn("[pcc-mobile] secure-storage migration failed:", err);
      }
      // 2. Register service worker (no-op if not in a window with one
      // available; safe to call repeatedly)
      try {
        await registerServiceWorker();
      } catch (err) {
        console.warn("[pcc-mobile] service worker registration failed:", err);
      }
      // 3. Resolve role + session token in parallel
      const [r, t] = await Promise.all([getRole(), getSessionToken()]);
      if (!cancelled) {
        setRole(r);
        setSessionToken(t);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Real SSE approval listener — Week 5 + Week 6 A3 (channel-id opt-in).
   *
   * Active when role === "user" AND a session token exists in secure
   * storage. On boot the mobile asks the gateway for a fresh channelId
   * via POST /api/sessions/:sessionToken/subscribe. If the call fails
   * we fall back to the W5 path (use sessionToken AS channelId), so
   * older gateway deployments and offline boots both keep working.
   *
   * Cleanup: the returned handle's `stop()` is invoked on unmount or
   * when role/sessionToken change.
   */
  useEffect(() => {
    if (role !== "user") return;
    if (!sessionToken) return;
    let cancelled = false;
    let handle: ApprovalListenerHandle | null = null;
    (async () => {
      const baseUrl = getGatewayBaseUrl();
      // Try to mint a channelId; fall back to token-as-channel-id when
      // the call fails for any reason (W5 behavior).
      const minted = await fetchChannelId(sessionToken, baseUrl);
      if (cancelled) return;
      const channelId = minted ?? sessionToken;
      try {
        handle = startApprovalListener({
          sessionId: channelId,
          sessionToken,
          baseUrl,
          onApproval: (payload) => {
            if (
              payload &&
              typeof payload === "object" &&
              !Array.isArray(payload)
            ) {
              const session = payload as ApprovalSession;
              setPendingApproval(session);
              // Phase 5 (W8): cache the approval so a Live Activity tap on
              // a cold-started app can re-hydrate the sheet for this session.
              cacheApproval(session);
              // Live Activity (Week 6 B5 + W8 Phase 2): start with the
              // initial "waiting" content state. handleApprove / handleDecline
              // walk the phase ladder via updateApprovalActivity.
              try {
                const liveHandle = startApprovalActivity({
                  id: session.id,
                  capability: session.capability,
                  amountUsd: session.amountUsd,
                  operatorName: session.operatorName,
                  expiresAt:
                    typeof (session as { expiresAt?: unknown }).expiresAt ===
                    "string"
                      ? (session as { expiresAt?: string }).expiresAt
                      : undefined,
                });
                setLiveActivity(liveHandle);
              } catch (err) {
                console.warn(
                  "[pcc-mobile] live-activity start failed:",
                  (err as Error).message,
                );
              }
            }
          },
          /**
           * W9 B: server-side settle-progress events drive intra-settling
           * progress on the lock-screen Live Activity. The approval
           * listener parses + dispatches the {phase, progress} payload
           * here; we forward it to the live-activity wrapper so the
           * widget can render a deterministic progress bar without
           * waiting for the HTTP settle response.
           *
           * We use a setLiveActivity callback form to read the latest
           * handle without re-subscribing on every dispatch — the
           * handle reference is stable for the duration of an approval,
           * so the closure-captured one works too, but the callback
           * form is more defensive against React 18 strict-mode double-
           * mounts.
           */
          onProgress: (payload) => {
            // Skip when no Live Activity is in flight (e.g. dev-mode
            // synthetic events that didn't start one). Reading stale
            // closure state via setLiveActivity is fine — we just bail.
            setLiveActivity((current) => {
              if (current) {
                try {
                  updateApprovalActivity(current, {
                    phase: "settling",
                    progress: payload.progress,
                  });
                } catch (err) {
                  console.warn(
                    "[pcc-mobile] live-activity progress update failed:",
                    (err as Error).message,
                  );
                }
              }
              return current; // no state change — callback form just used to read latest
            });
          },
          onError: (err) => {
            console.warn("[pcc-mobile] approval listener error:", err.message);
          },
        });
      } catch (err) {
        console.warn(
          "[pcc-mobile] approval listener could not be started:",
          (err as Error).message,
        );
      }
    })();
    return () => {
      cancelled = true;
      handle?.stop();
    };
  }, [role, sessionToken]);

  // Week 3 dev-mode fallback: when the dev-mode flag is on AND we have
  // not yet received a real approval-request event, stub one in after
  // 3s so the UI is exercisable without a backend. Preserved on purpose
  // — useful for storybook/dev work and CI smoke screenshots. In
  // production builds with a configured session token, the real
  // listener will fire long before the 3s timer.
  useEffect(() => {
    if (role !== "user") return;
    if (!isDevModeFakeApprovalEnabled()) return;
    const t = setTimeout(() => {
      // Only stub if the real listener hasn't already populated one.
      setPendingApproval((prev) =>
        prev !== null
          ? prev
          : {
              id: "dev-session-001",
              capability: "haircut",
              amountUsd: 32,
              operatorName: "Andre's Hair Salon",
              evidenceHash:
                "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
              captureClass: "tier-1-photo",
            },
      );
    }, 3000);
    return () => clearTimeout(t);
  }, [role]);

  /**
   * Phase 5 (W8) — cold-start deep-link rehydration.
   *
   * When the OS launches the app via a Live Activity tap (custom URL
   * scheme `pcc-mobile://approval/<sessionId>` or a same-origin
   * `?approval=<sessionId>` query), restore the cached approval payload
   * so the ApprovalSheet renders for the right session immediately —
   * even though the JS process has been recycled and the SSE listener
   * hasn't re-established yet.
   *
   * Falls back to the cached payload alone when the deep link is
   * absent but a cache entry exists (e.g. user re-opened the app without
   * tapping the activity but the original session is still pending).
   */
  useEffect(() => {
    if (role !== "user") return;
    const deepLinkSessionId = parseApprovalDeepLink();
    const cached = readCachedApproval();
    if (!cached) return;
    if (deepLinkSessionId && cached.id !== deepLinkSessionId) {
      // The OS dispatched a tap for a different session than the one
      // we cached. Trust the deep-link, drop the stale cache.
      clearCachedApproval();
      return;
    }
    // Always re-hydrate the sheet from cache — benign even without a
    // deep-link (the SSE listener will overwrite if a fresher event lands).
    setPendingApproval((prev) => prev ?? cached);
    // Only restart the Live Activity when there's an explicit deep-link
    // signal. A bare cache hit may just be leftover state from a still-
    // running session whose activity is alive on iOS already; we'd
    // otherwise double-start.
    if (!deepLinkSessionId) return;
    try {
      const handle = startApprovalActivity({
        id: cached.id,
        capability: cached.capability,
        amountUsd: cached.amountUsd,
        operatorName: cached.operatorName,
        expiresAt:
          typeof (cached as { expiresAt?: unknown }).expiresAt === "string"
            ? (cached as { expiresAt?: string }).expiresAt
            : undefined,
      });
      setLiveActivity((prev) => prev ?? handle);
    } catch {
      /* non-fatal */
    }
  }, [role]);

  /**
   * Phase 4 (W8) — tap / dismiss subscribers.
   *
   * tap   → re-show the ApprovalSheet for the cached session (covers the
   *         warm-start case where the JS process is alive but the user
   *         dismissed the sheet earlier without resolving).
   * dismiss → end the Live Activity locally without sending a server
   *         decision; the W6 server-side approval-timeout will catch it.
   */
  useEffect(() => {
    if (role !== "user") return;
    const offTap = onApprovalActivityTap((id) => {
      const cached = readCachedApproval();
      if (cached && cached.id === id) {
        setPendingApproval((prev) => prev ?? cached);
      }
    });
    const offDismiss = onApprovalActivityDismiss((id) => {
      // Dismiss without server POST. The user pulled the activity off
      // the lock-screen; treat that as "I'll deal with it via the app".
      setLiveActivity((prev) => {
        if (prev && prev.id === id) {
          try {
            endApprovalActivity(prev, { outcome: "dismiss" });
          } catch {
            /* non-fatal */
          }
          return null;
        }
        return prev;
      });
    });
    return () => {
      offTap();
      offDismiss();
    };
  }, [role]);

  /**
   * Phase 8 (W8) — expired-state timer.
   *
   * If the active approval has an `expiresAt` timestamp and that time
   * passes without the user resolving it, end the Live Activity with
   * outcome=expired and clear the sheet. The W6 server-side timeout
   * (default 60s) will independently reject the gate; this is the
   * client-side mirror so the UI reflects reality without waiting on
   * a server round-trip.
   */
  useEffect(() => {
    if (!pendingApproval) return;
    const expiresAtRaw = (pendingApproval as { expiresAt?: unknown })
      .expiresAt;
    if (typeof expiresAtRaw !== "string") return;
    const expiresAtMs = Date.parse(expiresAtRaw);
    if (!Number.isFinite(expiresAtMs)) return;
    const delay = expiresAtMs - Date.now();
    if (delay <= 0) {
      // Already expired — fire immediately on the next tick.
      const t = setTimeout(() => {
        setPendingApproval(null);
        clearCachedApproval();
        if (liveActivity) {
          try {
            endApprovalActivity(liveActivity, { outcome: "expired" });
          } catch {
            /* non-fatal */
          }
          setLiveActivity(null);
        }
      }, 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setPendingApproval(null);
      clearCachedApproval();
      if (liveActivity) {
        try {
          endApprovalActivity(liveActivity, { outcome: "expired" });
        } catch {
          /* non-fatal */
        }
        setLiveActivity(null);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [pendingApproval, liveActivity]);

  /**
   * Approve handler — Week 7 A5.
   *
   * Closes the W7-A loop. Flow on tap of "Approve with Face ID":
   *   1. ApprovalSheet has already biometric-signed and is calling us
   *      with the SignedReceipt (assertion bytes inside).
   *   2. We POST the decision back to the gateway via
   *      postApprovalDecision(). The gateway's awaitApprovalDecision()
   *      resolves and the parked centralized-settle proceeds.
   *   3. On success we dismiss the sheet + end the Live Activity with
   *      outcome=approve. On error we THROW so ApprovalSheet's existing
   *      error-state machinery surfaces the message and the user can
   *      retry — leaving the sheet open AND the Live Activity running.
   *
   * Failure modes:
   *   - 401 / authError → throw with a re-enroll-friendly message; the
   *     sheet shows it, the user can retry after re-enrolling. Live
   *     Activity stays up.
   *   - Network / 5xx  → throw the error message; sheet surfaces it.
   *     Live Activity stays up so the user knows the request is still
   *     pending server-side.
   *   - 404 / 409      → treated as success by postApprovalDecision
   *     (idempotent / stale-id) — UI dismisses, Live Activity ends.
   *
   * Missing approvalId / sessionToken: the dev-mode synthetic event
   * doesn't carry one. In that case we skip the POST entirely and just
   * dismiss locally (preserves the W3-W6 dev-mode behavior).
   */
  const handleApprove = async (signed: SignedReceipt): Promise<void> => {
    const approvalId = pendingApproval?.approvalId;
    const sessionId = pendingApproval?.id ?? signed.sessionId;
    // Phase 2 (W8): user tapped approve → walk the activity phase ladder.
    // Surfaces "approved" on the lock-screen even before the network call
    // returns so the user has visible feedback the action registered.
    if (liveActivity) {
      try {
        updateApprovalActivity(liveActivity, { phase: "approved" });
      } catch {
        /* non-fatal */
      }
    }
    if (approvalId && sessionToken) {
      const baseUrl = getGatewayBaseUrl();
      // Phase 2 (W8): server is now processing the decision.
      if (liveActivity) {
        try {
          updateApprovalActivity(liveActivity, { phase: "settling" });
        } catch {
          /* non-fatal */
        }
      }
      const result = await postApprovalDecision({
        baseUrl,
        sessionId,
        approvalId,
        sessionToken,
        decision: "approve",
        // Forward the biometric assertion so the server-side audit log
        // can record it. The gateway's resolveApprovalGate() doesn't
        // require a signature for the gate-resolve to succeed, but the
        // signed receipt is durable evidence the user really tapped.
        body: { signature: serializeAssertion(signed) },
      });
      if (!result.success) {
        // Phase 8 (W8): 408 from the server means the user took longer
        // than the gate timeout — surface as "expired" not as a generic
        // error so the UX matches the actual server-side state.
        if (result.status === 408) {
          setPendingApproval(null);
          clearCachedApproval();
          if (liveActivity) {
            try {
              endApprovalActivity(liveActivity, { outcome: "expired" });
            } catch {
              /* non-fatal */
            }
            setLiveActivity(null);
          }
          throw new Error(
            "This request expired before you approved. Please retry from a fresh request.",
          );
        }
        // Hand the error back to ApprovalSheet so it stays open and the
        // user can retry. We do NOT end the Live Activity here — leaving
        // it visible signals to the user that the request is still
        // pending server-side. Roll the activity back to "waiting" so
        // the lock-screen badge no longer says "approved".
        if (liveActivity) {
          try {
            updateApprovalActivity(liveActivity, { phase: "waiting" });
          } catch {
            /* non-fatal */
          }
        }
        const message =
          result.authError === true
            ? "Sign-in expired. Re-enroll your passkey and try again."
            : (result.error ?? `Failed to send approval (HTTP ${result.status}).`);
        throw new Error(message);
      }
    } else {
      console.info("[pcc-mobile] approve: no approvalId/token — dev-mode path", {
        sessionId,
      });
    }

    console.info("[pcc-mobile] session approved", {
      sessionId,
      signedAt: signed.signedAt,
    });
    setPendingApproval(null);
    clearCachedApproval();
    // Week 6 B5 + W8 Phase 2: terminal "done" content state then end.
    if (liveActivity) {
      try {
        updateApprovalActivity(liveActivity, { phase: "done" });
        endApprovalActivity(liveActivity, { outcome: "approve" });
      } catch (err) {
        console.warn(
          "[pcc-mobile] live-activity end failed:",
          (err as Error).message,
        );
      }
      setLiveActivity(null);
    }
  };

  /**
   * Decline handler — Week 7 A5.
   *
   * Mirror of handleApprove on the reject path. Differences:
   *   - No SignedReceipt — the user chose to dismiss without signing,
   *     so we POST an empty body.
   *   - We dismiss the sheet + end the Live Activity unconditionally.
   *     If the decision POST fails (network/server), we still consider
   *     the user's intent honored locally — the W6 timeout will eventually
   *     reject the gate anyway.
   *
   * The void return type matches ApprovalSheet's onDecline signature
   * (sync void), so we kick off the async POST without awaiting it.
   */
  const handleDecline = (): void => {
    const approvalId = pendingApproval?.approvalId;
    const sessionId = pendingApproval?.id;
    if (approvalId && sessionId && sessionToken) {
      const baseUrl = getGatewayBaseUrl();
      void postApprovalDecision({
        baseUrl,
        sessionId,
        approvalId,
        sessionToken,
        decision: "reject",
        body: { reason: "user-declined" },
      })
        .then((result) => {
          if (!result.success) {
            console.warn(
              "[pcc-mobile] decline POST failed:",
              result.error ?? `HTTP ${result.status}`,
            );
          }
        })
        .catch((err) => {
          console.warn("[pcc-mobile] decline POST threw:", (err as Error).message);
        });
    }
    console.info("[pcc-mobile] session declined", { sessionId });
    setPendingApproval(null);
    clearCachedApproval();
    if (liveActivity) {
      try {
        // W8 Phase 2: terminal "done" before ending so the lock-screen
        // shows the resolved state for the brief window before dismissal.
        updateApprovalActivity(liveActivity, { phase: "done" });
        endApprovalActivity(liveActivity, { outcome: "reject" });
      } catch (err) {
        console.warn(
          "[pcc-mobile] live-activity end failed:",
          (err as Error).message,
        );
      }
      setLiveActivity(null);
    }
  };

  /**
   * Compress the WebAuthn SignedReceipt into a compact opaque string for
   * the server-side audit log. Server doesn't verify it — any non-empty
   * string lets the gate resolve. We use base64url(JSON({sessionId, decision,
   * signedAt, assertion-id})) so the trail is human-readable in dev tools
   * but doesn't bloat the request.
   */
  function serializeAssertion(signed: SignedReceipt): string {
    try {
      const compact = {
        sessionId: signed.sessionId,
        decision: signed.decision,
        signedAt: signed.signedAt,
        // SignResult shape varies per platform; we extract id when present.
        assertionId:
          (signed.assertion as unknown as { id?: string })?.id ?? null,
      };
      return JSON.stringify(compact);
    } catch {
      return "passkey-assertion-opaque";
    }
  }

  if (role === null) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0A1A0F",
          color: "#E5F4EA",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
        role="status"
        aria-live="polite"
      >
        <span style={{ opacity: 0.6 }}>Loading…</span>
      </div>
    );
  }

  if (role === "operator") {
    // The Capacitor shell loads server.url already — when it boots in
    // operator mode we simply navigate the WebView at /operator/mobile.
    // This branch also runs if someone opens the React shell standalone
    // in a browser; the navigation effectively redirects them to the
    // deployed dashboard.
    return <OperatorBridge />;
  }

  return (
    <>
      <UserMobilePage
        onSwitchToOperator={() => setRole("operator")}
      />
      {pendingApproval && (
        <ApprovalSheet
          session={pendingApproval}
          onApprove={handleApprove}
          onDecline={handleDecline}
          enrollOptions={{
            userId: "pcc-user",
            displayName: "PCC User",
          }}
        />
      )}
    </>
  );
}

/**
 * Detect whether the dev-mode fake-approval trigger should fire. Enabled
 * when:
 *   - import.meta.env.DEV is true (vite dev mode), OR
 *   - the URL has ?devApproval=1 (allows ad-hoc demos in production
 *     builds for QA), OR
 *   - localStorage["pcc-mobile-dev-approval"] === "1"
 */
function isDevModeFakeApprovalEnabled(): boolean {
  // import.meta.env is replaced at build time by Vite. In jsdom unit
  // tests it's undefined; we treat undefined as "not dev" so tests don't
  // accidentally trigger.
  let isViteDev = false;
  try {
    const meta = (import.meta as { env?: { DEV?: boolean } }).env;
    isViteDev = !!meta?.DEV;
  } catch {
    // import.meta is missing in CommonJS-style runners — ignore.
  }
  if (isViteDev) return true;
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location?.search ?? "");
    if (params.get("devApproval") === "1") return true;
  }
  if (typeof localStorage !== "undefined") {
    if (localStorage.getItem("pcc-mobile-dev-approval") === "1") return true;
  }
  return false;
}

/**
 * In Capacitor, server.url already points the WebView at the dashboard,
 * so we don't need to navigate from the React side. In a plain browser
 * this redirects the user to the operator/mobile route on the dashboard.
 *
 * We avoid full window.location replacement on Capacitor because that
 * would unload the React shell (which holds the role-switch state). On
 * Capacitor we just render a thin "Switching to operator…" UI that the
 * native shell can replace by reloading the WebView at the right URL via
 * its own native navigation API in subsequent weeks.
 */
function OperatorBridge(): ReactElement {
  useEffect(() => {
    // In a browser, redirect. In Capacitor, this URL is already loaded;
    // window.location.replace is still safe (no-op when origin matches).
    if (typeof window === "undefined") return;
    const target = `${window.location.origin}/operator/mobile`;
    if (window.location.pathname !== "/operator/mobile") {
      window.location.replace(target);
    }
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0A1A0F",
        color: "#E5F4EA",
        fontFamily: "system-ui, -apple-system, sans-serif",
        gap: 24,
        padding: 24,
      }}
    >
      <span style={{ fontSize: 16, opacity: 0.85 }}>
        Loading operator mode…
      </span>
      <RoleSwitch variant="compact" />
    </div>
  );
}
