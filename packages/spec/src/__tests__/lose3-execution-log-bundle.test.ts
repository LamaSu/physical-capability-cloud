/**
 * LO-SE-3 consumer-run vector (bus #2125), re-emitted under the LO-EV-1 byte
 * contract (#2192). The committed fixture is the artifact the oracle runs its
 * committed program over; this test proves it conforms, so a drift in hashing
 * or signing fails CI instead of failing silently at settlement.
 *
 * Regenerate with: ../../node_modules/.bin/tsx scripts/emit-execution-log-bundle.mts
 */
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { hashBundle, hashEvent } from "../util/canonical.js";
import {
  SIGNING_PREIMAGE_CONTRACT,
  SigningPreimageError,
  parseEd25519PublicKeyHex,
  parseEd25519SignatureHex,
  signingPreimage,
} from "../evidence/signing-preimage.js";
import { makeExecutionLogVerifier } from "../evidence/verifiers/oracle-binding.js";
import type { LogChainEntryView } from "../evidence/verifiers/log-chain.js";
import type { EvidenceEvent } from "../types/evidence.js";

interface FixtureEvent {
  id: string;
  type: string;
  timestamp: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  hash: string;
}

const fixturePath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const vector = JSON.parse(readFileSync(fixturePath("./fixtures/lose3-execution-log-bundle.json"), "utf8"));
const bundle = vector.bundle as { bundleHash: string; kernelSignature: string; events: FixtureEvent[] };

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const publicKeyFromHex = (hex: unknown) =>
  createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(parseEd25519PublicKeyHex(hex))]),
    format: "der",
    type: "spki",
  });
const kernelKey = publicKeyFromHex(vector.kernelPublicKeyHex);
const verifyKernel = (message: Uint8Array, signatureHex: unknown) =>
  verify(null, message, kernelKey, parseEd25519SignatureHex(signatureHex));

const logEvent = bundle.events.find((e) => e.type === "printer_job_verified")!;
const logEntries = logEvent.payload.entries as LogChainEntryView[];
const logParams = logEvent.payload.params;
const CTX = { vocabVersion: 2 };

describe("LO-SE-3 vector — hashes recompute from the production canonicalizer", () => {
  it("every event hash recomputes", async () => {
    for (const e of bundle.events) {
      const { type, timestamp, source, payload } = e;
      expect(await hashEvent({ type, timestamp, source, payload } as Omit<EvidenceEvent, "hash" | "id">)).toBe(e.hash);
    }
  });

  it("the bundle digest recomputes", async () => {
    expect(await hashBundle(bundle.events as unknown as EvidenceEvent[])).toBe(bundle.bundleHash);
  });
});

describe("LO-SE-3 vector — the bundle signature follows the LO-EV-1 byte contract", () => {
  it("declares the contract it was signed under", () => {
    expect(vector.signingPreimageContract).toBe(SIGNING_PREIMAGE_CONTRACT);
  });

  it("the preimage is the UTF-8 of the tagged digest string, 71 bytes", () => {
    const preimage = signingPreimage(bundle.bundleHash);
    expect(preimage.length).toBe(71);
    expect(Buffer.from(preimage).toString("utf8")).toBe(bundle.bundleHash);
  });

  it("the kernel signature verifies over signingPreimage(bundleHash)", () => {
    expect(verifyKernel(signingPreimage(bundle.bundleHash), bundle.kernelSignature)).toBe(true);
  });
});

describe("LO-SE-3 vector — negative controls", () => {
  const raw32 = Buffer.from(bundle.bundleHash.slice("sha256:".length), "hex");

  it("the superseded raw-32 signature does NOT verify under the contract", () => {
    expect(verifyKernel(signingPreimage(bundle.bundleHash), vector.negatives.raw32KernelSignature)).toBe(false);
  });

  it("the contract signature does NOT verify over the raw 32 digest bytes (cross-form fails both ways)", () => {
    expect(verifyKernel(raw32, bundle.kernelSignature)).toBe(false);
  });

  it("a one-bit change to the signed digest does not verify", () => {
    const altered = Buffer.from(signingPreimage(bundle.bundleHash));
    altered[altered.length - 1] ^= 1;
    expect(verifyKernel(altered, bundle.kernelSignature)).toBe(false);
  });

  it("a malformed signature is rejected before any verification", () => {
    expect(() => verifyKernel(signingPreimage(bundle.bundleHash), bundle.kernelSignature.slice(0, 126))).toThrow(
      SigningPreimageError,
    );
  });

  it("a raw or 0x digest cannot be turned into a signing preimage", () => {
    expect(() => signingPreimage(`0x${raw32.toString("hex")}`)).toThrow(SigningPreimageError);
    expect(() => signingPreimage(raw32)).toThrow(SigningPreimageError);
  });

  it("execution_failed is absent from the bundle", () => {
    expect(bundle.events.some((e) => e.type === "execution_failed")).toBe(false);
  });
});

describe("LO-SE-3 vector — the #52 verifier over the carried chain", () => {
  const verifier = makeExecutionLogVerifier({
    verifyKernelSignature: (entryHash, signature) => verifyKernel(signingPreimage(entryHash), signature),
  });

  it("accepts the kernel-signed chain", async () => {
    const res = await verifier.verify(logEntries, logParams, CTX);
    expect(res.met).toBe(true);
  });

  it("rejects a forged log line", async () => {
    const forged = structuredClone(logEntries);
    forged[1]!.rawContent = "FORGED";
    const res = await verifier.verify(forged, logParams, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("entryHash mismatch");
  });

  it("rejects a signature moved from one entry to another", async () => {
    const moved = structuredClone(logEntries);
    moved[1]!.kernelSignature = moved[0]!.kernelSignature;
    const res = await verifier.verify(moved, logParams, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("kernel signature invalid");
  });
});

describe("LO-SE-3 vector — agrees with the evidence corpus", () => {
  const goldens = JSON.parse(readFileSync(fixturePath("../../../pcc-node/tests/goldens.json"), "utf8"));

  it("this file's verify path reproduces every signing_preimage golden, and rejects each raw-32 twin", () => {
    expect(goldens.signing_preimage.length).toBeGreaterThanOrEqual(3);
    for (const g of goldens.signing_preimage) {
      const preimage = signingPreimage(g.digest);
      expect(Buffer.from(preimage).toString("hex")).toBe(g.preimage_hex);
      const key = publicKeyFromHex(g.signer_public_key_hex);
      expect(verify(null, preimage, key, parseEd25519SignatureHex(g.signature_hex))).toBe(true);
      expect(verify(null, preimage, key, parseEd25519SignatureHex(g.raw32_signature_hex))).toBe(false);
    }
  });
});
