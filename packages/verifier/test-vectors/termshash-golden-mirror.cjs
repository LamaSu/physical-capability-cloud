#!/usr/bin/env node
/* termshash-golden-mirror.cjs — EVIDENCE lane (92dc40cb) independent ethers mirror for the v-next
 * termsHash canonical encoding — CanonicalJobTermsV1 v2.1 (deadline PER-MILESTONE).
 * Cross-family ratified: escrow #491/#499 + oracle #492/#495/#500 + sol rounds 1-2.
 * v2.1 change (escrow #499 + oracle #500): reclaimAt is PER-UNIT VARIABLE on-chain (no uniformity
 * constraint; staggered milestone deadlines are a supported shape), so `deadline` moves INTO the
 * per-milestone struct to mirror UnitConfig 1:1. A single job-level deadline would falsely assert a
 * uniformity the contract does not enforce.
 *
 * Encoding:
 *   TERMS_DOMAIN   = keccak256("PCC:vnext:job-terms:v1")
 *   milestonesRoot = keccak256(abi.encode( (uint256 milestoneIndex, bytes32 stepId, uint256 amount, uint64 deadline)[] ))
 *   termsHash      = keccak256(abi.encode(TERMS_DOMAIN, token, assuranceTier, milestonesRoot))
 * Rules: PIN milestones[] to the funded UnitConfig[] order — NEVER sort. amount = UnitConfig.g (USDC
 * base units, 6 dp); deadline = UnitConfig.reclaimAt (per-unit). termsHash is PURE (no chain/factory).
 * abi.encode ONLY.
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node termshash-golden-mirror.cjs
 */
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');

const TERMS_DOMAIN_STR = 'PCC:vnext:job-terms:v1';
const TERMS_DOMAIN = K(TERMS_DOMAIN_STR);

// ── canonical golden inputs (USDC = 6 decimals; amounts in base units) ──
const token = addr(0x05dcn);
const assuranceTier = 2n;             // uint8 (job-level; == requiredTier == requestedTier per oracle #495)
// milestones: FUNDED order, deliberately UNSORTED (pos0 carries milestoneIndex 1) AND staggered deadlines (per-milestone).
const MS_TYPE = 'tuple(uint256,bytes32,uint256,uint64)[]';  // (milestoneIndex, stepId, amount, deadline)
const milestones = [
  [1n, K('golden-step-1'), 600000n, 2000500000n], // idx1, 0.6 USDC, later deadline
  [0n, K('golden-step-0'), 400000n, 2000000000n], // idx0, 0.4 USDC, earlier deadline (staggered => proves per-milestone)
];
const milestonesRoot = keccak256(enc([MS_TYPE], [milestones]));
const termsHash = keccak256(enc(
  ['bytes32', 'address', 'uint8', 'bytes32'],
  [TERMS_DOMAIN, token, assuranceTier, milestonesRoot]));

console.log(`ethers=${E.version || 'v5.x'}  (independent of the Solidity contract)\n`);
console.log('== termsHash GOLDEN (CanonicalJobTermsV1 v2.1 — deadline PER-MILESTONE) ==');
console.log(`  TERMS_DOMAIN        "${TERMS_DOMAIN_STR}"`);
console.log(`  TERMS_DOMAIN bytes32 ${TERMS_DOMAIN}`);
console.log(`  token                ${token}`);
console.log(`  assuranceTier        ${assuranceTier}`);
console.log(`  milestones (funded order, UNSORTED, STAGGERED deadlines):`);
console.log(`    [0] {idx:1, step:golden-step-1, amt:600000, deadline:2000500000}`);
console.log(`    [1] {idx:0, step:golden-step-0, amt:400000, deadline:2000000000}`);
console.log(`  milestonesRoot       ${milestonesRoot}`);
console.log(`  termsHash            ${termsHash}\n`);

// ── negative parity: each single-field mutation MUST change termsHash ──
const rehash = (ms, tok = token, tier = assuranceTier) =>
  keccak256(enc(['bytes32', 'address', 'uint8', 'bytes32'],
    [TERMS_DOMAIN, tok, tier, keccak256(enc([MS_TYPE], [ms]))]));
const m = milestones;
const neg = [
  ['reorder milestones [1,0]->[0,1] (order IS committed)', rehash([m[1], m[0]])],
  ['change milestoneIndex (pos0 1->2)', rehash([[2n, m[0][1], m[0][2], m[0][3]], m[1]])],
  ['change amount (pos0 600000->600001)', rehash([[m[0][0], m[0][1], 600001n, m[0][3]], m[1]])],
  ['change stepId (pos0)', rehash([[m[0][0], K('golden-step-1-x'), m[0][2], m[0][3]], m[1]])],
  ['change per-milestone deadline (pos0 +1)', rehash([[m[0][0], m[0][1], m[0][2], 2000500001n], m[1]])],
  ['change assuranceTier (2->3)', rehash(m, token, 3n)],
  ['change token (+1)', rehash(m, addr(0x05ddn), assuranceTier)],
];
let ok = true;
for (const [label, h] of neg) {
  const changed = h.toLowerCase() !== termsHash.toLowerCase();
  ok = ok && changed;
  console.log(`${changed ? 'PASS' : 'FAIL'}  negative-parity: ${label}`);
}
console.log(`\n${ok ? 'termsHash GOLDEN v2.1 + negative parity: OK' : 'termsHash GOLDEN: DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
