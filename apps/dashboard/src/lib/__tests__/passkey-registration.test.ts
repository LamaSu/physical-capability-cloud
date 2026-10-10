/**
 * Tests for the pure passkey registration orchestration. No real
 * authenticator, no real network — fetch + startRegistration are injected.
 */

import { describe, it, expect, vi } from "vitest";
import {
  assembleCreationOptions,
  runPasskeyRegistration,
  detectPasskeySupport,
  utf8ToBase64url,
  type ChallengeResponse,
} from "../passkey-registration.js";

const CHALLENGE: ChallengeResponse = {
  sessionId: "sess-abc",
  challenge: "Y2hhbGxlbmdl",
  rpId: "capability.network",
  rpName: "Physical Capability Cloud",
  pubKeyCredParams: [
    { type: "public-key", alg: -7 },
    { type: "public-key", alg: -257 },
  ],
  authenticatorSelection: { userVerification: "preferred" },
  timeout_ms: 60000,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("assembleCreationOptions", () => {
  it("maps rpId/rpName into the WebAuthn rp object", () => {
    const opts = assembleCreationOptions(CHALLENGE, undefined, "rand1234");
    expect(opts.rp).toEqual({
      id: "capability.network",
      name: "Physical Capability Cloud",
    });
    expect(opts.challenge).toBe(CHALLENGE.challenge);
    expect(opts.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
  });

  it("derives the user handle from operatorId when bound", () => {
    const opts = assembleCreationOptions(CHALLENGE, "op@example.com", "rand1234");
    expect(opts.user.name).toBe("op@example.com");
    expect(opts.user.id).toBe(utf8ToBase64url("op@example.com"));
  });

  it("uses an anon-<handle> user for the anonymous path", () => {
    const opts = assembleCreationOptions(CHALLENGE, undefined, "rand1234");
    expect(opts.user.name).toBe("anon-rand1234");
  });
});

describe("runPasskeyRegistration", () => {
  it("an operator binding without the authorized fetch fails closed, before any request (astra A03c F2)", async () => {
    const fetchFn = vi.fn();
    const startRegistration = vi.fn();
    await expect(
      runPasskeyRegistration(
        { apiBase: "", operatorId: "op@example.com", fetchFn: fetchFn as any, startRegistration },
        "rand1234",
      ),
    ).rejects.toThrow(/authorized fetch/i);
    // Silently falling back to an anonymous challenge would register an unbound passkey.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it("runs challenge -> ceremony -> verify and returns the credential", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CHALLENGE)) // register-challenge
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: "sess-abc",
          credentialId: "cred-123",
          publicKey: "pub-xyz",
          rpId: "capability.network",
          persisted: true,
          verification: "verified",
        }),
      ); // verify-attestation
    const startRegistration = vi
      .fn()
      .mockResolvedValue({ id: "cred-123", response: {} });

    const res = await runPasskeyRegistration(
      { apiBase: "", fetchFn: fetchFn as any, startRegistration },
      "rand1234",
    );

    expect(res).toEqual({
      verified: true,
      credentialId: "cred-123",
      persisted: true,
    });
    // challenge then verify
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toContain("/api/onboard/passkey/register-challenge");
    expect(fetchFn.mock.calls[1][0]).toContain("/api/onboard/passkey/verify-attestation");
    // ceremony ran with assembled options
    expect(startRegistration).toHaveBeenCalledOnce();
    const passedOptions = startRegistration.mock.calls[0][0].optionsJSON;
    expect(passedOptions.challenge).toBe(CHALLENGE.challenge);
  });

  // Both calls: the challenge binds the operator with the signed-in key, and the
  // verification is behind the gateway's API gate, which honors a session cookie
  // only beside its own key (N103). A key-only user has no cookie at all.
  it("binding an operator sends the challenge and the verification through the authorized fetch, and builds no key itself", async () => {
    const verified = () =>
      jsonResponse({
        sessionId: "s",
        credentialId: "c",
        publicKey: "p",
        rpId: "capability.network",
        persisted: true,
        verification: "verified",
      });
    const authorizedFetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(CHALLENGE)).mockResolvedValueOnce(verified());
    // Answers too, so a verification sent without the key fails the assertions below, not the run.
    const fetchFn = vi.fn().mockResolvedValue(verified());
    const startRegistration = vi.fn().mockResolvedValue({ id: "c" });

    await runPasskeyRegistration(
      {
        apiBase: "",
        operatorId: "op@example.com",
        authorizedFetchFn,
        fetchFn: fetchFn as any,
        startRegistration,
      },
      "rand1234",
    );

    expect(authorizedFetchFn).toHaveBeenCalledTimes(2);
    const [challengePath, challengeInit] = authorizedFetchFn.mock.calls[0]!;
    expect(challengePath).toBe("/api/onboard/passkey/register-challenge");
    expect(JSON.stringify(challengeInit.headers).toLowerCase()).not.toContain("authorization");
    expect(JSON.parse(challengeInit.body).operatorId).toBe("op@example.com");
    const [verifyPath, verifyInit] = authorizedFetchFn.mock.calls[1]!;
    expect(verifyPath).toBe("/api/onboard/passkey/verify-attestation");
    expect(JSON.stringify(verifyInit.headers).toLowerCase()).not.toContain("authorization");
    expect(JSON.parse(verifyInit.body)).toEqual({ sessionId: CHALLENGE.sessionId, attestationResponse: { id: "c" } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws the gateway message when the challenge is rejected (e.g. 401)", async () => {
    // Operator-bound, so the challenge goes through the authorized fetch (astra A03c F2).
    const authorizedFetchFn = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        { error: "authentication_required_to_bind_operator", message: "need a key" },
        false,
        401,
      ),
    );
    const fetchFn = vi.fn();
    const startRegistration = vi.fn();

    await expect(
      runPasskeyRegistration(
        { apiBase: "", operatorId: "x", authorizedFetchFn, fetchFn: fetchFn as any, startRegistration },
        "rand1234",
      ),
    ).rejects.toThrow("need a key");
    expect(fetchFn).not.toHaveBeenCalled();
    // ceremony never runs if the challenge failed
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it("throws when verify rejects the attestation", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(CHALLENGE))
      .mockResolvedValueOnce(
        jsonResponse({ error: "webauthn_verify_failed", message: "bad sig" }, false, 400),
      );
    const startRegistration = vi.fn().mockResolvedValue({ id: "c" });

    await expect(
      runPasskeyRegistration(
        { apiBase: "", fetchFn: fetchFn as any, startRegistration },
        "rand1234",
      ),
    ).rejects.toThrow("bad sig");
  });
});

describe("detectPasskeySupport", () => {
  it("reports unavailable when PublicKeyCredential is absent", async () => {
    const res = await detectPasskeySupport({} as any);
    expect(res).toEqual({ available: false, platformAuthenticator: false });
  });

  it("reports platform authenticator when the API resolves true", async () => {
    const fakeWin = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      },
    } as any;
    const res = await detectPasskeySupport(fakeWin);
    expect(res).toEqual({ available: true, platformAuthenticator: true });
  });

  it("treats a throwing availability check as no platform authenticator", async () => {
    const fakeWin = {
      PublicKeyCredential: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => {
          throw new Error("boom");
        },
      },
    } as any;
    const res = await detectPasskeySupport(fakeWin);
    expect(res).toEqual({ available: true, platformAuthenticator: false });
  });
});
