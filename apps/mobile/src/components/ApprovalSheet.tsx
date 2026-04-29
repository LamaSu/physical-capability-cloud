import { useEffect, useState, type ReactElement } from "react";
import {
  passkeyManager,
  challengeBytesFromPayload,
  type PasskeyManager,
  type SignResult,
} from "../wallet/passkey-manager.js";

/**
 * ApprovalSheet — bottom-sheet UX that asks the user to approve a session
 * proposed by an agent on their behalf. Per Option C
 * (15-MOBILE-APP-FIRST-PRINCIPLES.md v3 + 16-CENTRALIZED-ALTERNATIVE.md), the
 * sheet:
 *   1. Shows the proposed capability + operator + amount in plain English
 *   2. Shows a 2-line evidence summary (capture-class + hash short-form)
 *   3. Biometric-gates the approval through passkey-manager.signApproval
 *   4. Returns the signed assertion to the caller (App.tsx → server POST)
 *
 * Decline simply calls onDecline — no signing happens. The caller decides
 * whether to inform the server of the decline.
 *
 * Failure modes the sheet handles:
 *   - Not-enrolled (call enroll-then-sign in one click)
 *   - Biometric denied / cancelled (offer retry)
 *   - Network error from caller's onApprove (surfaces error message)
 *
 * Styling matches the dashboard's dark-theme aesthetic without pulling in
 * framer-motion or @pcc/ui — the shell stays dependency-light.
 */

export interface ApprovalSession {
  /** Server-issued opaque session id */
  id: string;
  /** Capability label shown to user, e.g. "haircut" */
  capability: string;
  /** Total in USD (nominal — actual settlement is on-chain USDC) */
  amountUsd: number;
  /** Operator-facing display name, e.g. "Andre's Hair Salon" */
  operatorName: string;
  /** Hex SHA-256 of the evidence-bundle hash so far */
  evidenceHash: string;
  /**
   * Capture-class label, e.g. "tier-1-photo" or "tier-2-attested".
   * Surfaced to the user in plain language when present.
   */
  captureClass?: string;
  /** Stable, pre-canonicalized payload to be signed. */
  challengePayload?: unknown;
}

export interface SignedReceipt {
  /** Session id (echo) */
  sessionId: string;
  /** Decision */
  decision: "approve";
  /** WebAuthn assertion bundle from passkey-manager */
  assertion: SignResult;
  /** ISO 8601 timestamp when the user signed */
  signedAt: string;
}

export interface ApprovalSheetProps {
  /** The session payload the agent / server proposed. */
  session: ApprovalSession;
  /** Called with the signed receipt when the user approves. */
  onApprove: (signed: SignedReceipt) => void | Promise<void>;
  /** Called when the user declines or dismisses without signing. */
  onDecline: () => void;
  /**
   * Override the manager (DI for tests). Defaults to the singleton from
   * passkey-manager.
   */
  manager?: Pick<
    PasskeyManager,
    "isAvailable" | "enroll" | "sign" | "getCredentialId"
  >;
  /** User identity for enrollment if not yet enrolled. */
  enrollOptions?: { userId: string; displayName: string };
  /** Whether to render — when false the component renders nothing. */
  open?: boolean;
}

type ApprovalState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "needs-enroll" }
  | { kind: "enrolling" }
  | { kind: "signing" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "done" };

export function ApprovalSheet(props: ApprovalSheetProps): ReactElement | null {
  const {
    session,
    onApprove,
    onDecline,
    manager = passkeyManager,
    enrollOptions,
    open = true,
  } = props;

  const [state, setState] = useState<ApprovalState>({ kind: "idle" });
  const [credentialId, setCredentialId] = useState<string | null>(null);

  // Pre-load enrollment status when the sheet opens so the primary button
  // can label itself "Approve with Face ID" vs "Enroll passkey + Approve"
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setState({ kind: "checking" });
      try {
        const id = await manager.getCredentialId();
        if (cancelled) return;
        setCredentialId(id);
        setState({ kind: id ? "idle" : "needs-enroll" });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: `Could not check passkey status: ${(err as Error).message}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, manager]);

  if (!open) return null;

  const handleApprove = async (): Promise<void> => {
    try {
      // Step 1: enroll if needed
      if (state.kind === "needs-enroll" || !credentialId) {
        if (!enrollOptions) {
          setState({
            kind: "error",
            message:
              "No passkey is enrolled and no enrollment options were provided.",
          });
          return;
        }
        setState({ kind: "enrolling" });
        await manager.enroll(enrollOptions);
      }
      // Step 2: build challenge bytes
      setState({ kind: "signing" });
      const challenge = await challengeBytesFromPayload(
        session.challengePayload ?? {
          sessionId: session.id,
          capability: session.capability,
          amountUsd: session.amountUsd,
          operatorName: session.operatorName,
          evidenceHash: session.evidenceHash,
        },
      );
      // Step 3: sign (biometric-gated on native)
      const assertion = await manager.sign(challenge);
      // Step 4: hand to caller
      setState({ kind: "submitting" });
      const signed: SignedReceipt = {
        sessionId: session.id,
        decision: "approve",
        assertion,
        signedAt: new Date().toISOString(),
      };
      await onApprove(signed);
      setState({ kind: "done" });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // User-cancel surfaces as NotAllowedError; we present a friendlier
      // copy than a raw stack-trace.
      const friendly = /NotAllowedError|user cancelled|cancelled/i.test(msg)
        ? "Cancelled. Try again when ready."
        : msg;
      setState({ kind: "error", message: friendly });
    }
  };

  const handleDecline = (): void => {
    onDecline();
  };

  const primaryLabel =
    state.kind === "needs-enroll"
      ? "Enroll passkey + Approve"
      : state.kind === "enrolling"
        ? "Enrolling…"
        : state.kind === "signing"
          ? "Signing…"
          : state.kind === "submitting"
            ? "Submitting…"
            : "Approve with Face ID";

  const isBusy =
    state.kind === "checking" ||
    state.kind === "enrolling" ||
    state.kind === "signing" ||
    state.kind === "submitting";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-sheet-title"
      data-testid="approval-sheet"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        animation: "approval-fade-in 160ms ease-out",
      }}
    >
      <style>
        {`
          @keyframes approval-fade-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes approval-slide-up {
            from { transform: translateY(24px); opacity: 0.85; }
            to { transform: translateY(0); opacity: 1; }
          }
        `}
      </style>
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          backgroundColor: "#0F1F15",
          color: "#E5F4EA",
          fontFamily: "system-ui, -apple-system, sans-serif",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          padding:
            "20px 22px calc(env(safe-area-inset-bottom, 0px) + 24px) 22px",
          border: "1px solid rgba(16, 185, 129, 0.25)",
          borderBottom: "none",
          boxShadow: "0 -10px 30px rgba(0, 0, 0, 0.4)",
          animation: "approval-slide-up 200ms ease-out",
        }}
      >
        {/* Drag handle */}
        <div
          style={{
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: "rgba(255, 255, 255, 0.18)",
            margin: "0 auto 18px auto",
          }}
          aria-hidden="true"
        />
        <header style={{ marginBottom: 18 }}>
          <p
            style={{
              margin: 0,
              fontSize: 12,
              opacity: 0.6,
              textTransform: "uppercase",
              letterSpacing: 0.6,
            }}
          >
            Session approval
          </p>
          <h2
            id="approval-sheet-title"
            style={{
              fontSize: 20,
              fontWeight: 600,
              margin: "4px 0 0 0",
              lineHeight: 1.25,
            }}
          >
            Approve session
          </h2>
        </header>

        {/* Plain-English summary */}
        <section
          style={{
            backgroundColor: "rgba(16, 185, 129, 0.08)",
            border: "1px solid rgba(16, 185, 129, 0.2)",
            borderRadius: 12,
            padding: "14px 16px",
            marginBottom: 16,
          }}
        >
          <p
            data-testid="approval-summary"
            style={{
              margin: 0,
              fontSize: 16,
              lineHeight: 1.45,
            }}
          >
            <span style={{ fontWeight: 600 }}>
              ${session.amountUsd.toFixed(2)}
            </span>{" "}
            to{" "}
            <span style={{ fontWeight: 600 }}>{session.operatorName}</span>{" "}
            for {session.capability}.
          </p>
        </section>

        {/* Evidence summary */}
        <section
          data-testid="evidence-summary"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginBottom: 22,
            fontSize: 12,
            opacity: 0.75,
          }}
        >
          <div>
            Capture class:{" "}
            <span style={{ fontFamily: "monospace" }}>
              {session.captureClass ?? "tier-1"}
            </span>
          </div>
          <div>
            Evidence:{" "}
            <span style={{ fontFamily: "monospace" }}>
              {shortHash(session.evidenceHash)}
            </span>
          </div>
        </section>

        {/* Error state */}
        {state.kind === "error" && (
          <section
            role="alert"
            data-testid="approval-error"
            style={{
              backgroundColor: "rgba(239, 68, 68, 0.10)",
              border: "1px solid rgba(239, 68, 68, 0.35)",
              borderRadius: 10,
              padding: "10px 12px",
              marginBottom: 14,
              fontSize: 13,
              color: "#FCA5A5",
            }}
          >
            {state.message}
          </section>
        )}

        {/* Needs-enroll state */}
        {state.kind === "needs-enroll" && (
          <section
            data-testid="approval-needs-enroll"
            style={{
              fontSize: 13,
              opacity: 0.85,
              marginBottom: 14,
              lineHeight: 1.4,
            }}
          >
            No passkey enrolled yet. Approving will enroll a Face ID/Touch ID
            passkey first, then sign.
          </section>
        )}

        {/* Buttons */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={isBusy}
            data-testid="approval-approve"
            style={{
              padding: "14px",
              borderRadius: 12,
              border: "none",
              backgroundColor: isBusy ? "#0F6E50" : "#10B981",
              color: "#0A1A0F",
              fontSize: 15,
              fontWeight: 600,
              cursor: isBusy ? "wait" : "pointer",
              transition: "background-color 120ms ease",
            }}
          >
            {primaryLabel}
          </button>
          <button
            type="button"
            onClick={handleDecline}
            disabled={state.kind === "submitting" || state.kind === "signing"}
            data-testid="approval-decline"
            style={{
              padding: "14px",
              borderRadius: 12,
              border: "1px solid rgba(229, 244, 234, 0.25)",
              backgroundColor: "transparent",
              color: "#E5F4EA",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Truncate a hex hash to a 10-char head + 6-char tail for compact display.
 * Returns the input unchanged if it's already short.
 */
function shortHash(hash: string): string {
  if (!hash) return "—";
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}
