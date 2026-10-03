#!/usr/bin/env node
/* evidence-block-v2-mirror.cjs — EVIDENCE lane (c25c8f97). EvidenceBlockV1 v2, folding the sol NO-GO
 * (~/.claude/shared/vnext-evidenceblock-sol-nogo-fold-v1.md). v1 (evidence-block-v1-mirror.cjs, golden
 * 0xeb9d0a1b) is SUPERSEDED. Changes from v1:
 *   #2  DROP claimsAsserted — an attractive nuisance (prose-only "advisory"; mandatory mismatch-reject could
 *       veto a valid derived outcome). Fraud analytics, if needed, go in a SEPARATE producer-signed audit
 *       sidecar that is NOT an input to the signing API. The signer consumes ONLY the evaluator's derived result.
 *   #4  ADD unitContextDigest — canonical unit+challenge context, bound INSIDE the block; the oracle requires
 *       block.unitContextDigest == its INDEPENDENTLY-reconstructed outer/on-chain context. Kills cross-unit
 *       evidence replay (reuse unit A's block for unit B): outer-package scoping stops PACKAGE replay, not EVIDENCE replay.
 *   #3  attestationSetRoot now BINDS roleId + quorum config + job (per-role digest tree), not a flat sorted-hash
 *       list — so the same signatures cannot be relabeled between roles. Oracle ignores producer `satisfied`,
 *       recomputes membership/dedup/quorum/score itself. programHash is PINNED by the oracle to
 *       fundedPolicy.committedProgramHash (that check is oracle-side; the block just carries the value it will pin).
 *   #1  (oracle-side) release-authorizing signatures stay HARD-DISABLED until the (A) evaluator authenticates all
 *       inputs + returns DERIVED claims. This block is evaluator-READY, not a stand-alone money authority.
 *
 *   EVIDENCE_BLOCK_DOMAIN_V2 = keccak256("PCC:vnext:evidence-block:v2")
 *   evidenceBlockHash = keccak256(abi.encode(DOMAIN_V2, uint16 v=2,
 *       unitContextDigest, kernelSignedEventsRoot, sessionKeyAuthDigest, attestationSetRoot, workProductRoot, programHash))
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node evidence-block-v2-mirror.cjs
 *
 * RE-PIN to PRODUCTION (oracle #5772, bus #1069): the oracle pins the PRODUCTION coherent sample, not the
 * MIRROR-FORM sample this file originally pinned (golden 0x4605a6e9…, now SUPERSEDED below but still asserted
 * so a drift in the old construction is still caught). The PRODUCTION section below recomputes
 * kernelSignedEventsRoot, sessionKeyAuthDigest and attestationSetRoot from INPUTS, ported verbatim from three
 * read-only golden files in this folder (not required as modules — they have side effects / their own
 * process.exit()):
 *   - sessionKeyAuthDigest: RATIFIED D3 (oracle #1030), sessionkey-grant-golden-vector.cjs — the two-value
 *     model (canonicalSessionKeyBytes -> sessionKeyGrantHash -> sessionKeyAuthDigest, full-proof + keyVersion bound).
 *   - attestationSetRoot: RATIFIED D4 (oracle #1030), attestation-set-root-golden-vector.cjs — registry-snapshot
 *     role policy, per-role digest tree bound to roleId + quorum + fundedProgramHash.
 *   - kernelSignedEventsRoot: the PRODUCTION event set + sha256:-prefixed bundle construction (oracle #1049),
 *     kernel-signed-events-root-golden-vector.cjs — fixes the 0x-prefix-in-preimage bug this mirror's original
 *     (now-superseded) construction has.
 * unitContextDigest, workProductRoot and programHash are UNCHANGED: this mirror's existing computations already
 * match the production values (confirmed by assertion below). The public producer, PR #361 @2550254a, now
 * reproduces the production aggregate with its own functions; this re-pin lets the oracle replay it byte for byte.
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
function cjson(o) {
  if (Array.isArray(o)) return '[' + o.map(cjson).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + cjson(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
const sha256 = (s) => '0x' + crypto.createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

const DOMAIN_STR = 'PCC:vnext:evidence-block:v2';
const EVIDENCE_BLOCK_DOMAIN_V2 = K(DOMAIN_STR);
const EVIDENCE_BLOCK_VERSION = 2n;

// ═══ #4 unitContextDigest — canonical unit + challenge context (the oracle reconstructs this independently) ═══
const UNITCTX_DOMAIN = K('PCC:vnext:unit-context:v1');
const chainId = 8453n, escrow = addr(0xe5c0fn);
const jobIdHash = K('golden-job'), milestoneIndex = 3n, stepId = K('golden-step'), challengeNonce = K('golden-gateway-nonce');
// settlementUnitId is DERIVED from the same {chainId,escrow,jobIdHash,milestoneIndex,stepId} so the unit is SELF-CONSISTENT:
// the context milestoneIndex/stepId are NOT free — they must reproduce settlementUnitId. That is the anti-swap invariant the
// oracle enforces (derive settlementUnitId from the context fields, require equality). A test vector must be a VALID unit.
const SUD = K('PCC:vnext:settlement-unit:v1');
const settlementUnitId = keccak256(enc(['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32'],
  [SUD, chainId, escrow, jobIdHash, milestoneIndex, stepId]));  // == the gate-1 golden 0x4453a3d2..
const unitContext = (cid, esc, unit, job, mi, step, nonce) =>
  keccak256(enc(['bytes32', 'uint256', 'address', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
    [UNITCTX_DOMAIN, cid, esc, unit, job, mi, step, nonce]));
const unitContextDigest = unitContext(chainId, escrow, settlementUnitId, jobIdHash, milestoneIndex, stepId, challengeNonce);

// ═══ kernelSignedEventsRoot = EvidenceBundle.bundleHash (evidence.ts) ═══
const source = { deviceId: 'dev-golden', deviceType: 'controller', kernelId: 'kernel-golden-01' };
const events = [
  { type: 'execution_completed', timestamp: '1700000000', source, payload: { ok: true } },
  { type: 'cv_inspection_result', timestamp: '1700000005', source, payload: { pass: true, defects: 0 } },
];
const eventHash = (e) => sha256(cjson({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
const bundleHashOf = (evs) => sha256(cjson(evs.map(eventHash).sort()));
const kernelSignedEventsRoot = bundleHashOf(events);

// ═══ sessionKeyAuthDigest (evidence.ts SessionKeyAuthorization) ═══
const sessionKeyAuth = { sessionId: 'sess-golden', parentAgentId: 'kernel-golden-01', publicKey: 'aa'.repeat(32),
  issuedAt: 1699999000, expiresAt: 1700003600, scope: { allowedActions: ['sign-evidence'], contractIds: ['unit-golden'], maxSignatures: 8 }, parentSignature: 'bb'.repeat(64) };
const sessionKeyAuthDigest = sha256(cjson(sessionKeyAuth));

// ═══ #3 attestationSetRoot BINDS roleId + quorum + job (per-role digest tree), not a flat sorted-hash list ═══
const attJob = 'job-golden';
const roles = [
  { roleId: 'inspector', minPositive: 2, total: 3, minScore: 80,
    attestationHashes: [sha256(cjson([attJob, '0x' + '11'.repeat(20), 92])), sha256(cjson([attJob, '0x' + '22'.repeat(20), 88]))] },
];
// per-role digest binds roleId + quorum config + job + its SORTED attestation hashes -> role cannot be relabeled
const roleDigest = (r) => sha256(cjson({ roleId: r.roleId, minPositive: r.minPositive, total: r.total, minScore: r.minScore, job: attJob, hashes: [...r.attestationHashes].sort() }));
const attestationSetRoot = sha256(cjson(roles.map(roleDigest).sort()));

// ═══ workProductRoot = WorkProduct.productHash (work-product.ts) ═══
const workProduct = { kind: 'physical', jobId: 'job-golden', capabilityId: 'cap-golden', schemaHash: K('golden-work-schema'),
  producerAddress: '0x' + '33'.repeat(20), finalizedAt: 1700000006, details: { location: { lat: 37.77, lng: -122.42 }, photoBundleCid: 'bafyGoldenPhoto' } };
const workProductRoot = sha256(cjson({ kind: workProduct.kind, jobId: workProduct.jobId, capabilityId: workProduct.capabilityId,
  schemaHash: workProduct.schemaHash, producerAddress: workProduct.producerAddress, finalizedAt: workProduct.finalizedAt, details: workProduct.details }));

// ═══ programHash (verification-program.ts) — the oracle PINS this == fundedPolicy.committedProgramHash (#3) ═══
const program = { version: 1, schemaHash: K('golden-work-schema'), stages: [{ stageId: 'settle', releaseBps: 10000, onTimeout: 'refund', onFail: 'refund',
  predicate: { kind: 'and', children: [ { kind: 'event-presence', eventType: 'execution_completed', atLeast: 1 }, { kind: 'field-threshold', eventRef: { eventType: 'cv_inspection_result' }, path: '/pass', op: '=', value: 1 } ] } }] };
const programHash = sha256(cjson({ version: program.version, schemaHash: program.schemaHash, stages: program.stages }));
const fundedCommittedProgramHash = programHash; // the FUNDED policy's committedProgramHash (subjectBlockHash field); oracle requires equality

// ── evidenceBlockHash (v2: unitContextDigest in, claimsAsserted out) ──
const BLK_TYPES = ['bytes32', 'uint16', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'];
const blockFields = [unitContextDigest, kernelSignedEventsRoot, sessionKeyAuthDigest, attestationSetRoot, workProductRoot, programHash];
const evidenceBlockHash = keccak256(enc(BLK_TYPES, [EVIDENCE_BLOCK_DOMAIN_V2, EVIDENCE_BLOCK_VERSION, ...blockFields]));

console.log(`ethers=${E.version || 'v5.x'}\n== EvidenceBlockV1 v2 — folds sol NO-GO (claimsAsserted out, unitContextDigest in, role-bound attestations) ==`);
console.log(`  EVIDENCE_BLOCK_DOMAIN_V2 "${DOMAIN_STR}" -> ${EVIDENCE_BLOCK_DOMAIN_V2}`);
console.log(`  unitContextDigest (#4, NEW)          ${unitContextDigest}`);
console.log(`  kernelSignedEventsRoot               ${kernelSignedEventsRoot}`);
console.log(`  sessionKeyAuthDigest                 ${sessionKeyAuthDigest}`);
console.log(`  attestationSetRoot (#3, role-bound)  ${attestationSetRoot}`);
console.log(`  workProductRoot                      ${workProductRoot}`);
console.log(`  programHash                          ${programHash}`);
console.log(`  evidenceBlockHash                    ${evidenceBlockHash}\n`);

let ok = true;
const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// (1) claimsAsserted is GONE — the block has exactly 6 roots, none of them a producer claim (#2)
chk(blockFields.length === 6, '#2: block carries 6 roots, claimsAsserted REMOVED (no producer-claim field on the signing path)');

// (2) negative parity — every field + version + domain binds evidenceBlockHash
const fieldNames = ['unitContextDigest', 'kernelSignedEventsRoot', 'sessionKeyAuthDigest', 'attestationSetRoot', 'workProductRoot', 'programHash'];
for (let i = 0; i < 6; i++) {
  const m = blockFields.slice(); m[i] = K('mutant-' + i);
  chk(keccak256(enc(BLK_TYPES, [EVIDENCE_BLOCK_DOMAIN_V2, EVIDENCE_BLOCK_VERSION, ...m])).toLowerCase() !== evidenceBlockHash.toLowerCase(), `binds: mutate ${fieldNames[i]} -> hash changes`);
}
chk(keccak256(enc(BLK_TYPES, [K('PCC:vnext:evidence-block:v1'), 1n, ...blockFields])).toLowerCase() !== evidenceBlockHash.toLowerCase(), 'binds: v1 domain+version != v2 (supersede is a distinct hash)');

// (3) #4 CROSS-UNIT REPLAY: reuse this block for unit B -> the oracle reconstructs unit B context -> != block.unitContextDigest -> reject
const unitB = unitContext(chainId, escrow, K('other-unit'), jobIdHash, 1n, K('golden-step-1'), challengeNonce);
chk(unitB.toLowerCase() !== unitContextDigest.toLowerCase(), '#4 cross-unit: reconstructed unit-B context != block.unitContextDigest -> oracle rejects the replay (evidence replay closed, not just package replay)');
const staleChallenge = unitContext(chainId, escrow, settlementUnitId, jobIdHash, milestoneIndex, stepId, K('other-nonce'));
chk(staleChallenge.toLowerCase() !== unitContextDigest.toLowerCase(), '#4 challenge: a different challengeNonce -> different unitContextDigest (freshness bound)');
// #4 anti-swap INVARIANT: the context milestoneIndex/stepId are NOT free — they must reproduce settlementUnitId. A valid unit
// satisfies settlementUnitId == keccak(SUD, chainId, escrow, jobIdHash, milestoneIndex, stepId); the oracle derives + checks it.
chk(settlementUnitId.toLowerCase() === keccak256(enc(['bytes32','uint256','address','bytes32','uint256','bytes32'],[SUD,chainId,escrow,jobIdHash,milestoneIndex,stepId])).toLowerCase(),
    '#4 invariant: settlementUnitId DERIVES from the context {chainId,escrow,jobIdHash,milestoneIndex,stepId} -> this is a VALID unit (gate-1 golden 0x4453a3d2)');
chk(keccak256(enc(['bytes32','uint256','address','bytes32','uint256','bytes32'],[SUD,chainId,escrow,jobIdHash,2n,stepId])).toLowerCase() !== settlementUnitId.toLowerCase(),
    '#4 invariant negative: a DIFFERENT milestoneIndex in the context does NOT derive settlementUnitId -> oracle rejects an incoherent unit (mi/step bound, not free)');

// (4) #3 ROLE-RELABEL: move an attestation to a different roleId -> attestationSetRoot changes (roles bound, not flat hashes)
const relabeled = [{ ...roles[0], roleId: 'buyer' }];
chk(sha256(cjson(relabeled.map(roleDigest).sort())).toLowerCase() !== attestationSetRoot.toLowerCase(), '#3 role-bind: relabel roleId inspector->buyer -> attestationSetRoot changes (same sigs cannot be reused under another role)');
const weakerQuorum = [{ ...roles[0], minPositive: 1 }];
chk(sha256(cjson(weakerQuorum.map(roleDigest).sort())).toLowerCase() !== attestationSetRoot.toLowerCase(), '#3 quorum-bind: weakening minPositive 2->1 -> attestationSetRoot changes (quorum config is bound)');

// (5) #3 programHash PIN: the oracle requires block.programHash == fundedPolicy.committedProgramHash (producer cannot pick its own judge)
chk(programHash.toLowerCase() === fundedCommittedProgramHash.toLowerCase(), '#3 programHash-pin: block.programHash == fundedPolicy.committedProgramHash (a tautology program with a different hash is rejected at this gate)');
chk(K('tautology-atLeast-0-program').toLowerCase() !== fundedCommittedProgramHash.toLowerCase(), '#3 programHash-pin: a producer-chosen tautology program != the funded committedProgramHash -> rejected');

// (6) evaluator-SHAPE (reference, NOT the production evaluator A): derive over authenticated events -> physicalOutcomeVerified; NO claimsAsserted to trust
const derive = (evs) => { const has = (t) => evs.some(e => e.type === t); const cv = evs.find(e => e.type === 'cv_inspection_result'); return { physicalOutcomeVerified: has('execution_completed') && !!(cv && cv.payload && cv.payload.pass === true) }; };
chk(derive(events).physicalOutcomeVerified === true, 'evaluator-shape: derive over authenticated golden events -> physicalOutcomeVerified TRUE (release gate consumes DERIVED, there is no producer label to consult)');
chk(derive(events.filter(e => e.type !== 'execution_completed')).physicalOutcomeVerified === false, 'evaluator-shape negative: tampered events -> derived FALSE -> no release (fail-closed; #1 stays oracle-side until (A))');
chk(bundleHashOf(events.map(e => ({ ...e, source: { ...e.source, simulated: true } }))).toLowerCase() !== kernelSignedEventsRoot.toLowerCase(), 'authenticity: source.simulated flips the bundleHash (fabrication visible to the evaluator)');

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PRODUCTION section (oracle #5772, bus #1069) — re-derives kernelSignedEventsRoot, sessionKeyAuthDigest
// and attestationSetRoot from INPUTS using the ratified D3/D4 formulas + the production event-bundle
// construction, ported VERBATIM from three read-only golden files in this folder. Those files are not
// `require`d here — they have side effects (their own chk()/process.exit()) that would abort this script —
// so the formulas and inputs are copied in instead. unitContextDigest, workProductRoot and programHash are
// NOT re-derived: the mirror's existing computations above already equal the production values (confirmed
// in section (7) below), so they are reused as-is.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// ── PRODUCTION kernelSignedEventsRoot — ported verbatim from kernel-signed-events-root-golden-vector.cjs
//    (oracle #1049). Production canonicalize/sha256pfx + the PRODUCTION event set (ISO-8601 timestamps,
//    schema-valid; sol #34) — NOT the mirror's own `events` above, which is the 0x-prefixed BUG form on a
//    different event set. `source` is reused as-is: it is byte-identical to the golden file's. ──
function prodCanonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(prodCanonicalize).join(',') + ']';
  if (typeof v === 'object') { const ks = Object.keys(v).sort(); return '{' + ks.filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + prodCanonicalize(v[k])).join(',') + '}'; }
  return String(v);
}
const SHA = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const sha256pfx = (x) => 'sha256:' + SHA(prodCanonicalize(x));        // PRODUCTION spec sha256() — sha256: PREFIX

const prodEvents = [
  { type: 'execution_completed', timestamp: '2026-08-20T00:00:00Z', source, payload: { ok: true } },
  { type: 'cv_inspection_result', timestamp: '2026-08-20T00:00:05Z', source, payload: { pass: 1, defects: 0 } },
];
const prodEventHashes = prodEvents.map((e) => sha256pfx({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
const prodBundleHash = sha256pfx([...prodEventHashes].sort());
const prodKernelSignedEventsRoot = '0x' + prodBundleHash.slice(7);   // the frozen sha256:->bytes32 bridge

// ── PRODUCTION sessionKeyAuthDigest — RATIFIED D3 (oracle #1030), ported verbatim from
//    sessionkey-grant-golden-vector.cjs. Two-value model: canonicalSessionKeyBytes (EXPLICIT key order,
//    EXCLUDES parentSignature) -> sessionKeyGrantHash -> sessionKeyAuthDigest (binds the FULL proof incl
//    parentSignature + parentPubKey + scheme + keyVersion). ──
const raw32 = (h) => Buffer.from(h.slice(2), 'hex');
function canonicalSessionKeyBytes(sk) {
  const body = {
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: sk.publicKey,
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions].sort(),
      contractIds: [...sk.scope.contractIds].sort(),
      maxSignatures: sk.scope.maxSignatures,
    },
  };
  if (sk.derivationPath !== undefined) body.derivationPath = sk.derivationPath;
  return Buffer.from(JSON.stringify(body), 'utf8');
}
const GRANT_DOMAIN = K('PCC:vnext:session-key-grant:v1');
const AUTH_DOMAIN = K('PCC:vnext:session-key-auth:v1');
const SCHEME_ED25519 = 1;

const pSeed = Buffer.from('44'.repeat(32), 'hex');
const parentPriv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), pSeed]), format: 'der', type: 'pkcs8' });
const parentPubRaw = crypto.createPublicKey(parentPriv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const kernelPubRaw = 'aa'.repeat(32);

const prodSessionKeyAuth = {
  sessionId: 'sess-golden', parentAgentId: 'kernel-golden-01', publicKey: kernelPubRaw,
  issuedAt: 1755648000, expiresAt: 1755734400,
  scope: { allowedActions: ['sign-evidence'], contractIds: ['unit-golden'], maxSignatures: 8 },
};
const keyVersion = 1;

const grantBytes = canonicalSessionKeyBytes(prodSessionKeyAuth);
const parentSignature = '0x' + crypto.sign(null, grantBytes, parentPriv).toString('hex');

const sessionKeyGrantHash = keccak256(Buffer.concat([raw32(GRANT_DOMAIN), grantBytes]));
const prodSessionKeyAuthDigest = keccak256(enc(
  ['bytes32', 'bytes32', 'bytes', 'bytes32', 'uint8', 'uint32'],
  [AUTH_DOMAIN, sessionKeyGrantHash, parentSignature, '0x' + parentPubRaw, SCHEME_ED25519, keyVersion]));

// ── PRODUCTION attestationSetRoot — RATIFIED D4 (oracle #1030), ported verbatim from
//    attestation-set-root-golden-vector.cjs. REGISTRY-SNAPSHOT role policy (not inline signers), per-attestation
//    preimage incl timestamp+comment, producer `satisfied` EXCLUDED (recomputed), duplicate roleIds/attestors
//    REJECTED. Functions suffixed D4 / `rolesD4` / `byRoleD4` only to avoid shadowing the mirror's own
//    flat-form `roleDigest`/`attestationSetRoot`/`roles` above (#3 section); the formulas are unchanged. ──
const ROLE_DOMAIN = K('PCC:vnext:attestation-role:v1');
const ATTSET_DOMAIN = K('PCC:vnext:attestation-set:v1');
const fundedProgramHash = K('golden-program');
const jobId = 'job-golden';

const prodSha256bytes32 = (x) => '0x' + crypto.createHash('sha256').update(Buffer.from(prodCanonicalize(x), 'utf8')).digest('hex');
const attHash = (a) => prodSha256bytes32({ jobId: a.jobId, attestor: a.attestor, score: a.score, comment: a.comment, timestamp: a.timestamp });
const A1 = { jobId, attestor: '0x' + '11'.repeat(20), score: 92, comment: 'pass, within tol', timestamp: 1700000100 };
const A2 = { jobId, attestor: '0x' + '22'.repeat(20), score: 88, comment: 'ok', timestamp: 1700000200 };

const roleSignersDigest = (s) => keccak256(enc(['bytes32', 'bytes32'], [K(s.registryId), s.snapshotHash]));
const inspectorRole = {
  roleId: 'inspector',
  signers: { kind: 'registry', registryId: 'pcc-verifier-registry', snapshotHash: K('golden-registry-snapshot') },
  minPositive: 2, total: 3, minScore: 80,
};

function roleDigestD4(role, atts) {
  const attestors = atts.map(a => a.attestor.toLowerCase());
  if (new Set(attestors).size !== attestors.length) throw new Error('DUPLICATE_ATTESTOR in role ' + role.roleId);
  const hashes = atts.map(attHash).sort();
  return keccak256(enc(
    ['bytes32', 'bytes32', 'bytes32', 'uint32', 'uint32', 'uint32', 'bytes32', 'bytes32[]'],
    [ROLE_DOMAIN, K(role.roleId), roleSignersDigest(role.signers), role.minPositive, role.total, role.minScore ?? 0, fundedProgramHash, hashes]));
}

function attestationSetRootD4(roles, byRole) {
  const ids = roles.map(r => r.roleId);
  if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_ROLE');
  const rds = roles.map(r => roleDigestD4(r, byRole[r.roleId] || [])).sort();
  return keccak256(enc(['bytes32', 'bytes32', 'bytes32[]'], [ATTSET_DOMAIN, fundedProgramHash, rds]));
}

const rolesD4 = [inspectorRole];
const byRoleD4 = { inspector: [A1, A2] };
const prodAttestationSetRoot = attestationSetRootD4(rolesD4, byRoleD4);

// ── PRODUCTION aggregate — the mirror's existing six-root block formula (BLK_TYPES / EVIDENCE_BLOCK_DOMAIN_V2 /
//    EVIDENCE_BLOCK_VERSION, all defined above, UNCHANGED), applied to the PRODUCTION roots instead of the
//    mirror-form ones ──
const prodBlockFields = [unitContextDigest, prodKernelSignedEventsRoot, prodSessionKeyAuthDigest, prodAttestationSetRoot, workProductRoot, programHash];
const prodEvidenceBlockHash = keccak256(enc(BLK_TYPES, [EVIDENCE_BLOCK_DOMAIN_V2, EVIDENCE_BLOCK_VERSION, ...prodBlockFields]));

console.log(`== PRODUCTION coherent sample (oracle #5772, bus #1069) — the oracle pins THIS sample, not the mirror-form one above ==`);
console.log(`  unitContextDigest      (unchanged)      ${unitContextDigest}`);
console.log(`  kernelSignedEventsRoot (PRODUCTION)      ${prodKernelSignedEventsRoot}`);
console.log(`  sessionKeyAuthDigest   (D3, PRODUCTION)  ${prodSessionKeyAuthDigest}`);
console.log(`  attestationSetRoot     (D4, PRODUCTION)  ${prodAttestationSetRoot}`);
console.log(`  workProductRoot        (unchanged)      ${workProductRoot}`);
console.log(`  programHash            (unchanged)      ${programHash}`);
console.log(`  evidenceBlockHash      (PRODUCTION)      ${prodEvidenceBlockHash}\n`);

// (7) PRODUCTION PINNED GOLDEN (oracle #5772, bus #1069) — the oracle pins the PRODUCTION coherent sample.
const EXPECT_PROD = {
  unitContextDigest:      '0x4de8723033b81fe8465870c2105d5a13ca37337bea5881eafdf72666591fb519',
  kernelSignedEventsRoot: '0x4e0af964e4e066717998ed7a49bf7c874023bd402b825da22b4dabd70fb6f9fe',
  sessionKeyAuthDigest:   '0xaccbbe5a396764ac3eff908cca1c03d9d57e617407e0d8f3cb9bf9f9904a8323',
  attestationSetRoot:     '0xcb38575b678a08c0915704d648c851ee7b26f6737c2ddb097c7ff531a16ad0e9',
  workProductRoot:        '0xa7f8570e430e1dee4deed6c2d118ed7cbc9b9d60d81d6dbd6cb980a3ef4bb1a7',
  programHash:            '0x95e8193a8602b26f5930d45d810404ea6cf0a91c13849f918af40f406be565bc',
  evidenceBlockHash:      '0xcb30733c2904e714a4ef89a387b75bdcfa07aff5a4ea7482b55404a1e24e396c',
};
chk(unitContextDigest.toLowerCase() === EXPECT_PROD.unitContextDigest, `PRODUCTION: unitContextDigest == ${EXPECT_PROD.unitContextDigest} (mirror's existing #4 computation, unchanged, confirmed == production)`);
chk(workProductRoot.toLowerCase() === EXPECT_PROD.workProductRoot, `PRODUCTION: workProductRoot == ${EXPECT_PROD.workProductRoot} (mirror's existing computation, unchanged, confirmed == production)`);
chk(programHash.toLowerCase() === EXPECT_PROD.programHash, `PRODUCTION: programHash == ${EXPECT_PROD.programHash} (mirror's existing computation, unchanged, confirmed == production)`);
chk(prodKernelSignedEventsRoot.toLowerCase() === EXPECT_PROD.kernelSignedEventsRoot, `PRODUCTION: kernelSignedEventsRoot == ${EXPECT_PROD.kernelSignedEventsRoot} (production event set + sha256:-prefixed bundle construction, ported verbatim from kernel-signed-events-root-golden-vector.cjs, oracle #1049)`);
chk(prodSessionKeyAuthDigest.toLowerCase() === EXPECT_PROD.sessionKeyAuthDigest, `PRODUCTION: sessionKeyAuthDigest == ${EXPECT_PROD.sessionKeyAuthDigest} (D3 two-value formula, ported verbatim from sessionkey-grant-golden-vector.cjs, RATIFIED oracle #1030)`);
chk(prodAttestationSetRoot.toLowerCase() === EXPECT_PROD.attestationSetRoot, `PRODUCTION: attestationSetRoot == ${EXPECT_PROD.attestationSetRoot} (D4 registry-snapshot formula, ported verbatim from attestation-set-root-golden-vector.cjs, RATIFIED oracle #1030)`);
chk(prodEvidenceBlockHash.toLowerCase() === EXPECT_PROD.evidenceBlockHash, `PRODUCTION PINNED GOLDEN (oracle #5772, bus #1069): evidenceBlockHash == ${EXPECT_PROD.evidenceBlockHash} — re-pinned from the mirror-form sample below; PR #361 @2550254a reproduces this aggregate independently`);

// (8) SUPERSEDED — the mirror-form sample this file originally pinned (sessionKeyAuthDigest = flat
// sha256(cjson(auth)), attestationSetRoot = flat sorted-hash list, kernelSignedEventsRoot = 0x-prefixed-preimage
// form on the mirror's own event set). The oracle no longer pins this; kept so a drift in the OLD construction
// is still caught.
const EXPECT_SUPERSEDED = {
  EVIDENCE_BLOCK_DOMAIN_V2: '0xf15817db95786e8bbc3156b3e66c9fa7776b2d1233841e8718b9c91fa1c751a0',
  evidenceBlockHash:        '0x4605a6e9affa66fd2acd44f5b88d0468f293056573f04e884048f58ba8803a40',
};
chk(EVIDENCE_BLOCK_DOMAIN_V2.toLowerCase() === EXPECT_SUPERSEDED.EVIDENCE_BLOCK_DOMAIN_V2, `SUPERSEDED pinned golden: EVIDENCE_BLOCK_DOMAIN_V2 == ${EXPECT_SUPERSEDED.EVIDENCE_BLOCK_DOMAIN_V2}`);
chk(evidenceBlockHash.toLowerCase() === EXPECT_SUPERSEDED.evidenceBlockHash, `SUPERSEDED mirror-form evidenceBlockHash == ${EXPECT_SUPERSEDED.evidenceBlockHash} (pre-#5772 mirror-form sample; oracle now pins PRODUCTION above, #5772)`);

console.log(`\n${ok ? 'EvidenceBlockV1 v2 mirror: claimsAsserted OUT + unitContextDigest IN + role/quorum-bound attestations + programHash-pin gate + cross-unit/challenge/role-relabel rejected. Folds sol NO-GO #2/#3/#4. Oracle owns (A) evaluator + #1/#5 boundary checks. Re-pinned to the PRODUCTION coherent sample (oracle #5772, bus #1069); mirror-form sample SUPERSEDED but still checked for drift.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
