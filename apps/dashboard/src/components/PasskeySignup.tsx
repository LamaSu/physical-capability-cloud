/**
 * Option B passkey signup — minimal component.
 *
 * Renders the passkey registration affordance for the onboarding flow: a
 * button that runs the WebAuthn ceremony (Touch ID / Windows Hello / Android
 * biometric) via usePasskey, with support-detection + status + a graceful
 * fallback message for unsupported browsers.
 *
 * Deliberately scoped: this is the reusable widget. Wiring it into
 * OnboardChatPage as a first-class onboarding step lands once Phase B (the
 * ERC-4337 smart-wallet mint that consumes the registered credential) is
 * unblocked — until then a passkey has nothing downstream to authorize, so
 * the widget ships ready-but-not-yet-mounted in the main flow. See coord
 * bulletin 262.
 */

import React from "react";
import { usePasskey } from "../hooks/usePasskey.js";

export interface PasskeySignupProps {
  /** Bind the credential to an operator (requires apiKey). Omit for anonymous. */
  operatorId?: string;
  apiKey?: string;
  /** Called on a verified registration with the credential + persistence flag. */
  onRegistered?: (result: {
    credentialId: string;
    persisted: boolean;
  }) => void;
  /** Shown when the browser has no platform authenticator (fall back to option A). */
  onUnsupported?: () => void;
}

export function PasskeySignup({
  operatorId,
  apiKey,
  onRegistered,
  onUnsupported,
}: PasskeySignupProps): React.ReactElement {
  const { status, error, result, supported, register, reset } = usePasskey({
    operatorId,
    apiKey,
  });

  React.useEffect(() => {
    if (status === "success" && result?.verified) {
      onRegistered?.({
        credentialId: result.credentialId,
        persisted: result.persisted,
      });
    }
  }, [status, result, onRegistered]);

  React.useEffect(() => {
    if (status === "unsupported") onUnsupported?.();
  }, [status, onUnsupported]);

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 text-white/90">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-lg">🔐</span>
        <h3 className="text-sm font-semibold">Secure your identity with a passkey</h3>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-white/50">
        Use your device’s Touch ID, Windows Hello, or Android biometric — no
        password, no seed phrase, no key to lose. Your passkey stays on your
        device.
      </p>

      {status === "checking-support" && (
        <p className="mt-4 text-xs text-white/40">Checking device support…</p>
      )}

      {status === "unsupported" && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300/90">
          This browser or device doesn’t support platform passkeys. You can
          continue with the standard onboarding flow instead.
        </div>
      )}

      {(status === "ready" || status === "registering") && supported && (
        <button
          onClick={() => void register()}
          disabled={status === "registering"}
          className="mt-4 w-full rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-4 py-3 text-sm font-medium text-emerald-300 transition-all hover:border-emerald-400/60 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "registering"
            ? "Waiting for your device…"
            : "Create passkey"}
        </button>
      )}

      {status === "success" && result?.verified && (
        <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300/90">
          ✓ Passkey created
          {result.persisted
            ? " and linked to your operator account."
            : " (not linked to an account — sign in first to bind it)."}
        </div>
      )}

      {status === "error" && (
        <div className="mt-4 space-y-2">
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300/90">
            {error ?? "Something went wrong."}
          </div>
          <button
            onClick={reset}
            className="text-xs text-white/50 underline-offset-2 hover:text-white/80 hover:underline"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
