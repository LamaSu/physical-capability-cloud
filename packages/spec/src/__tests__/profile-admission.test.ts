/**
 * profileAdmitsBundle (LO-SE-2): does authenticated, bound evidence satisfy the
 * committed MeasurementProfile? Bundles here are real: production
 * hashEvent/hashBundle, an Ed25519 key signing signingPreimage(bundleHash), and
 * events that commit the job and kernel so LO-EV-9 binding genuinely passes.
 *
 * Round 2 answers the cross-family DO-NOT-SHIP on 29630a48 (pack 04): terms
 * are compared (F1), the presented set must open to the pinned set digest (F2),
 * samples are counted by sampleId (F3), and each version pin reads its own
 * field (F4). Evidence's rulings (bus #3419): value is a decimal string, and
 * the set digest binds the settlement unit.
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";

import {
  profileAdmitsBundle,
  computeBundleSetDigest,
  computeRegistryDigest,
  NON_NUMERIC_UNIT,
  PROFILE_OBSERVATION_FIELD,
  REGISTRY_SNAPSHOT_DOMAIN,
  type AdmissionBundle,
  type ProfileAdmissionInput,
  type ProfileAdmissionResult,
  type ProfileObservation,
  type SignerGrant,
} from "../evidence/profile-admission.js";
import {
  computeMeasurementProfileDigest,
  profileGoverns,
  type MeasurementProfileV1,
} from "../evidence/measurement-profile.js";
import { evidenceLevelOfBundles, evidenceLevelsOfEvents } from "../evidence/evidence-level.js";
import { sessionKeyDelegationPreimage, signingPreimage } from "../evidence/signing-preimage.js";
import { canonicalize, hashBundle, hashEvent, sha256 } from "../util/canonical.js";
import { verifyEvidenceSubjectBinding, type EvidenceSubject } from "../evidence/subject-binding.js";
import type { EvidenceEvent } from "../types/evidence.js";

const JOB = "job-admission-1";
const KERNEL = "kernel-admission-1";
const PRINTER = "dev-printer";
const CAMERA = "dev-camera";
const SCALE = "dev-scale";

const PRINTER_VERSION = "IppAdapter-1.0.0";
const CAMERA_VERSION = "PhotoCameraAdapter-1.0.0";
const SCALE_VERSION = "ScaleAdapter-1.0.0";

const DOCUMENT = { kind: "documentHash", value: "sha256:" + "b".repeat(64) };

const key = generateKeyPairSync("ed25519");
const T0 = Date.parse("2026-09-24T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** Per-device defaults for `source`, keyed by the device id (see the brief). */
function defaultSource(device: string): Record<string, unknown> {
  if (device === PRINTER) {
    return { deviceType: "controller", adapterType: "ipp", adapterVersion: PRINTER_VERSION, firmwareVersion: "printer-fw-7.3" };
  }
  if (device === SCALE) {
    return { deviceType: "instrument", adapterType: "scale", adapterVersion: SCALE_VERSION, firmwareVersion: "scale-fw-1.0" };
  }
  return { deviceType: "camera", adapterType: "photo", adapterVersion: CAMERA_VERSION, firmwareVersion: "cam-fw-2.1.0" };
}

/** Shallow-merge `override` over `base`; a key explicitly set to undefined is removed. */
function mergeDefined<T extends Record<string, unknown>>(base: T, override?: Record<string, unknown>): T {
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as T;
}

interface Draft {
  type: string;
  t: number;
  device: string;
  source?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  observation?: null | Partial<ProfileObservation>;
  simulated?: boolean;
  jobId?: string;
  kernelId?: string;
}

/** The default `profileObservation` record for one draft, against `profile`. */
function defaultObservation(profile: MeasurementProfileV1, d: Draft): ProfileObservation {
  const sampleId = "sha256:" + createHash("sha256").update(`${d.device}|${d.type}|${d.t}`).digest("hex");
  const obs: ProfileObservation = {
    profileDigest: computeMeasurementProfileDigest(profile),
    primitiveId: profile.interpretation.evidenceTypeIds[0]!,
    object: { ...profile.outcome.objectIdentity },
    method: profile.measurement.method,
    quantity: profile.measurement.quantity,
    unit: profile.measurement.unit,
    sampleId,
  };
  if (profile.measurement.unit !== NON_NUMERIC_UNIT) obs.value = "12.5";
  return obs;
}

async function toEvent(d: Draft): Promise<EvidenceEvent> {
  const source = mergeDefined({ deviceId: d.device, kernelId: d.kernelId ?? KERNEL, ...defaultSource(d.device) }, d.source);
  if (d.simulated) (source as Record<string, unknown>).simulated = true;
  const payload = { jobId: d.jobId ?? JOB, ...(d.payload ?? {}) };
  const unsigned = { type: d.type, timestamp: at(d.t), source, payload };
  const hash = await hashEvent(unsigned as unknown as Omit<EvidenceEvent, "hash" | "id">);
  return { ...unsigned, id: `${d.type}-${d.t}-${d.device}`, hash } as unknown as EvidenceEvent;
}

/** Attaches `payload.profileObservation` to every draft unless it says `observation: null`. */
// Two operators with registered keys: A runs the job (the deal assigns it), B is an independent
// inspector. evidence-level.ts judges independence between their trust domains (#345), so an
// inspection is inspected_output only from B's bundle.
const OPERATOR_A = `eip155:84532:0x${"aa".repeat(20)}`;
const OPERATOR_B = `eip155:84532:0x${"bb".repeat(20)}`;
const keyB = generateKeyPairSync("ed25519");
/** A key's raw 32 bytes as 0x + lowercase hex: the last 32 bytes of its SPKI DER. */
const rawKey = (k: ReturnType<typeof generateKeyPairSync>) => `0x${(k.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12).toString("hex")}`;
const KEY_A = rawKey(key);
const KEY_B = rawKey(keyB);
/** Each key's signer id, as kernels declare it: 0x and the key's first 40 hex digits. */
const SIGNER_A = KEY_A.slice(0, 42);
const SIGNER_B = KEY_B.slice(0, 42);
const KEYS: Record<string, ReturnType<typeof generateKeyPairSync>> = { [SIGNER_A]: key, [SIGNER_B]: keyB };
const DOMAINS: Record<string, string> = { [SIGNER_A]: OPERATOR_A, [SIGNER_B]: OPERATOR_B };

async function toBundle(drafts: Draft[], profile: MeasurementProfileV1, signer: string = SIGNER_A): Promise<AdmissionBundle> {
  const events = await Promise.all(
    drafts.map((d) => {
      if (d.observation === null) return toEvent(d);
      const merged = mergeDefined(
        defaultObservation(profile, d) as unknown as Record<string, unknown>,
        d.observation as Record<string, unknown> | undefined,
      );
      return toEvent({ ...d, payload: { ...(d.payload ?? {}), [PROFILE_OBSERVATION_FIELD]: merged } });
    }),
  );
  const bundleHash = await hashBundle(events);
  const value = sign(null, signingPreimage(bundleHash), KEYS[signer]!.privateKey).toString("hex");
  return { bundleHash, events, kernelSignature: { signer, algorithm: "ed25519", value } };
}

/** The pilot world: the printer's events in operator A's bundle, the camera's and scale's in independent operator B's. */
async function toBundles(drafts: Draft[], profile: MeasurementProfileV1): Promise<AdmissionBundle[]> {
  const executor = drafts.filter((d) => d.device === PRINTER);
  const inspector = drafts.filter((d) => d.device !== PRINTER);
  const out: AdmissionBundle[] = [];
  if (executor.length > 0) out.push(await toBundle(executor, profile, SIGNER_A));
  if (inspector.length > 0) out.push(await toBundle(inspector, profile, SIGNER_B));
  return out;
}

/**
 * The pinned registry snapshot (astra packs 271, 275, 281): each registered key, the operator that owns it, and
 * its grants. A is the executor of KERNEL (the kernel's own key); B is an independent witness for KERNEL.
 */
const REGISTRY = [
  { publicKey: KEY_A, trustDomain: DOMAINS[SIGNER_A]!, grants: [{ role: "executor" as const, kernelId: KERNEL }] },
  { publicKey: KEY_B, trustDomain: DOMAINS[SIGNER_B]!, grants: [{ role: "witness" as const, kernelId: KERNEL }] },
];
const REGISTRY_PIN = await computeRegistryDigest(REGISTRY);
/** The pin for `rows`, or a well-formed stand-in when admission is to refuse the rows themselves. */
async function pinOf(rows: unknown): Promise<string> {
  try {
    return await computeRegistryDigest(rows as ProfileAdmissionInput["registryKeys"]);
  } catch {
    return "sha256:" + "0".repeat(64);
  }
}

/**
 * A session key `root` delegates (LO-EV-1), as kernel-sdk makes one: its row key, its signer id, and the
 * authorization as kernel-sdk sends it (`publicKey` and `parentSignature` as bare hex). Its key pair joins KEYS, so
 * toBundle can sign with it. By default it is valid from a minute before the pilot to an hour after, for JOB.
 */
function delegate(
  root: ReturnType<typeof generateKeyPairSync>,
  over: { pair?: ReturnType<typeof generateKeyPairSync>; contractIds?: string[]; allowedActions?: string[]; issuedAt?: number; expiresAt?: number } = {},
) {
  const pair = over.pair ?? generateKeyPairSync("ed25519");
  const raw = rawKey(pair);
  const body = {
    sessionId: "session-0001",
    parentAgentId: "eip155:84532:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:7",
    publicKey: Buffer.from(raw.slice(2), "hex"),
    issuedAt: over.issuedAt ?? Math.floor(T0 / 1000) - 60,
    expiresAt: over.expiresAt ?? Math.floor(T0 / 1000) + 3600,
    scope: { allowedActions: over.allowedActions ?? ["evidence_submit"], contractIds: over.contractIds ?? [JOB], maxSignatures: 1000 },
  };
  const parentSignature = sign(null, sessionKeyDelegationPreimage(body as never), root.privateKey).toString("hex");
  const signer = raw.slice(0, 42);
  KEYS[signer] = pair;
  return { pair, raw, signer, authorization: { ...body, publicKey: raw.slice(2), parentSignature } };
}
/** The registry row of a delegated session key: its key, its root's key, and the root's delegation as received. */
const sessionRow = (session: ReturnType<typeof delegate>, root: string = KEY_A) => ({ publicKey: session.raw, delegatedBy: root, authorization: session.authorization });
const EXECUTOR_GRANTS: SignerGrant[] = [{ role: "executor", kernelId: KERNEL }];

/** printer execution_started t0, execution_completed t10, camera inspects (passed) at t20. */
const PILOT: Draft[] = [
  { type: "execution_started", t: 0, device: PRINTER },
  { type: "execution_completed", t: 10, device: PRINTER },
  { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true } },
];

/** printer runs the job; the scale weighs the result. */
const MASS_PILOT: Draft[] = [
  { type: "execution_started", t: 0, device: PRINTER },
  { type: "execution_completed", t: 10, device: PRINTER },
  { type: "instrument_result", t: 20, device: SCALE, payload: { pass: true } },
];

function inspectedPageProfile(): MeasurementProfileV1 {
  return {
    profileVersion: 1,
    profileId: "pcc://profiles/test/inspected-page/v1",
    outcome: {
      capabilityType: "document-printing",
      statement: "The page was printed and a separate camera inspected it.",
      objectIdentity: DOCUMENT,
    },
    device: {
      deviceId: CAMERA,
      kind: "camera",
      adapterType: "photo",
      permittedAdapterVersions: [CAMERA_VERSION],
      permittedFirmwareVersions: ["cam-fw-2.1.0"],
    },
    measurement: { method: "optical-capture", quantity: "printed-page-image", unit: "none", sampling: { minSamples: 1 } },
    capture: { startCondition: "execution_completed", endCondition: "open", coverage: { policy: "one-shot", minFraction: 1 } },
    calibration: { required: false },
    interpretation: { evidenceTypeIds: ["capture.photo_nonced"], acceptanceLevel: "inspected_output", onDeviceFailure: "reject" },
    simulationProhibited: true,
    witnesses: { requiredRoles: [], independentOfClaimant: false },
    onMissingData: "reject",
    onContradiction: "reject",
  };
}

function deviceReportedProfile(): MeasurementProfileV1 {
  const p = inspectedPageProfile();
  p.device = { deviceId: PRINTER, kind: "controller", adapterType: "ipp", permittedAdapterVersions: [PRINTER_VERSION], permittedFirmwareVersions: ["printer-fw-7.3"] };
  p.capture = { ...p.capture, startCondition: "execution_started" };
  p.interpretation = { ...p.interpretation, acceptanceLevel: "device_reported", evidenceTypeIds: ["receipt.kernel_signed"] };
  return p;
}

function massProfile(): MeasurementProfileV1 {
  const p = inspectedPageProfile();
  p.device = { deviceId: SCALE, kind: "instrument", adapterType: "scale", permittedAdapterVersions: [SCALE_VERSION], permittedFirmwareVersions: ["scale-fw-1.0"] };
  p.measurement = { method: "load-cell", quantity: "mass", unit: "kg", sampling: { minSamples: 1 } };
  p.interpretation = { ...p.interpretation, evidenceTypeIds: ["artifact.hash"] };
  return p;
}

async function admit(
  profile: MeasurementProfileV1,
  bundles: AdmissionBundle[],
  over: Partial<ProfileAdmissionInput> = {},
): Promise<ProfileAdmissionResult> {
  const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
  // The caller pinned exactly these bundles.
  const pinnedBundleSetDigest =
    bundles.length > 0 ? await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)) : ("sha256:" + "0".repeat(64));
  return profileAdmitsBundle({
    profile,
    committedDigest: computeMeasurementProfileDigest(profile),
    subject,
    bundles,
    pinnedBundleSetDigest,
    registryKeys: REGISTRY,
    pinnedRegistryDigest: over.registryKeys !== undefined ? await pinOf(over.registryKeys) : REGISTRY_PIN,
    executorTrustDomains: [OPERATOR_A],
    verifyPrimitiveInstance: () => true,
    ...over,
  });
}

const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe("profile admission — admits evidence that satisfies the committed profile", () => {
  it("admits the pilot: printer completes, a separate camera inspects after completion", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT, p));
    expect(r).toMatchObject({ decision: "admit", admits: true, reached: "inspected_output", qualifyingSamples: 1, reasons: [] });
  });

  it("admits a device_reported profile on the printer's own completion", async () => {
    const p = deviceReportedProfile();
    const r = await admit(p, await toBundles(PILOT, p));
    expect(r.decision).toBe("admit");
  });

  it("admits the mass profile: the scale's positive-control reading (decimal-string value)", async () => {
    const p = massProfile();
    const r = await admit(p, await toBundles(MASS_PILOT, p));
    expect(r).toMatchObject({ decision: "admit", qualifyingSamples: 1 });
  });

  it("judges independence by trust domain across several bundles of the same job (#345's rule)", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, [await toBundle(PILOT.slice(0, 2), p), await toBundle(PILOT.slice(2), p, SIGNER_B)]);
    expect(r.decision).toBe("admit");
  });

  it("an inspection in the assigned executor's own trust domain is not independent: device_reported, never inspected_output", async () => {
    const p = inspectedPageProfile();
    // One bundle, signed by operator A, whom the deal assigned: its camera is the executor's own.
    const r = await admit(p, [await toBundle(PILOT, p)]);
    expect(r).toMatchObject({ decision: "reject", reached: "device_reported" });
    expect(codes(r)).toEqual(["level-not-reached"]);
    // So is an independent operator's camera when the deal names no executor: independence cannot be shown.
    const unassigned = await admit(p, await toBundles(PILOT, p), { executorTrustDomains: [] });
    expect(unassigned).toMatchObject({ decision: "reject", reached: "device_reported" });
  });
});

describe("profile admission — trust domains (#345's one rule, steward #6478)", () => {
  it("an event present in two bundles counts at the MAX over its occurrences, as #345 does: the independent inspector's copy lifts it (steward #6623)", async () => {
    const p = inspectedPageProfile();
    // The camera's inspection in operator B's bundle (independent) AND in operator A's own (the executor's).
    const both = [await toBundle(PILOT, p, SIGNER_A), await toBundle(PILOT.slice(2), p, SIGNER_B)];
    expect(both[0]!.events[2]!.hash).toBe(both[1]!.events[0]!.hash);
    const r = await admit(p, both);
    expect(r).toMatchObject({ decision: "admit", reached: "inspected_output", qualifyingSamples: 1 });
    // With only the executor's copy, nothing independent attests it: device_reported.
    const ownOnly = await admit(p, [await toBundle(PILOT, p, SIGNER_A)]);
    expect(ownOnly).toMatchObject({ decision: "reject", reached: "device_reported" });
  });

  it("on duplicates, admission's levels are #345's: reached is evidenceLevelOfBundles, and the counted level is the max of evidenceLevelsOfEvents", async () => {
    const p = inspectedPageProfile();
    const both = [await toBundle(PILOT, p, SIGNER_A), await toBundle(PILOT.slice(2), p, SIGNER_B)];
    const authenticated = [
      { events: both[0]!.events as EvidenceEvent[], trustDomain: OPERATOR_A },
      { events: both[1]!.events as EvidenceEvent[], trustDomain: OPERATOR_B },
    ];
    const context = { executorTrustDomains: [OPERATOR_A] };
    const r = await admit(p, both);
    expect(r.reached).toBe(evidenceLevelOfBundles(authenticated, context));
    // The camera's inspection: one occurrence per bundle, and admission counted it at their maximum.
    const cameraHash = both[1]!.events[0]!.hash;
    const levels = evidenceLevelsOfEvents(authenticated, context).filter((l) => authenticated[l.bundleIndex]!.events[l.eventIndex]!.hash === cameraHash);
    expect(levels.map((l) => l.level)).toEqual(["device_reported", "inspected_output"]);
    expect(r.qualifyingSamples).toBe(1);
  });

  it("each signature is verified HERE, under the key its declared signer names in the pinned registry (astra packs 271, 275)", async () => {
    const p = inspectedPageProfile();
    const [printer, camera] = await toBundles(PILOT, p);
    const resign = (b: AdmissionBundle, change: Record<string, unknown>): AdmissionBundle => ({
      ...b,
      kernelSignature: { ...(b.kernelSignature as Record<string, unknown>), ...change },
    });
    // A bundle signed by B's key that declares A's signer id: it does not verify under A's key.
    const byB = await toBundle(PILOT.slice(0, 2), p, SIGNER_B);
    const cases: Array<[string, AdmissionBundle]> = [
      ["signed by another registered key than the one it declares", resign(byB, { signer: SIGNER_A })],
      ["declaring a signer id no registry key has", resign(printer!, { signer: `0x${"9".repeat(40)}` })],
      ["another algorithm", resign(printer!, { algorithm: "secp256k1" })],
      ["a signature that does not parse", resign(printer!, { value: "not-hex" })],
      ["a signature over another digest", resign(printer!, { value: (camera!.kernelSignature as { value: string }).value })],
    ];
    for (const [label, bad] of cases) {
      const r = await admit(p, [bad, camera!]);
      expect(codes(r), label).toEqual(["unauthenticated-bundle"]);
    }
    // The honest pair admits.
    expect((await admit(p, [printer!, camera!])).decision).toBe("admit");
  });

  it("astra pack 275: one key under two signer ids. The camera's bundle, signed by A's key but declaring B's id, does not verify under B's key", async () => {
    const p = inspectedPageProfile();
    const printer = await toBundle(PILOT.slice(0, 2), p, SIGNER_A);
    const cameraByA = await toBundle(PILOT.slice(2), p, SIGNER_A);
    const alias = { ...cameraByA, kernelSignature: { ...(cameraByA.kernelSignature as Record<string, unknown>), signer: SIGNER_B } };
    const r = await admit(p, [printer, alias]);
    expect(codes(r)).toEqual(["unauthenticated-bundle"]);
    expect(r.reached).not.toBe("inspected_output");
  });

  it("one key signing both bundles (one signer id) has ONE domain, the executor's: the camera is not independent (astra pack 271)", async () => {
    const p = inspectedPageProfile();
    const sameKey = [await toBundle(PILOT.slice(0, 2), p, SIGNER_A), await toBundle(PILOT.slice(2), p, SIGNER_A)];
    const r = await admit(p, sameKey);
    expect(r).toMatchObject({ decision: "reject", reached: "device_reported" });
    expect(codes(r)).toEqual(["level-not-reached"]);
  });

  it("a registry key that names no operator (null) authenticates, but no inspection can then be independent", async () => {
    const p = inspectedPageProfile();
    const unknown = REGISTRY.map((row) => ({ ...row, trustDomain: null }));
    const r = await admit(p, await toBundles(PILOT, p), { registryKeys: unknown });
    expect(r).toMatchObject({ decision: "reject", reached: "device_reported" });
    expect(codes(r)).toEqual(["level-not-reached"]);
    // A device_reported profile does not need independence.
    expect((await admit(deviceReportedProfile(), await toBundles(PILOT, deviceReportedProfile()), { registryKeys: unknown })).decision).toBe("admit");
  });

  it("the registry is the PINNED one: rows that do not digest to the pin (a key reassigned after it) are refused; a malformed pin rejects; row order is not committed", async () => {
    const p = inspectedPageProfile();
    const bundles = await toBundles(PILOT, p);
    // After the pin, B's key is reassigned to the executor A: the rows are no longer the pinned registry.
    const rotated = [REGISTRY[0]!, { ...REGISTRY[1]!, trustDomain: OPERATOR_A }];
    expect(codes(await admit(p, bundles, { registryKeys: rotated, pinnedRegistryDigest: REGISTRY_PIN }))).toEqual(["registry-mismatch"]);
    // A grant changed after the pin is not the pinned registry either (astra pack 281).
    const regranted = [REGISTRY[0]!, { ...REGISTRY[1]!, grants: [{ role: "witness" as const, kernelId: KERNEL, jobId: JOB }] }];
    expect(codes(await admit(p, bundles, { registryKeys: regranted, pinnedRegistryDigest: REGISTRY_PIN }))).toEqual(["registry-mismatch"]);
    // Pinned with the rotation, it is that registry, and the camera is the executor's own.
    expect(await admit(p, bundles, { registryKeys: rotated })).toMatchObject({ decision: "reject", reached: "device_reported" });
    expect(codes(await admit(p, bundles, { pinnedRegistryDigest: "0x" + "a".repeat(64) }))).toEqual(["registry-pin-invalid"]);
    expect((await admit(p, bundles, { registryKeys: [...REGISTRY].reverse(), pinnedRegistryDigest: REGISTRY_PIN })).decision).toBe("admit");
  });

  it("the registry is data, one row per key: a key twice (even with one domain), another spelling of a key, colliding signer ids, or a malformed row or grant is refused", async () => {
    const p = inspectedPageProfile();
    const bundles = await toBundles(PILOT, p);
    const G = EXECUTOR_GRANTS;
    const accessorRow = { publicKey: KEY_A, grants: G };
    Object.defineProperty(accessorRow, "trustDomain", { get: () => OPERATOR_A, enumerable: true });
    // Two keys that share their first 20 bytes, so one signer id: a declared signer would not name one key.
    const collideA = `0x${"ab".repeat(20)}${"00".repeat(12)}`;
    const collideB = `0x${"ab".repeat(20)}${"11".repeat(12)}`;
    // Each case and the reason it must be refused for, so none passes on another case's defect.
    const registries: Array<[unknown, RegExp]> = [
      [undefined, /must be a list/],
      [{}, /must be a list/],
      [[{ publicKey: "not-a-key", trustDomain: OPERATOR_A, grants: G }], /0x<64 lowercase hex>/],
      [[{ publicKey: KEY_A, grants: G }], /trustDomain: an operator principal id or null/],
      [[{ publicKey: KEY_A, trustDomain: "not-a-principal", grants: G }], /trustDomain: an operator principal id or null/],
      [[{ publicKey: `0x${KEY_A.slice(2).toUpperCase()}`, trustDomain: OPERATOR_A, grants: G }, REGISTRY[1]], /0x<64 lowercase hex>/],
      [[...REGISTRY, { publicKey: KEY_A, trustDomain: OPERATOR_B, grants: G }], /twice/],
      [[...REGISTRY, { publicKey: KEY_A, trustDomain: OPERATOR_A, grants: G }], /twice/],
      [[...REGISTRY, { publicKey: collideA, trustDomain: null, grants: G }, { publicKey: collideB, trustDomain: null, grants: G }], /signer id/],
      [[accessorRow, REGISTRY[1]], /no code supplied with the data may run/],
      // Grants (astra pack 281): a non-empty list of { role, kernelId, jobId? }, none twice, and nothing else on the row.
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: [] }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: [{ role: "owner", kernelId: KERNEL }] }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: [{ role: "executor", kernelId: "" }] }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: [{ role: "executor", kernelId: KERNEL, jobId: "" }] }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: [{ role: "executor", kernelId: KERNEL, jobId: null }] }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: [{ role: "executor", kernelId: KERNEL, unit: "u" }] }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: [...G, ...G] }, REGISTRY[1]], /none twice/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: G, note: "x" }, REGISTRY[1]], /grants: a non-empty list/],
      [[{ publicKey: KEY_A, trustDomain: OPERATOR_A, grants: G, delegatedBy: KEY_B }, REGISTRY[1]], /delegatedBy: a registered key/],
    ];
    for (const [registry, why] of registries) {
      const r = await admit(p, bundles, { registryKeys: registry as ProfileAdmissionInput["registryKeys"], pinnedRegistryDigest: REGISTRY_PIN });
      expect(codes(r), JSON.stringify(registry)).toEqual(["input-unreadable"]);
      expect(r.reasons[0]!.detail, JSON.stringify(registry)).toMatch(why);
    }
  });

  it("registryKeys is walked for code with the other data: an accessor row is refused as code, and its getter never runs", async () => {
    const p = inspectedPageProfile();
    let runs = 0;
    const row = { publicKey: KEY_A, grants: EXECUTOR_GRANTS };
    Object.defineProperty(row, "trustDomain", { get: () => (runs++, OPERATOR_A), enumerable: true });
    const r = await admit(p, await toBundles(PILOT, p), { registryKeys: [row as { publicKey: string; trustDomain: string }, REGISTRY[1]!], pinnedRegistryDigest: REGISTRY_PIN });
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(r.reasons[0]!.detail).toMatch(/no code supplied with the data may run/);
    expect(runs).toBe(0);
  });

  it("computeRegistryDigest commits to the rows and their grants, not their order, and refuses what admission refuses", async () => {
    expect(await computeRegistryDigest([...REGISTRY].reverse())).toBe(REGISTRY_PIN);
    expect(await computeRegistryDigest([REGISTRY[0]!, { ...REGISTRY[1]!, trustDomain: null }])).not.toBe(REGISTRY_PIN);
    await expect(computeRegistryDigest([...REGISTRY, REGISTRY[0]!])).rejects.toThrow("twice");
    await expect(computeRegistryDigest([{ publicKey: "0x00", trustDomain: null, grants: EXECUTOR_GRANTS }])).rejects.toThrow("must be");
    // Byte-identical to its definition: rows sorted by key, each registered row's grants sorted, under the v2 domain.
    const two: SignerGrant[] = [{ role: "witness", kernelId: "kernel-z" }, { role: "executor", kernelId: KERNEL, jobId: JOB }];
    const rows = [{ ...REGISTRY[1]!, grants: two }, REGISTRY[0]!];
    const sortedGrants = [two[1]!, two[0]!];
    const keys = [REGISTRY[0]!, { ...REGISTRY[1]!, grants: sortedGrants }].sort((a, b) => (a.publicKey < b.publicKey ? -1 : 1));
    expect(REGISTRY_SNAPSHOT_DOMAIN).toBe("PCC:evidence-registry-snapshot:v2");
    expect(await computeRegistryDigest(rows)).toBe(await sha256(canonicalize({ domain: REGISTRY_SNAPSHOT_DOMAIN, keys })));
    expect(await computeRegistryDigest([{ ...REGISTRY[1]!, grants: [...two].reverse() }, REGISTRY[0]!])).toBe(await computeRegistryDigest(rows));
    // A delegation is committed as received.
    const session = delegate(key);
    const withSession = [...REGISTRY, sessionRow(session)];
    const sessionKeys = [...keys.map((k) => (k.publicKey === KEY_B ? REGISTRY[1]! : k)), { publicKey: session.raw, delegatedBy: KEY_A, authorization: session.authorization }].sort((a, b) =>
      a.publicKey < b.publicKey ? -1 : 1,
    );
    expect(await computeRegistryDigest(withSession)).toBe(await sha256(canonicalize({ domain: REGISTRY_SNAPSHOT_DOMAIN, keys: sessionKeys })));
  });

  it("executorTrustDomains must be a list of operator principal ids, from the deal: absent or malformed rejects", async () => {
    const p = inspectedPageProfile();
    const bundles = await toBundles(PILOT, p);
    for (const executors of [undefined, OPERATOR_A, [OPERATOR_A, "not-a-principal"], [7], [OPERATOR_A.toUpperCase()]]) {
      const r = await admit(p, bundles, { executorTrustDomains: executors as unknown as string[] });
      expect(codes(r), JSON.stringify(executors)).toEqual(["input-unreadable"]);
    }
    const accessor: string[] = [];
    Object.defineProperty(accessor, 0, { get: () => OPERATOR_A, enumerable: true });
    expect(codes(await admit(p, bundles, { executorTrustDomains: accessor }))).toEqual(["input-unreadable"]);
  });

  it("the inspector's operator assigned as an executor is not independent of itself", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT, p), { executorTrustDomains: [OPERATOR_A, OPERATOR_B] });
    expect(r).toMatchObject({ decision: "reject", reached: "device_reported" });
  });

  it("a completion in the executor's bundle and a failed inspection in the inspector's contradict across trust domains", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles([...PILOT.slice(0, 2), { ...PILOT[2]!, payload: { passed: false } }], p));
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
  });
});

describe("profile admission — a signature authorizes only what its key's grant names (astra pack 281, DECISIONS 00:26)", () => {
  it("astra 281's reproduction: B, registered as a witness, signs the printer's execution events for KERNEL and declares B. Refused, never admitted", async () => {
    const p = deviceReportedProfile();
    const r = await admit(p, [await toBundle(PILOT.slice(0, 2), p, SIGNER_B)]);
    expect(r).toMatchObject({ decision: "reject", admits: false, reached: null, qualifyingSamples: 0 });
    expect(codes(r)).toEqual(["unauthorized-signer"]);
    expect(r.reasons[0]!.detail).toMatch(/is a witness for this subject, which signs inspections only, not execution_started/);
  });

  it("a registered key with no grant for the subject's kernel authorizes nothing: B signs, declares B and is registered, and is refused", async () => {
    const p = deviceReportedProfile();
    // B is the executor of another kernel: a valid signature by a registered key, for the wrong subject.
    const elsewhere = [REGISTRY[0]!, { ...REGISTRY[1]!, grants: [{ role: "executor" as const, kernelId: "kernel-other" }] }];
    const r = await admit(p, [await toBundle(PILOT.slice(0, 2), p, SIGNER_B)], { registryKeys: elsewhere });
    expect(codes(r)).toEqual(["unauthorized-signer"]);
    expect(r.reasons[0]!.detail).toMatch(/holds no grant for kernel kernel-admission-1, job job-admission-1: registry membership alone authorizes nothing/);
    // A witness for another kernel cannot inspect this one either.
    const q = inspectedPageProfile();
    const witnessElsewhere = [REGISTRY[0]!, { ...REGISTRY[1]!, grants: [{ role: "witness" as const, kernelId: "kernel-other" }] }];
    expect(codes(await admit(q, await toBundles(PILOT, q), { registryKeys: witnessElsewhere }))).toEqual(["unauthorized-signer"]);
  });

  it("an explicitly authorized independent inspector is admitted: a witness for the kernel, or for this one job; a witness for another job is not", async () => {
    const p = inspectedPageProfile();
    const bundles = await toBundles(PILOT, p);
    expect(await admit(p, bundles)).toMatchObject({ decision: "admit", reached: "inspected_output", qualifyingSamples: 1 });
    const forTheJob = [REGISTRY[0]!, { ...REGISTRY[1]!, grants: [{ role: "witness" as const, kernelId: KERNEL, jobId: JOB }] }];
    expect(await admit(p, bundles, { registryKeys: forTheJob })).toMatchObject({ decision: "admit", reached: "inspected_output" });
    const forAnotherJob = [REGISTRY[0]!, { ...REGISTRY[1]!, grants: [{ role: "witness" as const, kernelId: KERNEL, jobId: "job-other" }] }];
    expect(codes(await admit(p, bundles, { registryKeys: forAnotherJob }))).toEqual(["unauthorized-signer"]);
  });

  it("the executor's grant must name the subject's kernel, and its job when it names one; one grant that names the subject is enough", async () => {
    const p = deviceReportedProfile();
    const printer = [await toBundle(PILOT.slice(0, 2), p, SIGNER_A)];
    const withA = (grants: SignerGrant[]) => [{ ...REGISTRY[0]!, grants }, REGISTRY[1]!];
    expect((await admit(p, printer, { registryKeys: withA([{ role: "executor", kernelId: KERNEL, jobId: JOB }]) })).decision).toBe("admit");
    expect(codes(await admit(p, printer, { registryKeys: withA([{ role: "executor", kernelId: "kernel-other" }]) }))).toEqual(["unauthorized-signer"]);
    expect(codes(await admit(p, printer, { registryKeys: withA([{ role: "executor", kernelId: KERNEL, jobId: "job-other" }]) }))).toEqual(["unauthorized-signer"]);
    // The kernel's own key granted only as a witness may not sign the kernel's execution.
    expect(codes(await admit(p, printer, { registryKeys: withA([{ role: "witness", kernelId: KERNEL }]) }))).toEqual(["unauthorized-signer"]);
    const several: SignerGrant[] = [{ role: "witness", kernelId: "kernel-other" }, { role: "executor", kernelId: KERNEL }];
    expect((await admit(p, printer, { registryKeys: withA(several) })).decision).toBe("admit");
  });

  it("a witness signs inspections only: its bundle holding the kernel's completion beside the inspection is refused", async () => {
    const p = inspectedPageProfile();
    const witnessed = [await toBundle(PILOT.slice(0, 2), p, SIGNER_A), await toBundle(PILOT.slice(1), p, SIGNER_B)];
    const r = await admit(p, witnessed);
    expect(codes(r)).toEqual(["unauthorized-signer"]);
    expect(r.reasons[0]!.detail).toMatch(/signs inspections only, not execution_completed/);
  });

  it("a session key counts through a delegation rooted in a registered row and committed in the same pin; it holds its root's grant and domain", async () => {
    const p = inspectedPageProfile();
    const session = delegate(key);
    const registry = [...REGISTRY, sessionRow(session)];
    const bundles = [await toBundle(PILOT.slice(0, 2), p, session.signer), await toBundle(PILOT.slice(2), p, SIGNER_B)];
    expect(await admit(p, bundles, { registryKeys: registry })).toMatchObject({ decision: "admit", reached: "inspected_output" });
    // Its domain is its root's (A, the executor's): signing the camera's inspection makes it the executor's own.
    const own = [await toBundle(PILOT.slice(0, 2), p, SIGNER_A), await toBundle(PILOT.slice(2), p, session.signer)];
    expect(await admit(p, own, { registryKeys: registry })).toMatchObject({ decision: "reject", reached: "device_reported" });
    // Only the pinned rows' delegations count: left out of them, the session key names no registry key.
    expect(codes(await admit(p, bundles))).toEqual(["unauthenticated-bundle"]);
  });

  it("a delegation outside its root's subjects is refused: another job in its scope, a root granted for another kernel, events outside its window", async () => {
    const p = inspectedPageProfile();
    const camera = await toBundle(PILOT.slice(2), p, SIGNER_B);
    const run = async (session: ReturnType<typeof delegate>, registry: unknown[]) =>
      admit(p, [await toBundle(PILOT.slice(0, 2), p, session.signer), camera], { registryKeys: registry as ProfileAdmissionInput["registryKeys"] });
    const otherJob = delegate(key, { contractIds: ["job-other"] });
    const r1 = await run(otherJob, [...REGISTRY, sessionRow(otherJob)]);
    expect(codes(r1)).toEqual(["unauthorized-signer"]);
    expect(r1.reasons[0]!.detail).toMatch(/is delegated for job\(s\) job-other, not job job-admission-1/);
    const rootElsewhere = delegate(key);
    const elsewhere = [{ ...REGISTRY[0]!, grants: [{ role: "executor" as const, kernelId: "kernel-other" }] }, REGISTRY[1]!, sessionRow(rootElsewhere)];
    expect(codes(await run(rootElsewhere, elsewhere))).toEqual(["unauthorized-signer"]);
    // The pilot's events run from T0 to T0+20s: a delegation that expired at T0+5s, or was issued then, does not cover them.
    const expired = delegate(key, { expiresAt: Math.floor(T0 / 1000) + 5 });
    const r2 = await run(expired, [...REGISTRY, sessionRow(expired)]);
    expect(codes(r2)).toEqual(["unauthorized-signer"]);
    expect(r2.reasons[0]!.detail).toMatch(/outside its delegation's window/);
    const late = delegate(key, { issuedAt: Math.floor(T0 / 1000) + 5 });
    expect(codes(await run(late, [...REGISTRY, sessionRow(late)]))).toEqual(["unauthorized-signer"]);
    // The window's ends are inclusive, in whole seconds: issued at T0 and expiring at T0+10 covers the printer's events.
    const exact = delegate(key, { issuedAt: Math.floor(T0 / 1000), expiresAt: Math.floor(T0 / 1000) + 10 });
    expect((await run(exact, [...REGISTRY, sessionRow(exact)])).decision).toBe("admit");
  });

  it("a delegation the registry cannot vouch for refuses the registry: another signer than its root, a root that is not a registered row, another key, no evidence_submit, no job, a reversed window, a malformed authorization", async () => {
    const p = inspectedPageProfile();
    const bundles = await toBundles(PILOT, p);
    const s = delegate(key);
    const other = delegate(key);
    const { sessionId: _sessionId, ...noSessionId } = s.authorization;
    const cases: Array<[string, unknown[], RegExp]> = [
      ["signed by B, naming A as its root", [...REGISTRY, sessionRow(delegate(keyB))], /is not signed by its root key/],
      ["a root that is not in the snapshot", [...REGISTRY, sessionRow(s, `0x${"cd".repeat(32)}`)], /is not a registered row of this snapshot/],
      ["a session key as the root", [...REGISTRY, sessionRow(s), sessionRow(delegate(key), s.raw)], /is not a registered row of this snapshot/],
      ["the authorization of another key", [...REGISTRY, { ...sessionRow(s), authorization: other.authorization }], /delegates another key than its row's/],
      ["no evidence_submit", [...REGISTRY, sessionRow(delegate(key, { allowedActions: ["heartbeat"] }))], /does not allow evidence_submit/],
      ["no job: an empty scope", [...REGISTRY, sessionRow(delegate(key, { contractIds: [] }))], /names no job/],
      ["expiring before it is issued", [...REGISTRY, sessionRow(delegate(key, { issuedAt: 200, expiresAt: 100 }))], /expires before it is issued/],
      ["no sessionId", [...REGISTRY, { ...sessionRow(s), authorization: noSessionId }], /not a well-formed session key authorization/],
      ["an empty derivation path", [...REGISTRY, { ...sessionRow(s), authorization: { ...s.authorization, derivationPath: "" } }], /not a well-formed session key authorization/],
      ["a field the wire form does not have", [...REGISTRY, { ...sessionRow(s), authorization: { ...s.authorization, extra: 1 } }], /the LO-EV-1 wire form/],
      ["a scope field the wire form does not have", [...REGISTRY, { ...sessionRow(s), authorization: { ...s.authorization, scope: { ...s.authorization.scope, extra: 1 } } }], /the LO-EV-1 wire form/],
      ["a row with a domain beside its root", [...REGISTRY, { ...sessionRow(s), trustDomain: OPERATOR_B }], /delegatedBy: a registered key/],
    ];
    for (const [label, registry, why] of cases) {
      const r = await admit(p, bundles, { registryKeys: registry as ProfileAdmissionInput["registryKeys"], pinnedRegistryDigest: REGISTRY_PIN });
      expect(codes(r), label).toEqual(["input-unreadable"]);
      expect(r.reasons[0]!.detail, label).toMatch(why);
      await expect(computeRegistryDigest(registry as ProfileAdmissionInput["registryKeys"]), label).rejects.toThrow();
    }
  });

  it("the pin commits each delegation: the same session key re-delegated with a wider scope after the pin is not the pinned registry", async () => {
    const p = inspectedPageProfile();
    const session = delegate(key);
    const pinned = [...REGISTRY, sessionRow(session)];
    const pin = await computeRegistryDigest(pinned);
    const widened = delegate(key, { pair: session.pair, contractIds: [JOB, "job-other"] });
    const bundles = [await toBundle(PILOT.slice(0, 2), p, session.signer), await toBundle(PILOT.slice(2), p, SIGNER_B)];
    expect(codes(await admit(p, bundles, { registryKeys: [...REGISTRY, sessionRow(widened)], pinnedRegistryDigest: pin }))).toEqual(["registry-mismatch"]);
    expect((await admit(p, bundles, { registryKeys: pinned, pinnedRegistryDigest: pin })).decision).toBe("admit");
  });
});

describe("profile admission — the committed profile governs (section 3: mutation after acceptance)", () => {
  it("a profile changed after acceptance is rejected", async () => {
    const accepted = inspectedPageProfile();
    const loosened = inspectedPageProfile();
    loosened.interpretation.acceptanceLevel = "device_reported";
    const r = await admit(loosened, await toBundles(PILOT, accepted), { committedDigest: computeMeasurementProfileDigest(accepted) });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["digest-mismatch"]);
  });

  it("a committed digest in the sha256: evidence-event family is rejected", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT, p), { committedDigest: `sha256:${computeMeasurementProfileDigest(p).slice(2)}` });
    expect(codes(r)).toEqual(["digest-wrong-family"]);
  });
});

describe("profile admission — only authenticated, bound evidence counts (section 3: job A/B, node A/B)", () => {
  it("a bundle whose signature does not verify under its signer's registered key is rejected", async () => {
    const p = inspectedPageProfile();
    const [printer, camera] = await toBundles(PILOT, p);
    const value = (printer!.kernelSignature as { value: string }).value;
    const flipped = `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
    const r = await admit(p, [{ ...printer!, kernelSignature: { ...(printer!.kernelSignature as Record<string, unknown>), value: flipped } }, camera!]);
    expect(codes(r)).toEqual(["unauthenticated-bundle"]);
  });

  it("a signature that cannot be read counts as a failed signature", async () => {
    const p = inspectedPageProfile();
    const [printer, camera] = await toBundles(PILOT, p);
    for (const kernelSignature of [undefined, null, "a string", { ...(printer!.kernelSignature as Record<string, unknown>), value: 7 }]) {
      const r = await admit(p, [{ ...printer!, kernelSignature }, camera!]);
      expect(codes(r), JSON.stringify(kernelSignature)).toEqual(["unauthenticated-bundle"]);
    }
  });

  it("evidence from job A cannot satisfy job B", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT.map((d) => ({ ...d, jobId: "job-other" })), p));
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("job-mismatch");
  });

  it("evidence from node A cannot be substituted for node B", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT.map((d) => ({ ...d, kernelId: "kernel-other" })), p));
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("kernel-mismatch");
  });

  it("an event altered after hashing is rejected", async () => {
    const p = inspectedPageProfile();
    const b = await toBundle(PILOT, p);
    (b.events[2] as { payload: Record<string, unknown> }).payload.passed = false;
    const r = await admit(p, [b]);
    expect(codes(r)).toEqual(["unbound-bundle"]);
    expect(r.reasons[0]!.detail).toContain("event-hash-mismatch");
  });
});

describe("profile admission — simulated evidence cannot satisfy a non-simulated profile (section 3)", () => {
  it("a simulated source rejects the whole evidence set", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, simulated: true } : d));
    const r = await admit(p, await toBundles(drafts, p));
    expect(codes(r)).toEqual(["simulated-evidence"]);
  });

  it("a payload.mock event rejects too, even when a genuine inspection is present", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT, { type: "execution_progress", t: 5, device: PRINTER, payload: { mock: true } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(codes(r)).toEqual(["simulated-evidence"]);
  });
});

describe("profile admission — levels come from the evidence contract", () => {
  it("a device's report on its own output is not inspected_output", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, device: PRINTER } : d));
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reached).toBe("device_reported");
    expect(codes(r)).toEqual(["level-not-reached"]);
  });

  it("printer_job_verified alone proves no level, not even device_reported (the R5 print-leg case)", async () => {
    const p = deviceReportedProfile();
    const r = await admit(p, await toBundles([{ type: "printer_job_verified", t: 10, device: PRINTER }], p));
    expect(r.reached).toBeNull();
    expect(codes(r)).toEqual(["level-not-reached"]);
  });

  it("level-not-reached follows onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.onMissingData = "hold";
    const r = await admit(p, await toBundles(PILOT.slice(0, 2), p));
    expect(r.decision).toBe("hold");
    expect(codes(r)).toEqual(["level-not-reached"]);
  });
});

describe("profile admission — missing measurements follow the committed policy (section 3)", () => {
  it("an inspection from a camera the profile does not name does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, device: "dev-other-camera" } : d));
    const r = await admit(p, await toBundles(drafts, p));
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("1 from other devices");
  });

  it("an observation from an unpermitted version does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, source: { adapterVersion: "PhotoCameraAdapter-9.9.9" } } : d));
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("1 unpermitted version");
  });

  it("an observation with no version at all does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) =>
      d.device === CAMERA ? { ...d, source: { adapterVersion: undefined, firmwareVersion: undefined } } : d,
    );
    const r = await admit(p, await toBundles(drafts, p));
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("an inspection before the printer completed is outside the capture window", async () => {
    const p = inspectedPageProfile();
    const drafts = PILOT.map((d) => (d.device === CAMERA ? { ...d, t: 5 } : d));
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("1 outside the capture window");
  });

  it("fewer observations than minSamples is missing data", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const r = await admit(p, await toBundles(PILOT, p));
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("missing measurements follow onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    p.onMissingData = "hold";
    expect((await admit(p, await toBundles(PILOT, p))).decision).toBe("hold");
  });

  it("no bundles at all is missing data", async () => {
    const r = await admit(inspectedPageProfile(), []);
    expect(codes(r)).toEqual(["no-bundles"]);
  });
});

describe("profile admission — failure and contradiction follow the committed policy (section 3)", () => {
  it("completion and execution_failed together is a contradiction", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p));
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["contradictory-evidence"]);
  });

  it("a contradiction follows onContradiction: hold", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "hold";
    const r = await admit(p, await toBundles([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p));
    expect(r.decision).toBe("hold");
  });

  it("a reported device failure follows onDeviceFailure", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles([PILOT[0]!, { type: "execution_failed", t: 10, device: PRINTER }], p));
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("device-failure");
  });

  it("a hold finding never outranks a reject finding", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "hold";
    p.onMissingData = "reject";
    const r = await admit(p, [
      await toBundle([...PILOT.slice(0, 2), { type: "execution_failed", t: 11, device: PRINTER }], p),
    ]);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["contradictory-evidence", "level-not-reached"]);
  });
});

describe("profile admission — terms this version cannot evaluate fail closed, never skipped", () => {
  const cases: [string, (p: MeasurementProfileV1) => void, string][] = [
    ["a numeric tolerance", (p) => (p.measurement.tolerance = { comparator: ">=", target: 0.9 }), "measurement.tolerance"],
    ["required calibration", (p) => (p.calibration = { required: true, procedureId: "cal-1", validityWindowSeconds: 3600 }), "calibration.required"],
    ["required witnesses", (p) => (p.witnesses = { requiredRoles: ["inspector"], independentOfClaimant: true }), "witnesses.requiredRoles"],
    ["continuous coverage", (p) => (p.capture.coverage = { policy: "continuous", minFraction: 0.9 }), "coverage.policy"],
    ["a start token that is not an event type", (p) => (p.capture.startCondition = "printer_warm"), "startCondition"],
    ["an end token that is not an event type or open", (p) => (p.capture.endCondition = "capture_complete"), "endCondition"],
    ["a maxIntervalMs (continuous-capture) term", (p) => (p.measurement.sampling = { minSamples: 1, maxIntervalMs: 1000 }), "maxIntervalMs"],
    ["a one-shot coverage with minFraction below 1", (p) => (p.capture.coverage = { policy: "one-shot", minFraction: 0.5 }), "coverage.minFraction"],
    ["a device.kind that is not an evidence device type", (p) => (p.device.kind = "machine"), "device.kind"],
    ["a version pin containing a wildcard", (p) => (p.device.permittedFirmwareVersions = ["*-unpinned-pilot"]), "version pins are exact strings"],
    [
      "an evidenceTypeIds entry that is not an active primitive",
      (p) => (p.interpretation.evidenceTypeIds = ["capture.no_such_primitive"]),
      "is not an active vocabulary primitive",
    ],
  ];
  for (const [name, mutate, term] of cases) {
    it(`${name} → unverifiable-term`, async () => {
      const p = inspectedPageProfile();
      mutate(p);
      const r = await admit(p, await toBundles(PILOT, p));
      expect(r.decision).toBe("reject");
      expect(codes(r)).toEqual(["unverifiable-term"]);
      expect(r.reasons[0]!.detail).toContain(term);
    });
  }
});

describe("profile admission — review #363 fixes (evidence #2777, probes P1-P3 inverted)", () => {
  const INSPECT = (payload: Record<string, unknown>): Draft => ({ type: "cv_inspection_result", t: 20, device: CAMERA, payload });
  const PRINTED = PILOT.slice(0, 2);

  it("P1: the same signed bundle presented twice counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const b = await toBundles(PILOT, p);
    const r = await admit(p, [...b, ...b]);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("1 from the profiled device");
  });

  it("P1b: one event listed twice inside one signed bundle counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const r = await admit(p, await toBundles([...PILOT, PILOT[2]!], p));
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
  });

  it("P2: an inspection reporting passed:false is a failure, never a sample", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles([...PRINTED, INSPECT({ passed: false, antiSpoofScore: 0.1 })], p));
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(codes(r)).toEqual(["contradictory-evidence", "missing-measurements"]);
    expect(r.reasons[1]!.detail).toContain("1 failed inspection(s)");
  });

  it("a failed inspection with no completion is a device failure", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles([PILOT[0]!, INSPECT({ passed: false })], p));
    expect(codes(r)).toContain("device-failure");
  });

  it("any non-true passed value is a negative verdict", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles([...PRINTED, INSPECT({ passed: "yes" })], p));
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
  });
});

describe("profile admission — evaluates only what was hashed (coord-watch rule, evidence #3079)", () => {
  it("a getter that answered false to the hash cannot answer true to admission", async () => {
    const p = inspectedPageProfile();
    const b = await toBundle([...PILOT.slice(0, 2), { ...PILOT[2]!, payload: { passed: false } }], p);
    const payload = (b.events[2] as { payload: Record<string, unknown> }).payload;
    // Measure how many times binding reads `passed`, so the lie starts exactly after binding.
    // LO-EV-9's binding (#341) runs no caller code either: it refuses the accessor without
    // running its getter, so binding reads it 0 times and the lie starts at the first read.
    let reads = 0;
    Object.defineProperty(payload, "passed", { get: () => (reads++, false), enumerable: true, configurable: true });
    const probe = await verifyEvidenceSubjectBinding({
      bundleHash: b.bundleHash,
      events: b.events,
      subject: { jobId: JOB, kernelId: KERNEL },
    });
    expect(probe, "binding refuses data that carries code, at the event that carries it").toMatchObject({ ok: false, reason: "malformed-event", eventIndex: 2 });
    expect(reads, "reads of the getter during binding").toBe(0);
    const readsDuringBinding = reads;
    // Now: truthful (false, as hashed) for binding's reads, then true on every later read.
    reads = 0;
    Object.defineProperty(payload, "passed", {
      get: () => reads++ >= readsDuringBinding,
      enumerable: true,
      configurable: true,
    });
    const r = await admit(p, [b]);
    // Since astra pack 127, data that carries code (an accessor anywhere) is refused before
    // anything is read, so the getter never runs at all: stronger than evaluating its first answer.
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(r.reasons[0]!.detail).toMatch(/input\.bundles\.0\.events\.2\.payload\.passed: an accessor/);
    expect(r.qualifyingSamples).toBe(0);
  });

  it("contradictions come from evidence's deriveContradictions, named by kind", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p));
    expect(r.reasons[0]).toMatchObject({ code: "contradictory-evidence" });
    expect(r.reasons[0]!.detail).toContain("completion-and-failure");
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F1: terms are compared", () => {
  const PRINTED = PILOT.slice(0, 2);

  it("an observation naming a different object is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { object: { kind: "documentHash", value: "sha256:" + "c".repeat(64) } } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("not matching outcome.objectIdentity");
  });

  it("an inspection with no verdict field (the record is still present) proves no level (#345), so it is never a sample", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { score: 0.97 } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(codes(r)).toEqual(["level-not-reached"]);
    expect(r.reasons[0]!.detail).toContain("the evidence reaches device_reported");
  });

  it("a bare signed inspection with no profileObservation record does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true }, observation: null }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 0 });
    expect(r.reasons[0]!.detail).toContain("without a profileObservation record");
  });

  it("an observation naming another (active) primitive is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { primitiveId: "artifact.hash" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("not matching interpretation.evidenceTypeIds");
  });

  it("an observation naming a different method is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { method: "manual-count" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("not matching measurement.method");
  });

  it("an observation naming a different quantity is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { quantity: "page-count" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("not matching measurement.quantity");
  });

  it("an observation carrying another valid profile's digest is excluded", async () => {
    const p = inspectedPageProfile();
    const other = inspectedPageProfile();
    other.measurement.sampling.minSamples = 2;
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { profileDigest: computeMeasurementProfileDigest(other) } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("not matching the committed profile digest");
  });

  it("the mass profile admits a decimal-string value (positive control)", async () => {
    const p = massProfile();
    const r = await admit(p, await toBundles(MASS_PILOT, p));
    expect(r).toMatchObject({ decision: "admit", qualifyingSamples: 1 });
  });

  it("an observation with the wrong unit is excluded", async () => {
    const p = massProfile();
    const drafts = MASS_PILOT.map((d) => (d.device === SCALE ? { ...d, observation: { unit: "g" } } : d));
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("not matching measurement.unit");
  });

  const badValues: [string, unknown][] = [
    ["removed", undefined],
    ["a JSON number, not a string", 12.5],
    ["exponent notation", "1e-7"],
    ["a leading zero", "01.5"],
  ];
  for (const [name, value] of badValues) {
    it(`a numeric observation with value ${name} is excluded`, async () => {
      const p = massProfile();
      const drafts = MASS_PILOT.map((d) =>
        d.device === SCALE ? { ...d, observation: { value } as Partial<ProfileObservation> } : d,
      );
      const r = await admit(p, await toBundles(drafts, p));
      expect(r.reasons[0]!.detail).toContain("without a decimal-string value");
    });
  }

  it("a non-numeric (unit none) observation carrying a value is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { value: "3" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("with a value on a non-numeric (unit none) observation");
  });

  it("the primitive leg returning false excludes the observation", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT, p), { verifyPrimitiveInstance: () => false });
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });

  it("a primitive leg that throws excludes the observation the same way", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT, p), {
      verifyPrimitiveInstance: () => {
        throw new Error("verifier unavailable");
      },
    });
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });

  it("the primitive leg receives the primitive id, a frozen snapshot, and the frozen bound event set", async () => {
    const p = inspectedPageProfile();
    const b = await toBundles(PILOT, p);
    const cameraEvent = b[1]!.events[0] as EvidenceEvent;
    const calls: { id: string; observation: EvidenceEvent; events: readonly EvidenceEvent[] }[] = [];
    const r = await admit(p, b, {
      verifyPrimitiveInstance: (id, observation, events) => {
        calls.push({ id, observation, events });
        return true;
      },
    });
    expect(r.decision).toBe("admit");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.id).toBe("capture.photo_nonced");
    expect(call.observation.hash).toBe(cameraEvent.hash);
    expect(call.observation).not.toBe(cameraEvent);
    expect(call.events.some((e) => e.hash === cameraEvent.hash)).toBe(true);
    expect(Object.isFrozen(call.observation)).toBe(true);
    expect(Object.isFrozen(call.observation.payload)).toBe(true);
  });

  it("a leg that mutates its observation throws, and a throwing leg is a failure", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT, p), {
      verifyPrimitiveInstance: (_id, observation) => {
        (observation.payload as Record<string, unknown>).passed = false;
        return true;
      },
    });
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F2: the pinned set", () => {
  const subject = { jobId: JOB, kernelId: KERNEL };
  const FAILURE: Draft[] = [{ type: "execution_failed", t: 11, device: PRINTER }];

  it("omitting a stored failure bundle from the presented set cannot produce admit", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundles(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [...b1.map((b) => b.bundleHash), b2.bundleHash]);
    const r = await admit(p, b1, { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-mismatch"]);
    expect(r.reasons[0]!.detail).toContain("a bundle is missing or was not pinned");
  });

  it("an omitted bundle follows onMissingData: hold", async () => {
    const p = inspectedPageProfile();
    p.onMissingData = "hold";
    const b1 = await toBundles(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [...b1.map((b) => b.bundleHash), b2.bundleHash]);
    const r = await admit(p, b1, { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("hold");
  });

  it("presenting the full pinned set surfaces the contradiction the omission would have hidden", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundle(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash, b2.bundleHash]);
    const r = await admit(p, [b1, b2], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
  });

  it("a bundle outside the pinned set is rejected even though it verifies", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundle(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash]);
    const r = await admit(p, [b1, b2], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    // b2 (the extra, unpinned bundle) is a failure bundle: since evaluation
    // does not stop at the mismatch, the contradiction it makes with b1's
    // completion is also found.
    expect(codes(r)).toContain("bundle-set-mismatch");
    expect(codes(r)).toContain("contradictory-evidence");
  });

  it("a malformed pin is rejected, never recomputed", async () => {
    const p = inspectedPageProfile();
    const r = await admit(p, await toBundles(PILOT, p), { pinnedBundleSetDigest: "0x" + "a".repeat(64) });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-pin-invalid"]);

    // A malformed pin is invalid authority, not merely missing data: it must
    // reject even under onMissingData: "hold".
    const held = inspectedPageProfile();
    held.onMissingData = "hold";
    const r2 = await admit(held, await toBundles(PILOT, held), { pinnedBundleSetDigest: "0x" + "a".repeat(64) });
    expect(r2.decision).toBe("reject");
    expect(codes(r2)).toEqual(["bundle-set-pin-invalid"]);
  });

  it("a mismatched set is never admitted, and the evidence presented is still evaluated", async () => {
    const p = inspectedPageProfile();
    p.onMissingData = "hold";
    p.onContradiction = "reject";
    const b1 = await toBundles(PILOT, p);
    const b2 = await toBundle(FAILURE, p);
    const b3 = await toBundle([{ type: "camera_snapshot", t: 25, device: CAMERA, observation: null }], p);
    const pin = await computeBundleSetDigest(subject, [...b1.map((b) => b.bundleHash), b2.bundleHash]);
    const r = await admit(p, [...b1, b2, b3], { pinnedBundleSetDigest: pin });
    // Never admit on a mismatch, but a hard reject in what WAS presented
    // still decides: the mismatch (hold) cannot hide the contradiction
    // (reject), so reject outranks hold. Mismatch is found first. Every
    // presented bundle was authenticated and bound, the extra one included:
    // the contradiction is found in what was presented.
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-mismatch", "contradictory-evidence"]);
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F2: computeBundleSetDigest", () => {
  const subject = { jobId: JOB, kernelId: KERNEL };
  const h1 = "sha256:" + "1".repeat(64);
  const h2 = "sha256:" + "2".repeat(64);

  it("is order-insensitive and de-duplicating", async () => {
    const a = await computeBundleSetDigest(subject, [h1, h2]);
    const b = await computeBundleSetDigest(subject, [h2, h1, h1]);
    expect(a).toBe(b);
  });

  it("is job-bound: another jobId gives a different digest", async () => {
    const a = await computeBundleSetDigest(subject, [h1, h2]);
    const b = await computeBundleSetDigest({ ...subject, jobId: "job-other" }, [h1, h2]);
    expect(a).not.toBe(b);
  });

  it("is domain-separated from hashBundle over the same hashes", async () => {
    const setDigest = await computeBundleSetDigest(subject, [h1, h2]);
    const bundleDigest = await hashBundle([{ hash: h1 }, { hash: h2 }] as unknown as EvidenceEvent[]);
    expect(setDigest).not.toBe(bundleDigest);
  });

  it("is sha256:-tagged, 64 lowercase hex", async () => {
    expect(await computeBundleSetDigest(subject, [h1])).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws on an empty set", async () => {
    await expect(computeBundleSetDigest(subject, [])).rejects.toThrow();
  });

  it("throws on an entry that is not a sha256: tagged digest", async () => {
    await expect(computeBundleSetDigest(subject, ["not-a-digest"])).rejects.toThrow();
  });

  it("binds settlementUnitId when the subject names one", async () => {
    const withUnit = await computeBundleSetDigest({ ...subject, settlementUnitId: "0x" + "1".repeat(64) }, [h1, h2]);
    const withoutUnit = await computeBundleSetDigest(subject, [h1, h2]);
    expect(withUnit).not.toBe(withoutUnit);
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F3: samples, not events", () => {
  const PRINTED = PILOT.slice(0, 2);
  const S = "sha256:" + "c".repeat(64);

  it("a sample reissued with a new timestamp counts once", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const drafts = [
      ...PRINTED,
      { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true }, observation: { sampleId: S } },
      { type: "cv_inspection_result", t: 25, device: CAMERA, payload: { passed: true }, observation: { sampleId: S } },
    ];
    const b = await toBundles(drafts, p);
    expect((b[1]!.events[0] as EvidenceEvent).hash).not.toBe((b[1]!.events[1] as EvidenceEvent).hash);
    const r = await admit(p, b);
    expect(r).toMatchObject({ decision: "reject", qualifyingSamples: 1 });
    expect(codes(r)).toEqual(["missing-measurements"]);
    expect(r.reasons[0]!.detail).toContain("1 repeating a counted sample");
  });

  it("two distinct captures are two samples", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const drafts = [
      ...PRINTED,
      { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true } },
      { type: "cv_inspection_result", t: 25, device: CAMERA, payload: { passed: true } },
    ];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r).toMatchObject({ decision: "admit", qualifyingSamples: 2 });
  });

  it("a sampleId that is not a sha256: digest is excluded", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PRINTED, { ...PILOT[2]!, observation: { sampleId: "frame-7" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("without a sha256: sampleId");
  });
});

describe("profile admission — review #363 round 2 (ChatGPT pack 04), F4: split version pins", () => {
  function splitPinProfile(): MeasurementProfileV1 {
    const p = inspectedPageProfile();
    p.device = { ...p.device, permittedAdapterVersions: ["cam-A"], permittedFirmwareVersions: ["fw-1"] };
    return p;
  }

  it("each pin is checked against its own field (disjoint pins, both present, admits)", async () => {
    const p = splitPinProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterVersion: "cam-A", firmwareVersion: "fw-1" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.decision).toBe("admit");
  });

  it("a version present only in the other list does not count", async () => {
    const p = splitPinProfile();
    for (const source of [
      { adapterVersion: "fw-1", firmwareVersion: "fw-1" },
      { adapterVersion: "cam-A", firmwareVersion: "cam-A" },
    ]) {
      const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source }];
      const r = await admit(p, await toBundles(drafts, p));
      expect(r.reasons[0]!.detail).toContain("unpermitted version");
    }
  });

  it("the old one-field convention (firmwareVersion alone) does not count", async () => {
    const p = splitPinProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterVersion: undefined, firmwareVersion: "cam-A" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("unpermitted version");
  });

  it("device kind is compared with source.deviceType", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { deviceType: "thermal_camera" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("from another device kind or adapter");
  });

  it("adapter type is compared with source.adapterType", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterType: "mock-photo" } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("from another device kind or adapter");
  });

  it("a missing adapterType does not count", async () => {
    const p = inspectedPageProfile();
    const drafts = [...PILOT.slice(0, 2), { ...PILOT[2]!, source: { adapterType: undefined } }];
    const r = await admit(p, await toBundles(drafts, p));
    expect(r.reasons[0]!.detail).toContain("from another device kind or adapter");
  });
});

describe("profile admission — round 3 (astra pack 39): one snapshot, precedence, leg obligations", () => {
  const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
  const FAILURE: Draft[] = [{ type: "execution_failed", t: 11, device: PRINTER }];

  it("39-A: popping a presented bundle right after the call started does not remove it from what is evaluated", async () => {
    const p = inspectedPageProfile();
    const pilotBundle = await toBundle(PILOT, p);
    const failureBundle = await toBundle(FAILURE, p);
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, [pilotBundle.bundleHash, failureBundle.bundleHash]);
    const bundles = [pilotBundle, failureBundle];
    // Built by hand: admit() awaits internally before calling
    // profileAdmitsBundle, which would leave nothing to pop before the
    // snapshot is taken.
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      pinnedBundleSetDigest,
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    bundles.pop(); // the old code evaluated only the surviving pilot bundle, and admitted
    const r = await pending;
    expect(r.decision).not.toBe("admit");
    expect(codes(r)).toContain("contradictory-evidence");
  });

  it("39-A: mutating an already-presented bundle's events right after the call started changes nothing", async () => {
    const p = inspectedPageProfile();
    const [printerBundle, bundle] = await toBundles(PILOT, p);
    const bundles = [printerBundle!, bundle!];
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash));
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      pinnedBundleSetDigest,
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    const events = bundle!.events as unknown as EvidenceEvent[];
    (events[0] as unknown as { payload: Record<string, unknown> }).payload.passed = false;
    events.push({
      id: "junk-event",
      type: "camera_snapshot",
      timestamp: at(999),
      source: { deviceId: CAMERA, deviceType: "camera", kernelId: KERNEL },
      payload: {},
      hash: "sha256:" + "9".repeat(64),
    } as unknown as EvidenceEvent);
    const r = await pending;
    expect(r.decision).toBe("admit"); // exactly as without the mutation
  });

  it("39-B: the profile's minSamples changed during suspension does not weaken the committed threshold", async () => {
    const p = inspectedPageProfile();
    p.measurement.sampling.minSamples = 2;
    const pilot = await toBundles(PILOT, p); // one qualifying observation
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, pilot.map((b) => b.bundleHash));
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: pilot,
      pinnedBundleSetDigest,
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    p.measurement.sampling.minSamples = 1; // would satisfy the weakened threshold
    const r = await pending;
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["missing-measurements"]);
  });

  it("39-B: the profile's onContradiction changed during suspension does not soften the committed policy", async () => {
    const p = inspectedPageProfile();
    p.onContradiction = "reject";
    const bundle = await toBundle([...PILOT, { type: "execution_failed", t: 11, device: PRINTER }], p);
    const pinnedBundleSetDigest = await computeBundleSetDigest(subject, [bundle.bundleHash]);
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [bundle],
      pinnedBundleSetDigest,
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    p.onContradiction = "hold"; // would turn the reject into a hold
    const r = await pending;
    expect(r.decision).toBe("reject");
  });

  it("39-B: profileGoverns's snapshot is frozen", () => {
    const p = inspectedPageProfile();
    const digest = computeMeasurementProfileDigest(p);
    const governance = profileGoverns(digest, p);
    expect(governance.governs).toBe(true);
    expect(Object.isFrozen(governance.profile)).toBe(true);
  });

  it("the subject changed during suspension does not change which job is evaluated", async () => {
    const p = inspectedPageProfile();
    const mutableSubject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const pilot = await toBundles(PILOT, p);
    const pinnedBundleSetDigest = await computeBundleSetDigest(mutableSubject, pilot.map((b) => b.bundleHash));
    const input: ProfileAdmissionInput = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject: mutableSubject,
      bundles: pilot,
      pinnedBundleSetDigest,
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    };
    const pending = profileAdmitsBundle(input);
    mutableSubject.jobId = "job-other";
    const r = await pending;
    const baseline = await admit(p, pilot);
    expect(r).toEqual(baseline);
    expect(r.decision).toBe("admit");
  });

  it("39-C: a mismatch with a fabricated event among what was presented rejects on the mismatch first, then the fabrication", async () => {
    const p = inspectedPageProfile();
    const b1 = await toBundle(PILOT, p);
    const drafts2 = PILOT.map((d) => (d.device === CAMERA ? { ...d, simulated: true } : d));
    const b2 = await toBundle(drafts2, p);
    const pin = await computeBundleSetDigest(subject, [b1.bundleHash]);
    const r = await admit(p, [b1, b2], { pinnedBundleSetDigest: pin });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["bundle-set-mismatch", "simulated-evidence"]);
  });

  it("39-D: the leg's obligation — a sampleId that truly commits the capture admits", async () => {
    const p = inspectedPageProfile();
    const captureHash = "sha256:" + "d".repeat(64);
    const drafts = [
      ...PILOT.slice(0, 2),
      { type: "cv_inspection_result", t: 20, device: CAMERA, payload: { passed: true, captureHash }, observation: { sampleId: captureHash } },
    ];
    // The obligation pattern an oracle verifier must meet: check that the
    // claimed sampleId actually commits the raw capture, not just that it is
    // shaped like one. A leg of () => true proves nothing.
    const capturesMatch = (_id: string, obs: EvidenceEvent): boolean => {
      const payload = obs.payload as Record<string, unknown>;
      const observation = payload[PROFILE_OBSERVATION_FIELD] as { sampleId: string };
      return observation.sampleId === payload.captureHash;
    };
    const r = await admit(p, await toBundles(drafts, p), { verifyPrimitiveInstance: capturesMatch });
    expect(r.decision).toBe("admit");
  });

  it("39-E: the leg's obligation — a record attached to another capture is excluded", async () => {
    const p = inspectedPageProfile();
    const claimedSampleId = "sha256:" + "d".repeat(64);
    const actualCaptureHash = "sha256:" + "e".repeat(64); // a different capture
    const drafts = [
      ...PILOT.slice(0, 2),
      {
        type: "cv_inspection_result",
        t: 20,
        device: CAMERA,
        payload: { passed: true, captureHash: actualCaptureHash },
        observation: { sampleId: claimedSampleId },
      },
    ];
    const capturesMatch = (_id: string, obs: EvidenceEvent): boolean => {
      const payload = obs.payload as Record<string, unknown>;
      const observation = payload[PROFILE_OBSERVATION_FIELD] as { sampleId: string };
      return observation.sampleId === payload.captureHash;
    };
    const r = await admit(p, await toBundles(drafts, p), { verifyPrimitiveInstance: capturesMatch });
    expect(r.decision).toBe("reject");
    expect(r.reasons[0]!.detail).toContain("not verified as capture.photo_nonced");
  });
});

describe("profile admission — the LO-SE-3 failure-bearing negative is refused by outcome policy (astra pack 40, finding 40-9)", () => {
  const FIXTURE = JSON.parse(
    readFileSync(fileURLToPath(new URL("./fixtures/lose3-execution-log-bundle.json", import.meta.url)), "utf8"),
  ) as {
    kernelPublicKeyHex: string;
    bundle: AdmissionBundle;
    negatives: { failureBearingBundle: AdmissionBundle };
  };
  // The fixture's key is registered under no operator: its registry row names none.
  const fixtureRegistry = [
    { publicKey: `0x${FIXTURE.kernelPublicKeyHex}`, trustDomain: null, grants: [{ role: "executor" as const, kernelId: "kernel-hp-3301-golden" }] },
  ];
  const lose3Subject = { jobId: "job-lose3-consumer-run-001", kernelId: "kernel-hp-3301-golden" };

  async function run(bundle: AdmissionBundle) {
    const p = deviceReportedProfile();
    p.device = { ...p.device, deviceId: "dev-hp-3301-0D253A" };
    return profileAdmitsBundle({
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject: lose3Subject,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(lose3Subject, [bundle.bundleHash]),
      registryKeys: fixtureRegistry,
      pinnedRegistryDigest: await computeRegistryDigest(fixtureRegistry),
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    });
  }

  it("the failure-bearing bundle authenticates and binds, then is rejected as a completion-and-failure contradiction", async () => {
    const r = await run(FIXTURE.negatives.failureBearingBundle);
    expect(codes(r)).not.toContain("unauthenticated-bundle");
    expect(codes(r)).not.toContain("unbound-bundle");
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("contradictory-evidence");
    expect(r.reasons.find((x) => x.code === "contradictory-evidence")!.detail).toContain("completion-and-failure");
  });

  it("the positive bundle raises no contradiction; it is refused only because it carries no profile observation", async () => {
    const r = await run(FIXTURE.bundle);
    expect(codes(r)).not.toContain("unauthenticated-bundle");
    expect(codes(r)).not.toContain("unbound-bundle");
    expect(codes(r)).not.toContain("contradictory-evidence");
    expect(r.decision).not.toBe("admit");
  });
});

// ── astra r3 (pack 74, gpt-5.6-sol) ──
describe("profile admission — astra r3 (pack 74): the committed profile is the evaluated profile", () => {
  /** The pilot profile, JSON-parsed, with measurement.sampling holding only a "__proto__" member. */
  function protoProfile(minSamples: number): MeasurementProfileV1 {
    const json = JSON.stringify(inspectedPageProfile()).replace('"sampling":{"minSamples":1}', `"sampling":{"__proto__":{"minSamples":${minSamples}}}`);
    expect(json).toContain('"__proto__"');
    return JSON.parse(json) as MeasurementProfileV1;
  }
  /** The digest a copy that dropped the __proto__ member would carry: sampling hashed as {}. */
  function digestOfStripped(p: MeasurementProfileV1): string {
    const stripped = JSON.parse(JSON.stringify(p).replace(/"sampling":\{"__proto__":\{[^}]*\}\}/, '"sampling":{}'));
    return "0x" + createHash("sha256").update(canonicalize({ domain: "PCC:measurement-profile:v1", profile: stripped })).digest("hex");
  }

  it("a JSON __proto__ member cannot carry a weaker minSamples under a stricter commitment: reject, never admit", async () => {
    const committed = protoProfile(2);
    const presented = protoProfile(1);
    const committedDigest = digestOfStripped(committed);
    expect(digestOfStripped(presented)).toBe(committedDigest); // the bytes a stripping copy would hash are identical
    // One qualifying sample, its observation naming the committed digest (the commitment asked for two).
    const drafts = PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), profileDigest: committedDigest } }));
    const bundles = await toBundles(drafts, inspectedPageProfile());
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    // Called directly: the admit() helper computes a default digest from the presented profile,
    // which now refuses a __proto__ member outright (computeMeasurementProfileDigest throws).
    expect(() => computeMeasurementProfileDigest(presented)).toThrow(/__proto__/);
    const r = await profileAdmitsBundle({
      profile: presented,
      committedDigest,
      subject,
      bundles,
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toContain("profile-invalid");
    expect(r.reasons.map((x) => x.detail).join(" ")).toMatch(/__proto__/);
  });

  it("a throwing getter on a top-level input field resolves to reject; the call never throws", async () => {
    const p = inspectedPageProfile();
    const bundles = await toBundles(PILOT, p);
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const input = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    } as Record<string, unknown>;
    Object.defineProperty(input, "pinnedBundleSetDigest", {
      enumerable: true,
      get() {
        throw Object.create(null);
      },
    });
    const r = await profileAdmitsBundle(input as unknown as ProfileAdmissionInput);
    expect(r.decision).toBe("reject");
  });
});

// ── astra r4 (pack 125, gpt-5.6-sol): the snapshot must not inherit mutable, unhashed values ──
describe("profile admission — astra r4 (pack 125): inherited values never reach the decision", () => {
  it("a polluted Object.prototype cannot supply minSamples, before or after the first await", async () => {
    const p = inspectedPageProfile() as unknown as Record<string, any>;
    delete p.measurement.sampling.minSamples; // the profile's own term is gone
    const proto = Object.prototype as Record<string, unknown>;
    proto.minSamples = 2; // what validation would read through inheritance
    try {
      let committedDigest: string;
      try {
        committedDigest = computeMeasurementProfileDigest(p as unknown as MeasurementProfileV1);
      } catch {
        return; // refused: no commitment can be computed, which closes the bypass at its source
      }
      // An enumerable getter read during the copy schedules the prototype's change for after the first await.
      const presented = { ...p };
      Object.defineProperty(presented, "onMissingData", {
        enumerable: true,
        get() {
          queueMicrotask(() => { proto.minSamples = 1; });
          return "reject";
        },
      });
      const drafts = PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), profileDigest: committedDigest } }));
      const bundles = await toBundles(drafts, inspectedPageProfile());
      const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
      const r = await profileAdmitsBundle({
        profile: presented as unknown as MeasurementProfileV1,
        committedDigest,
        subject,
        bundles,
        pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
        registryKeys: REGISTRY,
        pinnedRegistryDigest: REGISTRY_PIN,
        executorTrustDomains: [OPERATOR_A],
        verifyPrimitiveInstance: () => true,
      });
      expect(r.decision).not.toBe("admit");
    } finally {
      delete proto.minSamples;
    }
  });

  it("an inherited getter that throws during validation resolves to reject; the call never throws", async () => {
    const p = inspectedPageProfile() as unknown as Record<string, any>;
    delete p.measurement.sampling.minSamples;
    Object.defineProperty(Object.prototype, "minSamples", {
      configurable: true,
      get() {
        throw Object.create(null);
      },
    });
    try {
      const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
      const r = await profileAdmitsBundle({
        profile: p as unknown as MeasurementProfileV1,
        committedDigest: "0x" + "0".repeat(64),
        subject,
        bundles: [],
        pinnedBundleSetDigest: "sha256:" + "0".repeat(64),
        registryKeys: REGISTRY,
        pinnedRegistryDigest: REGISTRY_PIN,
        executorTrustDomains: [OPERATOR_A],
        verifyPrimitiveInstance: () => true,
      });
      expect(r.decision).toBe("reject");
    } finally {
      delete (Object.prototype as Record<string, unknown>).minSamples;
    }
  });
});

// ── astra r5 (pack 127, gpt-5.6-sol): no code supplied with the data runs during admission ──
describe("profile admission — astra r5 (pack 127): a data getter cannot change inherited behavior mid-call", () => {
  it("a getter scheduling an Array.prototype.includes swap cannot admit an uncommitted primitive", async () => {
    const committed = inspectedPageProfile(); // commits capture.photo_nonced only
    const committedDigest = computeMeasurementProfileDigest(committed);
    const original = Array.prototype.includes;
    const presented = { ...committed } as Record<string, unknown>;
    Object.defineProperty(presented, "onMissingData", {
      enumerable: true,
      get() {
        queueMicrotask(() => {
          // after the first await: every includes() answers yes
          Array.prototype.includes = function () { return true; } as typeof Array.prototype.includes;
        });
        return "reject";
      },
    });
    try {
      // the camera's observation names a primitive the profile never committed
      const drafts = PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), primitiveId: "artifact.hash" } }));
      const bundles = await toBundles(drafts, committed);
      const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
      const r = await profileAdmitsBundle({
        profile: presented as unknown as MeasurementProfileV1,
        committedDigest,
        subject,
        bundles,
        pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
        registryKeys: REGISTRY,
        pinnedRegistryDigest: REGISTRY_PIN,
        executorTrustDomains: [OPERATOR_A],
        verifyPrimitiveInstance: () => true,
      });
      expect(r.decision).not.toBe("admit");
    } finally {
      Array.prototype.includes = original;
    }
  });
});

describe("profile admission — astra r5 (pack 127): no data-supplied code, and own membership checks", () => {
  it("a proxy anywhere in the data is refused before any trap runs", async () => {
    const p = inspectedPageProfile();
    let trapped = 0;
    const proxied = new Proxy({ ...p }, { get: (t, k) => { trapped++; return Reflect.get(t, k); }, ownKeys: (t) => { trapped++; return Reflect.ownKeys(t); } });
    const r = await admit(p, await toBundles(PILOT, p), { profile: proxied as unknown as MeasurementProfileV1 });
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(trapped).toBe(0);
  });

  it("an accessor on the input object itself is refused, and its getter never runs", async () => {
    const p = inspectedPageProfile();
    const bundles = await toBundles(PILOT, p);
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    let ran = false;
    const input = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash)),
    } as Record<string, unknown>;
    Object.defineProperty(input, "bundles", { enumerable: true, get() { ran = true; return bundles; } });
    const r = await profileAdmitsBundle(input as unknown as ProfileAdmissionInput);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(ran).toBe(false);
  });

  it("membership in committed lists does not go through Array.prototype.includes", async () => {
    const p = inspectedPageProfile();
    const committedDigest = computeMeasurementProfileDigest(p);
    const original = Array.prototype.includes;
    const bundles = await toBundles(PILOT.map((d) => (d.observation === null ? d : { ...d, observation: { ...(d.observation ?? {}), primitiveId: "artifact.hash" } })), p);
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const pin = await computeBundleSetDigest(subject, bundles.map((b) => b.bundleHash));
    // A process-level change that admission's own membership checks must not consult.
    Array.prototype.includes = function () { return true; } as typeof Array.prototype.includes;
    try {
      const r = await profileAdmitsBundle({ profile: p, committedDigest, subject, bundles, pinnedBundleSetDigest: pin, registryKeys: REGISTRY, pinnedRegistryDigest: REGISTRY_PIN, executorTrustDomains: [OPERATOR_A], verifyPrimitiveInstance: () => true });
      expect(r.decision).not.toBe("admit");
    } finally {
      Array.prototype.includes = original;
    }
  });
});

// ── astra r6 (pack 154, gpt-5.6-sol): an inherited array index is input-supplied code too ──
describe("profile admission — astra r6 (pack 154): sparse arrays with a custom prototype", () => {
  it("an inherited numeric getter on the bundles array never runs", async () => {
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    let ran = false;
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, "0", { get() { ran = true; return bundle; } });
    const bundles = [] as unknown as AdmissionBundle[];
    Object.setPrototypeOf(bundles, proto);
    (bundles as unknown as { length: number }).length = 1;
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const r = await profileAdmitsBundle({
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles,
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    });
    expect(ran).toBe(false);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["input-unreadable"]);
  });

  it("an inherited getter on a bundle object's custom prototype never runs, and what it would serve is absent from the copy", async () => {
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    let ran = false;
    const { events, ...rest } = bundle as unknown as Record<string, unknown>;
    const proto = Object.create(Object.prototype, { events: { get() { ran = true; return events; } } });
    const crafted = Object.assign(Object.create(proto), rest) as unknown as AdmissionBundle;
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const r = await profileAdmitsBundle({
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [crafted],
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    });
    expect(ran).toBe(false);
    expect(r.decision).toBe("reject");
    expect(codes(r)).toEqual(["unbound-bundle"]);
  });
});

// ── the dashboard's browser build (CI run 37090398492): no static node:util in admission ──
describe("profile admission: the proxy check is loaded at runtime, and fails closed without one", () => {
  it("profile-admission.ts has no static node:util import (vite has no node:util)", () => {
    const source = readFileSync(fileURLToPath(new URL("../evidence/profile-admission.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/from\s+["']node:util["']|require\(\s*["']node:util["']\s*\)/);
  });

  it("a proxy input is still refused before any trap runs", async () => {
    let trapped = 0;
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const target = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    };
    const input = new Proxy(target, { get: (t, k, r) => (trapped++, Reflect.get(t, k, r)), getOwnPropertyDescriptor: (t, k) => (trapped++, Reflect.getOwnPropertyDescriptor(t, k)) });
    const r = await profileAdmitsBundle(input as ProfileAdmissionInput);
    expect(codes(r)).toEqual(["input-unreadable"]);
    expect(trapped).toBe(0);
  });

  it("without a trap-free proxy check (a browser, or Node before 20.16), admission rejects as input-unreadable", async () => {
    // Every input is built with the check present; only admission runs without it.
    const p = inspectedPageProfile();
    const bundle = await toBundle(PILOT, p);
    const subject: EvidenceSubject = { jobId: JOB, kernelId: KERNEL };
    const input = {
      profile: p,
      committedDigest: computeMeasurementProfileDigest(p),
      subject,
      bundles: [bundle],
      pinnedBundleSetDigest: await computeBundleSetDigest(subject, [bundle.bundleHash]),
      registryKeys: REGISTRY,
      pinnedRegistryDigest: REGISTRY_PIN,
      executorTrustDomains: [OPERATOR_A],
      verifyPrimitiveInstance: () => true,
    };
    expect(codes(await profileAdmitsBundle(input))).not.toContain("input-unreadable");
    // No trap-free proxy check, as in the dashboard's browser build: node:util offers no isProxy there.
    vi.resetModules();
    vi.doMock("node:util", () => ({ types: {} }));
    try {
      const fresh = await import("../evidence/profile-admission.js");
      const r = await fresh.profileAdmitsBundle(input);
      expect(r.decision).toBe("reject");
      expect(codes(r)).toEqual(["input-unreadable"]);
    } finally {
      vi.doUnmock("node:util");
      vi.resetModules();
    }
  });
});
