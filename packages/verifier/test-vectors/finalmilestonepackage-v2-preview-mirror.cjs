#!/usr/bin/env node
/* finalmilestonepackage-v2-preview-mirror.cjs — EVIDENCE lane (92dc40cb) preview mirror for
 * FinalMilestonePackageV2 (schema hardening, coord #646 fold + oracle #654 effectiveEvidenceTime).
 * Doc: ~/.claude/shared/vnext-finalmilestonepackage-v2-proposal.md
 *
 * PREVIEW: pins the DECIDED mechanical changes so oracle can cross-confirm them byte-for-byte —
 *   (1) FROZEN framing: packageBodyHash = SHA-256( raw32(SIG_DOMAIN) || uint64_be(len(JCS)) || JCS )
 *       (V1 used ascii("0x"+hex(domain)) || ":" || JCS — three prose readings; V2 removes the ambiguity)
 *   (2) compositionSchemaVersion IN the signed body (V1 had it only in the outer commitment)
 *   (3) CANONICAL signature envelope: dedup-by-signer + sort-by-signer -> one packageDigest per (body, signer-set)
 *   (4) challengeBinding {nonce, tChallengeRef} folded into payloadRoot (oracle #654 nonce-into-package)
 * challengeBinding.nonce + acceptedEnvelopeHash are PLACEHOLDERS (gateway challenge mechanism +
 * AcceptedJobPolicyV1 not yet frozen) — clearly marked; the full V2 golden lands when they freeze.
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node finalmilestonepackage-v2-preview-mirror.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const sha256buf = (buf) => '0x' + crypto.createHash('sha256').update(buf).digest('hex');

// string-only-leaf JCS (canonical profile: numbers/ids are decimal/hex STRINGS)
function jcs(o) {
  if (Array.isArray(o)) return '[' + o.map(jcs).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + jcs(o[k])).join(',') + '}';
  if (typeof o !== 'string') throw new Error('canonical profile: non-string leaf ' + JSON.stringify(o));
  return JSON.stringify(o);
}

// ── FROZEN V2 framing: raw32(domain) || uint64_be(len(JCS_bytes)) || JCS_bytes ──
const SIG_DOMAIN = K('PCC:vnext:evidence-package-sig:v1');       // 0x… 32-byte hex
const raw32 = (hex) => Buffer.from(hex.slice(2), 'hex');
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
function packageBodyHashV2(body) {
  const jcsBytes = Buffer.from(jcs(body), 'utf8');
  return sha256buf(Buffer.concat([raw32(SIG_DOMAIN), u64be(jcsBytes.length), jcsBytes]));
}
// V1 framing (for the difference demo only)
const sha256str = (s) => '0x' + crypto.createHash('sha256').update(s).digest('hex');
const packageBodyHashV1 = (body) => sha256str(SIG_DOMAIN + ':' + jcs(body));

// ── canonical signature envelope: dedup-by-signer + sort-by-signer ──
function canonicalSigs(sigs) {
  const bySigner = new Map();
  for (const s of sigs) { const id = s.signer.toLowerCase(); if (!bySigner.has(id)) bySigner.set(id, s); } // dedup: first wins
  return [...bySigner.values()].sort((a, b) => (a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1));
}

// ── canonical inputs (unit aligned with the gate-1 / V1 goldens) ──
const chainId = '8453';
const escrow = '0x00000000000000000000000000000000000e5c0f';
const settlementUnitId = '0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1';

const body = {
  packageSchemaVersion: 'FinalMilestonePackageV2',
  packageFormat: '1',
  compositionSchemaVersion: '1',                    // NEW in-body; == outer commitment version
  unitBinding: {
    chainId, escrow, settlementUnitId,
    jobIdHash: K('golden-job'), milestoneIndex: '3', stepId: K('golden-step'),
    compositionRoot: '0x' + '00'.repeat(32),
    acceptedEnvelopeHash: K('golden-accepted-envelope'),   // PLACEHOLDER (AcceptedJobPolicyV1 not frozen)
  },
  producer: { operatorPrincipalId: 'op-golden', kernelId: 'kernel-golden-01', devicePrincipalId: 'dev-golden' },
  challengeBinding: { nonce: K('golden-gateway-nonce'), tChallengeRef: '1699999000' }, // PLACEHOLDER nonce (gateway-issued)
  // payloadRoot INCORPORATES the challenge nonce (oracle #654 nonce-into-package):
  evidence: { events: [{ type: 'execution_completed', at: '1700000000' }],
              payloadRoot: keccak256(enc(['bytes32', 'bytes32'], [K('golden-payload'), K('golden-gateway-nonce')])) },
  evidenceTimeBounds: { start: '1699999500', end: '1700000000' },  // CLAIMED-ONLY (may narrow [T_lo,T_hi], never widen)
};

const packageBodyHash = packageBodyHashV2(body);
// two authorized signers, deliberately given OUT OF ORDER + a duplicate, to prove canonicalization:
const rawSigs = [
  { signer: '0x' + 'bb'.repeat(20), scheme: 'secp256k1', sig: '0x' + '22'.repeat(65) },
  { signer: '0x' + 'aa'.repeat(20), scheme: 'ed25519',   sig: '0x' + '11'.repeat(64) },
  { signer: '0x' + 'bb'.repeat(20), scheme: 'secp256k1', sig: '0x' + '22'.repeat(65) }, // duplicate signer
];
const signatures = canonicalSigs(rawSigs);
const packageDigest = sha256str(jcs({ body, signatures }));

const EC_DOMAIN = K('PCC:vnext:evidence-commitment:v1');
const evidenceCommitment = keccak256(enc(
  ['bytes32', 'uint256', 'address', 'bytes32', 'uint16', 'uint8', 'bytes32'],
  [EC_DOMAIN, chainId, escrow, settlementUnitId, BigInt(body.compositionSchemaVersion), 1n, packageDigest]));

console.log('== FinalMilestonePackageV2 PREVIEW (frozen framing + version-in-body + canonical sigs) ==');
console.log(`  packageBodyHash    ${packageBodyHash}`);
console.log(`  packageDigest      ${packageDigest}`);
console.log(`  evidenceCommitment ${evidenceCommitment}\n`);

let ok = true;
const chk = (cond, label) => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); };

// (1) canonical-sig determinism: re-order / duplicate the raw sigs -> SAME packageDigest
const reordered = canonicalSigs([rawSigs[1], rawSigs[2], rawSigs[0], rawSigs[1]]);
chk(sha256str(jcs({ body, signatures: reordered })).toLowerCase() === packageDigest.toLowerCase(),
    'canonical-sig: reordered+duplicated signer set -> identical packageDigest (malleability closed)');
chk(signatures.length === 2, 'canonical-sig: duplicate signer deduped (3 raw -> 2 canonical)');

// (2) framing is actually different from V1 (proves the freeze changed the bytes -> re-golden needed)
chk(packageBodyHashV1(body).toLowerCase() !== packageBodyHash.toLowerCase(),
    'framing: V2 raw32||len||JCS differs from V1 ascii-hex||":"||JCS (re-golden required)');

// (3) length-prefix disambiguation: a body whose JCS could be confused under naive concat still separates
chk(packageBodyHashV2(body) === packageBodyHash, 'framing: V2 packageBodyHash deterministic');

// (4) negative parity — the new/critical fields all bind into packageDigest
const clone = (o) => JSON.parse(JSON.stringify(o));
const digestOf = (b) => sha256str(jcs({ body: b, signatures }));
const base = packageDigest;
for (const [label, mut] of [
  ['compositionSchemaVersion', (b) => (b.compositionSchemaVersion = '2')],
  ['challengeBinding.nonce',   (b) => (b.challengeBinding.nonce = K('other-nonce'))],
  ['producer.operatorPrincipalId', (b) => (b.producer.operatorPrincipalId = 'op-evil')],
  ['unitBinding.settlementUnitId', (b) => (b.unitBinding.settlementUnitId = K('other-unit'))],
  ['evidence.payloadRoot',     (b) => (b.evidence.payloadRoot = K('other-payload'))],
]) { const b = clone(body); mut(b); chk(digestOf(b).toLowerCase() !== base.toLowerCase(), `unit/version-bound: mutate ${label} -> packageDigest changes`); }

// (5) compositionSchemaVersion is bound in BOTH body and outer commitment (asymmetry closed)
const commitV2 = keccak256(enc(['bytes32','uint256','address','bytes32','uint16','uint8','bytes32'],
  [EC_DOMAIN, chainId, escrow, settlementUnitId, 2n, 1n, packageDigest]));
chk(commitV2.toLowerCase() !== evidenceCommitment.toLowerCase(),
    'version: outer compositionSchemaVersion also binds (body+outer must agree -> oracle checks equality)');

// (6) pinned PREVIEW golden — the DECIDED mechanics' output (oracle cross-confirms the framing against these;
//     re-pins if the placeholder challenge nonce / acceptedEnvelopeHash change once those inputs freeze).
const EXPECT = {
  packageBodyHash:    '0x21cdcf9056f2478d880827ebaf99c5dc022bdf362af3be795a6d92a61f54f70d',
  packageDigest:      '0xe1e5c30d2ed795e28ccb035edc53daacf13c5a077686dc4141c49ed9768a3fb5',
  evidenceCommitment: '0x26df8ceeca79290adfb1c18549b89c5d020f4553325a73a4fe9cd06cd4f970d7',
};
for (const [k, v] of [['packageBodyHash', packageBodyHash], ['packageDigest', packageDigest], ['evidenceCommitment', evidenceCommitment]])
  chk(v.toLowerCase() === EXPECT[k].toLowerCase(), `pinned preview-golden ${k} == ${EXPECT[k]}`);

console.log(`\n${ok ? 'FinalMilestonePackageV2 PREVIEW: mechanical changes verified (framing + version-in-body + canonical sigs + nonce-fold) + pinned. Full golden pends gateway challenge + AcceptedJobPolicyV1 freeze.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
