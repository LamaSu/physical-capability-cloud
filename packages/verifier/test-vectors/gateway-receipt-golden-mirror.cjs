#!/usr/bin/env node
/* gateway-receipt-golden-mirror.cjs — EVIDENCE lane (92dc40cb) independent mirror for the gateway
 * effectiveEvidenceTime RECEIPT (oracle #703, gateway-owned build / oracle-owned struct). The receipt
 * is the T_hi (received-by) anchor of oracle #654's [T_lo, T_hi] window; gateway ed25519-signs THIS
 * 32-byte digest out-of-band, oracle recomputes + verifies before trusting receivedAt.
 *
 * Evidence mirrors it because the receipt binds EVIDENCE'S packageDigest (the FinalMilestonePackageV2
 * golden 0xe1e5c30d..3fb5) — a receipt cannot be replayed onto other evidence. Third independent
 * re-implementation of oracle's encoding (same propose->cross-confirm loop as termsHash/O5/V2/acceptedPolicyDigest).
 *
 *   GATEWAY_RECEIPT_DOMAIN = keccak256("PCC:vnext:gateway-receipt:v1")
 *   receiptDigest = keccak256(abi.encode(DOMAIN, uint16 v, uint256 chainId, address escrow,
 *                     bytes32 settlementUnitId, bytes32 packageDigest, uint64 receivedAt))
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node gateway-receipt-golden-mirror.cjs
 */
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');

// ── domain (verify the string derives oracle's published bytes32) ──
const DOMAIN_STR = 'PCC:vnext:gateway-receipt:v1';
const GATEWAY_RECEIPT_DOMAIN = K(DOMAIN_STR);

// ── oracle #703 published golden inputs (packageDigest = the V2 golden) ──
const v = 1n;                                   // uint16
const chainId = 8453n;                          // uint256
const escrow = addr(0xe5c0fn);                  // address 0x..0E5C0F
const settlementUnitId = '0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1';
const packageDigest = '0xe1e5c30d2ed795e28ccb035edc53daacf13c5a077686dc4141c49ed9768a3fb5'; // FinalMilestonePackageV2 golden
const receivedAt = 1700000000n;                 // uint64

const RCPT_TYPES = ['bytes32', 'uint16', 'uint256', 'address', 'bytes32', 'bytes32', 'uint64'];
const receiptDigest = keccak256(enc(RCPT_TYPES,
  [GATEWAY_RECEIPT_DOMAIN, v, chainId, escrow, settlementUnitId, packageDigest, receivedAt]));

console.log(`ethers=${E.version || 'v5.x'}\n== gateway RECEIPT (effectiveEvidenceTime T_hi) — evidence mirror of oracle #703 ==`);
console.log(`  GATEWAY_RECEIPT_DOMAIN "${DOMAIN_STR}" -> ${GATEWAY_RECEIPT_DOMAIN}`);
console.log(`  packageDigest (V2 golden, bound in)     ${packageDigest}`);
console.log(`  receiptDigest                           ${receiptDigest}\n`);

let ok = true;
const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// (1) domain byte-match vs oracle #703 published value
chk(GATEWAY_RECEIPT_DOMAIN.toLowerCase() === '0xc6ba37cf35ac305d82792d994f57aaeca940fad501e197ab9057214ff4d67699',
    'domain: keccak256("PCC:vnext:gateway-receipt:v1") == oracle #703 published 0xc6ba37cf..7699');
// (2) receiptDigest byte-match vs oracle #703 published golden
chk(receiptDigest.toLowerCase() === '0xe805d61778bd424deaf8cb7a47240e9982289017e977e4ad45e085280e6e223e',
    'receiptDigest == oracle #703 published golden 0xe805d617..223e (3rd independent confirm)');
// (3) packageDigest bound: a receipt over a DIFFERENT package -> different digest (no cross-evidence replay)
const otherPkg = keccak256(enc(RCPT_TYPES, [GATEWAY_RECEIPT_DOMAIN, v, chainId, escrow, settlementUnitId, K('other-package'), receivedAt]));
chk(otherPkg.toLowerCase() !== receiptDigest.toLowerCase(), 'binds: packageDigest change -> receipt changes (cannot replay a receipt onto other evidence)');
// (4) receivedAt bound: a different T_hi -> different digest (the timestamp is authenticated, not free)
const otherTs = keccak256(enc(RCPT_TYPES, [GATEWAY_RECEIPT_DOMAIN, v, chainId, escrow, settlementUnitId, packageDigest, 1700000001n]));
chk(otherTs.toLowerCase() !== receiptDigest.toLowerCase(), 'binds: receivedAt change -> receipt changes (T_hi is authenticated)');
// (5) confirm the bound package IS evidence's V2 golden (the tie-in that makes this evidence-relevant)
chk(packageDigest.toLowerCase() === '0xe1e5c30d2ed795e28ccb035edc53daacf13c5a077686dc4141c49ed9768a3fb5',
    'tie-in: the receipt binds evidence FinalMilestonePackageV2 packageDigest 0xe1e5c30d..3fb5');

console.log(`\n${ok ? 'gateway-receipt mirror: BYTE-EXACT vs oracle #703 (domain + receiptDigest) — effectiveEvidenceTime T_hi confirmed over evidence V2 packageDigest.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
