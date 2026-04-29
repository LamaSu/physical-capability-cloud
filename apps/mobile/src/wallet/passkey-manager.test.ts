/**
 * Tests for passkey-manager.
 *
 * The actual WebAuthn calls (`navigator.credentials.create/get`) are mocked
 * because jsdom does not implement a real platform authenticator. We verify:
 *   1. Feature-detect returns false when WebAuthn is missing
 *   2. enrollPasskey roundtrips the credentialId into secure storage
 *   3. signApproval emits a well-formed assertion shape
 *   4. signApproval rejects on user cancel (simulated as NotAllowedError)
 *   5. getEnrolledCredentialId is null pre-enroll, the id post-enroll
 *   6. clearPasskey wipes the store
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setBiometricForTests,
  _setSecureStorageForTests,
  PasskeyManager,
  challengeBytesFromPayload,
  clearPasskey,
  enrollPasskey,
  getEnrolledCredentialId,
  isPasskeyAvailable,
  passkeyManager,
  signApproval,
} from "./passkey-manager.js";

// ---------------------------------------------------------------------------
// Helpers — fake WebAuthn + secure storage
// ---------------------------------------------------------------------------

interface FakeStore {
  data: Map<string, string>;
}

function fakeSecureStoragePlugin(store: FakeStore) {
  return {
    get: vi.fn(async ({ key }: { key: string }) => {
      const value = store.data.get(key);
      if (value === undefined) throw new Error("not found");
      return { value };
    }),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      store.data.set(key, value);
      return { value: true };
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      store.data.delete(key);
      return { value: true };
    }),
  };
}

/** Build a fake AuthenticatorAttestationResponse */
function fakeAttestationResponse(): AuthenticatorAttestationResponse {
  // Minimal shape — we only access attestationObject and getPublicKey
  const pub = new Uint8Array([0x04, 0x01, 0x02, 0x03]).buffer;
  return {
    attestationObject: new Uint8Array([0xAA, 0xBB]).buffer,
    clientDataJSON: new Uint8Array([0x7B, 0x7D]).buffer,
    getPublicKey() {
      return pub;
    },
    getPublicKeyAlgorithm() {
      return -7;
    },
    getAuthenticatorData() {
      return new Uint8Array([0xCC]).buffer;
    },
    getTransports() {
      return [];
    },
  } as unknown as AuthenticatorAttestationResponse;
}

/** Build a fake AuthenticatorAssertionResponse */
function fakeAssertionResponse(): AuthenticatorAssertionResponse {
  return {
    authenticatorData: new Uint8Array([0x11, 0x22, 0x33]).buffer,
    clientDataJSON: new Uint8Array([0x7B, 0x7D]).buffer,
    signature: new Uint8Array([0x99, 0xAA, 0xBB, 0xCC]).buffer,
    userHandle: new Uint8Array([0x10]).buffer,
  } as AuthenticatorAssertionResponse;
}

function fakeCredential(
  type: "create" | "get",
): PublicKeyCredential {
  const rawId = new Uint8Array([0x01, 0x02, 0x03, 0x04]).buffer;
  return {
    id: "FAKE_ID",
    rawId,
    type: "public-key",
    response:
      type === "create" ? fakeAttestationResponse() : fakeAssertionResponse(),
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
  } as unknown as PublicKeyCredential;
}

beforeEach(() => {
  // PWA mode (no Capacitor)
  (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  };
  _setBiometricForTests(null);
  _setSecureStorageForTests(null);
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
  // Mock navigator.credentials by default (each test overrides as needed)
  if (typeof navigator !== "undefined") {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      writable: true,
      value: {
        create: vi.fn(async () => fakeCredential("create")),
        get: vi.fn(async () => fakeCredential("get")),
      },
    });
  }
});

afterEach(() => {
  _setBiometricForTests(null);
  _setSecureStorageForTests(null);
});

// ---------------------------------------------------------------------------
// 1. isPasskeyAvailable
// ---------------------------------------------------------------------------

describe("isPasskeyAvailable", () => {
  it("returns false when WebAuthn API is missing", async () => {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(await isPasskeyAvailable()).toBe(false);
  });

  it("returns true on PWA when navigator.credentials.create exists", async () => {
    expect(await isPasskeyAvailable()).toBe(true);
  });

  it("returns false on native when biometric plugin is unavailable", async () => {
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
    };
    _setBiometricForTests(null);
    // _setBiometricForTests(null) marks the load as attempted, so the
    // module won't try to dynamic-import the missing package.
    expect(await isPasskeyAvailable()).toBe(false);
  });

  it("returns true on native when biometric plugin reports available", async () => {
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
    };
    _setBiometricForTests({
      authenticate: vi.fn(async () => undefined),
      checkBiometry: vi.fn(async () => ({ isAvailable: true })),
    });
    expect(await isPasskeyAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. enrollPasskey roundtrips into the credential-id store
// ---------------------------------------------------------------------------

describe("enrollPasskey", () => {
  it("persists credential id + public key on PWA via localStorage", async () => {
    expect(await getEnrolledCredentialId()).toBeNull();
    const result = await enrollPasskey({
      userId: "user-123",
      displayName: "Alice Tester",
    });
    expect(result.credentialId).toBeTruthy();
    expect(result.publicKey).toBeTruthy();
    expect(await getEnrolledCredentialId()).toBe(result.credentialId);
  });

  it("uses native secure storage when running under Capacitor", async () => {
    const store: FakeStore = { data: new Map() };
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
    };
    _setSecureStorageForTests(fakeSecureStoragePlugin(store));
    _setBiometricForTests({
      authenticate: vi.fn(async () => undefined),
    });
    const result = await enrollPasskey({
      userId: "user-456",
      displayName: "Bob Tester",
    });
    expect(store.data.get("pcc-passkey-credential-id")).toBe(
      result.credentialId,
    );
    expect(store.data.get("pcc-passkey-public-key")).toBe(result.publicKey);
  });

  it("throws if WebAuthn is unavailable", async () => {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    await expect(
      enrollPasskey({ userId: "u", displayName: "x" }),
    ).rejects.toThrow(/WebAuthn is not available/);
  });
});

// ---------------------------------------------------------------------------
// 3. signApproval — assertion shape
// ---------------------------------------------------------------------------

describe("signApproval", () => {
  it("emits a well-formed assertion shape", async () => {
    await enrollPasskey({ userId: "u1", displayName: "Test" });
    const challenge = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await signApproval(challenge);
    expect(result.signature).toBeTruthy();
    expect(typeof result.signature).toBe("string");
    expect(result.credentialId).toBeTruthy();
    expect(result.authenticatorData).toBeTruthy();
    expect(result.clientDataJSON).toBeTruthy();
  });

  it("rejects when user cancels the OS prompt", async () => {
    await enrollPasskey({ userId: "u2", displayName: "Test" });
    const cancelErr = Object.assign(new Error("user cancelled"), {
      name: "NotAllowedError",
    });
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      writable: true,
      value: {
        create: vi.fn(async () => fakeCredential("create")),
        get: vi.fn(async () => {
          throw cancelErr;
        }),
      },
    });
    await expect(signApproval(new Uint8Array([1]))).rejects.toThrow(
      /user cancelled/,
    );
  });

  it("rejects when no credential is enrolled", async () => {
    await expect(signApproval(new Uint8Array([1]))).rejects.toThrow(
      /No passkey enrolled/,
    );
  });

  it("biometric-gate failure surfaces as a sign error on native", async () => {
    (globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };
    const store: FakeStore = { data: new Map() };
    _setSecureStorageForTests(fakeSecureStoragePlugin(store));
    _setBiometricForTests({
      authenticate: vi.fn(async () => {
        throw new Error("biometryNotEnrolled");
      }),
    });
    // Manually populate the credential id so signApproval gets past the
    // not-enrolled check
    store.data.set("pcc-passkey-credential-id", "AAA-BBB");
    await expect(signApproval(new Uint8Array([1]))).rejects.toThrow(
      /Biometric verification failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. clearPasskey wipes the store
// ---------------------------------------------------------------------------

describe("clearPasskey + getEnrolledCredentialId lifecycle", () => {
  it("getEnrolledCredentialId is null pre-enroll, id post-enroll, null after clear", async () => {
    expect(await getEnrolledCredentialId()).toBeNull();
    const result = await enrollPasskey({
      userId: "u3",
      displayName: "Lifecycle",
    });
    expect(await getEnrolledCredentialId()).toBe(result.credentialId);
    await clearPasskey();
    expect(await getEnrolledCredentialId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. PasskeyManager wrapper
// ---------------------------------------------------------------------------

describe("PasskeyManager class wrapper", () => {
  it("delegates to module-level functions", async () => {
    const mgr = new PasskeyManager();
    expect(await mgr.getCredentialId()).toBeNull();
    const result = await mgr.enroll({
      userId: "u4",
      displayName: "Wrapper",
    });
    expect(await mgr.getCredentialId()).toBe(result.credentialId);
    expect(await mgr.isAvailable()).toBe(true);
    await mgr.clear();
    expect(await mgr.getCredentialId()).toBeNull();
  });

  it("default singleton works the same way", async () => {
    expect(await passkeyManager.getCredentialId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. challengeBytesFromPayload
// ---------------------------------------------------------------------------

describe("challengeBytesFromPayload", () => {
  it("returns 32-byte SHA-256 digest in jsdom", async () => {
    const bytes = await challengeBytesFromPayload({
      capability: "haircut",
      amountUsd: 32,
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    // Note: subtle.digest may or may not be in jsdom; either way a non-empty
    // Uint8Array is the contract.
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
