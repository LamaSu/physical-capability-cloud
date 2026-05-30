/**
 * Sign + verify roundtrip tests for A2A signed agent cards.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, type KeyLike } from "jose";
import { signAgentCard, type AgentCard } from "../sign-card.js";
import { verifyAgentCard } from "../verify-card.js";

const SAMPLE_CARD: AgentCard = {
  protocolVersion: "1.0",
  name: "Test Gateway",
  description: "Roundtrip test card",
  url: "https://test.example.com/a2a",
  version: "1.0.0",
  preferredTransport: "http+sse",
  capabilities: { streaming: true, pushNotifications: false },
  skills: [
    { id: "test-skill", name: "Test", tags: ["test"], description: "x" },
  ],
};

describe("signAgentCard + verifyAgentCard roundtrip", () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let jwks: { keys: Array<Record<string, unknown>> };

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    privateKey = pair.privateKey as KeyLike;
    publicKey = pair.publicKey as KeyLike;
    const pubJwk = await exportJWK(publicKey);
    jwks = {
      keys: [{ ...pubJwk, kid: "test-kid", use: "sig", alg: "ES256" }],
    };
  });

  it("signs and verifies a fresh card", async () => {
    const signed = await signAgentCard(SAMPLE_CARD, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });

    expect(signed.signatures).toBeDefined();
    expect(signed.signatures.length).toBe(1);
    expect(typeof signed.signatures[0]!.protected).toBe("string");
    expect(typeof signed.signatures[0]!.signature).toBe("string");

    const result = await verifyAgentCard(signed, { jwks });
    expect(result.valid).toBe(true);
    expect(result.card?.name).toBe("Test Gateway");
    expect(result.kid).toBe("test-kid");
  });

  it("verifies using caller-supplied KeyLike (skip JWKS)", async () => {
    const signed = await signAgentCard(SAMPLE_CARD, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });

    const result = await verifyAgentCard(signed, { key: publicKey });
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body (flip a single char)", async () => {
    const signed = await signAgentCard(SAMPLE_CARD, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });

    const tampered = { ...signed, name: "Tampered Gateway" };
    const result = await verifyAgentCard(tampered, { jwks });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/verify_failed/);
  });

  it("rejects when signatures array is missing", async () => {
    const result = await verifyAgentCard(SAMPLE_CARD, { jwks });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("no_signature");
  });

  it("rejects when signatures array is empty", async () => {
    const result = await verifyAgentCard({ ...SAMPLE_CARD, signatures: [] }, { jwks });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("no_signature");
  });

  it("rejects when kid is not in JWKS", async () => {
    const signed = await signAgentCard(SAMPLE_CARD, {
      privateKey,
      kid: "different-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });

    const result = await verifyAgentCard(signed, { jwks });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/kid_not_in_jwks/);
  });

  it("rejects when protected header has unsupported alg", async () => {
    // Manually construct a card with a forged RS256 header
    const forgedHeader = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "test-kid", typ: "vnd.a2a.card+jws" }),
      "utf-8",
    ).toString("base64url");
    const fake = {
      ...SAMPLE_CARD,
      signatures: [{ protected: forgedHeader, signature: "AAAA" }],
    };
    const result = await verifyAgentCard(fake, { jwks });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unsupported_alg/);
  });

  it("rejects malformed protected header", async () => {
    const fake = {
      ...SAMPLE_CARD,
      signatures: [{ protected: "!!!not-base64!!!", signature: "AAAA" }],
    };
    const result = await verifyAgentCard(fake, { jwks });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/header_decode_failed/);
  });

  it("strips any pre-existing signatures before re-signing", async () => {
    const first = await signAgentCard(SAMPLE_CARD, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });
    // Re-sign the already-signed card. The new signature must still verify.
    const second = await signAgentCard(first as AgentCard, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });
    expect(second.signatures.length).toBe(1);

    const result = await verifyAgentCard(second, { jwks });
    expect(result.valid).toBe(true);
  });

  it("verifies via jwksUrl using injected fetchImpl", async () => {
    const signed = await signAgentCard(SAMPLE_CARD, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });

    const fakeFetch = (async (_url: string) =>
      ({
        ok: true,
        status: 200,
        json: async () => jwks,
      }) as Response) as typeof fetch;

    const result = await verifyAgentCard(signed, {
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
      fetchImpl: fakeFetch,
    });
    expect(result.valid).toBe(true);
  });

  it("returns jwks_fetch_http_<status> when JWKS endpoint is 404", async () => {
    const signed = await signAgentCard(SAMPLE_CARD, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });

    const fakeFetch = (async () =>
      ({ ok: false, status: 404, json: async () => ({}) }) as Response) as typeof fetch;

    const result = await verifyAgentCard(signed, {
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
      fetchImpl: fakeFetch,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBe("jwks_fetch_http_404");
  });

  it("canonicalization is property-order-independent", async () => {
    const cardA = { protocolVersion: "1.0", name: "X", url: "u" };
    const cardB = { url: "u", name: "X", protocolVersion: "1.0" };

    const signedA = await signAgentCard(cardA, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });
    const signedB = await signAgentCard(cardB, {
      privateKey,
      kid: "test-kid",
      jwksUrl: "https://test.example.com/.well-known/jwks.json",
    });
    // ES256 is non-deterministic (k is randomised), so signatures will
    // differ, but BOTH must verify the same way.
    const rA = await verifyAgentCard(signedA, { jwks });
    const rB = await verifyAgentCard(signedB, { jwks });
    expect(rA.valid).toBe(true);
    expect(rB.valid).toBe(true);
  });
});
