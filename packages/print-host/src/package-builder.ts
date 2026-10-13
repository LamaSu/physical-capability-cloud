import { createHash, createPublicKey, verify } from "node:crypto";
import {
  canonicalize, checkDelegationScope, checkEventTimes, isValidKernelId,
  parseDevicePrincipalId, parseEvidenceTimeBound, sessionKeyDelegationPreimage,
  type EvidenceBundle, type SessionKey,
} from "@pcc/spec";
import { settlementUnitId } from "@pcc/contracts/vnext";
import { concatHex, encodeAbiParameters, getAddress, keccak256, recoverTypedDataAddress, toBytes, toHex, zeroHash, type Address, type Hex } from "viem";
import type { DeviceKey, OperatorKey } from "./keys.js";
import { prepareD1 } from "./operator-signing.js";

export type PackageBuilderErrorCode = "bad_context" | "bad_program" | "bad_bundle" |
  "event_binding" | "event_time" | "fabricated_event" | "bad_delegation" |
  "bad_signature" | "bad_body" | "bad_signatures" | "key_mismatch" | "signing_failed";

/** No inputs, crypto exceptions or server text escape through errors. */
export class PackageBuilderError extends Error {
  readonly code: PackageBuilderErrorCode;
  constructor(code: PackageBuilderErrorCode) {
    super(code);
    this.name = "PackageBuilderError";
    this.code = code;
  }
}

/** Local builder inputs, reconstructed from the funded unit and gateway challenge. */
export interface UnitContext {
  chainId: number | bigint;
  escrow: Address;
  settlementUnitId: Hex;
  jobIdHash: Hex;
  milestoneIndex: number | bigint;
  stepId: Hex;
  compositionRoot: Hex;
  acceptedEnvelopeHash: Hex;
  challengeNonce: Hex;
  compositionSchemaVersion: number | bigint;
  operator: Address;
  kernelId: string;
  devicePublicKey: Hex;
  tChallengeRef: string;
  evidenceTimeBounds: { start: string; end: string };
}

/** Evidence lane owns all three values; there are deliberately no MVP defaults. */
export interface ProgramContext {
  programHash: Hex;
  attestationSetRoot: Hex;
  workProductRoot: Hex;
}

const domain = (tag: string) => keccak256(toBytes(tag));
const uint256Max = (1n << 256n) - 1n;
const contextFields = ["chainId", "escrow", "settlementUnitId", "jobIdHash", "milestoneIndex", "stepId",
  "compositionRoot", "acceptedEnvelopeHash", "challengeNonce", "compositionSchemaVersion", "operator",
  "kernelId", "devicePublicKey", "tChallengeRef", "evidenceTimeBounds"] as const;

function fail(code: PackageBuilderErrorCode): never { throw new PackageBuilderError(code); }
function record(input: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (input === null || typeof input !== "object" ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))) fail("bad_context");
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || (!fields.includes(key) && !optional.includes(key)))) fail("bad_context");
  const result: Record<string, unknown> = {};
  for (const key of [...fields, ...optional.filter((key) => Object.hasOwn(input, key))]) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail("bad_context");
    result[key] = descriptor.value;
  }
  return result;
}
function word(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) fail("bad_context");
  return value as Hex;
}
function uint(value: unknown, max = uint256Max): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) value = BigInt(value);
  if (typeof value !== "bigint" || value < 0n || value > max) fail("bad_context");
  return value;
}
function address(value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail("bad_context");
  return getAddress(value).toLowerCase() as Address;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) fail("bad_context");
  return value;
}
function bounds(input: unknown) {
  const b = record(input, ["start", "end"]);
  const start = parseEvidenceTimeBound(b.start);
  const end = parseEvidenceTimeBound(b.end);
  if (start === null || end === null || start > end) fail("bad_context");
  return { start: String(start), end: String(end) };
}
function guarded<T>(code: PackageBuilderErrorCode, work: () => T): T {
  try { return work(); } catch { return fail(code); }
}
/** Copy own plain JSON data without invoking getters, toJSON or inherited properties. */
function jsonCopy(input: unknown, depth = 0, omitUndefined = false): unknown {
  if (depth > 64) fail("bad_bundle");
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(input)) fail("bad_bundle");
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input) && (!Number.isInteger(input) || Number.isSafeInteger(input))) return input;
  if (Array.isArray(input)) {
    if (Reflect.ownKeys(input).length !== input.length + 1) fail("bad_bundle");
    return Array.from({ length: input.length }, (_, index) => {
      const entry = Object.getOwnPropertyDescriptor(input, String(index));
      if (!entry?.enumerable || !Object.hasOwn(entry, "value")) fail("bad_bundle");
      return jsonCopy(entry.value, depth + 1, omitUndefined);
    });
  }
  if (typeof input !== "object" || input === null || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) fail("bad_bundle");
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const entry = Object.getOwnPropertyDescriptor(input, key);
    if (typeof key !== "string" || key === "toJSON" || !entry?.enumerable || !Object.hasOwn(entry, "value")) fail("bad_bundle");
    if (entry.value === undefined && omitUndefined) continue;
    output[key] = jsonCopy(entry.value, depth + 1, omitUndefined);
  }
  return output;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sha = (bytes: string | Uint8Array): Hex => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const publicKey = (hex: Hex) => createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(toBytes(hex))]), format: "der", type: "spki",
});

export function validateUnitContext(input: UnitContext) {
  return guarded("bad_context", () => {
    const c = record(input, contextFields);
    const chainId = uint(c.chainId);
    const challengeNonce = word(c.challengeNonce);
    const devicePublicKey = word(c.devicePublicKey);
    if (chainId === 0n || challengeNonce === zeroHash || !isValidKernelId(c.kernelId) ||
      parseDevicePrincipalId(`ed25519:${devicePublicKey}`) === null) fail("bad_context");
    return freeze({ chainId, escrow: address(c.escrow), settlementUnitId: word(c.settlementUnitId), jobIdHash: word(c.jobIdHash),
      milestoneIndex: uint(c.milestoneIndex), stepId: word(c.stepId), compositionRoot: word(c.compositionRoot),
      acceptedEnvelopeHash: word(c.acceptedEnvelopeHash), challengeNonce, compositionSchemaVersion: uint(c.compositionSchemaVersion, 65535n),
      operator: address(c.operator), kernelId: c.kernelId, devicePublicKey, tChallengeRef: text(c.tChallengeRef),
      evidenceTimeBounds: bounds(c.evidenceTimeBounds) });
  });
}

/** The challenge nonce is part of the unit context, while the settlement unit id excludes it. */
export function computeUnitContextDigest(input: UnitContext): Hex {
  const c = validateUnitContext(input);
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
  ], [domain("PCC:vnext:unit-context:v1"), c.chainId, c.escrow, c.settlementUnitId, c.jobIdHash, c.milestoneIndex, c.stepId, c.challengeNonce]));
}

function delegation(input: EvidenceBundle["sessionKeyAuthorization"]) {
  return guarded("bad_delegation", () => {
    const auth = record(input, ["sessionId", "parentAgentId", "publicKey", "issuedAt", "expiresAt", "scope", "parentSignature"], ["derivationPath"]);
    if (typeof auth.publicKey !== "string" || !/^[0-9a-f]{64}$/.test(auth.publicKey) ||
      typeof auth.parentSignature !== "string" || !/^(?:0x)?[0-9a-fA-F]{128}$/.test(auth.parentSignature)) fail("bad_delegation");
    const scope = jsonCopy(record(auth.scope, ["allowedActions", "contractIds", "maxSignatures"])) as SessionKey["scope"];
    const preimage = sessionKeyDelegationPreimage({
      sessionId: auth.sessionId as string, parentAgentId: auth.parentAgentId as SessionKey["parentAgentId"],
      publicKey: Buffer.from(auth.publicKey, "hex"), issuedAt: auth.issuedAt as number, expiresAt: auth.expiresAt as number, scope,
      ...(Object.hasOwn(auth, "derivationPath") ? { derivationPath: auth.derivationPath as string } : {}),
    });
    return { preimage, signature: `0x${auth.parentSignature.replace(/^0x/, "").toLowerCase()}` as Hex,
      body: JSON.parse(Buffer.from(preimage).toString("utf8")) as NonNullable<EvidenceBundle["sessionKeyAuthorization"]> };
  });
}

/** D3 v2 pins the LO-EV-1 grant bytes, funded device key, ed25519 scheme 1 and key version 1. */
export function computeSessionKeyAuthDigest(auth: EvidenceBundle["sessionKeyAuthorization"], devicePublicKey: Hex): Hex {
  return guarded("bad_delegation", () => {
    const d = delegation(auth);
    const grantHash = keccak256(concatHex([domain("PCC:vnext:session-key-grant:v1"), toHex(d.preimage)]));
    return keccak256(encodeAbiParameters([
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint32" },
    ], [domain("PCC:vnext:session-key-auth:v1"), grantHash, d.signature, word(devicePublicKey), 1, 1]));
  });
}

export function computeEvidenceBlockHash(unitContextDigest: Hex, kernelSignedEventsRoot: Hex,
  sessionKeyAuthDigest: Hex, program: ProgramContext): Hex {
  return guarded("bad_program", () => {
    const p = validateProgramContext(program);
    return keccak256(encodeAbiParameters([
      { type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
    ], [domain("PCC:vnext:evidence-block:v2"), 2, word(unitContextDigest), word(kernelSignedEventsRoot), word(sessionKeyAuthDigest),
      word(p.attestationSetRoot), word(p.workProductRoot), word(p.programHash)]));
  });
}

export function validateProgramContext(input: ProgramContext): ProgramContext {
  return guarded("bad_program", () => {
    const p = record(input, ["programHash", "attestationSetRoot", "workProductRoot"]);
    return freeze({ programHash: word(p.programHash), attestationSetRoot: word(p.attestationSetRoot), workProductRoot: word(p.workProductRoot) });
  });
}

function createPackageBody(c: ReturnType<typeof validateUnitContext>, evidenceBlockHash: Hex) {
  return {
    packageSchemaVersion: "FinalMilestonePackageV2" as const, packageFormat: "2" as const,
    compositionSchemaVersion: String(c.compositionSchemaVersion),
    unitBinding: { chainId: String(c.chainId), escrow: c.escrow, settlementUnitId: c.settlementUnitId, jobIdHash: c.jobIdHash,
      milestoneIndex: String(c.milestoneIndex), stepId: c.stepId, compositionRoot: c.compositionRoot, acceptedEnvelopeHash: c.acceptedEnvelopeHash },
    producer: { operatorPrincipalId: `eip155:${c.chainId}:${c.operator}`, kernelId: c.kernelId, devicePrincipalId: `ed25519:${c.devicePublicKey}` },
    challengeBinding: { nonce: c.challengeNonce, tChallengeRef: c.tChallengeRef },
    evidence: { evidenceBlockHash }, evidenceTimeBounds: c.evidenceTimeBounds,
  };
}
type PackageBody = ReturnType<typeof createPackageBody>;

/** Build the body and block synchronously. Receipt and finalized unit record are gateway inputs. */
export function buildMilestonePackage(bundle: EvidenceBundle, unit: UnitContext, program: ProgramContext) {
  const c = validateUnitContext(unit);
  const p = validateProgramContext(program);
  // Bundle canonicalization omits undefined members per LO-EV-1. Package JSON never does.
  const b = guarded("bad_bundle", () => jsonCopy(bundle, 0, true) as EvidenceBundle);
  if (!b || !Array.isArray(b.events) || b.events.length === 0 || typeof b.jobId !== "string" ||
    b.jobId.length === 0 || keccak256(toBytes(b.jobId)) !== c.jobIdHash ||
    settlementUnitId(c) !== c.settlementUnitId) fail("bad_bundle");
  const eventHashes = b.events.map((event) => {
    if (!event || !event.source || !event.payload || typeof event.type !== "string" || typeof event.timestamp !== "string") fail("bad_bundle");
    if ((Object.hasOwn(event.source, "simulated") && event.source.simulated !== false) ||
      (Object.hasOwn(event.payload, "mock") && event.payload.mock !== false)) fail("fabricated_event");
    if (event.source.kernelId !== c.kernelId || (Object.hasOwn(event.payload, "kernelId") && event.payload.kernelId !== c.kernelId) ||
      event.payload.jobId !== b.jobId || event.payload.settlementUnitId !== c.settlementUnitId || event.payload.challengeNonce !== c.challengeNonce) fail("event_binding");
    if (event.type.startsWith("courier_") && !((event.payload.provenance === "independent_carrier_scan" && event.payload.independentCarrierScan === true) ||
      (event.payload.provenance === "operator_self_report" && event.payload.independentCarrierScan === false))) fail("event_binding");
    return `sha256:${sha(canonicalize({ type: event.type, timestamp: event.timestamp, source: event.source, payload: event.payload })).slice(2)}`;
  });
  const kernelSignedEventsRoot = sha(canonicalize(eventHashes.sort()));
  const bundleHash = `sha256:${kernelSignedEventsRoot.slice(2)}`;
  if (typeof b.bundleHash !== "string" || b.bundleHash.toLowerCase() !== bundleHash) fail("bad_bundle");
  const d = delegation(b.sessionKeyAuthorization);
  const operatorPrincipalId = `eip155:${c.chainId}:${c.operator}`;
  if (!checkDelegationScope(d.body, { settlingJobId: b.jobId, sessionSignedEventCount: b.events.length, operatorPrincipalId }).ok ||
    !d.body.scope.allowedActions.includes("evidence_submit") || d.body.issuedAt >= d.body.expiresAt) fail("bad_delegation");
  if (!checkEventTimes(b.events, { notBefore: d.body.issuedAt, notAfter: d.body.expiresAt }, c.evidenceTimeBounds).ok) fail("event_time");
  guarded("bad_signature", () => {
    if (b.kernelSignature?.algorithm !== "ed25519" || !/^(?:0x)?[0-9a-f]{128}$/.test(b.kernelSignature.value) ||
      !verify(null, Buffer.from(bundleHash), publicKey(`0x${d.body.publicKey}`), Buffer.from(b.kernelSignature.value.replace(/^0x/, ""), "hex")) ||
      !verify(null, d.preimage, publicKey(c.devicePublicKey), toBytes(d.signature))) fail("bad_signature");
  });
  const unitContextDigest = computeUnitContextDigest(c);
  const sessionKeyAuthDigest = computeSessionKeyAuthDigest(b.sessionKeyAuthorization, c.devicePublicKey);
  const evidenceBlockHash = computeEvidenceBlockHash(unitContextDigest, kernelSignedEventsRoot, sessionKeyAuthDigest, p);
  const body = createPackageBody(c, evidenceBlockHash);
  return freeze({ body, packageBodyHash: computePackageBodyHash(body), evidenceBlockHash,
    evidenceBlock: { unitContextDigest, kernelSignedEventsRoot, sessionKeyAuthDigest,
      attestationSetRoot: p.attestationSetRoot, workProductRoot: p.workProductRoot, programHash: p.programHash } });
}

export type BuiltMilestonePackage = ReturnType<typeof buildMilestonePackage>;

function packageBody(input: PackageBody) {
  return guarded("bad_body", () => {
    const snapshot = jsonCopy(input);
    const b = record(snapshot, ["packageSchemaVersion", "packageFormat", "compositionSchemaVersion", "unitBinding", "producer", "challengeBinding", "evidence", "evidenceTimeBounds"]);
    const u = record(b.unitBinding, ["chainId", "escrow", "settlementUnitId", "jobIdHash", "milestoneIndex", "stepId", "compositionRoot", "acceptedEnvelopeHash"]);
    const p = record(b.producer, ["operatorPrincipalId", "kernelId", "devicePrincipalId"]);
    const h = record(b.challengeBinding, ["nonce", "tChallengeRef"]);
    const e = record(b.evidence, ["evidenceBlockHash"]);
    for (const value of [b.compositionSchemaVersion, u.chainId, u.milestoneIndex]) if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail("bad_body");
    if (b.packageSchemaVersion !== "FinalMilestonePackageV2" || b.packageFormat !== "2" ||
      u.escrow !== address(u.escrow) || !isValidKernelId(p.kernelId)) fail("bad_body");
    for (const key of ["settlementUnitId", "jobIdHash", "stepId", "compositionRoot", "acceptedEnvelopeHash"]) word(u[key]);
    text(p.operatorPrincipalId); text(p.devicePrincipalId); text(h.tChallengeRef); word(h.nonce); word(e.evidenceBlockHash); bounds(b.evidenceTimeBounds);
    return snapshot;
  });
}

/** SHA-256(raw32(keccak256(:sig:v1)) || u64be(UTF-8 byte length) || JCS(body)). */
export function computePackageBodyHash(body: PackageBody): Hex {
  const bytes = Buffer.from(canonicalize(packageBody(body)), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return sha(Buffer.concat([Buffer.from(toBytes(domain("PCC:vnext:evidence-package-sig:v1"))), length, bytes]));
}

/** Oracle rule: lowercase signer, first occurrence wins, then sort by signer. */
export function canonicalSignatures(input: readonly { signer: string; scheme: string; sig: string }[]) {
  return guarded("bad_signatures", () => {
    const entries = jsonCopy(input) as typeof input;
    if (!Array.isArray(entries)) fail("bad_signatures");
    const seen = new Set<string>();
    const result: Array<{ signer: string; scheme: string; sig: string }> = [];
    for (const entry of entries) {
      const e = record(entry, ["signer", "scheme", "sig"]);
      if (typeof e.signer !== "string" || !/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(e.signer)) fail("bad_signatures");
      const signer = e.signer.toLowerCase();
      const scheme = text(e.scheme); const sig = text(e.sig);
      if (!seen.has(signer)) { seen.add(signer); result.push({ signer, scheme, sig }); }
    }
    return result.sort((a, b) => a.signer < b.signer ? -1 : a.signer > b.signer ? 1 : 0);
  });
}

export function computePackageDigest(body: PackageBody, signatures: Parameters<typeof canonicalSignatures>[0]): Hex {
  return sha(canonicalize({ body: packageBody(body), signatures: canonicalSignatures(signatures) }));
}

/** D1 and D2 are both mandatory. Each closure receives its own protocol preimage. */
export async function signMilestonePackage(input: BuiltMilestonePackage, operatorKey: OperatorKey, deviceKey: DeviceKey) {
  const built = freeze(guarded("bad_body", () => jsonCopy(input) as BuiltMilestonePackage));
  if (computePackageBodyHash(built.body) !== built.packageBodyHash || built.body.evidence.evidenceBlockHash !== built.evidenceBlockHash) fail("bad_body");
  const block = built.evidenceBlock;
  if (computeEvidenceBlockHash(block.unitContextDigest, block.kernelSignedEventsRoot, block.sessionKeyAuthDigest,
    { attestationSetRoot: block.attestationSetRoot, workProductRoot: block.workProductRoot, programHash: block.programHash }) !== built.evidenceBlockHash) fail("bad_body");
  const { unitBinding: u, producer } = built.body;
  const operator = operatorKey.address.toLowerCase();
  const device = `0x${deviceKey.publicKeyHex}`;
  if (producer.operatorPrincipalId !== `eip155:${u.chainId}:${operator}` || producer.devicePrincipalId !== `ed25519:${device}`) fail("key_mismatch");
  try {
    if (u.chainId !== "84532" && u.chainId !== "31337") fail("key_mismatch");
    const d1Input = { escrow: getAddress(u.escrow), settlementUnitId: u.settlementUnitId, jobIdHash: u.jobIdHash,
      milestoneIndex: BigInt(u.milestoneIndex), stepId: u.stepId, compositionRoot: u.compositionRoot,
      acceptedEnvelopeHash: u.acceptedEnvelopeHash, packageBodyHash: built.packageBodyHash };
    const d1 = await operatorKey.signD1(d1Input);
    if ((await recoverTypedDataAddress({ ...prepareD1(d1Input, u.chainId === "84532" ? 84532 : 31337), signature: d1 })).toLowerCase() !== operator) fail("key_mismatch");
    const d2 = await deviceKey.signD2(toBytes(built.packageBodyHash));
    if (!verify(null, toBytes(built.packageBodyHash), publicKey(word(device)), toBytes(d2))) fail("signing_failed");
    const signatures = canonicalSignatures([
      { signer: operator, scheme: "secp256k1-eip712", sig: d1 },
      { signer: device, scheme: "ed25519-raw32", sig: d2 },
    ]);
    return freeze({ ...built, signatures, packageDigest: computePackageDigest(built.body, signatures) });
  } catch (error) {
    if (error instanceof PackageBuilderError && error.code === "key_mismatch") throw error;
    return fail("signing_failed");
  }
}
