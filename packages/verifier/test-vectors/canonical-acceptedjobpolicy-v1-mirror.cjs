#!/usr/bin/env node
/* canonical-acceptedjobpolicy-v1-mirror.cjs — EVIDENCE lane (92dc40cb) independent ethers mirror for
 * CanonicalAcceptedJobPolicyV1 -> acceptedPolicyDigest. Folds the §4.8 ratification verdict
 * (~/.claude/shared/inc3a-f2-ratification-verdict-v1.md) evidence-owned findings:
 *   R5   canonical AcceptedJobPolicyV1 byte encoding + digest (this file); digest = escrow PolicyIdentity
 *        index-6 opaque slot (escrow #685) + composition policyLeaf 0x04 (verdict). SUPERSETS termsHash
 *        (oracle #670 pref: ONE policy carrying both terms + subjects).
 *   R3/R4#2  evidenceSubjectBindings[{settlementUnitId, requirementId, sourceKind, propositionKind, valueRef}]
 *            with a CLOSED SubjectSelector grammar (one binding per requirement).
 *   R3#3 (F3) requiredSubject SPLIT into sourceIdentityConstraint + propositionSubjectConstraint.
 *   R4#4 (F4) subject homes + operatorPrincipal:Principal (bytes32 common ref, byte-comparable with
 *            approvedExpertSet/approvedThirdPartyExecutorSet for disjointness).
 * The tier-indexed closed authorityPolicy grammar (F9/R1) lives in the vocab manifest (primitives.ts),
 * documented in the doc; this mirror pins the acceptedPolicyDigest encoding.
 *
 * PROPOSED encoding for cross-family confirm (same propose->cross-confirm loop that closed termsHash/V2).
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node canonical-acceptedjobpolicy-v1-mirror.cjs
 */
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const Z32 = '0x' + '00'.repeat(32);

// ── SubjectSelector CLOSED grammar (R3/R4#2) — u8 kinds; each resolves to a committed policy field ──
const SEL = { NONE:0, POLICY_PAYER:1, EXPERT_SET_MEMBER:2, EXECUTOR_SET_MEMBER:3, EXPECTED_RECIPIENT:4,
  TARGET_SYSTEM:5, AUTHORIZED_TUPLE:6, ORACLE_SELF:7, CHILD_UNIT:8, CHALLENGE_ANCHOR:9,
  CAPTURE_NONCE_ANCHOR:10, EXPECTED_LOCATION:11, EXPECTED_ROUTE_AREA:12, OPERATING_ENVELOPE:13,
  COMMITTED_PROGRAM:14, RECIPE:15, CONTENT_ADDR:16 };

// ── canonical inputs (unit + terms aligned with the termsHash v2.1 golden so the SUPERSET is provable) ──
// termsHash v2.1 inputs (verbatim from termshash-golden-mirror): token 0x..05dc, tier 2, staggered milestones
const token = addr(0x5dcn);
const assuranceTier = 2n;
const milestones = [
  [1n, K('golden-step-1'), 600000n, 2000500000n],   // {milestoneIndex, stepId, amount, deadline}
  [0n, K('golden-step-0'), 400000n, 2000000000n],
];
const TERMS_DOMAIN = K('PCC:vnext:job-terms:v1');
const milestonesRoot = keccak256(enc(['tuple(uint256,bytes32,uint256,uint64)[]'], [milestones]));
const termsHash = keccak256(enc(['bytes32', 'address', 'uint8', 'bytes32'],
  [TERMS_DOMAIN, token, assuranceTier, milestonesRoot]));

// ── subject block (R4#4 homes; Principal = bytes32 common ref) ──
const payer = K('golden-payer');                       // Principal
const operatorPrincipal = K('golden-operator');        // Principal (R4 fix: bytes32, disjoint-comparable)
const operatorSettlementAddress = addr(0x0a71n);       // payout address (corroborates escrow.operator)
// authorized (operator,kernel,device) TUPLES (R4: relationship, not independent set-membership):
// sol: sets require canonical SORT + DEDUP (alias-independent identity) — no author/caller order-freedom.
const sortHex = (a) => [...new Set(a.map((x) => x.toLowerCase()))].sort();          // bytes32[] set
const sortTup = (a) => [...a].sort((x, y) => JSON.stringify(x).toLowerCase() < JSON.stringify(y).toLowerCase() ? -1 : 1); // tuple[] set
const authorizedTuples = sortTup([[operatorPrincipal, K('golden-kernel'), K('golden-device')]]);
const authorizedTuplesRoot = keccak256(enc(['tuple(bytes32,bytes32,bytes32)[]'], [authorizedTuples]));
const approvedExpertSet = sortHex([K('golden-expert-1')]);              // Principal[] set (disjoint from operatorPrincipal)
const approvedThirdPartyExecutorSet = sortHex([K('golden-exec-1')]);    // Principal[] set (R4: disjoint from operator)
const expertSetRoot = keccak256(enc(['bytes32[]'], [approvedExpertSet]));
const executorSetRoot = keccak256(enc(['bytes32[]'], [approvedThirdPartyExecutorSet]));
const expectedRecipient = K('golden-recipient');       // Principal
const targetSystemIdentity = K('golden-target-system');
const committedProgramHash = K('golden-program');
const recipeRef = K('golden-recipe');
const sampleManifestRef = K('golden-sample-manifest');  // R4: distinct field alongside recipeRef
const children = sortTup([[K('golden-child-job'), addr(0xc41dn)]]); // {childJobId, childEscrow} — set-sorted
const childrenRoot = keccak256(enc(['tuple(bytes32,address)[]'], [children]));
// telemetry/freshness subjects (verdict F4 / composition #688 enumeration):
const operatingEnvelopeHash = keccak256(enc(['tuple(bytes32,uint256,uint256)[]'],
  [[[K('power'), 0n, 1000n], [K('temp'), 0n, 250n]]]));  // pre-agreed bands (metric,min,max)
const expectedRouteArea = K('golden-route-area');
const expectedLocationHash = keccak256(enc(['int256', 'int256', 'uint256', 'uint64'],
  [377749000n, -1224194000n, 500n, 1700000000n]));       // {lat,lng,R(m),T}
const captureNonceAnchor = K('golden-capture-nonce');   // job-bound (CAPTURE_NONCE_ANCHOR)
const challengeAnchor = K('golden-challenge-anchor');    // bound to jobIdHash/settlementUnitId (CHALLENGE_ANCHOR)
const integrityGrade = 2n;                              // gps_trail integrity grade (raw/checked/fused/certified)

const SUBJECT_DOMAIN = K('PCC:vnext:accepted-policy-subjects:v1');
// 19 fields: domain + 16 bytes32 + operatorSettlementAddress(address) + integrityGrade(uint8).
const subjectBlockHash = keccak256(enc(
  ['bytes32','bytes32','bytes32','address','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32',
   'bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','uint8'],
  [SUBJECT_DOMAIN, payer, operatorPrincipal, operatorSettlementAddress, authorizedTuplesRoot,
   expertSetRoot, executorSetRoot, expectedRecipient, targetSystemIdentity, committedProgramHash,
   recipeRef, sampleManifestRef, childrenRoot, operatingEnvelopeHash, expectedRouteArea,
   expectedLocationHash, captureNonceAnchor, challengeAnchor, integrityGrade]));

// ── evidenceSubjectBindings (R3/R4#2): one per requirement; {settlementUnitId, requirementId, srcKind, propKind, valueRef} ──
// srcKind = sourceIdentityConstraint (who generated), propKind = propositionSubjectConstraint (what it is about) — the F3 SPLIT.
const settlementUnitId = '0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1'; // gate-1 golden unit
const B = (reqId, src, prop, valueRef) => [settlementUnitId, K(reqId), BigInt(src), BigInt(prop), valueRef];
const bindingsUnsorted = [
  B('req-approval-payer',     SEL.POLICY_PAYER,       SEL.NONE,             payer),                 // payer approves; source=payer, no distinct proposition
  B('req-target-confirm',     SEL.ORACLE_SELF,        SEL.TARGET_SYSTEM,    targetSystemIdentity),  // F3: source=oracle-fetch, proposition=target system
  B('req-escrow-receipt',     SEL.ORACLE_SELF,        SEL.CHILD_UNIT,       children[0][0]),        // F3: source=chain/oracle, proposition=child unit
  B('req-envelope',           SEL.AUTHORIZED_TUPLE,   SEL.OPERATING_ENVELOPE, operatingEnvelopeHash), // source=emitter, proposition=envelope
  B('req-artifact-hash',      SEL.AUTHORIZED_TUPLE,   SEL.CONTENT_ADDR,     Z32),                   // source=emitter, proposition=content (NONE-value)
];
// sol #786 f1 + "sets need sort/dedup": PIN the binding ORDER canonically by (settlementUnitId, requirementId)
// so composition RECOMPUTES bindingsRoot -> acceptedPolicyDigest deterministically (authenticates the bindings,
// no caller order-freedom). Exactly-one binding per (settlementUnitId, requirementId) — reject a duplicate.
const bkey = (r) => r[0].toLowerCase() + r[1].toLowerCase().slice(2);
const seenB = new Set();
for (const r of bindingsUnsorted) { if (seenB.has(bkey(r))) throw new Error('duplicate (settlementUnitId,requirementId) binding'); seenB.add(bkey(r)); }
const bindings = [...bindingsUnsorted].sort((a, b) =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
const bindingsRoot = keccak256(enc(
  ['tuple(bytes32,bytes32,uint8,uint8,bytes32)[]'], [bindings]));

// ── the digest: SUPERSETS termsHash (carries it) + subject block + bindings ──
const POLICY_DOMAIN = K('PCC:vnext:accepted-job-policy:v1');
const POLICY_VERSION = 1n;
const acceptedPolicyDigest = keccak256(enc(
  ['bytes32', 'uint16', 'bytes32', 'bytes32', 'bytes32'],
  [POLICY_DOMAIN, POLICY_VERSION, termsHash, subjectBlockHash, bindingsRoot]));

console.log(`ethers=${E.version || 'v5.x'}\n== CanonicalAcceptedJobPolicyV1 -> acceptedPolicyDigest (PROPOSED; folds R5/R3/R4/F3) ==`);
console.log(`  termsHash (superset, == v2.1 golden) ${termsHash}`);
console.log(`  subjectBlockHash                     ${subjectBlockHash}`);
console.log(`  bindingsRoot                         ${bindingsRoot}`);
console.log(`  acceptedPolicyDigest                 ${acceptedPolicyDigest}\n`);

let ok = true;
const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// SUPERSET proof: the carried termsHash == the independently-published v2.1 golden 0x2cb7a79e..4fe6
chk(termsHash.toLowerCase() === '0x2cb7a79e45cbb5b78b61dbbcc182b2f27ac7991b055a66ef58457459dc2f4fe6',
    'superset: carried termsHash == published v2.1 golden (one policy carries both, oracle #670)');

// negative parity — terms half, subject half, and a binding all bind into acceptedPolicyDigest
const reDigest = (th, sh, br) => keccak256(enc(['bytes32','uint16','bytes32','bytes32','bytes32'], [POLICY_DOMAIN, POLICY_VERSION, th, sh, br]));
chk(reDigest(K('other-terms'), subjectBlockHash, bindingsRoot).toLowerCase() !== acceptedPolicyDigest.toLowerCase(), 'binds: termsHash change -> digest changes');
chk(reDigest(termsHash, K('other-subjects'), bindingsRoot).toLowerCase() !== acceptedPolicyDigest.toLowerCase(), 'binds: subjectBlock change -> digest changes');
chk(reDigest(termsHash, subjectBlockHash, K('other-bindings')).toLowerCase() !== acceptedPolicyDigest.toLowerCase(), 'binds: bindings change -> digest changes');
// F3 split proof: swapping a binding source vs proposition kind changes bindingsRoot (they are DISTINCT axes)
const swapped = bindings.map((b, i) => i === 1 ? [b[0], b[1], b[3], b[2], b[4]] : b); // swap src<->prop on req-target-confirm
chk(keccak256(enc(['tuple(bytes32,bytes32,uint8,uint8,bytes32)[]'], [swapped])).toLowerCase() !== bindingsRoot.toLowerCase(),
    'F3: sourceIdentityConstraint and propositionSubjectConstraint are DISTINCT axes (swap changes root)');
// disjointness precondition (R4): operatorPrincipal must not be in expert/executor sets (byte-comparable now)
const disjoint = !approvedExpertSet.concat(approvedThirdPartyExecutorSet).map(x=>x.toLowerCase()).includes(operatorPrincipal.toLowerCase());
chk(disjoint, 'R4: operatorPrincipal (bytes32) is byte-disjoint from expert+executor sets');

// ── pinned PROPOSED golden (oracle cross-confirms, like termsHash/V2); re-pins if sub-type encodings change ──
const EXPECT = {
  subjectBlockHash:     '0x05fb7b45f6079ca2c82f6b3676e8af2cf98f3322bdc1e64acf0afc2aef2c46c7',
  bindingsRoot:         '0xb0fac97112a3e02d1c80e1017d033fa8d224b4ccf64de25ea5eaa0820ab6a340', // re-golden: bindings canonically sorted (sol #786 f1)
  acceptedPolicyDigest: '0xe616864b43af297effb3215ee6ed89bb3d0b19db20226a472a5b6ef216b2a3ee', // was 0xf6af20eb (unsorted); sorted-bindings is the authoritative form
};
console.log('');
for (const [k, v] of [['subjectBlockHash', subjectBlockHash], ['bindingsRoot', bindingsRoot], ['acceptedPolicyDigest', acceptedPolicyDigest]])
  chk(v.toLowerCase() === EXPECT[k].toLowerCase(), `pinned proposed-golden ${k} == ${EXPECT[k]}`);

console.log(`\n${ok ? 'CanonicalAcceptedJobPolicyV1 mirror OK (proposed encoding; folds R5/R3/R4/F3; supersets termsHash). Awaits oracle cross-confirm + composition policyLeaf 0x04 wiring + escrow idx-6 opaque commit.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
