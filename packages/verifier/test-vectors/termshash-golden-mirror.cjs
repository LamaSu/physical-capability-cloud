#!/usr/bin/env node
/* termshash-golden-mirror.cjs — EVIDENCE lane (92dc40cb) independent ethers mirror for the v-next
 * termsHash canonical encoding (CanonicalJobTermsV1 v2, cross-family ratified: escrow #491 + oracle
 * #492/#495 + sol rounds 1-2). Produces the byte-exact golden the oracle mirrors before any mint.
 *
 * Encoding (termsHash is ONE field of the 7-field PolicyIdentity; opaque to the escrow; payer+operator
 * +oracle must derive it byte-identically):
 *   TERMS_DOMAIN   = keccak256("PCC:vnext:job-terms:v1")
 *   milestonesRoot = keccak256(abi.encode( (uint256 milestoneIndex, bytes32 stepId, uint256 amount)[] ))
 *   termsHash      = keccak256(abi.encode(TERMS_DOMAIN, token, assuranceTier, deadline, milestonesRoot))
 * Rules: PIN milestones[] to the funded UnitConfig[] order — NEVER sort. amount = UnitConfig.g in the
 * settlement token's base units (USDC, 6 decimals). termsHash is PURE (no chain/factory — bound by the
 * salt + the two oracle domains + settlementUnitId). abi.encode ONLY (never encodePacked).
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

// ── domain constant (published as BOTH source-string and bytes32) ──
const TERMS_DOMAIN_STR = 'PCC:vnext:job-terms:v1';
const TERMS_DOMAIN = K(TERMS_DOMAIN_STR);

// ── canonical golden inputs (USDC = 6 decimals; amounts in base units) ──
const token = addr(0x05dcn);          // canonical settlement-token (USDC) marker
const assuranceTier = 2n;             // uint8
const deadline = 2000000000n;         // uint64 UTC Unix seconds (job-level; predicate: == every unit's reclaimAt)
// UNSORTED on purpose (funded UnitConfig[] is unique-but-unordered): position 0 carries milestoneIndex 1.
const MS_TYPE = 'tuple(uint256,bytes32,uint256)[]';
const milestones = [
  [1n, K('golden-step-1'), 600000n], // 0.6 USDC ; funded gross g
  [0n, K('golden-step-0'), 400000n], // 0.4 USDC ; sum = 1000000 (1 USDC), echoes the O5 golden G
];
const milestonesRoot = keccak256(enc([MS_TYPE], [milestones]));
const termsHash = keccak256(enc(
  ['bytes32', 'address', 'uint8', 'uint64', 'bytes32'],
  [TERMS_DOMAIN, token, assuranceTier, deadline, milestonesRoot]));

console.log(`ethers=${E.version || 'v5.x'}  (independent of the Solidity contract)\n`);
console.log('== termsHash GOLDEN (CanonicalJobTermsV1 v2) ==');
console.log(`  TERMS_DOMAIN        "${TERMS_DOMAIN_STR}"`);
console.log(`  TERMS_DOMAIN bytes32 ${TERMS_DOMAIN}`);
console.log(`  token                ${token}`);
console.log(`  assuranceTier        ${assuranceTier}`);
console.log(`  deadline             ${deadline}`);
console.log(`  milestones (funded order, UNSORTED): [ {idx:1,step:golden-step-1,amt:600000}, {idx:0,step:golden-step-0,amt:400000} ]`);
console.log(`  milestonesRoot       ${milestonesRoot}`);
console.log(`  termsHash            ${termsHash}\n`);

// ── negative parity: each single-field mutation MUST change termsHash ──
const rehash = (ms, tok = token, tier = assuranceTier, dl = deadline) =>
  keccak256(enc(['bytes32', 'address', 'uint8', 'uint64', 'bytes32'],
    [TERMS_DOMAIN, tok, tier, dl, keccak256(enc([MS_TYPE], [ms]))]));
const neg = [
  ['reorder milestones [1,0]->[0,1] (order IS committed)', rehash([milestones[1], milestones[0]])],
  ['change milestoneIndex (pos0 1->2)', rehash([[2n, milestones[0][1], milestones[0][2]], milestones[1]])],
  ['change amount (pos0 600000->600001)', rehash([[milestones[0][0], milestones[0][1], 600001n], milestones[1]])],
  ['change stepId (pos0)', rehash([[milestones[0][0], K('golden-step-1-x'), milestones[0][2]], milestones[1]])],
  ['change deadline (+1)', rehash(milestones, token, assuranceTier, deadline + 1n)],
  ['change assuranceTier (2->3)', rehash(milestones, token, 3n, deadline)],
  ['change token (+1)', rehash(milestones, addr(0x05ddn), assuranceTier, deadline)],
];
let ok = true;
for (const [label, h] of neg) {
  const changed = h.toLowerCase() !== termsHash.toLowerCase();
  ok = ok && changed;
  console.log(`${changed ? 'PASS' : 'FAIL'}  negative-parity: ${label}`);
}
console.log(`\n${ok ? 'termsHash GOLDEN + negative parity: OK' : 'termsHash GOLDEN: DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
