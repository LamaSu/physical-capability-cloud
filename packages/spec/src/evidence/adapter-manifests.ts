/**
 * Adapter + device-role DEFAULT emitter manifests — the supply-side DATA.
 *
 * One entry per adapter family present in packages/kernel/src/adapters/
 * (octoprint / ipp / opcua / sila / modbus / generic-http / mock) and per
 * evidence-only device ROLE (camera / sensor). Each declares, in the bounded
 * vocabulary, which primitives that adapter/role can EMIT. Auto-discovery reads
 * these to write structured `evidence.tierN.primitives[]` instead of free-text
 * `required[]`, turning an onboarded device from tier-0-capped into
 * eligible-by-default.
 *
 * These are DEFAULTS (adapter default → device confirm → operator adjust). They
 * are MATCHING artifacts — they never mint tier; the oracle verifies instances
 * at settlement (constraint D1). Adding a new adapter/role = adding a data entry
 * here, never changing code shape.
 *
 * Vocabulary coupling: entries reference primitive ids by STRING. Ids absent
 * from the live vocabulary (e.g. process-telemetry primitives still landing in a
 * parallel branch) are DROPPED by the builder until their entry ships, at which
 * point the derived tier rises with zero re-onboarding. So a forward-referenced
 * id is safe to list today and self-activates on merge.
 */

import { VOCAB_VERSION } from "./primitives.js";
import type { EvidenceEmitterManifest } from "./emitter-manifest.js";
import { buildEvidenceTiersFromEmits } from "./emitter-manifest.js";
import type { CsdEvidenceTier } from "../csd/schema.js";

/**
 * The "digital receipt core" shared by every Ed25519 kernel-signed connector.
 * receipt.kernel_signed is the earned tier-1; confirm.execution_mode kills the
 * mock-success class; ident.registered_key is the signing dependency;
 * artifact.hash is the integrity floor; decl.self_attested is the tier-0 floor.
 * This set is tier-1 eligible on its own.
 */
const DIGITAL_RECEIPT_CORE = [
  { id: "decl.self_attested" },
  { id: "ident.registered_key", via: "toKernelOutput" },
  { id: "receipt.kernel_signed", via: "toKernelOutput" },
  { id: "confirm.execution_mode", params: { expected: "real" } },
  { id: "artifact.hash", params: { mode: "plain" } },
] as const;

function adapterManifest(
  ref: string,
  emits: EvidenceEmitterManifest["emits"],
): EvidenceEmitterManifest {
  return { subject: { kind: "adapter", ref }, vocabVersion: VOCAB_VERSION, emits };
}

function deviceRoleManifest(
  ref: string,
  emits: EvidenceEmitterManifest["emits"],
): EvidenceEmitterManifest {
  return { subject: { kind: "device", ref }, vocabVersion: VOCAB_VERSION, emits };
}

/**
 * Default manifests keyed by adapterType. Every digital connector earns tier 1
 * from the receipt core; `mock` is deliberately tier-0-only (it cannot prove a
 * real execution — confirm.execution_mode gates mock at tier 0 anyway).
 */
export const ADAPTER_DEFAULT_MANIFESTS: Readonly<Record<string, EvidenceEmitterManifest>> = {
  // 3D printers via OctoPrint. The receipt core → tier 1 today; the forward
  // `telemetry.envelope_conformance` (a process-telemetry primitive landing in a
  // parallel branch) is dropped until it ships, then lifts envelope-checked runs.
  octoprint: adapterManifest("octoprint", [
    ...DIGITAL_RECEIPT_CORE,
    { id: "artifact.hash", bind: "outputArtifactCid", via: "gcode" },
    { id: "telemetry.envelope_conformance", via: "telemetry" },
  ]),

  // 2D printers via IPP.
  ipp: adapterManifest("ipp", [
    ...DIGITAL_RECEIPT_CORE,
    { id: "artifact.hash", bind: "outputDocumentCid", via: "print" },
  ]),

  // Industrial PLC / SCADA via OPC-UA (self-describing address space).
  opcua: adapterManifest("opcua", [
    ...DIGITAL_RECEIPT_CORE,
    { id: "telemetry.envelope_conformance", via: "opcua-node" },
  ]),

  // Lab automation via SiLA 2 (self-describing feature definitions).
  sila: adapterManifest("sila", [
    ...DIGITAL_RECEIPT_CORE,
    { id: "telemetry.envelope_conformance", via: "sila-feature" },
  ]),

  // PLC / fieldbus via Modbus.
  modbus: adapterManifest("modbus", [...DIGITAL_RECEIPT_CORE]),

  // Arbitrary external HTTP capability. Adds target-system confirmation via the
  // upstream's own channel (api) — a natural fit for HTTP-backed work.
  "generic-http": adapterManifest("generic-http", [
    { id: "decl.self_attested" },
    { id: "ident.registered_key", via: "toKernelOutput" },
    { id: "receipt.kernel_signed", via: "toKernelOutput" },
    { id: "confirm.execution_mode", params: { expected: "real" } },
    { id: "confirm.target_system", params: { channel: "api" }, via: "http-response" },
  ]),

  // Mock adapter — honestly tier-0 only. It cannot attest a real execution.
  mock: adapterManifest("mock", [{ id: "decl.self_attested" }]),
};

/**
 * Default manifests keyed by evidence-only device ROLE. Cameras and sensors have
 * no billable CSD of their own — this is exactly why the manifest attaches to
 * the DEVICE (design §2, Alt-C). They upgrade OTHER capabilities' tiers.
 */
export const DEVICE_ROLE_DEFAULT_MANIFESTS: Readonly<Record<string, EvidenceEmitterManifest>> = {
  // Camera peripheral → nonce-bound photo capture (CC1 in v1 auto-onboarding;
  // rises to CC2/tier-2 with an independent check + the human floor).
  camera: deviceRoleManifest("camera", [
    { id: "decl.self_attested" },
    { id: "artifact.hash", params: { mode: "plain" } },
    {
      id: "capture.photo_nonced",
      params: { media: "photo", minClass: "CC1" },
      bind: "capturePhotoCid",
      via: "captureSnapshot",
    },
  ]),

  // Generic sensor peripheral → hashed raw signal log (artifact.hash floor →
  // tier 1). Device-signed / metric-window primitives lift it further as they land.
  sensor: deviceRoleManifest("sensor", [
    { id: "decl.self_attested" },
    { id: "artifact.hash", params: { mode: "plain" }, bind: "sensorLogCid", via: "stopRecording" },
  ]),
};

/** Resolve an adapter's default emitter manifest. Undefined for unknown types. */
export function getAdapterManifest(adapterType: string): EvidenceEmitterManifest | undefined {
  return ADAPTER_DEFAULT_MANIFESTS[adapterType];
}

/** Resolve an evidence-only device role's default manifest. */
export function getDeviceRoleManifest(role: string): EvidenceEmitterManifest | undefined {
  return DEVICE_ROLE_DEFAULT_MANIFESTS[role];
}

export interface AdapterEvidence {
  /** The CSD `evidence` tier map to attach. */
  evidence: Record<string, CsdEvidenceTier>;
  /** True when derived from a known adapter manifest (structured primitives[]);
   *  false = the free-text tier-0 on-ramp for an undeclared adapter. */
  structured: boolean;
}

/**
 * Build the CSD `evidence` map for an adapter type at onboarding time.
 *
 * Known adapter → structured `primitives[]` (eligible at the adapter's natural
 * tier). Unknown/undeclared adapter → legacy free-text tier-0 only, which the
 * eligibility lint caps at tier 0 — the permissionless on-ramp, preserved.
 */
export function buildAdapterEvidence(adapterType: string): AdapterEvidence {
  const manifest = getAdapterManifest(adapterType);
  if (!manifest) {
    return {
      structured: false,
      evidence: {
        tier0: {
          description: "Self-attested completion (undeclared adapter — tier-0 on-ramp).",
          required: ["jobId", "timestamp"],
        },
      },
    };
  }
  return { structured: true, evidence: buildEvidenceTiersFromEmits(manifest.emits) };
}
