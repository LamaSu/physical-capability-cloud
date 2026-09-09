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
 *   - #52 machine.execution_log → `makeExecutionLogVerifier` over
 *     `verifyLogChain` (chain + kernel-signature checks), with the
 *     registered-key check injected by the consumer (`VerifyKernelSignature` —
 *     kernel wraps `KernelKeychain.verifySignature`; the oracle resolves the
 *     signer against its registered-key snapshot, #47).
 *
 * Still fail-closed stubs (`met:false`, never a silent pass):
 *   - #53 telemetry.envelope_conformance → will wrap `detectDrifts`
 *     (power/temp/duration envelope) → met ⇔ zero alerts ≥ severityFloor
 *   - #54 telemetry.coverage_gate       → will wrap `detectDrifts` (sensor_gap
 *     leg) as a negative gate
 *   - #55 process.batch_record          → composition glue over #52/#53/#54 +
 *     the existing event-sequence rule
 *
 * `verifierStatus` in `primitives.ts` stays `"stub"` for #52 until a production
 * consumer actually RUNS this binding (the oracle's evaluator, private repo) —
 * "live" means machinery exists and runs today, and the run half is not this
 * file's to claim. Flipping it is hash-safe (verifierStatus is excluded from
 * VOCAB_MANIFEST_HASH) and happens with the consumer wiring, not before.
 */

import { makeStubVerifier, type PrimitiveVerifier, type PrimitiveVerifyResult } from "../verifier-interface.js";
import {
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

/** Everything the consumer must inject to bind #52. */
export interface ExecutionLogVerifierDeps {
  /** Signature check over `entryHash` for the expected kernel signer. */
  verifyKernelSignature: VerifyKernelSignature;
  /** Floor on chain length; a zero-entry chain is vacuous, never `met`. */
  minEntries?: number;
}

function isEntryView(x: unknown): x is LogChainEntryView {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.entryId === "string" &&
    typeof e.entryHash === "string" &&
    typeof e.previousHash === "string" &&
    typeof e.rawContent === "string" &&
    typeof e.source === "string" &&
    typeof e.capturedAt === "string" &&
    typeof e.kernelSignature === "string"
  );
}

function fail(detail: string[]): PrimitiveVerifyResult {
  return { met: false, detail };
}

/**
 * Real PrimitiveVerifier for #52 machine.execution_log.
 *
 * `instance` contract: the captured chain as `readonly LogChainEntryView[]`
 * (the kernel's `LogEntry[]` is assignable). `instance == null` means the data
 * is not yet available → `met:"pending"` per the verifier-interface contract;
 * anything present-but-malformed fails CLOSED.
 *
 * Param semantics (schema in `primitives.ts` #52):
 *   - `logKind` (required): must be one of the declared kinds, else fail.
 *   - `minCadenceMs` (optional): enforced — no gap between consecutive
 *     `capturedAt` timestamps may exceed it.
 *   - `alarmPolicy` (optional): NOT generically enforceable by this binding
 *     (needs log-content interpretation) → its presence fails CLOSED rather
 *     than being silently ignored. Nobody weakens a check to pass it.
 *   - `disclosure` (optional): capture-side, verification-neutral — ignored
 *     with a detail note.
 */
export function makeExecutionLogVerifier(deps: ExecutionLogVerifierDeps): PrimitiveVerifier {
  const minEntries = deps.minEntries ?? 1;
  return {
    id: "machine.execution_log",
    async verify(instance, params, _ctx): Promise<PrimitiveVerifyResult> {
      if (instance === null || instance === undefined) {
        return { met: "pending", detail: ["execution log not yet available"] };
      }
      if (!Array.isArray(instance) || !instance.every(isEntryView)) {
        return fail(["instance is not a LogChainEntryView[] — fails closed"]);
      }

      const p = (params ?? {}) as Record<string, unknown>;
      const detail: string[] = [];
      if (typeof p.logKind !== "string" || !EXECUTION_LOG_KINDS.has(p.logKind)) {
        return fail([`params.logKind missing or invalid (got ${JSON.stringify(p.logKind)}) — required by #52 schema`]);
      }
      if (p.alarmPolicy !== undefined) {
        return fail(["params.alarmPolicy declared but not enforceable by this binding — fails closed rather than silently ignored"]);
      }
      if (p.disclosure !== undefined) {
        detail.push(`params.disclosure=${String(p.disclosure)} is capture-side; not checked here`);
      }

      if (instance.length < minEntries) {
        return fail([`chain has ${instance.length} entries; minimum is ${minEntries} — an empty/short chain is vacuous, never met`]);
      }

      if (typeof p.minCadenceMs === "number" && instance.length > 1) {
        for (let i = 1; i < instance.length; i++) {
          const prev = Date.parse(instance[i - 1]!.capturedAt);
          const cur = Date.parse(instance[i]!.capturedAt);
          if (!Number.isFinite(prev) || !Number.isFinite(cur)) {
            return fail([`entry ${i - 1} or ${i} has an unparseable capturedAt — cadence unverifiable, fails closed`]);
          }
          const gap = cur - prev;
          if (gap > p.minCadenceMs) {
            return fail([`cadence gap of ${gap}ms between entries ${i - 1} and ${i} exceeds minCadenceMs=${p.minCadenceMs}`]);
          }
        }
      }

      const chain = await verifyLogChain(instance, deps.verifyKernelSignature);
      if (!chain.valid) {
        return fail([
          `log chain invalid (first break at index ${chain.brokenAt})`,
          ...chain.errors.slice(0, 5),
        ]);
      }

      detail.unshift(`verified ${chain.entries}-entry kernel-signed chain (logKind=${p.logKind})`);
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
