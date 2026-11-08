/**
 * Oracle-binding seam for the industrial primitives (#52–#55).
 *
 * History: this file began as the "interface + stub" seam ONLY (evidence-vocab
 * §8 stub policy), with the real bindings deferred to a settlement lane
 * (bulletins #291/#293, July era). Under goal `pcc-close-delta` the steward
 * re-routed the binding work to the sensors lane (bus #2063, from the astra
 * memo LO-SE-3): wrap the extracted, parity-tested predicates into real
 * `PrimitiveVerifier`s here, one primitive at a time, fail-closed throughout.
 *
 * Bound so far:
 *   - #52 machine.execution_log → `makeExecutionLogVerifier`. It verifies the
 *     kernel-signed BUNDLE that carries the log: the bundle signature, LO-EV-9
 *     subject binding, then one linear chain from GENESIS through
 *     `verifyLogChain`. The registered signer and the registered-key checks
 *     are injected by the consumer (the kernel wraps
 *     `KernelKeychain.verifySignature`; the oracle resolves the signer against
 *     its registered-key snapshot, #47).
 *
 * Still fail-closed stubs (`met:false`, never a silent pass):
 *   - #53 telemetry.envelope_conformance → will wrap `detectDrifts`
 *     (power/temp/duration envelope) → met ⇔ zero alerts ≥ severityFloor
 *   - #54 telemetry.coverage_gate       → will wrap `detectDrifts` (sensor_gap
 *     leg) as a negative gate
 *   - #55 process.batch_record          → composition glue over #52/#53/#54 +
 *     the existing event-sequence rule
 *
 * `verifierStatus` in `primitives.ts` stays `"stub"` for #52 until the oracle's
 * /settle actually RUNS this binding (private repo) — "live" means "in the
 * /settle verified set" (the lockstep rule in primitives.ts), and the run half
 * is not this file's to claim. Flipping it is hash-safe (verifierStatus is
 * excluded from VOCAB_MANIFEST_HASH) and happens with the /settle wiring, not
 * before.
 */

import { makeStubVerifier, type PrimitiveVerifier, type PrimitiveVerifyResult } from "../verifier-interface.js";
import { parseEd25519SignatureHex } from "../signing-preimage.js";
import { verifyEvidenceSubjectBinding, type EvidenceSubject } from "../subject-binding.js";
import type { Signature } from "../../types/common.js";
import type { EvidenceEvent } from "../../types/evidence.js";
import { plainDataCopy } from "../../util/plain-data.js";
import {
  GENESIS_HASH,
  verifyLogChain,
  type LogChainEntryView,
  type VerifyKernelSignature,
} from "./log-chain.js";

/** The ids of the four industrial primitives added in the v1.5-industrial cut. */
export const INDUSTRIAL_PRIMITIVE_IDS = [
  "machine.execution_log", // #52
  "telemetry.envelope_conformance", // #53
  "telemetry.coverage_gate", // #54
  "process.batch_record", // #55
] as const;

export type IndustrialPrimitiveId = (typeof INDUSTRIAL_PRIMITIVE_IDS)[number];

/** Valid `logKind` values per the #52 paramsSchema in `primitives.ts`. */
const EXECUTION_LOG_KINDS = new Set(["job_log", "command_trace", "alarm_log", "program_transcript"]);

/**
 * Everything the consumer must inject to bind #52. The signer and both keys come
 * from the registry for the job's kernel, never from the evidence.
 */
export interface ExecutionLogVerifierDeps {
  /**
   * The kernel's registered signer (`Signature.signer`). The bundle's signature
   * and every entry's must carry exactly this signer, so a relabelled signature
   * fails here before any key is consulted.
   */
  expectedSigner: string;
  /** Registered-key check over `signingPreimage(bundleHash)` (LO-EV-1). A throw is a failure. */
  verifyBundleSignature: (bundleHash: string, signature: Signature) => Promise<boolean> | boolean;
  /** Registered-key check over `signingPreimage(entryHash)`. A throw is a failure. */
  verifyKernelSignature: VerifyKernelSignature;
  /** Floor on chain length: an integer >= 1 (default 1). Anything else throws when the verifier is built. */
  minEntries?: number;
}

/**
 * The #52 `instance`: the kernel-signed bundle that carries the log, as stored.
 * Not the entries alone: an entry's signature covers its own content but not
 * its predecessor, its position or its run (`computeLogEntryHash` is over
 * `{capturedAt, rawContent, source}`), so entries alone cannot show that a
 * chain is the one the kernel produced. The bundle's signature covers every
 * event it carries, and with them every link.
 */
export interface ExecutionLogInstance {
  bundleHash: string;
  events: readonly unknown[];
  kernelSignature: unknown;
}

/** `Signature.algorithm` for logs: every log producer signs Ed25519 (LO-EV-1). */
const LOG_SIGNATURE_ALGORITHM = "ed25519";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why `s` is not the registered signer's Ed25519 `Signature` object, or null. */
function signatureProblem(s: unknown, expectedSigner: string): string | null {
  if (!isRecord(s)) return "must be a Signature object {signer, algorithm, value}, not a bare value";
  if (s.signer !== expectedSigner) return `signer ${JSON.stringify(String(s.signer))} is not the registered signer`;
  if (s.algorithm !== LOG_SIGNATURE_ALGORITHM) return `algorithm must be ${LOG_SIGNATURE_ALGORITHM}`;
  try {
    parseEd25519SignatureHex(s.value);
  } catch {
    return "value is not a 64-byte Ed25519 signature in lowercase hex";
  }
  return null;
}

/**
 * Why `x` is not a verifiable log-chain entry, or null if it is.
 *
 * `kernelSignature` must be the registered signer's Ed25519 `Signature` object
 * `{signer, algorithm, value}`: the shape the kernel's LogCaptureService and
 * pcc-node's log_capture.py both emit. A redacted entry (no `rawContent`) cannot
 * have its entryHash recomputed, so it fails closed.
 */
function entryViewProblem(x: unknown, expectedSigner: string): string | null {
  if (!isRecord(x)) return "not an object";
  for (const field of ["entryId", "entryHash", "previousHash", "source", "capturedAt"] as const) {
    if (typeof x[field] !== "string") return `${field} missing or not a string`;
  }
  if (typeof x.rawContent !== "string") {
    return "rawContent absent (a redacted entry): its entryHash cannot be recomputed, so it cannot be verified here";
  }
  const problem = signatureProblem(x.kernelSignature, expectedSigner);
  return problem === null ? null : `kernelSignature: ${problem}`;
}

/**
 * The one `logKind` chain in the bound events, in chain order. Two carriers
 * exist, and a bundle may use either, never both:
 *   - one event whose payload is `{primitive: "machine.execution_log",
 *     params: {logKind}, entries: [...]}` (the kernel path, LO-SE-3); the
 *     array is the chain;
 *   - one `log_hash_chain_entry` event per entry, with `payload.logKind`
 *     (pcc-node's producers, e.g. #417's command trace); the entries are ordered
 *     by their links, from GENESIS.
 * Anything but exactly one linear chain from GENESIS that uses every entry
 * (no second log, fork, gap, second GENESIS or leftover) fails closed. A
 * truncated or reordered chain cannot reach here: the bundle's signature covers
 * every event.
 */
function extractChain(
  events: readonly EvidenceEvent[],
  logKind: string,
): { ok: true; entries: unknown[] } | { ok: false; reason: string } {
  const carried = events.filter(
    (e) =>
      isRecord(e.payload) &&
      e.payload.primitive === "machine.execution_log" &&
      isRecord(e.payload.params) &&
      e.payload.params.logKind === logKind,
  );
  const perEntry = events.filter(
    (e) => e.type === "log_hash_chain_entry" && isRecord(e.payload) && e.payload.logKind === logKind,
  );
  if (carried.length + perEntry.length === 0) {
    return { ok: false, reason: `the bundle carries no ${logKind} execution log` };
  }
  if (carried.length > 1 || (carried.length === 1 && perEntry.length > 0)) {
    return { ok: false, reason: `the bundle carries more than one ${logKind} log, so which one is the execution's is ambiguous` };
  }
  if (carried.length === 1) {
    const entries = (carried[0]!.payload as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return { ok: false, reason: "payload.entries is not an array" };
    return { ok: true, entries };
  }
  // One event per entry: follow the links from GENESIS; every entry exactly once.
  const byPrevious = new Map<unknown, Record<string, unknown>>();
  for (const e of perEntry) {
    const entry = e.payload as Record<string, unknown>;
    if (byPrevious.has(entry.previousHash)) {
      return { ok: false, reason: `two ${logKind} entries follow ${String(entry.previousHash)}: the log forks or holds a second chain` };
    }
    byPrevious.set(entry.previousHash, entry);
  }
  // An entry hash covers {capturedAt, rawContent, source}, not previousHash, so two
  // identical entries share a hash and the second can name the first, or itself, as
  // its predecessor. Counting steps would then count one entry twice and leave
  // another unread; so each entry is visited at most once, and a revisit refuses.
  const ordered: Record<string, unknown>[] = [];
  const visited = new Set<Record<string, unknown>>();
  let next = byPrevious.get(GENESIS_HASH);
  while (next !== undefined) {
    if (visited.has(next)) {
      return { ok: false, reason: `the ${logKind} chain revisits an entry (a cycle: two entries share an entry hash), so one entry would count twice` };
    }
    visited.add(next);
    ordered.push(next);
    next = byPrevious.get(next.entryHash);
  }
  if (ordered.length !== perEntry.length) {
    return { ok: false, reason: `${perEntry.length - ordered.length} ${logKind} entr(ies) are not on the chain from GENESIS (a gap or a second chain)` };
  }
  return { ok: true, entries: ordered };
}

async function legPasses(leg: () => Promise<boolean> | boolean): Promise<boolean> {
  try {
    return (await leg()) === true;
  } catch {
    return false;
  }
}

function fail(detail: string[]): PrimitiveVerifyResult {
  return { met: false, detail };
}

/**
 * Real PrimitiveVerifier for #52 machine.execution_log.
 *
 * `instance`: the kernel-signed bundle that carries the log
 * (`ExecutionLogInstance`). `ctx.subject`: the job (and kernel, unit, challenge)
 * the evidence must be for, from the job record, never from the evidence. Both
 * are copied once, as plain data, and only the copies are read. `instance ==
 * null` means the data is not yet available, so `met:"pending"`; anything
 * present but malformed fails CLOSED with its first defect.
 *
 * In order:
 *   1. the bundle's signature is the registered signer's Ed25519 signature
 *      (`deps.expectedSigner`, then `deps.verifyBundleSignature`);
 *   2. the bundle binds to the job and kernel (LO-EV-9,
 *      `verifyEvidenceSubjectBinding`): its digest opens to its events, and
 *      every event commits the subject;
 *   3. the `logKind` chain is extracted from the BOUND snapshots (`extractChain`):
 *      one linear chain from GENESIS;
 *   4. every entry carries the registered signer's Ed25519 signature;
 *   5. `verifyLogChain`: each entryHash recomputes, each link holds, and each
 *      entry signature verifies (`deps.verifyKernelSignature`).
 *
 * Param semantics (schema in `primitives.ts` #52):
 *   - `logKind` (required): must be one of the declared kinds, else fail.
 *   - `minCadenceMs` (optional): enforced — no gap between consecutive
 *     `capturedAt` timestamps may exceed it. Independently of it, `capturedAt`
 *     must never decrease along the chain (equal allowed; evidence, bus #3553).
 *   - `alarmPolicy` (optional): NOT generically enforceable by this binding
 *     (needs log-content interpretation) → its presence fails CLOSED rather
 *     than being silently ignored. Nobody weakens a check to pass it.
 *   - `disclosure` (optional): not checked here, but NOT neutral — a
 *     "redacted-commit" entry carries no rawContent, so its entryHash cannot
 *     be recomputed and the entry fails closed. This binding verifies only
 *     full-disclosure chains.
 *
 * What this does not decide: whether the logged execution SUCCEEDED. A log
 * that faithfully records a failure is authentic; outcome policy is the
 * evaluator's (evidence levels, contradictions, admission).
 */
export function makeExecutionLogVerifier(deps: ExecutionLogVerifierDeps): PrimitiveVerifier {
  const minEntries = deps.minEntries ?? 1;
  if (!Number.isInteger(minEntries) || minEntries < 1) {
    throw new TypeError(`makeExecutionLogVerifier: minEntries must be an integer >= 1 (got ${String(minEntries)})`);
  }
  if (typeof deps.expectedSigner !== "string" || deps.expectedSigner.length === 0) {
    throw new TypeError("makeExecutionLogVerifier: expectedSigner (the kernel's registered signer) is required");
  }
  const { expectedSigner } = deps;
  const verifyEntrySignature: VerifyKernelSignature = (entryHash, signature) =>
    legPasses(() => deps.verifyKernelSignature(entryHash, signature));

  return {
    id: "machine.execution_log",
    async verify(instance, params, ctx): Promise<PrimitiveVerifyResult> {
      if (instance === null || instance === undefined) {
        return { met: "pending", detail: ["execution log not yet available"] };
      }
      const bundleCopy = plainDataCopy(instance);
      if (!bundleCopy.ok || !isRecord(bundleCopy.value)) {
        return fail(["instance is not the plain-data bundle that carries the log — fails closed"]);
      }
      const bundle = bundleCopy.value;
      if (typeof bundle.bundleHash !== "string" || !Array.isArray(bundle.events)) {
        return fail(["instance must be the kernel-signed bundle {bundleHash, events, kernelSignature}, not bare entries — fails closed"]);
      }
      const bundleSigProblem = signatureProblem(bundle.kernelSignature, expectedSigner);
      if (bundleSigProblem !== null) return fail([`bundle kernelSignature: ${bundleSigProblem} — fails closed`]);

      const p = (params ?? {}) as Record<string, unknown>;
      const detail: string[] = [];
      if (typeof p.logKind !== "string" || !EXECUTION_LOG_KINDS.has(p.logKind)) {
        return fail([`params.logKind missing or invalid (got ${typeof p.logKind === "string" ? JSON.stringify(p.logKind) : typeof p.logKind}) — required by #52 schema`]);
      }
      if (p.alarmPolicy !== undefined) {
        return fail(["params.alarmPolicy declared but not enforceable by this binding — fails closed rather than silently ignored"]);
      }
      if (p.disclosure !== undefined) {
        detail.push(`params.disclosure=${String(p.disclosure)} noted; only entries carrying rawContent can be verified`);
      }

      const subjectCopy = plainDataCopy(isRecord(ctx) ? (ctx as Record<string, unknown>).subject : undefined);
      if (!subjectCopy.ok || !isRecord(subjectCopy.value)) {
        return fail(["ctx.subject (the job the evidence must be for, from the job record) is missing — fails closed"]);
      }

      if (!(await legPasses(() => deps.verifyBundleSignature(bundle.bundleHash as string, bundle.kernelSignature as Signature)))) {
        return fail(["bundle signature does not verify under the registered key — fails closed"]);
      }
      const binding = await verifyEvidenceSubjectBinding({
        bundleHash: bundle.bundleHash,
        events: bundle.events as readonly unknown[],
        subject: subjectCopy.value as unknown as EvidenceSubject,
      });
      if (!binding.ok) {
        const at = binding.eventIndex === undefined ? "" : ` at event ${binding.eventIndex}`;
        return fail([`bundle does not bind to the job: ${binding.reason}${at} — fails closed`]);
      }

      const chain = extractChain(binding.events, p.logKind);
      if (!chain.ok) return fail([`${chain.reason} — fails closed`]);
      for (let i = 0; i < chain.entries.length; i++) {
        const problem = entryViewProblem(chain.entries[i], expectedSigner);
        if (problem !== null) return fail([`entry ${i}: ${problem} — fails closed`]);
      }
      const entries = chain.entries as LogChainEntryView[];

      if (entries.length < minEntries) {
        return fail([`chain has ${entries.length} entries; minimum is ${minEntries} — an empty/short chain is vacuous, never met`]);
      }

      // capturedAt never goes backwards along the chain (equal is allowed;
      // evidence ruling, bus #3553), and, when declared, no gap exceeds
      // minCadenceMs. A producer times a never-completed entry no earlier than
      // its predecessor; it never invents a completion.
      for (let i = 1; i < entries.length; i++) {
        const prev = Date.parse(entries[i - 1]!.capturedAt);
        const cur = Date.parse(entries[i]!.capturedAt);
        if (!Number.isFinite(prev) || !Number.isFinite(cur)) {
          return fail([`entry ${i - 1} or ${i} has an unparseable capturedAt — order unverifiable, fails closed`]);
        }
        if (cur < prev) {
          return fail([`capturedAt goes backwards between entries ${i - 1} and ${i} — a log chain's capture times never decrease`]);
        }
        if (typeof p.minCadenceMs === "number" && cur - prev > p.minCadenceMs) {
          return fail([`cadence gap of ${cur - prev}ms between entries ${i - 1} and ${i} exceeds minCadenceMs=${p.minCadenceMs}`]);
        }
      }

      const verified = await verifyLogChain(entries, verifyEntrySignature);
      if (!verified.valid) {
        return fail([
          `log chain invalid (first break at index ${verified.brokenAt})`,
          ...verified.errors.slice(0, 5),
        ]);
      }

      detail.unshift(`verified ${verified.entries}-entry chain in a kernel-signed bundle bound to the job (logKind=${p.logKind})`);
      return { met: true, detail };
    },
  };
}

/**
 * Fail-closed stub verifiers for the industrial primitives, keyed by id.
 * Consuming this map (rather than a silent absence) guarantees an unbound
 * industrial primitive resolves to `met:false`, never an accidental pass (§8).
 *
 * NOTE: #52 has a real binding now — consumers that can inject the signature
 * check should use `industrialVerifiers({...})` instead; this all-stub map
 * remains for callers with nothing to inject (still correct: fail closed).
 */
export function industrialVerifierStubs(): Record<IndustrialPrimitiveId, PrimitiveVerifier> {
  return {
    "machine.execution_log": makeStubVerifier("machine.execution_log"),
    "telemetry.envelope_conformance": makeStubVerifier("telemetry.envelope_conformance"),
    "telemetry.coverage_gate": makeStubVerifier("telemetry.coverage_gate"),
    "process.batch_record": makeStubVerifier("process.batch_record"),
  };
}

/**
 * The industrial verifier map with every shipped real binding included:
 * #52 real (chain + signature via the injected check), #53–#55 still stubs.
 */
export function industrialVerifiers(
  deps: ExecutionLogVerifierDeps,
): Record<IndustrialPrimitiveId, PrimitiveVerifier> {
  return {
    ...industrialVerifierStubs(),
    "machine.execution_log": makeExecutionLogVerifier(deps),
  };
}
