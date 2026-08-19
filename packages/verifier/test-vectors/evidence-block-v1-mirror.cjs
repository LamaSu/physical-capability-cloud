#!/usr/bin/env node
/* evidence-block-v1-mirror.cjs — EVIDENCE lane (c25c8f97) mirror for EvidenceBlockV1, the (B) half of
 * the sol #1 trust root (oracle #836/#1074, bus #849). Doc: ~/.claude/shared/vnext-evidence-block-v1.md
 *
 * WHY: oracle's release predicate now REQUIRES claims.physicalOutcomeVerified, but it INGESTS it as a
 * producer LABEL (test-vectors/_gen.mjs:443 literally passes the bool through). To let the oracle REDERIVE
 * the claim it needs all four VerificationProgram-evaluator inputs bound into the signed package,
 * independently authenticatable + un-substitutable. EvidenceBlockV1 is that binding.
 *
 *   EVIDENCE_BLOCK_DOMAIN = keccak256("PCC:vnext:evidence-block:v1")
 *   evidenceBlockHash = keccak256(abi.encode(DOMAIN, uint16 v,
 *       kernelSignedEventsRoot, sessionKeyAuthDigest, attestationSetRoot, workProductRoot, programHash, claimsAsserted))
 *
 * Each root is computed HERE the way its real spec type computes it (evidence.ts bundleHash, work-product.ts
 * productHash, verification-program.ts programHash) so the golden binds the actual spec digests, not arbitrary bytes.
 * A REFERENCE mini-evaluator proves the block is evaluator-SHAPED (asserted==derived PASS, tampered->derived-false->reject).
 * That reference is a SHAPE proof only — the production evaluator (A) is a separate, @pcc/spec-owned build.
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node evidence-block-v1-mirror.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const ZERO32 = '0x' + '00'.repeat(32);

// canonical JSON (sorted keys, standard JSON leaves — strings/numbers/bools). Deterministic.
function cjson(o) {
  if (Array.isArray(o)) return '[' + o.map(cjson).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + cjson(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
const sha256 = (s) => '0x' + crypto.createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

// ── EVIDENCE_BLOCK_DOMAIN (verify the string derives the bytes32) ──
const DOMAIN_STR = 'PCC:vnext:evidence-block:v1';
const EVIDENCE_BLOCK_DOMAIN = K(DOMAIN_STR);
const EVIDENCE_BLOCK_VERSION = 1n;

// ═══ (1) kernelSignedEventsRoot = EvidenceBundle.bundleHash (evidence.ts:149,167) ═══
// per-event hash = sha256(canonical(type+timestamp+source+payload)); bundleHash = sha256(canonical(sorted event hashes)).
const source = { deviceId: 'dev-golden', deviceType: 'controller', kernelId: 'kernel-golden-01' }; // source.simulated absent => claims real HW
const events = [
  { id: 'e1', type: 'execution_completed', timestamp: '1700000000', source, payload: { ok: true } },
  { id: 'e2', type: 'cv_inspection_result', timestamp: '1700000005', source, payload: { pass: true, defects: 0 } },
];
const eventHash = (e) => sha256(cjson({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
const bundleHashOf = (evs) => sha256(cjson(evs.map(eventHash).sort()));
const kernelSignedEventsRoot = bundleHashOf(events);

// ═══ sessionKeyAuthDigest = sha256(canonical(SessionKeyAuthorization body)) (evidence.ts:182) ═══
const sessionKeyAuth = {
  sessionId: 'sess-golden', parentAgentId: 'kernel-golden-01',
  publicKey: 'aa'.repeat(32), issuedAt: 1699999000, expiresAt: 1700003600,
  scope: { allowedActions: ['sign-evidence'], contractIds: ['unit-golden'], maxSignatures: 8 },
  parentSignature: 'bb'.repeat(64),
};
const sessionKeyAuthDigest = sha256(cjson(sessionKeyAuth));

// ═══ (2) attestationSetRoot = sha256(canonical(sorted attestationHashes)) (attestation.ts N-of-M) ═══
const attestations = [
  { jobId: 'job-golden', attestor: '0x' + '11'.repeat(20), score: 92, timestamp: 1700000010, attestationHash: sha256(cjson(['job-golden', '0x' + '11'.repeat(20), 92, '', 1700000010])) },
  { jobId: 'job-golden', attestor: '0x' + '22'.repeat(20), score: 88, timestamp: 1700000011, attestationHash: sha256(cjson(['job-golden', '0x' + '22'.repeat(20), 88, '', 1700000011])) },
];
const attestationSetRoot = sha256(cjson(attestations.map(a => a.attestationHash).sort()));

// ═══ (3) workProductRoot = WorkProduct.productHash (work-product.ts:157) ═══
const workProduct = {
  kind: 'physical', jobId: 'job-golden', capabilityId: 'cap-golden', schemaHash: K('golden-work-schema'),
  producerAddress: '0x' + '33'.repeat(20), finalizedAt: 1700000006,
  details: { location: { lat: 37.77, lng: -122.42 }, photoBundleCid: 'bafyGoldenPhoto' },
};
const workProductRoot = sha256(cjson({ kind: workProduct.kind, jobId: workProduct.jobId, capabilityId: workProduct.capabilityId,
  schemaHash: workProduct.schemaHash, producerAddress: workProduct.producerAddress, finalizedAt: workProduct.finalizedAt, details: workProduct.details }));

// ═══ (4) programHash = VerificationProgram.programHash (verification-program.ts:248) ═══
// deterministic predicate: execution_completed present AND cv_inspection_result.pass == true (event-presence AND field-threshold).
const program = {
  version: 1, schemaHash: K('golden-work-schema'),
  stages: [{ stageId: 'settle', releaseBps: 10000, onTimeout: 'refund', onFail: 'refund',
    predicate: { kind: 'and', children: [
      { kind: 'event-presence', eventType: 'execution_completed', atLeast: 1 },
      { kind: 'field-threshold', eventRef: { eventType: 'cv_inspection_result' }, path: '/pass', op: '=', value: 1 },
    ] } }],
};
const programHash = sha256(cjson({ version: program.version, schemaHash: program.schemaHash, stages: program.stages }));

// ═══ claimsAsserted = producer's ASSERTED claims digest (ADVISORY — oracle rederives + cross-checks) ═══
const assertedClaims = { physicalOutcomeVerified: true };
const claimsAsserted = sha256(cjson(assertedClaims));

// ── evidenceBlockHash ──
const BLK_TYPES = ['bytes32', 'uint16', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'];
const blockFields = [kernelSignedEventsRoot, sessionKeyAuthDigest, attestationSetRoot, workProductRoot, programHash, claimsAsserted];
const evidenceBlockHash = keccak256(enc(BLK_TYPES, [EVIDENCE_BLOCK_DOMAIN, EVIDENCE_BLOCK_VERSION, ...blockFields]));

console.log(`ethers=${E.version || 'v5.x'}\n== EvidenceBlockV1 — binds the four VerificationProgram-evaluator inputs (sol #1 trust root, part B) ==`);
console.log(`  EVIDENCE_BLOCK_DOMAIN "${DOMAIN_STR}" -> ${EVIDENCE_BLOCK_DOMAIN}`);
console.log(`  kernelSignedEventsRoot (bundleHash)  ${kernelSignedEventsRoot}`);
console.log(`  sessionKeyAuthDigest                 ${sessionKeyAuthDigest}`);
console.log(`  attestationSetRoot                   ${attestationSetRoot}`);
console.log(`  workProductRoot (productHash)        ${workProductRoot}`);
console.log(`  programHash                          ${programHash}`);
console.log(`  claimsAsserted (ADVISORY)            ${claimsAsserted}`);
console.log(`  evidenceBlockHash                    ${evidenceBlockHash}\n`);

let ok = true;
const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// (1) domain byte-derivation
chk(EVIDENCE_BLOCK_DOMAIN.length === 66 && EVIDENCE_BLOCK_DOMAIN.startsWith('0x'), 'domain: keccak256("PCC:vnext:evidence-block:v1") is a 32-byte value');

// (2) NEGATIVE PARITY — every one of the six fields binds evidenceBlockHash
const fieldNames = ['kernelSignedEventsRoot', 'sessionKeyAuthDigest', 'attestationSetRoot', 'workProductRoot', 'programHash', 'claimsAsserted'];
for (let i = 0; i < 6; i++) {
  const mutated = blockFields.slice(); mutated[i] = K('mutant-' + i);
  const h = keccak256(enc(BLK_TYPES, [EVIDENCE_BLOCK_DOMAIN, EVIDENCE_BLOCK_VERSION, ...mutated]));
  chk(h.toLowerCase() !== evidenceBlockHash.toLowerCase(), `binds: mutate ${fieldNames[i]} -> evidenceBlockHash changes`);
}
// version binds
chk(keccak256(enc(BLK_TYPES, [EVIDENCE_BLOCK_DOMAIN, 2n, ...blockFields])).toLowerCase() !== evidenceBlockHash.toLowerCase(), 'binds: version bump -> evidenceBlockHash changes');
// domain binds
chk(keccak256(enc(BLK_TYPES, [K('PCC:vnext:evidence-block:v2'), EVIDENCE_BLOCK_VERSION, ...blockFields])).toLowerCase() !== evidenceBlockHash.toLowerCase(), 'binds: domain change -> evidenceBlockHash changes');

// (3) TIER-ABSENCE binding: a zero root (tier without attestations) is EXPLICITLY bound, not free —
//     a tier-2 package cannot drop attestationSetRoot to a different value to dodge the check.
const zeroAttest = blockFields.slice(); zeroAttest[2] = ZERO32;
const hZero = keccak256(enc(BLK_TYPES, [EVIDENCE_BLOCK_DOMAIN, EVIDENCE_BLOCK_VERSION, ...zeroAttest]));
chk(hZero.toLowerCase() !== evidenceBlockHash.toLowerCase(), 'tier-absence: attestationSetRoot=0x00..0 binds distinctly from a real root (absence is committed, not omittable)');

// (4) REFERENCE mini-evaluator (SHAPE proof; NOT the production evaluator A) — proves rederive + assert-cross-check.
function deriveClaims(evs) {
  const has = (t) => evs.some(e => e.type === t);
  const cv = evs.find(e => e.type === 'cv_inspection_result');
  const physicalOutcomeVerified = has('execution_completed') && !!(cv && cv.payload && cv.payload.pass === true);
  return { physicalOutcomeVerified };
}
const derived = deriveClaims(events);
const derivedDigest = sha256(cjson(derived));
chk(derived.physicalOutcomeVerified === true, 'evaluator-shape: derive over golden events -> physicalOutcomeVerified TRUE');
chk(derivedDigest.toLowerCase() === claimsAsserted.toLowerCase(), 'evaluator-shape: derived claims digest == claimsAsserted (producer told the truth -> release gate consumes DERIVED)');
// tampered events: drop execution_completed -> derived false -> != asserted -> reject (the sol #1 close, in shape)
const tampered = events.filter(e => e.type !== 'execution_completed');
const derivedT = deriveClaims(tampered);
chk(derivedT.physicalOutcomeVerified === false, 'evaluator-shape negative: tampered events (no execution_completed) -> derived physicalOutcomeVerified FALSE');
chk(sha256(cjson(derivedT)).toLowerCase() !== claimsAsserted.toLowerCase(), 'evaluator-shape negative: lying producer (asserts true, evidence says false) -> derived != asserted -> REJECT (fail-closed)');
// a fabricated-source bundle must be rejected regardless of claim (evidence.ts source.simulated)
const simEvents = events.map(e => ({ ...e, source: { ...e.source, simulated: true } }));
chk(bundleHashOf(simEvents).toLowerCase() !== kernelSignedEventsRoot.toLowerCase(), 'authenticity: source.simulated flips the bundleHash (fabrication is visible to the evaluator, not hidden)');

// (5) roots are the REAL spec digests (recompute determinism — same inputs -> same roots)
chk(bundleHashOf(events).toLowerCase() === kernelSignedEventsRoot.toLowerCase(), 'root-real: bundleHash recompute is deterministic (evidence.ts shape)');
chk(programHash === sha256(cjson({ version: program.version, schemaHash: program.schemaHash, stages: program.stages })), 'root-real: programHash recompute is deterministic (verification-program.ts shape)');

// (6) PINNED GOLDEN
const EXPECT = {
  EVIDENCE_BLOCK_DOMAIN: '0xf08313eb24a6bb0513d30724bbed52301b5930a6baa6333b9583f2198c959ca9',
  evidenceBlockHash:     '0xeb9d0a1ba4bf7c46210c81d85f3e44d3637b6373deb1b744cf350cf75f201a79',
};
chk(EVIDENCE_BLOCK_DOMAIN.toLowerCase() === EXPECT.EVIDENCE_BLOCK_DOMAIN, `pinned golden: EVIDENCE_BLOCK_DOMAIN == ${EXPECT.EVIDENCE_BLOCK_DOMAIN}`);
chk(evidenceBlockHash.toLowerCase() === EXPECT.evidenceBlockHash, `pinned golden: evidenceBlockHash == ${EXPECT.evidenceBlockHash}`);

console.log(`\n${ok ? 'EvidenceBlockV1 mirror: encoding + six-field binding + tier-absence + evaluator-SHAPE (rederive/assert-cross-check/fabrication-visible) VERIFIED. GOLDEN evidenceBlockHash printed above — oracle cross-confirms byte-for-byte; production evaluator (A) is the separate @pcc/spec build.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
