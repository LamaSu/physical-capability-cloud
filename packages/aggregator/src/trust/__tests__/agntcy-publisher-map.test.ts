import { describe, it, expect } from "vitest";
import { DigitalCaptureClass, TrustTier } from "@pcc/spec";
import {
  mapAgntcyIdentityToTrust,
  applyTrustMapping,
} from "../agntcy-publisher-map.js";

describe("mapAgntcyIdentityToTrust", () => {
  it("returns AUTO_INDEXED / DCC2 for no Sigstore bundle", () => {
    const r = mapAgntcyIdentityToTrust(undefined);
    expect(r.trustTier).toBe(TrustTier.AUTO_INDEXED);
    expect(r.assuranceCeiling).toBe(DigitalCaptureClass.DCC2);
  });

  it("returns QUARANTINED / DCC0 when Rekor proof fails", () => {
    const r = mapAgntcyIdentityToTrust({
      issuer: "https://accounts.google.com",
      subject: "user@cisco.com",
      rekorVerified: false,
    });
    expect(r.trustTier).toBe(TrustTier.QUARANTINED);
    expect(r.assuranceCeiling).toBe(DigitalCaptureClass.DCC0);
    expect(r.reason).toBe("rekor_proof_failed");
  });

  it("returns VERIFIED_PARTNER / DCC4 for LF founder org emails", () => {
    const cases = [
      "user@anthropic.com",
      "user@cisco.com",
      "ops@outshift.io",
      "team@dell.com",
      "x@google.com",
      "y@oracle.com",
      "z@redhat.com",
    ];
    for (const subject of cases) {
      const r = mapAgntcyIdentityToTrust({
        issuer: "https://accounts.google.com",
        subject,
        rekorVerified: true,
      });
      expect(r.trustTier).toBe(TrustTier.VERIFIED_PARTNER);
      expect(r.assuranceCeiling).toBe(DigitalCaptureClass.DCC4);
    }
  });

  it("returns VERIFIED_PUBLISHER / DCC3 for GitHub OIDC", () => {
    const r = mapAgntcyIdentityToTrust({
      issuer: "https://token.actions.githubusercontent.com",
      subject: "https://github.com/lamasu/physical-capability-cloud",
      rekorVerified: true,
    });
    expect(r.trustTier).toBe(TrustTier.VERIFIED_PUBLISHER);
    expect(r.assuranceCeiling).toBe(DigitalCaptureClass.DCC3);
  });

  it("returns VERIFIED_PUBLISHER / DCC3 for any verified non-founder identity", () => {
    const r = mapAgntcyIdentityToTrust({
      issuer: "https://accounts.example.com",
      subject: "ops@somewhere-else.com",
      rekorVerified: true,
    });
    expect(r.trustTier).toBe(TrustTier.VERIFIED_PUBLISHER);
    expect(r.assuranceCeiling).toBe(DigitalCaptureClass.DCC3);
  });

  it("returns VERIFIED_PARTNER / DCC4 when Sigstore present but unverified (Phase 1)", () => {
    const r = mapAgntcyIdentityToTrust({
      issuer: "https://accounts.example.com",
      subject: "anon@nowhere.test",
      // rekorVerified undefined — Phase 1 default
    });
    expect(r.trustTier).toBe(TrustTier.VERIFIED_PARTNER);
    expect(r.assuranceCeiling).toBe(DigitalCaptureClass.DCC4);
  });
});

describe("applyTrustMapping", () => {
  it("returns a new IndexedTool with updated trust fields and does not mutate input", () => {
    const tool = {
      id: "x",
      cid: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as `sha256:${string}`,
      version: "1",
      source: {
        type: "agntcy-dht" as const,
        url: "https://x.example",
        fetchedAt: "2026-05-25T00:00:00.000Z",
      },
      ingestedAt: "2026-05-25T00:00:00.000Z",
      ingestionMethod: "oasf" as const,
      upstreamUrl: "https://x.example",
      skills: [],
      domains: [],
      features: [],
      inputSchema: {},
      description: "x",
      actionClass: "read" as const,
      assuranceCeiling: DigitalCaptureClass.DCC4,
      trustTier: TrustTier.VERIFIED_PARTNER,
      knownVulns: [],
      lastFetchedAt: "2026-05-25T00:00:00.000Z",
      invocationCount: 0,
      driftAlerts: [],
      schemaHashHistory: [],
      hostingPeers: [],
    };
    const updated = applyTrustMapping(tool, undefined);
    expect(updated.trustTier).toBe(TrustTier.AUTO_INDEXED);
    expect(updated.assuranceCeiling).toBe(DigitalCaptureClass.DCC2);
    // Input untouched.
    expect(tool.trustTier).toBe(TrustTier.VERIFIED_PARTNER);
  });
});
