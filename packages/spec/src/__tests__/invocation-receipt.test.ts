import { describe, it, expect } from "vitest";
import {
  InvocationReceiptSchema,
  type InvocationReceipt,
} from "../types/invocation-receipt.js";
import { DigitalCaptureClass } from "../types/dcc.js";

const sha = (c: string) => ("sha256:" + c.repeat(64)) as `sha256:${string}`;

function makeReceipt(overrides: Partial<InvocationReceipt> = {}): InvocationReceipt {
  const base: InvocationReceipt = {
    receiptId: "rec-001",
    receiptCID: sha("a"),
    schemaVersion: "1.0",
    indexedToolId: "tool-001",
    toolCID: sha("b"),
    toolSchemaHashAtCall: sha("c"),
    requestProjection: {
      method: "POST",
      url: "https://upstream.example.com/api",
      headersHash: sha("d"),
      bodyHash: sha("e"),
      middlewareRedactions: ["headers.authorization"],
      timestamp: "2026-05-23T12:00:00.000Z",
    },
    responseProjection: {
      status: 200,
      headersHash: sha("f"),
      bodyHash: sha("0"),
      middlewareRedactions: [],
      timestamp: "2026-05-23T12:00:01.000Z",
    },
    requestedDccClass: DigitalCaptureClass.DCC1,
    effectiveDccClass: DigitalCaptureClass.DCC1,
    pccSignature: "ed25519:placeholder",
    pccKeyId: "pcc-key-001",
    callerAgentId: "agent-007",
    callerSessionId: "sess-xyz",
    pccFeeBps: 100,
  };
  return { ...base, ...overrides };
}

describe("InvocationReceiptSchema (zod)", () => {
  it("accepts a minimal DCC1 receipt", () => {
    expect(() => InvocationReceiptSchema.parse(makeReceipt())).not.toThrow();
  });

  it("requires schemaVersion literal '1.0'", () => {
    const r = makeReceipt({ schemaVersion: "2.0" as "1.0" });
    expect(() => InvocationReceiptSchema.parse(r)).toThrow();
  });

  it("requires all sha256 fields to match the format", () => {
    expect(() =>
      InvocationReceiptSchema.parse(makeReceipt({ toolCID: "not-a-hash" as `sha256:${string}` })),
    ).toThrow();
    expect(() =>
      InvocationReceiptSchema.parse(makeReceipt({ receiptCID: "x" as `sha256:${string}` })),
    ).toThrow();
  });

  it("accepts effectiveDccClass below requestedDccClass with a downgrade reason", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC5,
      effectiveDccClass: DigitalCaptureClass.DCC1,
      downgradeReason: "trustTierCeiling cap to DCC1",
    });
    expect(() => InvocationReceiptSchema.parse(r)).not.toThrow();
  });

  it("permits DCC2+ proofs (upstreamSignature, sigstoreBundleRef, teeQuote, zkProof) as optional", () => {
    const r = makeReceipt({
      requestedDccClass: DigitalCaptureClass.DCC5,
      effectiveDccClass: DigitalCaptureClass.DCC5,
      upstreamSignature: "ed25519:upstream-sig",
      upstreamKeyId: "did:web:upstream.example.com",
      sigstoreBundleRef: "ghcr.io/lamasu/sigstore-bundle@sha256:deadbeef",
      teeQuote: "base64:tee-quote-blob",
      zkProof: "base64url:zk-proof-bytes",
    });
    expect(() => InvocationReceiptSchema.parse(r)).not.toThrow();
  });

  it("requires pccFeeBps in [0, 10000]", () => {
    expect(() => InvocationReceiptSchema.parse(makeReceipt({ pccFeeBps: -1 }))).toThrow();
    expect(() => InvocationReceiptSchema.parse(makeReceipt({ pccFeeBps: 10001 }))).toThrow();
    expect(() => InvocationReceiptSchema.parse(makeReceipt({ pccFeeBps: 0 }))).not.toThrow();
    expect(() => InvocationReceiptSchema.parse(makeReceipt({ pccFeeBps: 10000 }))).not.toThrow();
  });

  it("requires requestProjection.url to be a URL", () => {
    const r = makeReceipt();
    r.requestProjection.url = "not a url";
    expect(() => InvocationReceiptSchema.parse(r)).toThrow();
  });

  it("permits a streamCommit on the responseProjection", () => {
    const r = makeReceipt();
    r.responseProjection.streamCommit = sha("9");
    expect(() => InvocationReceiptSchema.parse(r)).not.toThrow();
  });
});
