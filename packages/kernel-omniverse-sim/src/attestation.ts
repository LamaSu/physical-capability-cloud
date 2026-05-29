/**
 * Sim-attestation envelope signing.
 *
 * Wraps a SimRunResult in a signed envelope so the PCC gateway can verify
 * the attestation came from this kernel's signing key. Ed25519 via
 * tweetnacl (matches @pcc/kernel-sdk).
 */

import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";
import type { SimAttestation, SimRunResult } from "./types.js";

function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Canonical JSON for hashing/signing — sorted keys, no whitespace. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalize(
          (value as Record<string, unknown>)[k],
        )}`,
    )
    .join(",")}}`;
}

export function hashWorkflow(workflow: MadsciWorkflow): string {
  return createHash("sha256").update(canonicalize(workflow)).digest("hex");
}

export interface SignAttestationOptions {
  result: SimRunResult;
  workflow: MadsciWorkflow;
  runnerVersion: string;
  /** Ed25519 secret key (64 bytes), hex-encoded. */
  secretKeyHex: string;
}

export function signAttestation(opts: SignAttestationOptions): SimAttestation {
  const secret = fromHex(opts.secretKeyHex);
  if (secret.length !== nacl.sign.secretKeyLength) {
    throw new Error(
      `secretKey must be ${nacl.sign.secretKeyLength} bytes, got ${secret.length}`,
    );
  }
  const publicKey = secret.slice(32);

  const envelope = {
    result: opts.result,
    runnerVersion: opts.runnerVersion,
    workflowHash: hashWorkflow(opts.workflow),
    timestamp: new Date().toISOString(),
  };
  const canonical = canonicalize(envelope);
  const sig = nacl.sign.detached(
    new TextEncoder().encode(canonical),
    secret,
  );
  return {
    ...envelope,
    signature: toHex(sig),
    signerPublicKey: toHex(publicKey),
  };
}

export function verifyAttestation(attestation: SimAttestation): boolean {
  const envelope = {
    result: attestation.result,
    runnerVersion: attestation.runnerVersion,
    workflowHash: attestation.workflowHash,
    timestamp: attestation.timestamp,
  };
  const canonical = canonicalize(envelope);
  return nacl.sign.detached.verify(
    new TextEncoder().encode(canonical),
    fromHex(attestation.signature),
    fromHex(attestation.signerPublicKey),
  );
}
