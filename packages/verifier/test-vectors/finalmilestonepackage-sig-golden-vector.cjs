#!/usr/bin/env node
/* finalmilestonepackage-sig-golden-vector.cjs — EVIDENCE lane (c25c8f97). The GOLDEN for the FinalMilestonePackageV2
 * SIGNATURE framing per RATIFIED D1 + D2 (sol 2026-08-25, ~/.claude/shared/sol-d1-out.md; Evidence Commitment
 * Profile v1 §2 registry rows PACKAGE-BODY/operator + PACKAGE-BODY/kernel). REPLACES the stale raw-secp256k1
 * operator KAT (finalmilestonepackage-realsig-kat.cjs 61f40d35) that sol ruled "no longer authoritative after D1".
 *
 * THREE distinct signed surfaces on one package (kept separate ON PURPOSE):
 *   packageBodyHash = SHA-256( raw32(SIG_DOMAIN_V2) ‖ u64be(len(JCS(body))) ‖ JCS(body) )   [FROZEN framing, #664]
 *   OPERATOR (D1)  = EIP-712 signTypedData over FinalMilestonePackageV2{8 unitBinding fields + packageBodyHash};
 *                    scheme secp256k1-eip712; EIP-191 REJECTED for this surface (no downgrade path).
 *                    A settlement authorization is a wallet-legible typed money-auth, not a blind opaque-hash sign.
 *   KERNEL   (D2)  = ed25519 over raw32(packageBodyHash), EXACTLY 32 bytes; scheme ed25519-raw32.
 *                    packageBodyHash is a raw bytes32 — NOT sha256:-tagged, NOT UTF-8.
 *
 * This is the framing conformance target. The integrated packageDigest/evidenceCommitment aggregate stays
 * oracle-owned (settlement-vector a60087ac). Run:
 *   NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node finalmilestonepackage-sig-golden-vector.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const K = (s) => keccak256(toUtf8Bytes(s));
const raw32 = (h) => Buffer.from(h.slice(2), 'hex');
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

// ── production canonicalize (Profile §1) — JCS(body) is canonicalize over the unsigned body ──
function canonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') { const ks = Object.keys(v).sort(); return '{' + ks.filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}'; }
  return String(v);
}

const SIG_DOMAIN_V2 = K('PCC:vnext:evidence-package-sig:v2');   // raw32 domain, frozen V2 framing (#664)

// ── coherent unit binding: reuse the integrated settlement-vector values (settlementUnitId 0x4453a3d2,
//    acceptedEnvelopeHash == the REAL acceptedPolicyDigest 0xa821492a). Sample escrow addr 0xE5C0... (address-parametric). ──
const escrow = '0xE5C0F00000000000000000000000000000000001';
const unitBinding = {
  chainId: 84532,                                   // Base Sepolia
  escrow,
  settlementUnitId: '0x4453a3d2' + '00'.repeat(28), // sample-coherent with the integrated vector's unit
  jobIdHash: K('job-golden'),
  milestoneIndex: 3,
  stepId: K('golden-step'),
  compositionRoot: K('golden-composition-root'),
  acceptedEnvelopeHash: '0xa821492ad1c9d685fc794c21485480f01169c2d690d73c86a354143f3f496a41', // == acceptedPolicyDigest (authoritative)
};

// ── unsigned V2 body (representative; the framing is what this golden pins, not the aggregate packageDigest) ──
const unsignedBody = {
  version: 2,
  unitBinding,
  compositionSchemaVersion: 1,
  evidenceBlockHash: '0x4605a6e9affa66fd2acd44f5b88d0468f293056573f04e884048f58ba8803a40', // EvidenceBlockV2 (coherence-fixed)
  challengeBinding: { nonce: K('golden-challenge-nonce'), tChallengeRef: 'gw:challenge:golden' },
  evidenceTimeBounds: { start: '2026-08-20T00:00:00Z', end: '2026-08-20T00:05:00Z' }, // CLAIMED-only, never gates authz
};

// packageBodyHash = SHA-256( raw32(SIG_DOMAIN_V2) ‖ u64be(len(JCS)) ‖ JCS )  — raw bytes32, no sha256: tag
const jcs = Buffer.from(canonicalize(unsignedBody), 'utf8');
const preimage = Buffer.concat([raw32(SIG_DOMAIN_V2), u64be(jcs.length), jcs]);
const packageBodyHash = '0x' + crypto.createHash('sha256').update(preimage).digest('hex');

// ── D1: OPERATOR EIP-712 (secp256k1-eip712) ──
const domain = { name: 'PCC FinalMilestonePackage', version: '2', chainId: unitBinding.chainId, verifyingContract: escrow };
const types = {
  FinalMilestonePackageV2: [
    { name: 'chainId', type: 'uint256' },
    { name: 'escrow', type: 'address' },
    { name: 'settlementUnitId', type: 'bytes32' },
    { name: 'jobIdHash', type: 'bytes32' },
    { name: 'milestoneIndex', type: 'uint256' },
    { name: 'stepId', type: 'bytes32' },
    { name: 'compositionRoot', type: 'bytes32' },
    { name: 'acceptedEnvelopeHash', type: 'bytes32' },
    { name: 'packageBodyHash', type: 'bytes32' },
  ],
};
const message = {
  chainId: unitBinding.chainId, escrow, settlementUnitId: unitBinding.settlementUnitId, jobIdHash: unitBinding.jobIdHash,
  milestoneIndex: unitBinding.milestoneIndex, stepId: unitBinding.stepId, compositionRoot: unitBinding.compositionRoot,
  acceptedEnvelopeHash: unitBinding.acceptedEnvelopeHash, packageBodyHash,
};
const TypedDataEncoder = E.TypedDataEncoder || (E.utils && E.utils._TypedDataEncoder);
const eip712Digest = TypedDataEncoder.hash(domain, types, message);           // keccak256(0x1901 ‖ domSep ‖ hashStruct)
const operatorWallet = new E.Wallet('0x' + '11'.repeat(32));                   // deterministic operator key
const operatorSigPromise = operatorWallet.signTypedData(domain, types, message);

// ── D2: KERNEL ed25519 over raw32(packageBodyHash) (exactly 32 bytes) ──
const kSeed = Buffer.from('22'.repeat(32), 'hex');
const kernelPriv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), kSeed]), format: 'der', type: 'pkcs8' });
const kernelPubRaw = crypto.createPublicKey(kernelPriv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const kernelMsg = raw32(packageBodyHash);                                      // 32 bytes, NOT utf8, NOT sha256:-tagged
const kernelSig = '0x' + crypto.sign(null, kernelMsg, kernelPriv).toString('hex');
const ed25519verify = (m, pubHex, sigHex) => crypto.verify(null, m,
  crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' }),
  Buffer.from(sigHex.slice(2), 'hex'));

(async () => {
  const operatorSig = await operatorSigPromise;
  const recovered = E.verifyTypedData(domain, types, message, operatorSig);
  const sig = E.Signature.from(operatorSig);

  console.log(`ethers=${E.version || 'v6'}\n== FinalMilestonePackageV2 SIGNATURE golden (RATIFIED D1 EIP-712 + D2 ed25519-raw32) ==`);
  console.log(`  packageBodyHash        ${packageBodyHash}`);
  console.log(`  EIP-712 digest         ${eip712Digest}`);
  console.log(`  operator (recovered)   ${recovered}  (expected ${operatorWallet.address})`);
  console.log(`  operator sig v=${sig.v}  low-s=${BigInt(sig.s) <= BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')}`);
  console.log(`  kernel pub (raw32)     0x${kernelPubRaw}`);
  console.log(`  kernel ed25519 sig     ${kernelSig.slice(0, 26)}..\n`);

  let ok = true; const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };
  const N2 = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0'); // secp256k1 n/2

  // (1) D1: operator EIP-712 recovers to the operator wallet (on-chain ecrecover parity)
  chk(recovered.toLowerCase() === operatorWallet.address.toLowerCase(), 'D1: EIP-712 signTypedData recovers to the operator address (ecrecover parity)');

  // (2) D1: canonical signature — low-s + v in {27,28}
  chk(BigInt(sig.s) <= N2 && (sig.v === 27 || sig.v === 28), 'D1: operator sig is canonical — low-s and v in {27,28}');

  // (3) D1: domain BINDS chain + escrow (defense-in-depth namespace) — domain.chainId==message.chainId, verifyingContract==escrow
  chk(domain.chainId === message.chainId && domain.verifyingContract.toLowerCase() === message.escrow.toLowerCase(), 'D1: EIP-712 domain binds chainId + verifyingContract==escrow (duplicated in message on purpose)');

  // (4) D1: tampering ANY unit field flips the digest -> recovers to a DIFFERENT (wrong) signer -> settlement rejects
  const evilMsg = { ...message, milestoneIndex: 4 };
  const recoveredEvil = E.verifyTypedData(domain, types, evilMsg, operatorSig);
  chk(TypedDataEncoder.hash(domain, types, evilMsg) !== eip712Digest && recoveredEvil.toLowerCase() !== operatorWallet.address.toLowerCase(), 'D1: mutating a unit field (milestoneIndex) -> different EIP-712 digest -> signature no longer recovers the operator (replay/confusion rejected)');

  // (5) D1: cross-escrow replay rejected — same sig under a different verifyingContract does NOT recover the operator
  const evilDomain = { ...domain, verifyingContract: '0xE5C0F00000000000000000000000000000000002' };
  chk(E.verifyTypedData(evilDomain, types, message, operatorSig).toLowerCase() !== operatorWallet.address.toLowerCase(), 'D1: replaying the operator sig under a different escrow (verifyingContract) does not recover the operator');

  // (6) D2: kernel ed25519 verifies over raw32(packageBodyHash), exactly 32 bytes
  chk(kernelMsg.length === 32 && ed25519verify(kernelMsg, kernelPubRaw, kernelSig), 'D2: kernel ed25519-raw32 verifies over raw32(packageBodyHash) (exactly 32 bytes)');

  // (7) D2: framing is raw32, NOT sha256:-tagged and NOT utf8 — signing the utf8 of the hex string does NOT verify
  const utf8Msg = Buffer.from(packageBodyHash, 'utf8'); // the WRONG (66-byte) framing D2 explicitly rejects
  chk(utf8Msg.length !== 32 && !ed25519verify(utf8Msg, kernelPubRaw, kernelSig), 'D2: raw32 framing — the sig does NOT verify over utf8(packageBodyHash-hex) (the rejected 66-byte / sha256:-tagged forms)');

  // (8) D2: tamper — flipping the body flips packageBodyHash -> kernel sig no longer verifies
  const body2 = { ...unsignedBody, compositionSchemaVersion: 2 };
  const jcs2 = Buffer.from(canonicalize(body2), 'utf8');
  const pbh2 = '0x' + crypto.createHash('sha256').update(Buffer.concat([raw32(SIG_DOMAIN_V2), u64be(jcs2.length), jcs2])).digest('hex');
  chk(pbh2 !== packageBodyHash && !ed25519verify(raw32(pbh2), kernelPubRaw, kernelSig), 'D2: mutating the body -> different packageBodyHash -> kernel sig rejects (body-bound)');

  // (9) EIP-191 is NOT an accepted operator framing (no downgrade path): an EIP-191 personal_sign over the digest
  //     recovers a signer, but it is a DIFFERENT signature than the EIP-712 one the verifier requires.
  const eip191Sig = await operatorWallet.signMessage(E.getBytes(eip712Digest));
  chk(eip191Sig !== operatorSig, 'D1: EIP-191 personal_sign over the digest is a DISTINCT signature — the operator surface accepts ONLY secp256k1-eip712, so an EIP-191 sig is not interchangeable (no dual-scheme downgrade)');

  console.log(`\n${ok ? 'FinalMilestonePackageV2 SIGNATURE golden VERIFIED (D1/D2 ratified): operator secp256k1-eip712 (ecrecover parity, canonical low-s, chain+escrow-bound, tamper+cross-escrow rejected); kernel ed25519-raw32 over raw32(packageBodyHash) (32B, body-bound, utf8/sha256:-tagged forms rejected). Supersedes the raw-secp256k1 operator KAT (sol D1). The producer must sign via this EIP-712 path; integrated packageDigest stays oracle-owned.' : 'DIVERGENCE -- blocker'}`);
  process.exit(ok ? 0 : 1);
})();
