/**
 * #52 machine.execution_log real binding (LO-SE-3, bus #2063; astra pack 40
 * DO-NOT-SHIP fixes; capturedAt ordering, bus #3553) — the verifier wraps a
 * kernel-signed BUNDLE: bundle signature (registered signer, ed25519, 128-hex
 * value), LO-EV-9 subject binding, exactly one linear logKind chain from
 * GENESIS (`extractChain`, carrier A or carrier B, never both), per-entry
 * signature shape, non-decreasing capturedAt, then `verifyLogChain`. Fails
 * CLOSED on every degraded input — including the astra attacks the old
 * entries-only contract could not detect: truncation, reordering with
 * rewritten links, cross-run splice, and gaps.
 */
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";

import { describe, it, expect } from "vitest";

import {
  makeExecutionLogVerifier,
  industrialVerifiers,
  industrialVerifierStubs,
  type ExecutionLogInstance,
  type ExecutionLogVerifierDeps,
} from "../evidence/verifiers/oracle-binding.js";
import { computeLogEntryHash, GENESIS_HASH, type LogChainEntryView } from "../evidence/verifiers/log-chain.js";
import { hashEvent, hashBundle } from "../util/canonical.js";
import { signingPreimage, parseEd25519SignatureHex } from "../evidence/signing-preimage.js";
import type { Signature, Timestamp } from "../types/common.js";
import type { EvidenceEvent } from "../types/evidence.js";

// ── keys: a real Ed25519 keypair, plus a second unrelated one for "wrong key" attacks ──
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function publicKeyFromRaw(raw: Buffer) {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}
function rawPub(publicKey: KeyObject): Buffer {
  return (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
}

const KEY = generateKeyPairSync("ed25519");
const KEY_RAW_PUB = rawPub(KEY.publicKey);
const KEY_PUB_OBJ = publicKeyFromRaw(KEY_RAW_PUB);
const SIGNER = `0x${KEY_RAW_PUB.toString("hex").slice(0, 40)}`;
const OTHER_KEY = generateKeyPairSync("ed25519");

function sign(digest: string): Signature {
  return {
    signer: SIGNER as `0x${string}`,
    algorithm: "ed25519",
    value: edSign(null, signingPreimage(digest), KEY.privateKey).toString("hex"),
  };
}
/** Correctly labelled (signer = SIGNER) but cryptographically signed by a DIFFERENT key. */
function signWithOtherKey(digest: string): Signature {
  return {
    signer: SIGNER as `0x${string}`,
    algorithm: "ed25519",
    value: edSign(null, signingPreimage(digest), OTHER_KEY.privateKey).toString("hex"),
  };
}
/** The registered-key check both deps legs use: real Ed25519 verify against KEY. */
function verifySignature(digest: string, signature: unknown): boolean {
  const s = signature as { value?: unknown } | null;
  if (typeof s !== "object" || s === null) return false;
  try {
    return edVerify(null, signingPreimage(digest), KEY_PUB_OBJ, parseEd25519SignatureHex(s.value));
  } catch {
    return false;
  }
}

// ── subject / job identity ──────────────────────────────────────────────
const JOB = "job-oracle-binding-336";
const KERNEL = "kernel-oracle-binding-336";
const DEVICE = "dev-oracle-binding-336";
const T0 = Date.parse("2026-09-20T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString() as Timestamp;

const PARAMS = { logKind: "job_log" };
const CTX = { vocabVersion: 2, subject: { jobId: JOB, kernelId: KERNEL } };

function deps(overrides: Partial<ExecutionLogVerifierDeps> = {}): ExecutionLogVerifierDeps {
  return {
    expectedSigner: SIGNER,
    verifyBundleSignature: verifySignature,
    verifyKernelSignature: verifySignature,
    ...overrides,
  };
}
const v = (overrides: Partial<ExecutionLogVerifierDeps> = {}) => makeExecutionLogVerifier(deps(overrides));

// ── entry / event / bundle builders ─────────────────────────────────────
async function buildEntriesAt(contents: string[], timestamps: Timestamp[]): Promise<LogChainEntryView[]> {
  const out: LogChainEntryView[] = [];
  for (let i = 0; i < contents.length; i++) {
    const capturedAt = timestamps[i]!;
    const entryHash = await computeLogEntryHash(contents[i]!, DEVICE, capturedAt);
    out.push({
      entryId: `e${i}`,
      entryHash,
      previousHash: i === 0 ? GENESIS_HASH : out[i - 1]!.entryHash,
      rawContent: contents[i]!,
      source: DEVICE,
      capturedAt,
      kernelSignature: sign(entryHash),
    });
  }
  return out;
}
async function buildEntries(
  contents: string[],
  opts: { startMs?: number; stepMs?: number } = {},
): Promise<LogChainEntryView[]> {
  const startMs = opts.startMs ?? 0;
  const stepMs = opts.stepMs ?? 1000;
  return buildEntriesAt(
    contents,
    contents.map((_, i) => iso(startMs + i * stepMs)),
  );
}

/** Recompute an event's hash from {type,timestamp,source,payload}. */
async function rehashEvent(
  raw: { type: string; timestamp: string; source: unknown; payload: unknown },
  id?: string,
): Promise<EvidenceEvent> {
  const hash = await hashEvent(raw as never);
  return { ...raw, ...(id ? { id } : {}), hash } as unknown as EvidenceEvent;
}

/** Carrier A: one printer_job_verified-shaped event whose payload.entries is the whole chain. */
async function carrierAEvent(entries: LogChainEntryView[], logKind = "job_log"): Promise<EvidenceEvent> {
  return rehashEvent(
    {
      type: "printer_job_verified",
      timestamp: iso(600000),
      source: { deviceId: DEVICE, deviceType: "controller", kernelId: KERNEL },
      payload: { jobId: JOB, primitive: "machine.execution_log", params: { logKind }, entries },
    },
    `${JOB}-carrierA`,
  );
}

/** Carrier B: one log_hash_chain_entry event per entry. */
async function carrierBEvents(entries: LogChainEntryView[], logKind = "job_log"): Promise<EvidenceEvent[]> {
  const out: EvidenceEvent[] = [];
  for (let i = 0; i < entries.length; i++) {
    out.push(
      await rehashEvent(
        {
          type: "log_hash_chain_entry",
          timestamp: entries[i]!.capturedAt,
          source: { deviceId: DEVICE, deviceType: "controller", kernelId: KERNEL },
          payload: { jobId: JOB, logKind, ...entries[i] },
        },
        `${JOB}-carrierB-${i}`,
      ),
    );
  }
  return out;
}

/** Wrap events into a kernel-signed bundle. `signer` defaults to the real registered key. */
async function bundleOf(
  events: EvidenceEvent[],
  signer: (bundleHash: string) => Signature = sign,
): Promise<ExecutionLogInstance> {
  const bundleHash = await hashBundle(events);
  return { bundleHash, events, kernelSignature: signer(bundleHash) };
}
async function carrierABundle(entries: LogChainEntryView[], logKind = "job_log"): Promise<ExecutionLogInstance> {
  return bundleOf([await carrierAEvent(entries, logKind)]);
}

describe("#52 binding — accepts a real kernel-signed BUNDLE (positives)", () => {
  it("carrier A: one event carrying payload.entries[] → met:true", async () => {
    const bundle = await carrierABundle(await buildEntries(["a", "b", "c"]));
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(true);
    expect(res.detail.join(" ")).toContain("3-entry");
  });

  it("carrier B: one log_hash_chain_entry event per entry, in SHUFFLED order → met:true", async () => {
    const entries = await buildEntries(["a", "b", "c"]);
    const events = await carrierBEvents(entries);
    const shuffled = [events[2]!, events[0]!, events[1]!];
    const bundle = await bundleOf(shuffled);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(true);
  });

  it("instance null → met:\"pending\" (data not yet available)", async () => {
    const res = await v().verify(null, PARAMS, CTX);
    expect(res.met).toBe("pending");
  });
});

describe("#52 binding — truncation and reordering: individual signatures don't commit to sequence, the BUNDLE signature must", () => {
  it("carrier A truncation, NOT rehashed → binding failure (stale event.hash no longer matches the truncated payload)", async () => {
    const entries = await buildEntries(["a", "b", "c"]);
    const good = await carrierABundle(entries);
    const originalEvent = good.events[0] as unknown as EvidenceEvent;
    const truncatedEvent = {
      ...originalEvent,
      payload: { ...(originalEvent.payload as object), entries: entries.slice(0, 2) },
    };
    const tampered: ExecutionLogInstance = { ...good, events: [truncatedEvent] };
    const res = await v().verify(tampered, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toMatch(/bundle does not bind to the job/);
  });

  it("carrier A truncation, rehashed event+bundle but the OLD bundle signature → bundle signature does not verify", async () => {
    const entries = await buildEntries(["a", "b", "c"]);
    const good = await carrierABundle(entries);
    const originalEvent = good.events[0] as unknown as EvidenceEvent;
    const rawTruncated = {
      type: originalEvent.type,
      timestamp: originalEvent.timestamp,
      source: originalEvent.source,
      payload: { ...(originalEvent.payload as object), entries: entries.slice(0, 2) },
    };
    const truncatedEvent = await rehashEvent(rawTruncated, originalEvent.id);
    const tampered = await bundleOf([truncatedEvent], () => good.kernelSignature as Signature);
    const res = await v().verify(tampered, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("bundle signature does not verify");
  });

  it("carrier A reordering with REWRITTEN links, rehashed but the OLD bundle signature → bundle signature does not verify (entry signatures alone would have survived this)", async () => {
    const [e0, e1, e2] = await buildEntries(["a", "b", "c"]);
    const e2r = { ...e2!, previousHash: e0!.entryHash };
    const e1r = { ...e1!, previousHash: e2!.entryHash };
    const good = await carrierABundle([e0!, e1!, e2!]);
    const originalEvent = good.events[0] as unknown as EvidenceEvent;
    const rawReordered = {
      type: originalEvent.type,
      timestamp: originalEvent.timestamp,
      source: originalEvent.source,
      payload: { ...(originalEvent.payload as object), entries: [e0!, e2r, e1r] },
    };
    const reorderedEvent = await rehashEvent(rawReordered, originalEvent.id);
    const tampered = await bundleOf([reorderedEvent], () => good.kernelSignature as Signature);
    const res = await v().verify(tampered, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("bundle signature does not verify");
  });

  it("carrier B truncation, rehashed bundle but the OLD bundle signature → bundle signature does not verify", async () => {
    const entries = await buildEntries(["a", "b", "c"]);
    const events = await carrierBEvents(entries);
    const good = await bundleOf(events);
    const tampered = await bundleOf(events.slice(0, 2), () => good.kernelSignature as Signature);
    const res = await v().verify(tampered, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("bundle signature does not verify");
  });
});

describe("#52 binding — cross-run splice and ambiguous carriers", () => {
  it("cross-run splice: two carrier-B chains, EACH starting at GENESIS, kernel-signed for real → ambiguity detected, never silently merged", async () => {
    const chainA = await buildEntries(["a1", "a2"]);
    const chainB = await buildEntries(["b1", "b2"], { startMs: 500000 });
    const bundle = await bundleOf([...(await carrierBEvents(chainA)), ...(await carrierBEvents(chainB))]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toMatch(/forks or holds a second chain|more than one|not on the chain/);
  });

  it("carrier A and carrier B for the same logKind in one bundle → ambiguous, 'more than one'", async () => {
    const entries = await buildEntries(["a", "b"]);
    const bundle = await bundleOf([await carrierAEvent(entries), ...(await carrierBEvents(entries))]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("more than one");
  });

  it("carrier B with a GAP (entries 0 and 2 only, entry 1 omitted) → not on the chain from GENESIS", async () => {
    const entries = await buildEntries(["a", "b", "c"]);
    const events = await carrierBEvents(entries);
    const bundle = await bundleOf([events[0]!, events[2]!]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("not on the chain from GENESIS");
  });
});

describe("#52 binding — the chain's own shape is named (lane mutation check, survivors b-fork-allowed and b-no-log-allowed)", () => {
  it("a fork, two entries following the same predecessor, is named as a fork", async () => {
    const [e0, e1] = await buildEntries(["a", "b"]);
    const [, e1b] = await buildEntriesAt(["a", "b-other"], [e0!.capturedAt, iso(1500)]);
    const forked = { ...e1b!, entryId: "e1b", previousHash: e0!.entryHash };
    const res = await v().verify(await bundleOf(await carrierBEvents([e0!, e1!, forked])), PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("the log forks or holds a second chain");
  });

  it("a kernel-signed bundle that carries no log of the logKind says so", async () => {
    const other = await carrierAEvent(await buildEntries(["a"]), "alarm_log");
    const res = await v().verify(await bundleOf([other]), PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("the bundle carries no job_log execution log");
  });
});

describe("#52 binding — subject binding", () => {
  it("events commit a DIFFERENT jobId than ctx.subject → job-mismatch binding failure", async () => {
    const entries = await buildEntries(["a", "b"]);
    const rawEvent = {
      type: "printer_job_verified",
      timestamp: iso(60000),
      source: { deviceId: DEVICE, deviceType: "controller", kernelId: KERNEL },
      payload: { jobId: "job-other", primitive: "machine.execution_log", params: { logKind: "job_log" }, entries },
    };
    const event = await rehashEvent(rawEvent, "job-other-event");
    const bundle = await bundleOf([event]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("job-mismatch");
  });

  it("ctx without a subject → ctx.subject is missing, fails closed", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const res = await v().verify(bundle, PARAMS, { vocabVersion: 2 });
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("ctx.subject");
  });

  it("the OLD contract's bare entries[] as the instance → rejected with a message that mentions the bundle", async () => {
    const entries = await buildEntries(["a", "b"]);
    const res = await v().verify(entries, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("bundle");
  });
});

describe("#52 binding — signer and algorithm binding", () => {
  it("bundle signature relabelled to another signer → bundle kernelSignature: signer", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const tampered: ExecutionLogInstance = {
      ...bundle,
      kernelSignature: { ...(bundle.kernelSignature as Signature), signer: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    };
    const res = await v().verify(tampered, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("bundle kernelSignature: signer");
  });

  it("an entry's signer relabelled, bundle re-signed validly by the real key → entry N: kernelSignature: signer", async () => {
    const entries = await buildEntries(["a", "b"]);
    const events = await carrierBEvents(entries);
    const bad = events[1] as unknown as EvidenceEvent;
    const rawBad = {
      type: bad.type,
      timestamp: bad.timestamp,
      source: bad.source,
      payload: {
        ...(bad.payload as object),
        kernelSignature: { ...(bad.payload as { kernelSignature: Signature }).kernelSignature, signer: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
      },
    };
    const rehashed = await rehashEvent(rawBad, bad.id);
    const bundle = await bundleOf([events[0]!, rehashed]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("entry 1: kernelSignature: signer");
  });

  it("bundle signature algorithm set to secp256k1 → algorithm must be ed25519", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const tampered: ExecutionLogInstance = {
      ...bundle,
      kernelSignature: { ...(bundle.kernelSignature as Signature), algorithm: "secp256k1" },
    };
    const res = await v().verify(tampered, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("algorithm must be ed25519");
  });

  it("bundle signature VALUE from another key (valid format, correct label) → bundle signature does not verify", async () => {
    const entries = await buildEntries(["a"]);
    const good = await carrierABundle(entries);
    const forged = await bundleOf(good.events as EvidenceEvent[], signWithOtherKey);
    const res = await v().verify(forged, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("bundle signature does not verify");
  });

  it("an entry signature VALUE from another key, bundle re-signed by the real key → log chain invalid", async () => {
    const entries = await buildEntries(["a", "b"]);
    const events = await carrierBEvents(entries);
    const bad = events[1] as unknown as EvidenceEvent;
    const badEntryHash = (bad.payload as { entryHash: string }).entryHash;
    const rawBad = {
      type: bad.type,
      timestamp: bad.timestamp,
      source: bad.source,
      payload: { ...(bad.payload as object), kernelSignature: signWithOtherKey(badEntryHash) },
    };
    const rehashed = await rehashEvent(rawBad, bad.id);
    const bundle = await bundleOf([events[0]!, rehashed]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("log chain invalid");
  });

  it("a signature value that isn't 128 hex → 64-byte Ed25519", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const tampered: ExecutionLogInstance = {
      ...bundle,
      kernelSignature: { ...(bundle.kernelSignature as Signature), value: "not-hex" },
    };
    const res = await v().verify(tampered, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("64-byte Ed25519");
  });
});

describe("#52 binding — integrity inside a validly signed bundle (entry-level tamper, fully re-hashed and re-signed by the real key)", () => {
  it("rawContent altered → log chain invalid (the recorded entryHash no longer matches a fresh recompute)", async () => {
    const entries = await buildEntries(["a", "b"]);
    const events = await carrierBEvents(entries);
    const bad = events[1] as unknown as EvidenceEvent;
    const rawBad = {
      type: bad.type,
      timestamp: bad.timestamp,
      source: bad.source,
      payload: { ...(bad.payload as object), rawContent: "TAMPERED" },
    };
    const rehashed = await rehashEvent(rawBad, bad.id);
    const bundle = await bundleOf([events[0]!, rehashed]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("log chain invalid");
  });

  it("a redacted entry (rawContent removed) → entry N: rawContent absent", async () => {
    const entries = await buildEntries(["a", "b"]);
    const events = await carrierBEvents(entries);
    const bad = events[1] as unknown as EvidenceEvent;
    const { rawContent: _drop, ...redactedPayload } = bad.payload as Record<string, unknown>;
    const rawBad = { type: bad.type, timestamp: bad.timestamp, source: bad.source, payload: redactedPayload };
    const rehashed = await rehashEvent(rawBad, bad.id);
    const bundle = await bundleOf([events[0]!, rehashed]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("entry 1: rawContent absent");
  });
});

describe("#52 binding — minEntries and the factory", () => {
  const baseDeps = { expectedSigner: SIGNER, verifyBundleSignature: verifySignature, verifyKernelSignature: verifySignature };

  it.each([0, -1, 1.5, NaN, Infinity])("the factory throws for minEntries=%p", (minEntries) => {
    expect(() => makeExecutionLogVerifier({ ...baseDeps, minEntries })).toThrow();
  });

  it("the factory throws when expectedSigner is missing", () => {
    const { expectedSigner: _drop, ...rest } = baseDeps;
    expect(() => makeExecutionLogVerifier(rest as unknown as ExecutionLogVerifierDeps)).toThrow();
  });

  it("an empty carrier-A entries array → chain has 0 entries", async () => {
    const bundle = await carrierABundle([]);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("chain has 0 entries");
  });
});

describe("#52 binding — params", () => {
  it("a logKind not in the allowlist → rejected (params.logKind)", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]), "syslog");
    const res = await v().verify(bundle, { logKind: "syslog" }, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("params.logKind");
  });

  it("alarmPolicy declared → fails closed, never silently ignored", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const res = await v().verify(bundle, { logKind: "job_log", alarmPolicy: "none-critical" }, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("alarmPolicy");
  });

  it("cadence gap beyond minCadenceMs → rejected", async () => {
    const bundle = await carrierABundle(await buildEntries(["a", "b"], { stepMs: 5000 }));
    const res = await v().verify(bundle, { logKind: "job_log", minCadenceMs: 1000 }, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("cadence gap");
  });

  // Evidence ruling #3553: capturedAt is ALWAYS non-decreasing along the
  // chain, whether or not minCadenceMs is set.
  it("capturedAt goes BACKWARDS between two entries → rejected, even with no minCadenceMs set", async () => {
    const entries = await buildEntriesAt(["a", "b", "c"], [iso(0), iso(2000), iso(1000)]);
    const bundle = await carrierABundle(entries);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("capturedAt goes backwards");
  });

  it("EQUAL capturedAt between consecutive entries is allowed → met:true", async () => {
    const entries = await buildEntriesAt(["a", "b"], [iso(0), iso(0)]);
    const bundle = await carrierABundle(entries);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(true);
  });

  it("an unparseable capturedAt fails order checking even with no minCadenceMs set → order unverifiable", async () => {
    const entries = await buildEntriesAt(["a", "b"], [iso(0), "not-a-time" as Timestamp]);
    const bundle = await carrierABundle(entries);
    const res = await v().verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("order unverifiable");
  });
});

describe("#52 binding — injected legs that throw are treated as failure, never propagate", () => {
  it("verifyBundleSignature throws → fails (leg failure treated as false)", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const throwing = v({
      verifyBundleSignature: () => {
        throw new Error("boom");
      },
    });
    const res = await throwing.verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
  });

  it("verifyKernelSignature throws → log chain invalid", async () => {
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const throwing = v({
      verifyKernelSignature: () => {
        throw new Error("boom");
      },
    });
    const res = await throwing.verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("log chain invalid");
  });
});

describe("#52 binding — snapshot integrity", () => {
  // Since astra pack 154: an instance carrying a getter is refused without the getter ever running.
  it("an instance whose events property is a getter is refused, and the getter never runs", async () => {
    const real = await carrierABundle(await buildEntries(["a"]));
    let reads = 0;
    const instance = {
      bundleHash: real.bundleHash,
      get events() {
        reads++;
        return real.events;
      },
      kernelSignature: real.kernelSignature,
    };
    const res = await v().verify(instance, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(reads).toBe(0);
  });
});

describe("industrial verifier maps (adapted to the new deps contract)", () => {
  it("industrialVerifiers: #52 real (accepts a kernel-signed bundle), #53-#55 still fail-closed stubs", async () => {
    const map = industrialVerifiers(deps());
    const bundle = await carrierABundle(await buildEntries(["a"]));
    const ok = await map["machine.execution_log"].verify(bundle, PARAMS, CTX);
    expect(ok.met).toBe(true);
    const stub = await map["telemetry.envelope_conformance"].verify({}, {}, CTX);
    expect(stub.met).toBe(false);
  });

  it("industrialVerifierStubs unchanged: all four fail closed", async () => {
    const map = industrialVerifierStubs();
    const bundle = await carrierABundle(await buildEntries(["a"]));
    for (const id of Object.keys(map) as (keyof ReturnType<typeof industrialVerifierStubs>)[]) {
      const res = await map[id].verify(bundle, PARAMS, CTX);
      expect(res.met).toBe(false);
    }
  });
});

// ── astra r2 (pack 73, gpt-5.6-sol): carrier B must visit every signed entry exactly once ──
// An entry hash covers {capturedAt, rawContent, source}, not previousHash, so two identical
// entries share a hash, and the second can link to the first as its own predecessor.
describe("#52 binding — carrier B visits every signed entry exactly once (astra r2, pack 73)", () => {
  async function identicalPairAndHidden(): Promise<LogChainEntryView[]> {
    const t = iso(0);
    const h = await computeLogEntryHash("ok", DEVICE, t);
    const e0: LogChainEntryView = { entryId: "e0", entryHash: h, previousHash: GENESIS_HASH, rawContent: "ok", source: DEVICE, capturedAt: t, kernelSignature: sign(h) };
    const e1: LogChainEntryView = { ...e0, entryId: "e1", previousHash: h };
    const t2 = iso(1000);
    const h2 = await computeLogEntryHash("job FAILED", DEVICE, t2);
    const unrelated = `sha256:${"ab".repeat(32)}`;
    const e2: LogChainEntryView = { entryId: "e2", entryHash: h2, previousHash: unrelated as LogChainEntryView["previousHash"], rawContent: "job FAILED", source: DEVICE, capturedAt: t2, kernelSignature: sign(h2) };
    return [e0, e1, e2];
  }

  it("a repeated entry cannot pad the walk and hide a third signed entry (met:false, minEntries 3)", async () => {
    const bundle = await bundleOf(await carrierBEvents(await identicalPairAndHidden()));
    const res = await v({ minEntries: 3 }).verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toMatch(/revisit|twice|cycle/);
  });

  it("a self-linked duplicate alone is refused as a revisit, never counted twice", async () => {
    const [e0, e1] = await identicalPairAndHidden();
    const bundle = await bundleOf(await carrierBEvents([e0!, e1!]));
    const res = await v({ minEntries: 2 }).verify(bundle, PARAMS, CTX);
    expect(res.met).toBe(false);
  });
});
