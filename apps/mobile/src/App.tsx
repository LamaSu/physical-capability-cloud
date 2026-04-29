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
 * Week 5: how the listener knows which channel to subscribe to.
 *
 * The gateway publishes approval requests to topic `approval:<sessionId>`.
 * For v1 the mobile uses its persisted Week-4 passkey session token AS
 * the channel id — i.e. the agent issuing a request on the user's behalf
 * POSTs to `/api/sessions/<that-token>/request-approval`. This works
 * because:
 *   - The token is already opaque, unguessable, and per-device.
 *   - The user shares the token with their agent at the same moment they
 *     authorize that agent to act for them.
 *   - The gateway's per-topic SSE isolation means no other subscriber
 *     can fish for the user's events.
 *
 * Decoupling channel-id from session-token is a Week 6+ refinement
 * (likely tying it to a "subscription" record minted at agent-onboarding
 * time so a single agent can hand the channel-id to multiple sessions).
 */
function getChannelIdFromToken(token: string | null): string | null {
  return token;
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
   * Real SSE approval listener — Week 5.
   *
   * Active when role === "user" AND a session token exists in secure
   * storage. On approval-request events the payload is mapped onto
   * ApprovalSession (which is a structural superset of the wire shape)
   * and surfaced via setPendingApproval — same UI path the dev-mode
   * fake trigger uses.
   *
   * Cleanup: the returned handle's `stop()` is invoked on unmount or
   * when role/sessionToken change.
   */
  useEffect(() => {
    if (role !== "user") return;
    const channelId = getChannelIdFromToken(sessionToken);
    if (!channelId) return;
    let handle: ApprovalListenerHandle | null = null;
    try {
      handle = startApprovalListener({
        sessionId: channelId,
        sessionToken,
        baseUrl: getGatewayBaseUrl(),
        onApproval: (payload) => {
          // The wire shape from POST /api/sessions/:id/request-approval
          // is structurally compatible with ApprovalSession (id,
          // capability, amountUsd, operatorName, evidenceHash, optional
          // captureClass). Extra fields (kernelId, params, requestedAt)
          // pass through harmlessly.
          if (
            payload &&
            typeof payload === "object" &&
            !Array.isArray(payload)
          ) {
            setPendingApproval(payload as ApprovalSession);
          }
        },
        onError: (err) => {
          // Logged but not surfaced — the listener auto-reconnects.
          console.warn("[pcc-mobile] approval listener error:", err.message);
        },
      });
    } catch (err) {
      console.warn(
        "[pcc-mobile] approval listener could not be started:",
        (err as Error).message,
      );
    }
    return () => {
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

  const handleApprove = async (signed: SignedReceipt): Promise<void> => {
    // In Week 4 this POSTs to /api/sessions/:id/approve with the
    // assertion. For Week 3 we just log and dismiss.
    console.info("[pcc-mobile] session approved", {
      sessionId: signed.sessionId,
      signedAt: signed.signedAt,
    });
    setPendingApproval(null);
  };

  const handleDecline = (): void => {
    console.info("[pcc-mobile] session declined");
    setPendingApproval(null);
  };

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
