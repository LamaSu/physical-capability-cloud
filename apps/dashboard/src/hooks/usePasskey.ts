/**
 * Option B passkey registration — React hook.
 *
 * Thin wrapper over lib/passkey-registration.ts (the pure, unit-tested
 * orchestration). Supplies the real @simplewebauthn/browser startRegistration
 * + window.fetch, tracks ceremony state for the UI, and detects browser
 * support so the caller can fall back to the option-A (gateway-custody) path
 * on unsupported browsers.
 *
 * Backend endpoints (merged PR #198, behind PCC_PASSKEY_ENABLED):
 *   POST /api/onboard/passkey/register-challenge
 *   POST /api/onboard/passkey/verify-attestation
 */

import { useCallback, useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import {
  runPasskeyRegistration,
  detectPasskeySupport,
  type PasskeyRegistrationResult,
  type PublicKeyCredentialCreationOptionsJSONLite,
  type AttestationResponseJSON,
} from "../lib/passkey-registration.js";

// The real startRegistration types optionsJSON as the full
// PublicKeyCredentialCreationOptionsJSON and returns RegistrationResponseJSON.
// Our orchestration uses structurally-compatible lite shapes, so bridge the
// two via a single narrow adapter (cast through unknown once, here) rather
// than loosening the pure lib's types.
const startRegistrationAdapter = startRegistration as unknown as (args: {
  optionsJSON: PublicKeyCredentialCreationOptionsJSONLite;
}) => Promise<AttestationResponseJSON>;

const API = (import.meta as any).env?.VITE_PCC_URL ?? "";

export type PasskeyStatus =
  | "idle"
  | "checking-support"
  | "unsupported"
  | "ready"
  | "registering"
  | "success"
  | "error";

export interface UsePasskeyOptions {
  /** Bind the credential to an operator (requires apiKey). Omit for anonymous. */
  operatorId?: string;
  apiKey?: string;
  /** Override the gateway base URL (defaults to VITE_PCC_URL / same-origin). */
  apiBase?: string;
}

export interface UsePasskeyReturn {
  status: PasskeyStatus;
  error: string | null;
  result: PasskeyRegistrationResult | null;
  /** True once support detection confirms a platform authenticator is usable. */
  supported: boolean;
  /** Kick off the registration ceremony (prompts biometric). */
  register: () => Promise<void>;
  /** Reset back to the pre-registration state (for "try again"). */
  reset: () => void;
}

export function usePasskey(options: UsePasskeyOptions = {}): UsePasskeyReturn {
  const { operatorId, apiKey, apiBase = API } = options;
  const [status, setStatus] = useState<PasskeyStatus>("checking-support");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PasskeyRegistrationResult | null>(null);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectPasskeySupport()
      .then((s) => {
        if (cancelled) return;
        if (s.available && s.platformAuthenticator) {
          setSupported(true);
          setStatus("ready");
        } else {
          setSupported(false);
          setStatus("unsupported");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setSupported(false);
        setStatus("unsupported");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const register = useCallback(async () => {
    setError(null);
    setResult(null);
    setStatus("registering");
    try {
      const res = await runPasskeyRegistration(
        {
          apiBase,
          operatorId,
          apiKey,
          fetchFn: window.fetch.bind(window),
          startRegistration: startRegistrationAdapter,
        },
        // Random handle for the anonymous-user path. crypto.randomUUID is
        // available in every browser that supports WebAuthn platform auth.
        crypto.randomUUID().slice(0, 8),
      );
      setResult(res);
      setStatus(res.verified ? "success" : "error");
      if (!res.verified) setError("Attestation did not verify.");
    } catch (e) {
      // startRegistration throws NotAllowedError when the user cancels/dismisses
      // the biometric prompt — surface a friendly message for that case.
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        /notallowed|abort|cancel/i.test(msg)
          ? "Passkey prompt was dismissed. Try again when you're ready."
          : msg,
      );
      setStatus("error");
    }
  }, [apiBase, operatorId, apiKey]);

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
    setStatus(supported ? "ready" : "unsupported");
  }, [supported]);

  return { status, error, result, supported, register, reset };
}
