#!/usr/bin/env node
/* evidencecommitment-golden-mirror.cjs — EVIDENCE lane (92dc40cb) independent ethers mirror for the
 * v-next evidenceCommitment (seam §0.4 evidence-binding). This is the DOMAIN-SEPARATED commitment that
 * the on-chain `evidenceBundleHash` must equal — oracle #472 P0-2 replaced the raw packageHash with it
 * (a raw-digest verdict was unmintable). Third independent implementation of the seam's evidence-binding
 * hash: Solidity `VNextSettlementLib.computeEvidenceCommitment` (@ b427d0ad) == oracle mirror == this.
 *
 *   EVIDENCE_COMMITMENT_DOMAIN = keccak256("PCC:vnext:evidence-commitment:v1")
 *   packageFormat              = EVIDENCE_PACKAGE_FORMAT_V1 = 1
 *   packageDigest              = SHA-256(JCS(FinalMilestonePackage))            (seam §0.4)
 *   evidenceCommitment = keccak256(abi.encode(
 *       EVIDENCE_COMMITMENT_DOMAIN, chainId, escrow, settlementUnitId,
 *       compositionSchemaVersion (uint16), packageFormat (uint8), packageDigest))
 *
 * Unlike termsHash (PURE), the evidence commitment is CHAIN + ESCROW bound (it names the specific unit
 * being settled). Run:
 *   NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node evidencecommitment-golden-mirror.cjs
 */
const E = require('ethers');
const crypto = require('crypto');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const sha256hex = (s) => '0x' + crypto.createHash('sha256').update(s).digest('hex');
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');

const EC_DOMAIN_STR = 'PCC:vnext:evidence-commitment:v1';
const EC_DOMAIN = K(EC_DOMAIN_STR);
const PACKAGE_FORMAT_V1 = 1n;

// ── canonical inputs (aligned with the gate-1 golden set) ──
const chainId = 8453n;
const escrow = addr(0xe5c0fn);
// settlementUnitId derived exactly as gate-1 (self-consistent with gate1-golden-mirror.cjs -> 0x4453a3d2..)
const SUD = K('PCC:vnext:settlement-unit:v1');
const settlementUnitId = keccak256(enc(
  ['bytes32', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32'],
  [SUD, chainId, escrow, K('golden-job'), 3n, K('golden-step')]));
const compositionSchemaVersion = 1n;                 // uint16 sample
const packageDigest = sha256hex('golden-package');   // SHA-256(JCS(FinalMilestonePackage)) sample (§0.4)

const EC_TYPES = ['bytes32', 'uint256', 'address', 'bytes32', 'uint16', 'uint8', 'bytes32'];
const evidenceCommitment = keccak256(enc(EC_TYPES,
  [EC_DOMAIN, chainId, escrow, settlementUnitId, compositionSchemaVersion, PACKAGE_FORMAT_V1, packageDigest]));

console.log(`ethers=${E.version || 'v5.x'}  (independent of the Solidity contract)\n`);
console.log('== evidenceCommitment GOLDEN (seam §0.4 evidence-binding) ==');
console.log(`  EVIDENCE_COMMITMENT_DOMAIN "${EC_DOMAIN_STR}"`);
console.log(`  EVIDENCE_COMMITMENT_DOMAIN bytes32 ${EC_DOMAIN}`);
console.log(`  chainId ${chainId}   escrow ${escrow}`);
console.log(`  settlementUnitId ${settlementUnitId}  (== gate-1 golden unit 0x4453a3d2..)`);
console.log(`  compositionSchemaVersion ${compositionSchemaVersion}   packageFormat ${PACKAGE_FORMAT_V1}`);
console.log(`  packageDigest SHA-256("golden-package") ${packageDigest}`);
console.log(`  evidenceCommitment ${evidenceCommitment}\n`);

const re = (a) => keccak256(enc(EC_TYPES, a));
const neg = [
  ['chainId 8453->84532 (chain-bound)', [EC_DOMAIN, 84532n, escrow, settlementUnitId, compositionSchemaVersion, PACKAGE_FORMAT_V1, packageDigest]],
  ['escrow +1 (escrow-bound)', [EC_DOMAIN, chainId, addr(0xe5c10n), settlementUnitId, compositionSchemaVersion, PACKAGE_FORMAT_V1, packageDigest]],
  ['settlementUnitId change', [EC_DOMAIN, chainId, escrow, K('other-unit'), compositionSchemaVersion, PACKAGE_FORMAT_V1, packageDigest]],
  ['compositionSchemaVersion 1->2', [EC_DOMAIN, chainId, escrow, settlementUnitId, 2n, PACKAGE_FORMAT_V1, packageDigest]],
  ['packageFormat 1->2', [EC_DOMAIN, chainId, escrow, settlementUnitId, compositionSchemaVersion, 2n, packageDigest]],
  ['packageDigest change', [EC_DOMAIN, chainId, escrow, settlementUnitId, compositionSchemaVersion, PACKAGE_FORMAT_V1, sha256hex('golden-package-x')]],
];
let ok = true;
for (const [label, a] of neg) { const c = re(a).toLowerCase() !== evidenceCommitment.toLowerCase(); ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  negative-parity: ${label}`); }
console.log(`\n${ok ? 'evidenceCommitment GOLDEN + negative parity: OK' : 'evidenceCommitment GOLDEN: DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
