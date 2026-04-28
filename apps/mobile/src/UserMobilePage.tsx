import type { ReactElement } from "react";

/**
 * UserMobilePage — placeholder landing for the v1 user-side surface.
 *
 * The user role exists alongside operator (per
 * 15-MOBILE-APP-FIRST-PRINCIPLES.md § 4) and will receive:
 * - Session-approval prompts (via lock-screen-approve UX)
 * - Live progress for in-flight agent work (via Live Activity)
 * - Settlement receipts
 * - Category-level delegation rule configuration
 * - Cross-device continuity with desktop sessions
 *
 * For Week 1 we stub the screen with a heading + "Coming soon" copy.
 * Subsequent weeks layer in:
 *   Week 2 — passkey-bound smart-wallet identity
 *   Week 3 — push notifications + Live Activities
 *   Week 5 — inbound flows (CallKit / full-screen-Intent)
 *
 * Kept ultra-minimal and dependency-free (no @pcc/ui imports) because
 * Week 1's success criterion is "doesn't break the monorepo" — adding a
 * cross-package dependency expands the typecheck / build surface.
 */
export interface UserMobilePageProps {
  /** Called when the user wants to switch back to operator mode. */
  onSwitchToOperator?: () => void;
}

export function UserMobilePage({
  onSwitchToOperator,
}: UserMobilePageProps): ReactElement {
  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#0A1A0F",
        color: "#E5F4EA",
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
        display: "flex",
        flexDirection: "column",
        padding: "calc(env(safe-area-inset-top, 0px) + 24px) 24px calc(env(safe-area-inset-bottom, 0px) + 24px) 24px",
      }}
    >
      <header style={{ marginBottom: 32 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 8,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              backgroundColor: "#10B981",
              display: "inline-block",
            }}
            aria-hidden="true"
          />
          <span style={{ fontSize: 13, opacity: 0.85 }}>PCC User</span>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>
          Your agent sessions live here
        </h1>
      </header>

      <main style={{ flexGrow: 1 }}>
        <section
          style={{
            border: "1px solid rgba(16, 185, 129, 0.25)",
            borderRadius: 14,
            padding: "20px 18px",
            backgroundColor: "rgba(16, 185, 129, 0.05)",
          }}
        >
          <h2 style={{ fontSize: 18, margin: "0 0 8px 0" }}>Coming soon</h2>
          <p style={{ fontSize: 14, lineHeight: 1.5, margin: 0, opacity: 0.85 }}>
            Live agent sessions, settlement receipts, and category-level
            delegation rules will land here in subsequent releases.
          </p>
          <ul
            style={{
              margin: "16px 0 0 0",
              padding: 0,
              listStyle: "none",
              fontSize: 13,
              opacity: 0.75,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <li>
              <span style={{ marginRight: 8 }}>•</span>Approve sessions via
              lock-screen biometric (Week 3)
            </li>
            <li>
              <span style={{ marginRight: 8 }}>•</span>Track in-flight work via
              Live Activity (Week 3)
            </li>
            <li>
              <span style={{ marginRight: 8 }}>•</span>Receipts + on-chain
              receipts in plain language
            </li>
          </ul>
        </section>
      </main>

      {onSwitchToOperator && (
        <footer style={{ marginTop: 32 }}>
          <button
            type="button"
            onClick={onSwitchToOperator}
            style={{
              width: "100%",
              padding: "14px",
              borderRadius: 12,
              border: "1px solid rgba(16, 185, 129, 0.4)",
              backgroundColor: "transparent",
              color: "#10B981",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Switch to operator mode
          </button>
        </footer>
      )}
    </div>
  );
}
