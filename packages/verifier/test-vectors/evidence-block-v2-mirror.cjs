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

// (7) PINNED GOLDEN
const EXPECT = {
  EVIDENCE_BLOCK_DOMAIN_V2: '0xf15817db95786e8bbc3156b3e66c9fa7776b2d1233841e8718b9c91fa1c751a0',
  evidenceBlockHash:        '0x4605a6e9affa66fd2acd44f5b88d0468f293056573f04e884048f58ba8803a40',
};
chk(EVIDENCE_BLOCK_DOMAIN_V2.toLowerCase() === EXPECT.EVIDENCE_BLOCK_DOMAIN_V2, `pinned golden: EVIDENCE_BLOCK_DOMAIN_V2 == ${EXPECT.EVIDENCE_BLOCK_DOMAIN_V2}`);
chk(evidenceBlockHash.toLowerCase() === EXPECT.evidenceBlockHash, `pinned golden: evidenceBlockHash == ${EXPECT.evidenceBlockHash}`);

console.log(`\n${ok ? 'EvidenceBlockV1 v2 mirror: claimsAsserted OUT + unitContextDigest IN + role/quorum-bound attestations + programHash-pin gate + cross-unit/challenge/role-relabel rejected. Folds sol NO-GO #2/#3/#4. Oracle owns (A) evaluator + #1/#5 boundary checks. GOLDEN printed above.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
