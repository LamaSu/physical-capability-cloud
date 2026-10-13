import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { concatHex, encodeAbiParameters, getAddress, keccak256, toBytes, toHex, zeroHash, type Hex } from "viem";
import { settlementUnitId } from "@pcc/contracts/vnext";
import { canonicalize, hashEvent, sessionKeyDelegationPreimage, type EvidenceBundle, type EvidenceEvent, type SessionKey } from "@pcc/spec";
import { generateHostKeys } from "../src/keygen.js";
import { loadDeviceKey, loadOperatorKey } from "../src/keys.js";
import { openUnitEvidenceSession } from "../src/unit-session.js";
import {
  buildMilestonePackage, canonicalSignatures, computeEvidenceBlockHash, computePackageBodyHash, computePackageDigest,
  computeSessionKeyAuthDigest, computeUnitContextDigest, signMilestonePackage, validateUnitContext,
  type BuiltMilestonePackage, type UnitContext,
} from "../src/package-builder.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const word = (label: string): Hex => `0x${createHash("sha256").update(label).digest("hex")}`;
const randomWord = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const address = (label: string) => getAddress(word(label).slice(0, 42));
const tag = (label: string) => keccak256(toBytes(label));
const program = { programHash: word("program"), attestationSetRoot: word("attestations"), workProductRoot: word("work") };
const sha = (bytes: string | Uint8Array) => `0x${createHash("sha256").update(bytes).digest("hex")}`;

// Runtime relative imports keep print-host's test tsc from including gateway files beyond rootDir.
interface GatewayPackage {
  computePackageBodyHash(body: unknown): Hex;
  validatePackageBody(body: unknown): unknown;
  canonicalSignatures(signatures: unknown): Array<{ signer: string; scheme: string; sig: string }>;
}
interface GatewayDigest {
  packageDigestV2PreImage(body: unknown, signatures: unknown): string;
  packageDigestV2OfPreImage(preimage: string): Hex;
}
interface GatewayVerifier {
  createEip712OperatorVerifier(deps: { operatorForUnit: () => string }): {
    verifyOperatorSignature(input: { unitBinding: BuiltMilestonePackage["body"]["unitBinding"]; packageBodyHash: Hex;
      operatorPrincipalId: string; signer: string; sig: string }): Promise<boolean>;
  };
}
async function gateway() {
  const bodyPath = "../../gateway/src/settlement/final-milestone-package-v2.ts";
  const digestPath = "../../gateway/src/settlement/package-digest-v2.ts";
  const verifierPath = "../../gateway/src/settlement/operator-signature-verifier.ts";
  const [body, digest, verifier] = await Promise.all([import(bodyPath), import(digestPath), import(verifierPath)]);
  return { body: body as GatewayPackage, digest: digest as GatewayDigest, verifier: verifier as GatewayVerifier };
}

function goldenContext(): UnitContext {
  return { chainId: 84532n, escrow: address("escrow"), settlementUnitId: word("unit"), jobIdHash: word("job"), milestoneIndex: 7n,
    stepId: word("step"), compositionRoot: zeroHash, acceptedEnvelopeHash: word("policy"), challengeNonce: word("nonce"),
    compositionSchemaVersion: 0, operator: address("operator"), kernelId: "kernel:golden", devicePublicKey: word("device"),
    tChallengeRef: "challenge:golden", evidenceTimeBounds: { start: "1700000000", end: "1701000000" } };
}
function goldenAuth(): NonNullable<EvidenceBundle["sessionKeyAuthorization"]> {
  return { sessionId: "golden:session", parentAgentId: `eip155:84532:${address("operator").toLowerCase()}`,
    publicKey: word("session").slice(2), issuedAt: 1700000000, expiresAt: 1701000000,
    scope: { allowedActions: ["workflow_step_complete", "evidence_submit"], contractIds: ["job:golden"], maxSignatures: 3 },
    derivationPath: "golden/path", parentSignature: word("sig:a").slice(2) + word("sig:b").slice(2) };
}
// No public gateway implementation exists for these three hashes. These are independently
// spelled contract-formula goldens, pinned below, using ABI encoding rather than host helpers.
function independentContext(c: UnitContext) {
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" },
    { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
  ], [tag("PCC:vnext:unit-context:v1"), BigInt(c.chainId), c.escrow, c.settlementUnitId, c.jobIdHash, BigInt(c.milestoneIndex), c.stepId, c.challengeNonce]));
}
function independentAuth(auth: ReturnType<typeof goldenAuth>, device: Hex) {
  const grant = { sessionId: auth.sessionId, parentAgentId: auth.parentAgentId, publicKey: auth.publicKey,
    issuedAt: auth.issuedAt, expiresAt: auth.expiresAt, scope: { allowedActions: [...auth.scope.allowedActions].sort(),
      contractIds: [...auth.scope.contractIds].sort(), maxSignatures: auth.scope.maxSignatures },
    ...(auth.derivationPath === undefined ? {} : { derivationPath: auth.derivationPath }) };
  const grantHash = keccak256(concatHex([tag("PCC:vnext:session-key-grant:v1"), toHex(toBytes(JSON.stringify(grant)))]));
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes" },
    { type: "bytes32" }, { type: "uint8" }, { type: "uint32" }],
  [tag("PCC:vnext:session-key-auth:v1"), grantHash, `0x${auth.parentSignature.replace(/^0x/, "")}`, device, 1, 1]));
}
function independentBlock(context: Hex, events: Hex, auth: Hex, p = program) {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint16" }, { type: "bytes32" }, { type: "bytes32" },
    { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
  [tag("PCC:vnext:evidence-block:v2"), 2, context, events, auth, p.attestationSetRoot, p.workProductRoot, p.programHash]));
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ph4b-package-")); directories.push(directory);
  const now = new Date("2026-10-10T12:00:00.000Z");
  const generated = await generateHostKeys(join(directory, "keys"), { now });
  const operatorKey = await loadOperatorKey(generated.paths.operatorKeyFile, 84532, { now });
  const deviceKey = await loadDeviceKey(generated.paths.deviceKeyFile, { now, delegationBinding: { chainId: 84532, operator: operatorKey.address } });
  const fundedAt = 1700000000;
  const jobId = "job:package-fixture";
  const context: UnitContext = { ...goldenContext(), operator: operatorKey.address, devicePublicKey: `0x${deviceKey.publicKeyHex}`,
    jobIdHash: keccak256(toBytes(jobId)), evidenceTimeBounds: { start: String(fundedAt), end: String(fundedAt + 120) } };
  context.settlementUnitId = settlementUnitId({ ...context, chainId: BigInt(context.chainId), milestoneIndex: BigInt(context.milestoneIndex) });
  const session = await openUnitEvidenceSession({ settlementUnitId: context.settlementUnitId, challengeNonce: context.challengeNonce,
    jobId, parentAgentId: `eip155:84532:${operatorKey.address.toLowerCase()}`, fundedAt, expiresAt: fundedAt + 21 * 86400,
    deviceKey, journalDir: join(directory, "journal"), now: () => fundedAt + 150 });
  for (const [index, type] of ["execution_started", "execution_completed", "courier_delivery_confirmed"].entries()) {
    const base = { type: type as EvidenceEvent["type"], timestamp: new Date((fundedAt + index * 60) * 1000).toISOString(),
      source: { kernelId: context.kernelId, deviceId: "printer:package", deviceType: "controller" as const },
      payload: { jobId, settlementUnitId: context.settlementUnitId, challengeNonce: context.challengeNonce,
        ...(type.startsWith("courier_") ? { provenance: "independent_carrier_scan", independentCarrierScan: true,
          rawBody: "opaque-carrier-body", commitment: "opaque-carrier-commitment" } : {}) } };
    await session.addEvent({ ...base, id: `event:${index}`, hash: await hashEvent(base) });
  }
  const bundle = await session.finalize();
  const built = buildMilestonePackage(bundle, context, program);
  return { bundle, context, built, operatorKey, deviceKey, generated, now, directory };
}

describe("V-next package hash parity", () => {
  it("pins unit-context domain and ABI order to the independent contract-formula golden (B1)", () => {
    const expected = "0x4aa79e0b5ad0bd51acc66cfc2f21ddabc4f920756df52de9b2640359c5bde7a9";
    expect(independentContext(goldenContext())).toBe(expected);
    expect(computeUnitContextDigest(goldenContext())).toBe(expected);
  });
  it("pins D3 v2 to independent LO-EV-1 grant bytes and ABI contract-formula golden", () => {
    const expected = "0xd9f35e3d4c616a0412dbe0d4468816bb8e0db46ab19db2c3032ace9a33291b48";
    expect(independentAuth(goldenAuth(), word("device"))).toBe(expected);
    expect(computeSessionKeyAuthDigest(goldenAuth(), word("device"))).toBe(expected);
  });
  it("pins evidence-block field order to the independent contract-formula golden (B2)", () => {
    const context = independentContext(goldenContext()); const auth = independentAuth(goldenAuth(), word("device"));
    const expected = "0x1d41c77d01cea059399b1201c041ddaf1864c2b336aee46bbb82e3aaa763d916";
    expect(independentBlock(context, word("events"), auth)).toBe(expected);
    expect(computeEvidenceBlockHash(context, word("events"), auth, program)).toBe(expected);
  });
  it("matches independent unit-context, D3 v2 and block formulas on randomized valid inputs", () => {
    for (let index = 0; index < 48; index++) {
      const c = { ...goldenContext(), escrow: getAddress(toHex(randomBytes(20))), settlementUnitId: randomWord(), jobIdHash: randomWord(),
        stepId: randomWord(), milestoneIndex: BigInt(index) << 64n, challengeNonce: randomWord() };
      const a = { ...goldenAuth(), sessionId: `session:random:${index}`, parentSignature: toHex(randomBytes(64)),
        scope: { ...goldenAuth().scope, contractIds: ["job:z", "job:a", `job:${index}`] },
        ...(index % 2 ? { derivationPath: undefined } : {}) };
      const device = randomWord(); const events = randomWord();
      const p = { programHash: randomWord(), attestationSetRoot: randomWord(), workProductRoot: randomWord() };
      expect(computeUnitContextDigest(c)).toBe(independentContext(c));
      expect(computeSessionKeyAuthDigest(a, device)).toBe(independentAuth(a, device));
      expect(computeEvidenceBlockHash(independentContext(c), events, independentAuth(a, device), p))
        .toBe(independentBlock(independentContext(c), events, independentAuth(a, device), p));
    }
  });
  it("matches gateway body validation, packageBodyHash, canonicalSignatures and package digest on randomized valid inputs", async () => {
    const { built } = await fixture(); const gw = await gateway();
    for (let index = 0; index < 48; index++) {
      const body = { ...built.body, compositionSchemaVersion: String(index),
        unitBinding: { ...built.body.unitBinding, chainId: String((BigInt(index) + 1n) << 80n), milestoneIndex: String(BigInt(index) << 64n),
          escrow: toHex(randomBytes(20)), stepId: randomWord(), jobIdHash: randomWord(), compositionRoot: randomWord() },
        challengeBinding: { nonce: randomWord(), tChallengeRef: `challenge:é:${index}` },
        evidence: { evidenceBlockHash: randomWord() } };
      const signatures = [
        { signer: toHex(randomBytes(20)), scheme: "secp256k1-eip712", sig: toHex(randomBytes(65)) },
        { signer: randomWord(), scheme: "ed25519-raw32", sig: toHex(randomBytes(64)) },
      ].reverse();
      expect(gw.body.validatePackageBody(body)).toEqual(body);
      expect(computePackageBodyHash(body)).toBe(gw.body.computePackageBodyHash(body));
      expect(canonicalSignatures(signatures)).toEqual(gw.body.canonicalSignatures(signatures));
      expect(computePackageDigest(body, signatures)).toBe(gw.digest.packageDigestV2OfPreImage(gw.digest.packageDigestV2PreImage(body, signatures)));
    }
  });
  it("lowercases, deduplicates first-wins and sorts the oracle signature set and digest (B3)", async () => {
    const { built } = await fixture();
    const low = address("signature-low").toLowerCase(); const high = randomWord();
    const entries = [
      { signer: high, scheme: "ed25519-raw32", sig: "first-device" },
      { signer: low, scheme: "secp256k1-eip712", sig: "first-operator" },
      { signer: `0x${low.slice(2).toUpperCase()}`, scheme: "ignored-duplicate", sig: "later-operator" },
      { signer: high, scheme: "ignored-duplicate", sig: "later-device" },
    ];
    const expected = [entries[0], entries[1]].map((entry) => ({ ...entry, signer: entry.signer.toLowerCase() }))
      .sort((a, b) => a.signer.localeCompare(b.signer));
    const saved = structuredClone(entries);
    expect(canonicalSignatures(entries)).toEqual(expected);
    expect(entries).toEqual(saved);
    expect(computePackageDigest(built.body, entries)).toBe(sha(canonicalize({ body: built.body, signatures: expected })));
    expect(computePackageDigest(built.body, entries)).toBe(computePackageDigest(built.body, expected.reverse()));
    // Public gateway is intentionally stricter here: it refuses duplicates/case; oracle contract wins.
    const gw = await gateway(); expect(() => gw.body.canonicalSignatures(entries)).toThrow();
  });
});

describe("package construction and mandatory signatures", () => {
  it("builds the #622 session output, verifies mandatory D1 with gateway and D2 over raw32 only (B4)", async () => {
    const { bundle, built, deviceKey, operatorKey } = await fixture(); const gw = await gateway();
    expect(bundle.sessionKeyAuthorization!.expiresAt - bundle.sessionKeyAuthorization!.issuedAt).toBeGreaterThan(3600);
    expect(built.evidenceBlock.kernelSignedEventsRoot).toBe(`0x${bundle.bundleHash.slice(7)}`);
    expect(gw.body.validatePackageBody(built.body)).toEqual(built.body);
    const captured: Uint8Array[] = [];
    const device = { ...deviceKey, signD2: async (input: Uint8Array | string) => {
      expect(input).toBeInstanceOf(Uint8Array); captured.push(new Uint8Array(input as Uint8Array)); return deviceKey.signD2(input);
    } };
    const signed = await signMilestonePackage(built, operatorKey, device);
    expect(captured).toEqual([toBytes(built.packageBodyHash)]);
    expect(signed.signatures).toHaveLength(2);
    const d1 = signed.signatures.find((entry) => entry.scheme === "secp256k1-eip712")!;
    const d2 = signed.signatures.find((entry) => entry.scheme === "ed25519-raw32")!;
    expect(d1.signer).toBe(operatorKey.address.toLowerCase());
    expect(d2.signer).toBe(`0x${deviceKey.publicKeyHex}`);
    const verifier = gw.verifier.createEip712OperatorVerifier({ operatorForUnit: () => operatorKey.address });
    expect(await verifier.verifyOperatorSignature({ unitBinding: built.body.unitBinding, packageBodyHash: built.packageBodyHash,
      operatorPrincipalId: built.body.producer.operatorPrincipalId, signer: d1.signer, sig: d1.sig })).toBe(true);
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(deviceKey.publicKeyHex, "hex")]), format: "der", type: "spki" });
    const signature = toBytes(d2.sig as Hex);
    expect(verify(null, toBytes(built.packageBodyHash), publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from(`sha256:${built.packageBodyHash.slice(2)}`), publicKey, signature)).toBe(false);
    const a = bundle.sessionKeyAuthorization!;
    const preimage = sessionKeyDelegationPreimage({ ...a, publicKey: Buffer.from(a.publicKey, "hex"),
      parentAgentId: a.parentAgentId as SessionKey["parentAgentId"], scope: { ...a.scope, allowedActions: a.scope.allowedActions as SessionKey["scope"]["allowedActions"] } });
    expect(verify(null, preimage, publicKey, signature)).toBe(false);
    expect(signed.packageDigest).toBe(gw.digest.packageDigestV2OfPreImage(gw.digest.packageDigestV2PreImage(signed.body, signed.signatures)));
    expect(signed.packageDigest).not.toBe(signed.packageBodyHash);
    expect(Object.isFrozen(signed.body.unitBinding)).toBe(true);
    expect(Object.isFrozen(signed.signatures)).toBe(true);
  });
  it("refuses a loaded operator key whose hidden chain differs from the package", async () => {
    const f = await fixture(); const wrongChainKey = await loadOperatorKey(f.generated.paths.operatorKeyFile, 31337, { now: f.now });
    await expect(signMilestonePackage(f.built, wrongChainKey, f.deviceKey)).rejects.toMatchObject({ code: "key_mismatch" });
  });
  it("freezes the signing snapshot across D1 awaits", async () => {
    const f = await fixture(); const mutable = structuredClone(f.built);
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    const operator = { ...f.operatorKey, signD1: vi.fn(async (input) => { await pending; return f.operatorKey.signD1(input); }) };
    const signing = signMilestonePackage(mutable, operator, f.deviceKey);
    mutable.body.producer.kernelId = "kernel:mutated"; mutable.body.challengeBinding.tChallengeRef = "mutated";
    release(); const signed = await signing;
    expect(signed.body).toEqual(f.built.body);
    expect(signed.body).not.toEqual(mutable.body);
  });
  it("rejects forged inconsistent blocks before signing", async () => {
    const f = await fixture(); const forged = structuredClone(f.built); forged.evidenceBlock.programHash = randomWord();
    const signD1 = vi.fn(f.operatorKey.signD1);
    await expect(signMilestonePackage(forged, { ...f.operatorKey, signD1 }, f.deviceKey)).rejects.toMatchObject({ code: "bad_body" });
    expect(signD1).not.toHaveBeenCalled();
  });
  it("rejects a self-consistent package whose unit id does not derive from its own fields before either signature (RV-L3b)", async () => {
    const f = await fixture(); const forged = structuredClone(f.built);
    forged.body.unitBinding.settlementUnitId = word("forged:unit-id");
    const forgedContext = { ...f.context, settlementUnitId: forged.body.unitBinding.settlementUnitId };
    expect(settlementUnitId({ ...forgedContext, chainId: BigInt(forgedContext.chainId),
      milestoneIndex: BigInt(forgedContext.milestoneIndex) })).not.toBe(forgedContext.settlementUnitId);
    forged.evidenceBlock.unitContextDigest = independentContext(forgedContext);
    forged.evidenceBlockHash = independentBlock(forged.evidenceBlock.unitContextDigest,
      forged.evidenceBlock.kernelSignedEventsRoot, forged.evidenceBlock.sessionKeyAuthDigest);
    forged.body.evidence.evidenceBlockHash = forged.evidenceBlockHash;
    forged.packageBodyHash = computePackageBodyHash(forged.body);
    expect(forged.evidenceBlock.unitContextDigest).toBe(computeUnitContextDigest(forgedContext));
    expect(computeEvidenceBlockHash(forged.evidenceBlock.unitContextDigest, forged.evidenceBlock.kernelSignedEventsRoot,
      forged.evidenceBlock.sessionKeyAuthDigest, program)).toBe(forged.evidenceBlockHash);
    const signD1 = vi.fn(f.operatorKey.signD1); const signD2 = vi.fn(f.deviceKey.signD2);
    await expect(signMilestonePackage(forged, { ...f.operatorKey, signD1 }, { ...f.deviceKey, signD2 }))
      .rejects.toMatchObject({ code: "bad_body" });
    expect(signD1).not.toHaveBeenCalled(); expect(signD2).not.toHaveBeenCalled();
  });
  it.each(["challenge nonce", "unit binding"] as const)("rejects a self-consistent block spliced from another %s before either signature", async (difference) => {
    const f = await fixture();
    const siblingContext = { ...f.context };
    if (difference === "challenge nonce") siblingContext.challengeNonce = word("sibling:nonce");
    else {
      siblingContext.milestoneIndex = BigInt(f.context.milestoneIndex) + 1n;
      siblingContext.stepId = word("sibling:step");
      siblingContext.settlementUnitId = settlementUnitId({ ...siblingContext, chainId: BigInt(siblingContext.chainId),
        milestoneIndex: BigInt(siblingContext.milestoneIndex) });
    }
    const auth = f.bundle.sessionKeyAuthorization!;
    const session = await openUnitEvidenceSession({ settlementUnitId: siblingContext.settlementUnitId,
      challengeNonce: siblingContext.challengeNonce, jobId: f.bundle.jobId, parentAgentId: auth.parentAgentId,
      fundedAt: auth.issuedAt, expiresAt: auth.expiresAt, deviceKey: f.deviceKey,
      journalDir: join(f.directory, "sibling-journal"), now: () => auth.issuedAt + 150 });
    for (const event of f.bundle.events) {
      const base = { type: event.type, timestamp: event.timestamp, source: structuredClone(event.source),
        payload: { ...structuredClone(event.payload), settlementUnitId: siblingContext.settlementUnitId,
          challengeNonce: siblingContext.challengeNonce } };
      await session.addEvent({ ...base, id: event.id, hash: await hashEvent(base) });
    }
    const sibling = buildMilestonePackage(await session.finalize(), siblingContext, program);
    const spliced = structuredClone(f.built);
    spliced.body.evidence.evidenceBlockHash = sibling.evidenceBlockHash;
    spliced.evidenceBlock = sibling.evidenceBlock;
    spliced.evidenceBlockHash = sibling.evidenceBlockHash;
    spliced.packageBodyHash = computePackageBodyHash(spliced.body);
    expect(computeEvidenceBlockHash(spliced.evidenceBlock.unitContextDigest, spliced.evidenceBlock.kernelSignedEventsRoot,
      spliced.evidenceBlock.sessionKeyAuthDigest, { programHash: spliced.evidenceBlock.programHash,
        attestationSetRoot: spliced.evidenceBlock.attestationSetRoot, workProductRoot: spliced.evidenceBlock.workProductRoot })).toBe(spliced.evidenceBlockHash);
    expect(spliced.evidenceBlock.unitContextDigest).not.toBe(computeUnitContextDigest(f.context));
    const signD1 = vi.fn(f.operatorKey.signD1); const signD2 = vi.fn(f.deviceKey.signD2);
    const operator = { ...f.operatorKey, signD1 }; const device = { ...f.deviceKey, signD2 };
    const control = await signMilestonePackage(f.built, operator, device);
    expect(control.signatures).toHaveLength(2);
    expect(signD1).toHaveBeenCalledTimes(1); expect(signD2).toHaveBeenCalledTimes(1);
    signD1.mockClear(); signD2.mockClear();
    await expect(signMilestonePackage(spliced, operator, device)).rejects.toMatchObject({ code: "bad_body" });
    expect(signD1).not.toHaveBeenCalled(); expect(signD2).not.toHaveBeenCalled();
  });
  it.each(["programHash", "attestationSetRoot", "workProductRoot"] as const)("requires the evidence lane's bytes32 %s", async (field) => {
    const f = await fixture();
    expect(() => buildMilestonePackage(f.bundle, f.context, { ...program, [field]: "" })).toThrowError("bad_program");
    const missing = { ...program }; delete (missing as Partial<typeof program>)[field];
    expect(() => buildMilestonePackage(f.bundle, f.context, missing)).toThrowError("bad_program");
  });
  it.each([
    ["chainId", -1], ["milestoneIndex", Number.MAX_SAFE_INTEGER + 1], ["compositionSchemaVersion", 65536],
    ["challengeNonce", zeroHash], ["tChallengeRef", ""], ["kernelId", "Ed25519:reserved"], ["devicePublicKey", "not-a-key"],
    ["evidenceTimeBounds", { start: "1700000100", end: "1700000000" }],
  ])("refuses invalid context %s", (field, value) => {
    expect(() => validateUnitContext({ ...goldenContext(), [field]: value })).toThrowError("bad_context");
  });
  it.each(["chainId", "escrow", "settlementUnitId", "jobIdHash", "milestoneIndex", "stepId", "compositionRoot",
    "acceptedEnvelopeHash", "challengeNonce", "compositionSchemaVersion", "operator", "kernelId", "devicePublicKey", "tChallengeRef", "evidenceTimeBounds"])
  ("requires own data context field %s", (field) => {
    const context = goldenContext(); const getter = vi.fn(() => undefined);
    Object.defineProperty(context, field, { enumerable: true, get: getter });
    expect(() => validateUnitContext(context)).toThrowError("bad_context"); expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    ["source simulated", "fabricated_event", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.events[0].source.simulated = true; }],
    ["payload mock", "fabricated_event", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.events[0].payload.mock = null; }],
    ["unit event binding", "event_binding", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.events[0].payload.settlementUnitId = randomWord(); }],
    ["nonce event binding", "event_binding", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.events[0].payload.challengeNonce = randomWord(); }],
    ["kernel event binding", "event_binding", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.events[0].source.kernelId = "kernel:other"; }],
    ["job hash", "bad_bundle", (f: Awaited<ReturnType<typeof fixture>>) => { f.context.jobIdHash = randomWord(); }],
    ["unit derivation", "bad_bundle", (f: Awaited<ReturnType<typeof fixture>>) => { f.context.settlementUnitId = randomWord(); }],
    ["bundle signature", "bad_signature", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.kernelSignature.value = toHex(randomBytes(64)); }],
    ["delegation signature", "bad_signature", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.sessionKeyAuthorization!.parentSignature = toHex(randomBytes(64)); }],
    ["parent operator", "bad_delegation", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.sessionKeyAuthorization!.parentAgentId = "eip155:84532:" + address("other").toLowerCase(); }],
    ["scope exhaustion", "bad_delegation", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.sessionKeyAuthorization!.scope.maxSignatures = 1; }],
    ["time bounds", "event_time", (f: Awaited<ReturnType<typeof fixture>>) => { f.context.evidenceTimeBounds = { start: "1800000000", end: "1800000100" }; }],
    ["courier provenance", "event_binding", (f: Awaited<ReturnType<typeof fixture>>) => { f.bundle.events[2].payload.independentCarrierScan = false; }],
  ] as const)("refuses %s before producing a package", async (_name, code, mutate) => {
    const f = await fixture(); mutate(f);
    expect(() => buildMilestonePackage(f.bundle, f.context, program)).toThrowError(code);
  });
  it("body hashing refuses extras and unsafe JSON without invoking accessors", async () => {
    const { built } = await fixture();
    for (const extra of [undefined, 1, () => "ignored"]) {
      expect(() => computePackageBodyHash({ ...built.body, extra } as typeof built.body)).toThrowError("bad_body");
    }
    const getter = vi.fn(() => built.body.unitBinding);
    const body = { ...built.body }; Object.defineProperty(body, "unitBinding", { enumerable: true, get: getter });
    expect(() => computePackageBodyHash(body)).toThrowError("bad_body"); expect(getter).not.toHaveBeenCalled();
  });
});
