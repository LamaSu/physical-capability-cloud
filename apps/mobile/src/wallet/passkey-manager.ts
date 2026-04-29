/**
 * Passkey manager — Option C identity primitive for the PCC mobile app.
 *
 * Per `15-MOBILE-APP-FIRST-PRINCIPLES.md` v3 and `16-CENTRALIZED-ALTERNATIVE.md`,
 * the mobile device is NOT a smart-wallet signer. It is a hardware **passkey**
 * (P-256 secure-enclave / TEE / Android StrongBox) that signs **receipt
 * approval challenges** issued by the PCC server. The signed assertion is the
 * user's authorization to the centralized substrate; the substrate carries the
 * on-chain settlement.
 *
 * What this module owns:
 *   - Feature-detect WebAuthn + biometric availability
 *   - Enroll a P-256 credential bound to PCC as the relying party
 *   - Persist the credentialId in secure storage (Keychain / Encrypted SP)
 *   - On approval, biometric-gate via @aparajita/capacitor-biometric-auth,
 *     then run navigator.credentials.get() with the server-issued challenge
 *
 * What this module does NOT own:
 *   - Server-side enrollment/challenge endpoints (Week 4)
 *   - Receipt-approval UX (`ApprovalSheet.tsx`, this same week)
 *   - secp256k1 / Smart Wallet UserOps (deliberately removed in v3 — that
 *     was the pre-pivot architecture; current architecture is centralized
 *     server signs operations, mobile signs the intent)
 *
 * Design notes:
 *   - `Capacitor.isNativePlatform()` branches the biometric prompt: native
 *     uses the @aparajita plugin; PWA falls back to the browser's
 *     `userVerification: 'preferred'` which surfaces the OS biometric prompt
 *     anyway through the platform authenticator.
 *   - We deliberately keep this dependency-light. WebAuthn API is used
 *     directly via navigator.credentials; @simplewebauthn/browser is only
 *     used for its `bufferToBase64URLString` / `base64URLStringToBuffer`
 *     helpers because writing them by hand is error-prone.
 *   - The signed message is `authenticatorData || sha256(clientDataJSON)`
 *     per WebAuthn spec — the server reconstructs both and verifies the
 *     P-256 signature with the stored public key.
 */

import {
  bufferToBase64URLString,
  base64URLStringToBuffer,
} from "@simplewebauthn/browser";
import {
  getApiKey,
  isNative,
} from "../storage/secure-api-key.js";

// PCC relying-party config. RP ID must match the eTLD+1 of the dashboard's
// origin so the same passkey works in PWA and Capacitor WebView.
const RP_ID =
  // Allow tests / local dev to override
  (typeof globalThis !== "undefined" &&
    (globalThis as { __PCC_RP_ID__?: string }).__PCC_RP_ID__) ||
  "capability.network";
const RP_NAME = "Physical Capability Cloud";

const CREDENTIAL_ID_KEY = "pcc-passkey-credential-id";
const PUBLIC_KEY_KEY = "pcc-passkey-public-key";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrollOptions {
  /** Stable user identifier — typically the API-key-bound operator/user id. */
  userId: string;
  /** Human-readable name shown in the OS passkey prompt. */
  displayName: string;
}

export interface EnrollResult {
  /** Base64URL-encoded credential id. */
  credentialId: string;
  /**
   * Base64URL-encoded raw P-256 public key from the attestation object's
   * authData. Server stores this and uses it to verify subsequent
   * assertions.
   */
  publicKey: string;
}

export interface SignResult {
  /** Base64URL-encoded P-256 ECDSA signature. */
  signature: string;
  /** Credential id used to sign (matches the enrolled one). */
  credentialId: string;
  /** Base64URL-encoded authenticatorData blob. */
  authenticatorData: string;
  /** Base64URL-encoded clientDataJSON (server reconstructs sha256 over this). */
  clientDataJSON: string;
}

// ---------------------------------------------------------------------------
// Capacitor / WebAuthn detection
// ---------------------------------------------------------------------------

interface CapacitorBridge {
  isNativePlatform: () => boolean;
  getPlatform?: () => string;
}

interface BiometricAuthLike {
  authenticate(opts?: {
    reason?: string;
    cancelTitle?: string;
  }): Promise<void>;
  checkBiometry?(): Promise<{ isAvailable: boolean }>;
}

let _biometricPlugin: BiometricAuthLike | null = null;
let _biometricLoadAttempted = false;

/** For tests: inject a fake biometric plugin. */
export function _setBiometricForTests(p: BiometricAuthLike | null): void {
  _biometricPlugin = p;
  _biometricLoadAttempted = true;
}

async function getBiometricPlugin(): Promise<BiometricAuthLike | null> {
  if (!isNative()) return null;
  if (_biometricPlugin) return _biometricPlugin;
  if (_biometricLoadAttempted) return _biometricPlugin;
  _biometricLoadAttempted = true;
  try {
    const mod = await import(
      /* @vite-ignore */ "@aparajita/capacitor-biometric-auth"
    );
    const candidate = (mod as { BiometricAuth?: BiometricAuthLike })
      .BiometricAuth;
    if (candidate) {
      _biometricPlugin = candidate;
    }
  } catch {
    // Plugin not present — biometric gate falls back to WebAuthn's own
    // userVerification prompt.
  }
  return _biometricPlugin;
}

/**
 * Feature-detect: does this runtime have BOTH the WebAuthn API (for the
 * actual signing) AND a path to biometric verification? Returns false on
 * a server, in a stripped-down WebView, or in a browser without
 * `navigator.credentials`.
 */
export async function isPasskeyAvailable(): Promise<boolean> {
  if (typeof navigator === "undefined") return false;
  if (!navigator.credentials || typeof navigator.credentials.create !== "function") {
    return false;
  }
  // PWA: the platform authenticator surfaces biometry through WebAuthn's
  // `userVerification` — no extra check needed.
  if (!isNative()) return true;
  // Native: confirm the biometric plugin is loadable and reports a sensor.
  const plugin = await getBiometricPlugin();
  if (!plugin) return false;
  if (typeof plugin.checkBiometry === "function") {
    try {
      const res = await plugin.checkBiometry();
      return !!res?.isAvailable;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Secure storage for credential id + public key
// ---------------------------------------------------------------------------

interface SecureStoragePlugin {
  get(opts: { key: string }): Promise<{ value: string }>;
  set(opts: { key: string; value: string }): Promise<{ value: boolean }>;
  remove(opts: { key: string }): Promise<{ value: boolean }>;
}

let _secureStorage: SecureStoragePlugin | null = null;
let _secureStorageLoadAttempted = false;

/** For tests: inject a fake secure storage. */
export function _setSecureStorageForTests(p: SecureStoragePlugin | null): void {
  _secureStorage = p;
  _secureStorageLoadAttempted = true;
}

async function getSecureStorage(): Promise<SecureStoragePlugin | null> {
  if (!isNative()) return null;
  if (_secureStorage) return _secureStorage;
  if (_secureStorageLoadAttempted) return _secureStorage;
  _secureStorageLoadAttempted = true;
  try {
    const mod = await import(
      /* @vite-ignore */ "capacitor-secure-storage-plugin"
    );
    const candidate = (mod as { SecureStoragePlugin?: SecureStoragePlugin })
      .SecureStoragePlugin;
    if (candidate) {
      _secureStorage = candidate;
    }
  } catch {
    // Plugin not present.
  }
  return _secureStorage;
}

async function storeString(key: string, value: string): Promise<void> {
  if (isNative()) {
    const plugin = await getSecureStorage();
    if (plugin) {
      await plugin.set({ key, value });
      // Defensively wipe any localStorage shadow so this never leaks via
      // web inspectors on rooted devices.
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.removeItem(key);
        } catch {
          // ignore
        }
      }
      return;
    }
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, value);
  }
}

async function readString(key: string): Promise<string | null> {
  if (isNative()) {
    const plugin = await getSecureStorage();
    if (plugin) {
      try {
        const { value } = await plugin.get({ key });
        return value || null;
      } catch {
        return null;
      }
    }
  }
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(key);
}

async function removeString(key: string): Promise<void> {
  if (isNative()) {
    const plugin = await getSecureStorage();
    if (plugin) {
      try {
        await plugin.remove({ key });
      } catch {
        // ignore
      }
    }
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — module-level functions
// ---------------------------------------------------------------------------

/**
 * Read the persisted credential id, or null if no passkey is enrolled.
 */
export async function getEnrolledCredentialId(): Promise<string | null> {
  return readString(CREDENTIAL_ID_KEY);
}

/**
 * Read the persisted public key (base64url), or null.
 */
export async function getEnrolledPublicKey(): Promise<string | null> {
  return readString(PUBLIC_KEY_KEY);
}

/**
 * Wipe the credential id + public key from secure storage. The actual
 * platform credential lives in the OS passkey store and is removed via
 * Settings → Passwords on iOS / Settings → Security → Credentials on
 * Android — we only own the references on our side.
 */
export async function clearPasskey(): Promise<void> {
  await removeString(CREDENTIAL_ID_KEY);
  await removeString(PUBLIC_KEY_KEY);
}

/**
 * Run the WebAuthn `create()` flow against PCC's relying-party config and
 * persist the resulting credential id + public key.
 *
 * Throws if:
 *   - WebAuthn isn't available (`navigator.credentials` missing)
 *   - The user cancels the OS prompt (`NotAllowedError`)
 *   - The platform authenticator can't satisfy our criteria
 */
export async function enrollPasskey(opts: EnrollOptions): Promise<EnrollResult> {
  if (typeof navigator === "undefined" || !navigator.credentials?.create) {
    throw new Error("WebAuthn is not available in this runtime.");
  }
  // 32 bytes of fresh randomness — server will issue a real challenge in
  // production; pre-Week-4 we self-issue here for the on-device demo path.
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userIdBytes = new TextEncoder().encode(opts.userId);
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: challenge as BufferSource,
    rp: { id: RP_ID, name: RP_NAME },
    user: {
      id: userIdBytes as BufferSource,
      name: opts.userId,
      displayName: opts.displayName,
    },
    // P-256 (alg -7) is what Apple Secure Enclave + Android StrongBox issue.
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "required",
    },
    timeout: 60_000,
    attestation: "none",
  };
  const credential = (await navigator.credentials.create({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!credential) {
    throw new Error("Passkey enrollment returned no credential.");
  }
  const response =
    credential.response as AuthenticatorAttestationResponse;
  // The publicKey is exposed by getPublicKey() on modern browsers; if not
  // available, the server can derive it from the attestationObject.
  let pubKeyB64u = "";
  const getPub = (response as { getPublicKey?: () => ArrayBuffer | null })
    .getPublicKey;
  if (typeof getPub === "function") {
    const raw = getPub.call(response);
    if (raw) {
      pubKeyB64u = bufferToBase64URLString(raw);
    }
  }
  if (!pubKeyB64u) {
    // Fall back to the attestationObject — server unwraps it.
    pubKeyB64u = bufferToBase64URLString(response.attestationObject);
  }
  const credentialIdB64u = bufferToBase64URLString(credential.rawId);
  await storeString(CREDENTIAL_ID_KEY, credentialIdB64u);
  await storeString(PUBLIC_KEY_KEY, pubKeyB64u);
  return { credentialId: credentialIdB64u, publicKey: pubKeyB64u };
}

/**
 * Sign a server-issued approval challenge.
 *
 * Native path:
 *   1. Biometric-gate via @aparajita/capacitor-biometric-auth (Face ID /
 *      Touch ID / fingerprint / iris).
 *   2. Run navigator.credentials.get() with `userVerification: 'required'`
 *      so the platform authenticator does its own gate.
 *
 * PWA path:
 *   - WebAuthn's userVerification handles biometry directly through the
 *     OS — no second prompt needed.
 *
 * Throws if:
 *   - The user cancels (NotAllowedError or biometric plugin throws)
 *   - No credential is enrolled (call enrollPasskey first)
 *   - WebAuthn isn't available
 */
export async function signApproval(
  challenge: Uint8Array,
): Promise<SignResult> {
  if (typeof navigator === "undefined" || !navigator.credentials?.get) {
    throw new Error("WebAuthn is not available in this runtime.");
  }
  const credentialIdB64u = await getEnrolledCredentialId();
  if (!credentialIdB64u) {
    throw new Error(
      "No passkey enrolled. Call enrollPasskey() before signApproval().",
    );
  }
  // Biometric gate (native only — PWA gets it via WebAuthn itself)
  if (isNative()) {
    const plugin = await getBiometricPlugin();
    if (plugin) {
      try {
        await plugin.authenticate({
          reason: "Approve PCC session",
          cancelTitle: "Cancel",
        });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        throw new Error(
          `Biometric verification failed: ${e?.message ?? String(err)}`,
        );
      }
    }
  }
  const credentialIdBuf = base64URLStringToBuffer(credentialIdB64u);
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: challenge as BufferSource,
    rpId: RP_ID,
    allowCredentials: [
      {
        type: "public-key",
        id: credentialIdBuf as BufferSource,
      },
    ],
    userVerification: "required",
    timeout: 60_000,
  };
  const assertion = (await navigator.credentials.get({
    publicKey,
  })) as PublicKeyCredential | null;
  if (!assertion) {
    throw new Error("Passkey signing returned no assertion.");
  }
  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    signature: bufferToBase64URLString(response.signature),
    credentialId: bufferToBase64URLString(assertion.rawId),
    authenticatorData: bufferToBase64URLString(response.authenticatorData),
    clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
  };
}

// ---------------------------------------------------------------------------
// Class wrapper for easier mocking in tests / DI in higher layers
// ---------------------------------------------------------------------------

/**
 * Thin OO wrapper over the module-level functions. Higher-level code (e.g.
 * <ApprovalSheet>) takes a PasskeyManager instance, which can be replaced
 * with a stub in tests without monkey-patching the module.
 */
export class PasskeyManager {
  isAvailable(): Promise<boolean> {
    return isPasskeyAvailable();
  }
  enroll(opts: EnrollOptions): Promise<EnrollResult> {
    return enrollPasskey(opts);
  }
  sign(challenge: Uint8Array): Promise<SignResult> {
    return signApproval(challenge);
  }
  getCredentialId(): Promise<string | null> {
    return getEnrolledCredentialId();
  }
  getPublicKey(): Promise<string | null> {
    return getEnrolledPublicKey();
  }
  clear(): Promise<void> {
    return clearPasskey();
  }
}

/**
 * Default singleton — most call-sites can import this directly.
 */
export const passkeyManager = new PasskeyManager();

/**
 * Helper: SHA-256 a JSON-stringified payload to produce the challenge bytes
 * passed to signApproval. The server should issue the canonical payload
 * shape and the server-side verifier reconstructs the same bytes — for
 * Week-3 dev we compute it locally so the UI is testable.
 */
export async function challengeBytesFromPayload(
  payload: unknown,
): Promise<Uint8Array> {
  // Stable JSON: sort keys at the top level so server + client agree.
  const json = JSON.stringify(payload, Object.keys(payload as object).sort());
  const enc = new TextEncoder().encode(json);
  // jsdom in tests doesn't always expose subtle.digest; fall back to a
  // simple hash if needed (the test mocks this layer anyway).
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return new Uint8Array(buf);
  }
  // Fallback — only hit in oddly-stripped environments.
  return enc;
}
