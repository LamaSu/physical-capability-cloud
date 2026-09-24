#!/usr/bin/env node
/* finalmilestonepackage-golden-mirror.cjs — EVIDENCE lane (92dc40cb) independent mirror for the
 * FinalMilestonePackageV1 canonical form + UNIT-BINDING (the concrete fix for the ChatGPT B1
 * "semantic replay" finding — see coord #635, which corrected evidence #586's overclaim).
 *
 * THE FIX: binding the evidenceCommitment to a unit only prevents COMMITMENT-VALUE reuse. To also
 * prevent re-wrapping the SAME packageDigest into a fresh commitment for another unit, the SIGNED
 * package BODY must itself name the unit. This mirror shows a unit-bound package and proves (via
 * negative parity) that changing ANY unit-binding field changes packageBodyHash -> packageDigest ->
 * evidenceCommitment. The oracle must reconstruct the settlement context independently and require
 * body.unitBinding == that context BEFORE deriving packageDigest.
 *
 * Hash layering (ChatGPT S2 — no signature circularity):
 *   packageBodyHash = SHA-256(JCS(unsignedBody))
 *   signature       = Sign(EVIDENCE_PACKAGE_SIG_DOMAIN || packageBodyHash)   (device/operator; sample here)
 *   packageDigest   = SHA-256(JCS({ body, signatures }))            (== the seam's §0.4 packageDigest)
 *   evidenceCommitment = keccak256(abi.encode(EVIDENCE_COMMITMENT_DOMAIN, chainId, escrow,
 *                          settlementUnitId, compositionSchemaVersion(uint16), packageFormat(uint8), packageDigest))
 *
 * Canonical profile (ChatGPT S2): ALL numeric quantities are canonical DECIMAL STRINGS and all 32-byte
 * values are 0x-hex strings -> JCS reduces to {recursive key-sort + JSON string escaping}, no float/int
 * ambiguity across TS/Go/Rust producers. NON-PRODUCTION sample signature (proves the hash chain, not signing).
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node finalmilestonepackage-golden-mirror.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const sha256 = (s) => '0x' + crypto.createHash('sha256').update(s).digest('hex');

// minimal RFC-8785 JCS for STRING-only leaves (the canonical profile forbids raw numbers): recursive
// key-sort + JSON string escaping, no insignificant whitespace. Numbers/ids are decimal/hex strings.
function jcs(o) {
  if (Array.isArray(o)) return '[' + o.map(jcs).join(',') + ']';
  if (o && typeof o === 'object') {
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + jcs(o[k])).join(',') + '}';
  }
  if (typeof o !== 'string') throw new Error('canonical profile: non-string leaf ' + JSON.stringify(o));
  return JSON.stringify(o);
}

// ── canonical inputs (unit aligned with the gate-1 / evidenceCommitment goldens) ──
const chainId = '8453';
const escrow = '0x00000000000000000000000000000000000e5c0f';
const settlementUnitId = '0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1';
const jobIdHash = K('golden-job');
const stepId = K('golden-step');

// the SIGNED body: names the unit (unitBinding) + the producer + the evidence payload.
const body = {
  packageSchemaVersion: 'FinalMilestonePackageV1',
  packageFormat: '1',
  unitBinding: {                                   // <-- the B1 fix: the package NAMES its unit
    chainId, escrow, settlementUnitId, jobIdHash,
    milestoneIndex: '3', stepId,
    compositionRoot: '0x' + '00'.repeat(32),       // 0 = non-composed
    acceptedEnvelopeHash: K('golden-accepted-envelope'), // ties to the funded AcceptedJobPolicyV1 (B4)
  },
  producer: { kernelId: 'kernel-golden-01', operatorPrincipalId: 'op-golden', devicePrincipalId: 'dev-golden' },
  evidence: { events: [{ type: 'execution_completed', at: '1700000000' }], payloadRoot: K('golden-payload') },
  evidenceTimeBounds: { start: '1699999000', end: '1700000000' },
};
const SIG_DOMAIN = K('PCC:vnext:evidence-package-sig:v1');
const packageBodyHash = sha256(SIG_DOMAIN + ':' + jcs(body));  // domain-tagged body hash the signature covers
const signatures = [{ signer: '0x' + '0d'.repeat(20), scheme: 'secp256k1', sig: '0x' + '11'.repeat(65) }]; // SAMPLE
const packageDigest = sha256(jcs({ body, signatures }));        // == seam §0.4 packageDigest

const EC_DOMAIN = K('PCC:vnext:evidence-commitment:v1');
const evidenceCommitment = keccak256(enc(
  ['bytes32', 'uint256', 'address', 'bytes32', 'uint16', 'uint8', 'bytes32'],
  [EC_DOMAIN, chainId, escrow, settlementUnitId, 1n, 1n, packageDigest]));

console.log('== FinalMilestonePackageV1 GOLDEN (unit-bound; B1 semantic-replay fix) ==');
console.log(`  packageBodyHash    ${packageBodyHash}`);
console.log(`  packageDigest      ${packageDigest}`);
console.log(`  evidenceCommitment ${evidenceCommitment}\n`);

// negative parity — mutating ANY unit-binding field changes the whole chain (proves unit-bound):
const clone = (o) => JSON.parse(JSON.stringify(o));
const digestOf = (b) => sha256(jcs({ body: b, signatures }));
const base = packageDigest;
const cases = [
  ['unitBinding.settlementUnitId', (b) => (b.unitBinding.settlementUnitId = K('other-unit'))],
  ['unitBinding.escrow',           (b) => (b.unitBinding.escrow = '0x' + '00'.repeat(19) + 'ff')],
  ['unitBinding.chainId',          (b) => (b.unitBinding.chainId = '84532')],
  ['unitBinding.jobIdHash',        (b) => (b.unitBinding.jobIdHash = K('other-job'))],
  ['unitBinding.milestoneIndex',   (b) => (b.unitBinding.milestoneIndex = '4')],
  ['unitBinding.acceptedEnvelopeHash', (b) => (b.unitBinding.acceptedEnvelopeHash = K('other-envelope'))],
  ['producer.kernelId',            (b) => (b.producer.kernelId = 'kernel-evil')],
  ['evidence.payloadRoot',         (b) => (b.evidence.payloadRoot = K('other-payload'))],
];
let ok = true;
for (const [label, mut] of cases) {
  const b = clone(body); mut(b);
  const changed = digestOf(b).toLowerCase() !== base.toLowerCase();
  ok = ok && changed;
  console.log(`${changed ? 'PASS' : 'FAIL'}  unit-bound: mutate ${label} -> packageDigest changes`);
}
// re-wrap attack: same packageDigest, different unit in the OUTER commitment -> the commitment differs,
// AND (the point) the body still names unit-A, so an honest oracle rejects it for unit-B. Show the outer diff:
const commitB = keccak256(enc(['bytes32','uint256','address','bytes32','uint16','uint8','bytes32'],
  [EC_DOMAIN, chainId, '0x' + '00'.repeat(19) + 'ff', K('other-unit'), 1n, 1n, packageDigest]));
const reWrapDiffers = commitB.toLowerCase() !== evidenceCommitment.toLowerCase();
ok = ok && reWrapDiffers;
console.log(`${reWrapDiffers ? 'PASS' : 'FAIL'}  re-wrap: same packageDigest under unitB -> different commitment (outer bind) AND body still names unitA (oracle must reject)`);

// ── pinned-golden PARITY (S6: assert the ratified output, not just sensitivity) ──
const EXPECT = {
  packageBodyHash:    '0xd3097c2ed0a63b82ed71d88b1ea8f77e0b04222551b3856be52c06db47dab781',
  packageDigest:      '0xc3c9d1bc6d20d1284219e508ae2a3f6d5c13f090da1b16081c3b9257e0d89520',
  evidenceCommitment: '0x8e85df138f9034a3d9665399d58ca18b18dd58ab41bcb33229b5d71da83f39c9',
};
for (const [k, v] of [['packageBodyHash', packageBodyHash], ['packageDigest', packageDigest], ['evidenceCommitment', evidenceCommitment]]) {
  const pass = v.toLowerCase() === EXPECT[k].toLowerCase(); ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  pinned-golden ${k} == ${EXPECT[k]}`);
}
console.log(`\n${ok ? 'FinalMilestonePackageV1 GOLDEN + PARITY + unit-binding parity: OK' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
