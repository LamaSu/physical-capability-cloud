#!/usr/bin/env node
/* authoritypolicy-projection-v1-mirror.cjs — EVIDENCE lane (92dc40cb). The COMMITTED manifest projection
 * that composition (Model A static check, #724/#730) + oracle (runtime role check, #710/#730) BOTH read,
 * so their checks cannot diverge (oracle #730: "same committed manifest = the two checks cannot disagree").
 *
 * projection row = (evidenceTypeId, tier) -> { allowedSourceRoles (u8 bitset), propositionSubjectConstraint (SubjectSelector u8) }
 *   - COMPOSITION static @derivation: exactly-one binding; propositionKind in {0..16}; propositionKind == this
 *     projection propositionSubjectConstraint for (evidenceType,tier); role in allowedSourceRoles. (F3 proposition+role side.)
 *   - ORACLE runtime @settlement: reads allowedSourceRoles here + the sourceIdentityConstraint from the full
 *     authorityPolicy manifest, checks the ACTUAL producer. (F3 source side — NOT in this projection; no producer at derivation.)
 * roles bitset: emitter(1)=0b001, evaluator(2)=0b010, oracle(3)=0b100.
 * SubjectSelector: 0 NONE,1 POLICY_PAYER,2 EXPERT_SET,3 EXECUTOR_SET,4 EXPECTED_RECIPIENT,5 TARGET_SYSTEM,
 *   6 AUTHORIZED_TUPLE,7 ORACLE_SELF,8 CHILD_UNIT,9 CHALLENGE_ANCHOR,10 CAPTURE_NONCE_ANCHOR,11 EXPECTED_LOCATION,
 *   12 EXPECTED_ROUTE_AREA,13 OPERATING_ENVELOPE,14 COMMITTED_PROGRAM,15 RECIPE,16 CONTENT_ADDR.
 * PROPOSED (cross-family confirm, like termsHash/V2/acceptedPolicyDigest).
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node authoritypolicy-projection-v1-mirror.cjs
 */
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));

// roles bitsets + SubjectSelector kinds
const EMIT=1, EVAL=2, ORAC=4;                 // bit0/1/2
const S = { NONE:0, PAYER:1, EXPERT:2, EXECUTOR:3, RECIPIENT:4, TARGET:5, TUPLE:6, ORACLE_SELF:7, CHILD:8,
  CHALLENGE:9, CAPTURE_NONCE:10, LOCATION:11, ROUTE_AREA:12, ENVELOPE:13, PROGRAM:14, RECIPE:15, CONTENT:16 };

// per-primitive: id, tiers[], roles(bitset), propositionKind. (tier-variant rows listed separately.)
const P = [
  ['approval.payer',                 [2,3], EVAL,        S.NONE],
  ['approval.expert',                [2,3], EVAL,        S.NONE],
  ['confirm.execution_mode',   [0,1,2,3], EMIT,          S.NONE],       // gate
  ['decl.self_attested',             [0],   EMIT,        S.NONE],
  ['artifact.hash',              [1,2,3],   EMIT,        S.CONTENT],
  ['fresh.challenge_bound',      [1,2,3],   EMIT,        S.CHALLENGE],
  ['pay.escrow_receipt',       [0,1,2,3],   ORAC,        S.CHILD],
  ['ident.registered_key',       [1,2,3],   EMIT|EVAL|ORAC, S.NONE],    // enabler: valueRef->enabled requirementId (#711)
  ['receipt.kernel_signed',        [1,2],   EMIT,        S.NONE],
  ['telemetry.geofence_event',     [1,2],   EMIT,        S.LOCATION],
  ['confirm.recipient_nonce',        [2],   EVAL,        S.NONE],
  ['confirm.recipient_signature',  [1,2],   EVAL,        S.NONE],
  ['capture.photo_nonced',         [1,2],   EMIT,        S.CAPTURE_NONCE],
  ['telemetry.gps_trail',        [1,2,3],   EMIT,        S.ROUTE_AREA],
  ['confirm.target_system',        [1,2],   EVAL|ORAC,   S.TARGET],
  ['machine.execution_log',      [1,2,3],   EMIT,        S.PROGRAM],
  ['telemetry.envelope_conformance',[1,2,3],EMIT,        S.ENVELOPE],
  ['telemetry.coverage_gate',  [0,1,2,3],   EMIT,        S.NONE],       // gate
  ['process.batch_record',       [1,2,3],   EMIT,        S.RECIPE],
];
// tier-VARIANT: measure.io_test_pair (t1 operator-run vs t2 oracle/third-party-executed) — roles differ by tier.
const PV = [
  ['measure.io_test_pair', 1, EMIT,      S.NONE],   // t1: operator self-test
  ['measure.io_test_pair', 2, EVAL|ORAC, S.NONE],   // t2: oracle-executed or approved third-party executor
];

// build rows {evidenceTypeId=keccak(id), tier, roles, propositionKind}
const rows = [];
for (const [id, tiers, roles, prop] of P) for (const t of tiers) rows.push([K(id), t, roles, prop]);
for (const [id, t, roles, prop] of PV) rows.push([K(id), t, roles, prop]);

// CANONICAL-SORT by (evidenceTypeId asc, tier asc) — keyed lookup set, order carries no meaning (NOT a never-sort violation).
rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);

const PROJECTION_DOMAIN = K('PCC:vnext:authoritypolicy-projection:v1');
const PROJECTION_VERSION = 1n;
const rowsRoot = keccak256(enc(['tuple(bytes32,uint8,uint8,uint8)[]'], [rows]));
const projectionDigest = keccak256(enc(['bytes32', 'uint16', 'uint256', 'bytes32'],
  [PROJECTION_DOMAIN, PROJECTION_VERSION, BigInt(rows.length), rowsRoot]));

console.log(`ethers=${E.version || 'v5.x'}\n== authorityPolicy PROJECTION (evidenceType,tier)->{roles,propositionKind} — composition+oracle read this ==`);
console.log(`  rows: ${rows.length}   rowsRoot ${rowsRoot}`);
console.log(`  projectionDigest ${projectionDigest}\n`);

let ok = true;
const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// lookup helper (what composition/oracle do): (evidenceType,tier) -> {roles, propositionKind}
const lookup = (id, tier) => { const r = rows.find(x => x[0] === K(id) && x[1] === tier); return r ? { roles: r[2], prop: r[3] } : null; };
// spot-checks that the F3 proposition side is what composition asserts against:
chk(lookup('confirm.target_system', 2).prop === S.TARGET && lookup('confirm.target_system', 2).roles === (EVAL|ORAC),
    'lookup: confirm.target_system t2 -> propositionKind=TARGET_SYSTEM, roles={evaluator,oracle}');
chk(lookup('approval.payer', 2).prop === S.NONE && lookup('approval.payer', 2).roles === EVAL,
    'lookup: approval.payer t2 -> propositionKind=NONE, roles={evaluator} (expert cannot pass: role+subject at runtime)');
chk(lookup('measure.io_test_pair', 1).roles === EMIT && lookup('measure.io_test_pair', 2).roles === (EVAL|ORAC),
    'lookup: measure.io_test_pair is TIER-VARIANT — t1 roles={emitter}, t2 roles={evaluator,oracle} (F9 tier-indexed)');
chk(lookup('artifact.hash', 1).prop === S.CONTENT && lookup('pay.escrow_receipt', 0).prop === S.CHILD,
    'lookup: artifact.hash->CONTENT_ADDR, pay.escrow_receipt->CHILD_UNIT (proposition != producer, F3 split)');
// coverage: every one of the 20 primitives has >=1 row
const ids = new Set(rows.map(r => r[0]));
chk(ids.size === 20, `coverage: all 20 primitives present (got ${ids.size})`);
// determinism: sort is canonical -> re-sorting a shuffled copy gives the same rowsRoot
const shuffled = [...rows].reverse().sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
chk(keccak256(enc(['tuple(bytes32,uint8,uint8,uint8)[]'], [shuffled])).toLowerCase() === rowsRoot.toLowerCase(),
    'canonical-sort: order-independent (shuffled input -> identical rowsRoot)');
// negative parity: flip one row role or prop -> projectionDigest changes
const mut = rows.map((r, i) => i === 0 ? [r[0], r[1], r[2] ^ ORAC, r[3]] : r);
const mutRoot = keccak256(enc(['tuple(bytes32,uint8,uint8,uint8)[]'], [mut]));
chk(mutRoot.toLowerCase() !== rowsRoot.toLowerCase(), 'binds: flipping one role bit -> rowsRoot (and projectionDigest) changes');

// ── pinned PROPOSED golden (composition+oracle cross-confirm, then fold into VOCAB_MANIFEST_HASH) ──
const EXPECT = {
  rowsRoot:         '0x661a81120ed7ce419ada0091e5a6d4b3923dc1ffa18fc286b3041b85fa7ec68a',
  projectionDigest: '0xb044b20b6ea2470f0d80e2fc73651c77a9dfc406707df1dfec460335f5a83900',
};
chk(rows.length === 51, `row count == 51 (20 primitives x their tiers)`);
for (const [k, val] of [['rowsRoot', rowsRoot], ['projectionDigest', projectionDigest]])
  chk(val.toLowerCase() === EXPECT[k].toLowerCase(), `pinned proposed-golden ${k} == ${EXPECT[k]}`);

console.log(`\n${ok ? 'authorityPolicy projection mirror OK — the committed (evidenceType,tier)->{roles,propositionKind} table for composition Model A + oracle runtime. Awaits composition+oracle cross-confirm + fold into VOCAB_MANIFEST_HASH.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
