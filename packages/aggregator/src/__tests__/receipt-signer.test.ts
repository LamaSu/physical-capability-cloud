import { describe, it, expect } from "vitest";
import type { InvocationReceipt } from "@pcc/spec";
import { DigitalCaptureClass } from "@pcc/spec";
import { signReceipt, verifyReceiptSignature, signAndAnchorReceipt } from "../receipt-signer.js";
import { createReceiptAnchorClient } from "../receipt-anchor-client.js";

const SHA = "sha256:" + "a".repeat(64);

function makeBody() {
  return {
    receiptId: "rcpt-1",
    schemaVersion: "1.0" as const,
    indexedToolId: "tool-1",
    toolCID: SHA,
    toolSchemaHashAtCall: SHA,
    requestProjection: {
      method: "POST",
      url: "https://example.com",
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: [],
      timestamp: "2026-05-23T00:00:00.000Z",
    },
    responseProjection: {
      status: 200,
      headersHash: SHA,
      bodyHash: SHA,
      middlewareRedactions: [],
      timestamp: "2026-05-23T00:00:01.000Z",
    },
    requestedDccClass: DigitalCaptureClass.DCC1,
    effectiveDccClass: DigitalCaptureClass.DCC1,
    callerAgentId: "agent-1",
    callerSessionId: "session-1",
    pccFeeBps: 100,
  };
}

const TEST_KEY = {
  keyId: "test-key-1",
  secretHex: "abcdef0123456789".repeat(4),
};

describe("signReceipt + verifyReceiptSignature", () => {
  it("round-trips: sign then verify returns true", () => {
    const body = makeBody();
    const signed = signReceipt(body, TEST_KEY);
    expect(signed.pccSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.pccKeyId).toBe(TEST_KEY.keyId);
    expect(signed.receiptCID).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyReceiptSignature(signed, TEST_KEY)).toBe(true);
  });

  it("tampered body fails verification", () => {
    const body = makeBody();
    const signed = signReceipt(body, TEST_KEY);
    const tampered: InvocationReceipt = {
      ...signed,
      callerAgentId: "agent-2",
    };
    expect(verifyReceiptSignature(tampered, TEST_KEY)).toBe(false);
  });

  it("wrong key fails verification", () => {
    const body = makeBody();
    const signed = signReceipt(body, TEST_KEY);
    const wrongKey = {
      keyId: "other",
      secretHex: "deadbeef".repeat(8),
    };
    expect(verifyReceiptSignature(signed, wrongKey)).toBe(false);
  });

  it("same body produces same signature (deterministic canonicalization)", () => {
    const body = makeBody();
    const s1 = signReceipt(body, TEST_KEY);
    const s2 = signReceipt(body, TEST_KEY);
    expect(s1.pccSignature).toBe(s2.pccSignature);
    expect(s1.receiptCID).toBe(s2.receiptCID);
  });
});

describe("signAndAnchorReceipt", () => {
  it("returns disabled outcome when no anchor client provided", () => {
    const body = makeBody();
    const { receipt, anchor } = signAndAnchorReceipt(body, { key: TEST_KEY });
    expect(receipt.pccSignature).toMatch(/^[0-9a-f]{64}$/);
    expect(anchor).toEqual({ mode: "disabled" });
  });

  it("returns disabled outcome when anchor client is disabled", () => {
    const client = createReceiptAnchorClient({
      enabled: false,
      chainBackend: {
        anchorOne: async () => "0x0",
        anchorBatch: async () => "0x0",
      },
      manifestStorage: { publishManifest: async () => "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}` },
    });
    const body = makeBody();
    const { anchor } = signAndAnchorReceipt(body, { key: TEST_KEY, anchor: client });
    expect(anchor).toEqual({ mode: "disabled" });
  });

  it("routes signed receipt through enabled anchor client (batch path for DCC1)", () => {
    const client = createReceiptAnchorClient({
      enabled: true,
      chainBackend: {
        anchorOne: async () => "0x0",
        anchorBatch: async () => "0xbatched",
      },
      manifestStorage: { publishManifest: async () => "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}` },
    });
    const body = makeBody();
    const { receipt, anchor } = signAndAnchorReceipt(body, { key: TEST_KEY, anchor: client });
    expect(receipt.pccSignature).toBeTruthy();
    expect(anchor.mode).toBe("batched");
  });
});
