#!/usr/bin/env node
'use strict';
/* finalmilestonepackage-v2-d1-eip712-mirror.cjs — EVIDENCE lane (c25c8f97) golden vectors for the
 * D1 (operator) EIP-712 signature of FinalMilestonePackageV2.
 *
 * Contract: returns/pcc-evidence-work/d1-eip712-struct-proposal.md — RATIFIED by the oracle (bus
 * #5773) and escrow (bus #5785), 2026-10-03. Escrow's ratification carried two decisions:
 *   1. ERC-1271 (contract) operators cannot mint under v1 — D1 fails closed for them. The ratified
 *      rule is a 65-byte ECDSA recovery ONLY (the oracle applies the same rule); supporting
 *      isValidSignature against operator() is a versioned change, not part of v1.
 *   2. The escrow clone must be bound through fundedEscrowOf(policyKey(payer, operator, jobIdHash))
 *      before operator() is trusted, so a look-alike clone cannot vouch for itself.
 * NEITHER decision changes the struct, domain or digest bytes below — they govern how the chain
 * establishes "the authoritative operator" before these bytes are ever checked. These vectors cover
 * the ECDSA recovery path only (how a signature over the ratified struct is accepted or refused).
 *
 * The struct (exact field order, the doc wins if this comment ever drifts from it):
 *   FinalMilestonePackageV2(uint256 chainId,address escrow,bytes32 settlementUnitId,bytes32
 *     jobIdHash,uint256 milestoneIndex,bytes32 stepId,bytes32 compositionRoot,bytes32
 *     acceptedEnvelopeHash,bytes32 packageBodyHash)
 * Domain: EIP712Domain(string name,string version,uint256 chainId,address verifyingContract),
 *   name="PCC FinalMilestonePackage", version="2", chainId=unitBinding.chainId,
 *   verifyingContract=unitBinding.escrow, no salt.
 * Digest: keccak256(0x1901 || domainSeparator || hashStruct(message)).
 *
 * Sample body: finalmilestonepackage-v2-preview-mirror.cjs's `body` object, copied verbatim (not
 * required as a module — that file is a side-effecting script with its own process.exit(), so
 * requiring it would execute and kill this process). packageBodyHash is RE-IMPLEMENTED here (same
 * SHA-256(raw32(SIG_DOMAIN) || u64be(len(JCS)) || JCS) framing) and asserted equal to that file's
 * own pinned EXPECT.packageBodyHash (0x21cdcf90...) — both the source literal (read from its text)
 * and the independent recomputation from the identical body object must agree.
 *
 * ethers is NOT installed in this worktree. Run:
 *   NODE_PATH=/mnt/sparkbulk/pcc-lanes/wt-evidence-loev1/node_modules/.pnpm/ethers@6.16.0_bufferutil@4.1.0_utf-8-validate@6.0.6/node_modules \
 *     node finalmilestonepackage-v2-d1-eip712-mirror.cjs
 * Writes: finalmilestonepackage-v2-d1-eip712.vectors.json (beside this file)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const E = require('ethers');

const HERE = __dirname;
const OUT_PATH = path.join(HERE, 'finalmilestonepackage-v2-d1-eip712.vectors.json');

const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const sha256buf = (buf) => '0x' + crypto.createHash('sha256').update(buf).digest('hex');
const raw32 = (hex) => Buffer.from(hex.slice(2), 'hex');
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

// ── string-only-leaf JCS — copied VERBATIM from finalmilestonepackage-v2-preview-mirror.cjs so the
//    packageBodyHash framing is byte-identical (that file is the authority; do not "improve" this). ──
function jcs(o) {
  if (Array.isArray(o)) return '[' + o.map(jcs).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + jcs(o[k])).join(',') + '}';
  if (typeof o !== 'string') throw new Error('canonical profile: non-string leaf ' + JSON.stringify(o));
  return JSON.stringify(o);
}
const SIG_DOMAIN = K('PCC:vnext:evidence-package-sig:v1');
function packageBodyHashV2(body) {
  const jcsBytes = Buffer.from(jcs(body), 'utf8');
  return sha256buf(Buffer.concat([raw32(SIG_DOMAIN), u64be(jcsBytes.length), jcsBytes]));
}

// ── the preview mirror's sample inputs + body, copied verbatim (do NOT modify that file; this is a
//    separate re-implementation, per the brief: "re-implement it ... pin the value and assert it
//    equals the preview mirror's"). ──
const chainId = '8453';
const escrow = '0x00000000000000000000000000000000000e5c0f';
const settlementUnitId = '0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1';
const body = {
  packageSchemaVersion: 'FinalMilestonePackageV2',
  packageFormat: '1',
  compositionSchemaVersion: '1',
  unitBinding: {
    chainId, escrow, settlementUnitId,
    jobIdHash: K('golden-job'), milestoneIndex: '3', stepId: K('golden-step'),
    compositionRoot: '0x' + '00'.repeat(32),
    acceptedEnvelopeHash: K('golden-accepted-envelope'),
  },
  producer: { operatorPrincipalId: 'op-golden', kernelId: 'kernel-golden-01', devicePrincipalId: 'dev-golden' },
  challengeBinding: { nonce: K('golden-gateway-nonce'), tChallengeRef: '1699999000' },
  evidence: { events: [{ type: 'execution_completed', at: '1700000000' }],
              payloadRoot: keccak256(enc(['bytes32', 'bytes32'], [K('golden-payload'), K('golden-gateway-nonce')])) },
  evidenceTimeBounds: { start: '1699999500', end: '1700000000' },
};
const packageBodyHash = packageBodyHashV2(body);
const PREVIEW_MIRROR_PINNED_PACKAGE_BODY_HASH = '0x21cdcf9056f2478d880827ebaf99c5dc022bdf362af3be795a6d92a61f54f70d'; // finalmilestonepackage-v2-preview-mirror.cjs EXPECT.packageBodyHash (read verbatim from that file's source)

// ── D1 struct / domain / types / message ──
const unitBinding = body.unitBinding;
const domain = { name: 'PCC FinalMilestonePackage', version: '2', chainId: unitBinding.chainId, verifyingContract: unitBinding.escrow };
const TYPE_STRING = 'FinalMilestonePackageV2(uint256 chainId,address escrow,bytes32 settlementUnitId,bytes32 jobIdHash,uint256 milestoneIndex,bytes32 stepId,bytes32 compositionRoot,bytes32 acceptedEnvelopeHash,bytes32 packageBodyHash)';
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
  chainId: unitBinding.chainId, escrow: unitBinding.escrow, settlementUnitId: unitBinding.settlementUnitId,
  jobIdHash: unitBinding.jobIdHash, milestoneIndex: unitBinding.milestoneIndex, stepId: unitBinding.stepId,
  compositionRoot: unitBinding.compositionRoot, acceptedEnvelopeHash: unitBinding.acceptedEnvelopeHash, packageBodyHash,
};

const encoder = E.TypedDataEncoder.from(types);
if (encoder.encodeType('FinalMilestonePackageV2') !== TYPE_STRING) throw new Error('encodeType drifted from the pinned TYPE_STRING');
const typeHash = keccak256(toUtf8Bytes(TYPE_STRING));
const domainSeparator = E.TypedDataEncoder.hashDomain(domain);
const structHash = encoder.hashStruct('FinalMilestonePackageV2', message);
const digest = E.TypedDataEncoder.hash(domain, types, message);
// self-check: digest independently re-derived from the contract's own stated formula, not just trusted from the static helper.
const digestSelfCheck = keccak256(Buffer.concat([Buffer.from('1901', 'hex'), raw32(domainSeparator), raw32(structHash)]));

// ── secp256k1 constants (cross-checked against the house constant already used in
//    finalmilestonepackage-sig-golden-vector.cjs) ──
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_N2 = SECP256K1_N / 2n; // floor(n/2)
const HOUSE_N2_LITERAL = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── deterministic keys, PUBLIC TEST DATA ──
const operatorPrivateKey = K('pcc-d1-golden-operator');
const nonOperatorPrivateKey = K('pcc-d1-golden-not-operator');
const operatorWallet = new E.Wallet(operatorPrivateKey);
const nonOperatorWallet = new E.Wallet(nonOperatorPrivateKey);

// ── the gated verifier: implements the contract's verification rule (form -> recover -> identity). ──
function verifyD1(digestHex, sigHex, expectedOperator) {
  const hex = (sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex).toLowerCase();
  if (hex.length !== 130) return { accepted: false, reason: 'bad_length', recovered: null, detail: `sig is ${hex.length / 2} bytes, need exactly 65` };
  const rHex = '0x' + hex.slice(0, 64);
  const sHex = '0x' + hex.slice(64, 128);
  const vByte = parseInt(hex.slice(128, 130), 16);
  const r = BigInt(rHex), s = BigInt(sHex);
  if (r === 0n) return { accepted: false, reason: 'r_zero', recovered: null };
  if (r >= SECP256K1_N) return { accepted: false, reason: 'r_out_of_range', recovered: null };
  if (s === 0n) return { accepted: false, reason: 's_zero', recovered: null };
  if (s >= SECP256K1_N) return { accepted: false, reason: 's_out_of_range', recovered: null };
  if (vByte !== 27 && vByte !== 28) return { accepted: false, reason: 'v_not_27_or_28', recovered: null };
  if (s > SECP256K1_N2) return { accepted: false, reason: 'high_s', recovered: null };
  let recovered;
  try {
    recovered = E.recoverAddress(digestHex, { r: rHex, s: sHex, v: vByte });
  } catch (e) {
    return { accepted: false, reason: 'recovery_exception', recovered: null, detail: String((e && e.message) || e) };
  }
  if (recovered.toLowerCase() === ZERO_ADDRESS) return { accepted: false, reason: 'zero_address', recovered };
  if (recovered.toLowerCase() !== expectedOperator.toLowerCase()) return { accepted: false, reason: 'signer_mismatch', recovered };
  return { accepted: true, reason: null, recovered };
}

const OPERATOR_PRINCIPAL_ID_RE = /^eip155:[0-9]+:0x[0-9a-f]{40}$/;
const canonicalOperatorPrincipalId = (chainIdDecimalStr, addressLower) => `eip155:${chainIdDecimalStr}:${addressLower}`;
function checkOperatorPrincipalId(claimed, chainIdDecimalStr, recoveredAddr) {
  if (!OPERATOR_PRINCIPAL_ID_RE.test(claimed)) return { ok: false, reason: 'operatorPrincipalId_not_lowercase' };
  const canon = canonicalOperatorPrincipalId(chainIdDecimalStr, recoveredAddr.toLowerCase());
  if (claimed !== canon) return { ok: false, reason: 'operatorPrincipalId_mismatch' };
  return { ok: true };
}
// full D1 entry: signature rule (1-3) + operatorPrincipalId shape/identity (4) + signer label (5).
function verifyD1Entry({ digest: dg, signature, expectedOperator, claimedOperatorPrincipalId, claimedSignerLabel, chainIdDecimalStr }) {
  const sigCheck = verifyD1(dg, signature, expectedOperator);
  if (!sigCheck.accepted) return sigCheck;
  const principalCheck = checkOperatorPrincipalId(claimedOperatorPrincipalId, chainIdDecimalStr, sigCheck.recovered);
  if (!principalCheck.ok) return { accepted: false, reason: principalCheck.reason, recovered: sigCheck.recovered };
  if (claimedSignerLabel.toLowerCase() !== sigCheck.recovered.toLowerCase()) return { accepted: false, reason: 'signer_label_mismatch', recovered: sigCheck.recovered };
  return { accepted: true, reason: null, recovered: sigCheck.recovered };
}

function sigDisplay(sigHex) {
  const hex = sigHex.slice(2);
  const out = { full: sigHex, byteLength: hex.length / 2 };
  if (hex.length === 130) {
    out.r = '0x' + hex.slice(0, 64);
    out.s = '0x' + hex.slice(64, 128);
    out.v = parseInt(hex.slice(128, 130), 16);
  }
  return out;
}
function tryRawRecover(digestHex, rHex, sHex, vNum) {
  try { return E.recoverAddress(digestHex, { r: rHex, s: sHex, v: vNum }); } catch (e) { return null; }
}

let ok = true;
const chk = (cond, label, detail) => { ok = ok && cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

console.log('== FinalMilestonePackageV2 D1 (operator) EIP-712 — golden vectors ==\n');
console.log(`  packageBodyHash   ${packageBodyHash}`);
console.log(`  typeHash          ${typeHash}`);
console.log(`  domainSeparator   ${domainSeparator}`);
console.log(`  structHash        ${structHash}`);
console.log(`  digest            ${digest}\n`);

chk(packageBodyHash.toLowerCase() === PREVIEW_MIRROR_PINNED_PACKAGE_BODY_HASH.toLowerCase(),
  'packageBodyHash (re-implemented framing + preview mirror\'s own body) == preview mirror\'s pinned EXPECT.packageBodyHash', packageBodyHash);
chk(digest === digestSelfCheck, 'digest == keccak256(0x1901 || domainSeparator || structHash) (formula re-derived independently of the static helper)');
chk(SECP256K1_N2 === HOUSE_N2_LITERAL, 'secp256k1 n/2 == the house constant already used in finalmilestonepackage-sig-golden-vector.cjs');

(async () => {
  // ── POSITIVE ──
  const positiveSig = await operatorWallet.signTypedData(domain, types, message);
  const positiveResult = verifyD1(digest, positiveSig, operatorWallet.address);
  const operatorPrincipalId = canonicalOperatorPrincipalId(unitBinding.chainId, operatorWallet.address.toLowerCase());
  const positiveEntry = verifyD1Entry({
    digest, signature: positiveSig, expectedOperator: operatorWallet.address,
    claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: positiveResult.recovered,
    chainIdDecimalStr: unitBinding.chainId,
  });
  chk(positiveEntry.accepted === true, 'POSITIVE: accepted (recovered == operator, operatorPrincipalId canonical, signer label matches)');
  chk(positiveResult.recovered && positiveResult.recovered.toLowerCase() === operatorWallet.address.toLowerCase(),
    'POSITIVE: recovered address == operator wallet address', positiveResult.recovered);

  const posHex = positiveSig.slice(2);
  const posR = posHex.slice(0, 64), posS = posHex.slice(64, 128);
  const posRHex = '0x' + posR, posSHex = '0x' + posS;
  const posV = parseInt(posHex.slice(128, 130), 16);

  // ── NEGATIVES ──
  const negatives = [];
  const pushNeg = (name, dg, sigHex, cpid, csl, expectedReason, note) => {
    const result = verifyD1Entry({
      digest: dg, signature: sigHex, expectedOperator: operatorWallet.address,
      claimedOperatorPrincipalId: cpid !== undefined ? cpid : operatorPrincipalId,
      claimedSignerLabel: csl !== undefined ? csl : operatorWallet.address,
      chainIdDecimalStr: unitBinding.chainId,
    });
    chk(result.accepted === false && result.reason === expectedReason, `NEGATIVE ${name}: refused as ${expectedReason}`, `got=${JSON.stringify(result)}`);
    negatives.push({ name, domain, message, digest: dg, signature: sigDisplay(sigHex), claimedOperatorPrincipalId: cpid !== undefined ? cpid : operatorPrincipalId, result, expected: { accepted: false, reason: expectedReason }, note });
  };

  // 1. high-s: (r, n-s, v flipped) — refused by the low-s rule. ethers' own recoverAddress REFUSES
  //    to even attempt recovery on a non-canonical s (empirically: throws "non-canonical s; use
  //    ._s"), so the "recovers the same address" fact is demonstrated independently by the sibling
  //    Python cross-check's unconstrained recovery, not here.
  {
    const highS = (SECP256K1_N - BigInt(posSHex)).toString(16).padStart(64, '0');
    const flippedV = posV === 27 ? 28 : 27;
    const sig = '0x' + posR + highS + flippedV.toString(16).padStart(2, '0');
    pushNeg('high-s', digest, sig, undefined, undefined, 'high_s',
      'r unchanged, s -> n-s, v flipped. Mathematically the same key (ECDSA malleable twin); refused purely for non-canonical s. ethers.recoverAddress itself throws "non-canonical s; use ._s" if asked to recover this — the Python cross-check demonstrates the same-address fact with its own unconstrained recovery.');
  }
  // 2. v = 29
  {
    const sig = '0x' + posR + posS + (29).toString(16).padStart(2, '0');
    pushNeg('v-29', digest, sig, undefined, undefined, 'v_not_27_or_28', 'v byte set to 29 (0x1d); refused before any recovery attempt. ethers.recoverAddress independently throws "invalid v" for this value.');
  }
  // 3 & 4. v = 0 and v = 1 (raw recovery id). Exactly one of these shares yParity with the real,
  //    accepted signature's v (27 or 28, whichever RFC6979 deterministic signing actually produced
  //    for this message+key -- NOT assumed fixed in advance); that one is the dangerous near-miss
  //    where an ungated recoverAddress call would reach the OPERATOR. The other has the opposite
  //    parity and recovers to an unrelated address. Both are refused by the same v in {27,28} gate;
  //    which one is the "near miss" is computed at runtime, not hardcoded, and cross-checked by an
  //    explicit assertion below (parity match must agree with ungated-recovers-to-operator).
  {
    const realYParity = posV - 27; // 0 or 1, whichever this run's deterministic signature actually used
    for (const candidateV of [0, 1]) {
      const sig = '0x' + posR + posS + candidateV.toString(16).padStart(2, '0');
      const ungated = tryRawRecover(digest, posRHex, posSHex, candidateV);
      const sameParity = candidateV === realYParity;
      const matchesOperator = !!(ungated && ungated.toLowerCase() === operatorWallet.address.toLowerCase());
      chk(sameParity === matchesOperator, `v-raw-recid-${candidateV}: parity match (${sameParity}) agrees with ungated-recovery-equals-operator (${matchesOperator})`, `ungated=${ungated}`);
      const note = sameParity
        ? `v byte set to ${candidateV} (raw yParity ${candidateV}, the SAME parity as this run's real accepted signature, v=${posV}). WITHOUT the explicit v-range gate, ethers.recoverAddress recovers this to ${ungated} -- the operator's own address. This vector proves the v in {27,28} rule is load-bearing, not redundant with signer-mismatch.`
        : `v byte set to ${candidateV} (raw yParity ${candidateV}, the OPPOSITE parity from this run's real accepted signature, v=${posV}). Refused by the same v in {27,28} rule; ungated recovery yields ${ungated} -- an unrelated address, not the operator.`;
      pushNeg(`v-raw-recid-${candidateV}`, digest, sig, undefined, undefined, 'v_not_27_or_28', note);
    }
  }
  // 5. EIP-2098 64-byte compact form
  {
    const compact = E.Signature.from(positiveSig).compactSerialized;
    const expanded = E.Signature.from(compact); // ethers can expand it back -- proves the material is cryptographically legitimate
    const ungated = tryRawRecover(digest, expanded.r, expanded.s, expanded.v);
    pushNeg('eip2098-compact-64-byte', digest, compact, undefined, undefined, 'bad_length',
      `64-byte EIP-2098 compact serialization of the SAME valid signature (r || yParityAndS, no v byte). Refused purely for wire form (65 bytes required); expanded back via ethers it recovers ${ungated} (the operator), proving the signature itself is legitimate -- only the FORM is refused.`);
  }
  // 6. r = 0
  {
    const sig = '0x' + '00'.repeat(32) + posS + posV.toString(16).padStart(2, '0');
    pushNeg('r-zero', digest, sig, undefined, undefined, 'r_zero', 'r forced to 32 zero bytes. Refused outright as a structurally invalid signature component -- never attempted as a recovery, so never "recovers to the zero address"; the refusal reason says exactly what is wrong (r_zero), not zero_address.');
  }
  // 7. s = 0
  {
    const sig = '0x' + posR + '00'.repeat(32) + posV.toString(16).padStart(2, '0');
    pushNeg('s-zero', digest, sig, undefined, undefined, 's_zero', 's forced to 32 zero bytes. Same treatment as r=0: refused outright, reason is s_zero, never zero_address.');
  }
  // 8. wrong domain chainId
  {
    const domainWrongChainId = { ...domain, chainId: (BigInt(unitBinding.chainId) + 1n).toString() };
    const digestWrongChainId = E.TypedDataEncoder.hash(domainWrongChainId, types, message);
    const result = verifyD1Entry({ digest: digestWrongChainId, signature: positiveSig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'signer_mismatch', 'NEGATIVE wrong-domain-chainId: refused as signer_mismatch', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'wrong-domain-chainId', domain: domainWrongChainId, message, digest: digestWrongChainId, signature: sigDisplay(positiveSig), claimedOperatorPrincipalId: operatorPrincipalId, result, expected: { accepted: false, reason: 'signer_mismatch' }, note: 'The valid operator signature verified against a digest recomputed under domain.chainId+1 (message unchanged). Recovery succeeds but yields an unrelated address, not the operator.' });
  }
  // 9. wrong verifyingContract
  {
    const domainWrongVerifyingContract = { ...domain, verifyingContract: '0x' + 'ab'.repeat(20) };
    const digestWrongVerifyingContract = E.TypedDataEncoder.hash(domainWrongVerifyingContract, types, message);
    const result = verifyD1Entry({ digest: digestWrongVerifyingContract, signature: positiveSig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'signer_mismatch', 'NEGATIVE wrong-verifyingContract: refused as signer_mismatch', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'wrong-verifyingContract', domain: domainWrongVerifyingContract, message, digest: digestWrongVerifyingContract, signature: sigDisplay(positiveSig), claimedOperatorPrincipalId: operatorPrincipalId, result, expected: { accepted: false, reason: 'signer_mismatch' }, note: 'The valid operator signature verified against a digest recomputed under a different verifyingContract (message unchanged, including message.escrow). Cross-escrow replay rejected.' });
  }
  // 10. mutated milestoneIndex
  {
    const messageMutatedMilestone = { ...message, milestoneIndex: (BigInt(unitBinding.milestoneIndex) + 1n).toString() };
    const digestMutatedMilestone = E.TypedDataEncoder.hash(domain, types, messageMutatedMilestone);
    const result = verifyD1Entry({ digest: digestMutatedMilestone, signature: positiveSig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'signer_mismatch', 'NEGATIVE mutated-milestoneIndex: refused as signer_mismatch', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'mutated-milestoneIndex', domain, message: messageMutatedMilestone, digest: digestMutatedMilestone, signature: sigDisplay(positiveSig), claimedOperatorPrincipalId: operatorPrincipalId, result, expected: { accepted: false, reason: 'signer_mismatch' }, note: `milestoneIndex bumped from ${unitBinding.milestoneIndex} to ${(BigInt(unitBinding.milestoneIndex) + 1n).toString()}; struct hash changes, the original signature no longer recovers the operator.` });
  }
  // 11. mutated stepId
  {
    const evilStepId = K('pcc-d1-golden-other-stepId');
    const messageMutatedStepId = { ...message, stepId: evilStepId };
    const digestMutatedStepId = E.TypedDataEncoder.hash(domain, types, messageMutatedStepId);
    const result = verifyD1Entry({ digest: digestMutatedStepId, signature: positiveSig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'signer_mismatch', 'NEGATIVE mutated-stepId: refused as signer_mismatch', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'mutated-stepId', domain, message: messageMutatedStepId, digest: digestMutatedStepId, signature: sigDisplay(positiveSig), claimedOperatorPrincipalId: operatorPrincipalId, result, expected: { accepted: false, reason: 'signer_mismatch' }, note: 'stepId replaced with an unrelated bytes32; struct hash changes, original signature no longer recovers the operator.' });
  }
  // 12. mutated packageBodyHash
  {
    const evilPackageBodyHash = K('pcc-d1-golden-other-packageBodyHash');
    const messageMutatedPbh = { ...message, packageBodyHash: evilPackageBodyHash };
    const digestMutatedPbh = E.TypedDataEncoder.hash(domain, types, messageMutatedPbh);
    const result = verifyD1Entry({ digest: digestMutatedPbh, signature: positiveSig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'signer_mismatch', 'NEGATIVE mutated-packageBodyHash: refused as signer_mismatch', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'mutated-packageBodyHash', domain, message: messageMutatedPbh, digest: digestMutatedPbh, signature: sigDisplay(positiveSig), claimedOperatorPrincipalId: operatorPrincipalId, result, expected: { accepted: false, reason: 'signer_mismatch' }, note: 'packageBodyHash field replaced with an unrelated bytes32 (simulating a post-hoc struct tamper, independent of body re-framing); struct hash changes, original signature no longer recovers the operator.' });
  }
  // 13. valid signature by the non-operator key
  {
    const nonOperatorSig = await nonOperatorWallet.signTypedData(domain, types, message);
    const result = verifyD1Entry({ digest, signature: nonOperatorSig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'signer_mismatch' && result.recovered && result.recovered.toLowerCase() === nonOperatorWallet.address.toLowerCase(),
      'NEGATIVE valid-signature-non-operator-key: refused as signer_mismatch, recovers to the non-operator exactly', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'valid-signature-non-operator-key', domain, message, digest, signature: sigDisplay(nonOperatorSig), claimedOperatorPrincipalId: operatorPrincipalId, result, expected: { accepted: false, reason: 'signer_mismatch' }, note: `A well-formed, canonical, correctly-recovering signature -- just from the wrong key. Recovers exactly to the non-operator wallet (${nonOperatorWallet.address}), which is not the authoritative operator.` });
  }
  // 14. EIP-191 personal_sign over the same 32-byte digest
  {
    const eip191Sig = await operatorWallet.signMessage(E.getBytes(digest));
    const result = verifyD1Entry({ digest, signature: eip191Sig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: operatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'signer_mismatch' && eip191Sig !== positiveSig,
      'NEGATIVE eip191-personal-sign-over-same-digest: distinct signature, refused as signer_mismatch', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'eip191-personal-sign-over-same-digest', domain, message, digest, signature: sigDisplay(eip191Sig), claimedOperatorPrincipalId: operatorPrincipalId, result, expected: { accepted: false, reason: 'signer_mismatch' }, note: 'Same operator key, same 32-byte digest, but signed as EIP-191 personal_sign ("\\x19Ethereum Signed Message:\\n32" || digest) instead of EIP-712. The verifier only ever recovers against the raw digest (never re-wraps with the EIP-191 prefix), so this signature recovers to a different, unrelated address. No EIP-712/EIP-191 downgrade path exists.' });
  }
  // 15. operatorPrincipalId with an uppercase / checksummed address (signature itself is VALID)
  {
    const checksummedOperatorPrincipalId = `eip155:${unitBinding.chainId}:${operatorWallet.address}`; // operatorWallet.address is EIP-55 checksummed (mixed case) in ethers v6
    const result = verifyD1Entry({ digest, signature: positiveSig, expectedOperator: operatorWallet.address, claimedOperatorPrincipalId: checksummedOperatorPrincipalId, claimedSignerLabel: operatorWallet.address, chainIdDecimalStr: unitBinding.chainId });
    chk(result.accepted === false && result.reason === 'operatorPrincipalId_not_lowercase',
      'NEGATIVE operatorPrincipalId-checksummed-case: refused as operatorPrincipalId_not_lowercase (signature itself recovers the operator correctly)', `got=${JSON.stringify(result)}`);
    negatives.push({ name: 'operatorPrincipalId-checksummed-case', domain, message, digest, signature: sigDisplay(positiveSig), claimedOperatorPrincipalId: checksummedOperatorPrincipalId, result, expected: { accepted: false, reason: 'operatorPrincipalId_not_lowercase' }, note: `The EIP-712 signature is fully valid and recovers the operator; only the operatorPrincipalId string is wrong (EIP-55 checksummed/mixed-case address instead of all-lowercase). Compared byte-exact per the contract's pin #2, not case-insensitively; the same regex (^eip155:[0-9]+:0x[0-9a-f]{40}$) also rejects a fully-uppercase address.` });
  }

  console.log(`\nnegatives built: ${negatives.length} (expected 15)`);
  chk(negatives.length === 15, 'exactly 15 negative vectors (every listed negative, with both "or" bullets split into their own vectors)');

  // ── assemble + write ──
  const vectors = {
    vector: 'pcc.evidence.finalmilestonepackage-v2-d1-eip712/mirror',
    note: "Public test data. D1 (operator) EIP-712 golden vectors for FinalMilestonePackageV2, per "
      + "d1-eip712-struct-proposal.md, RATIFIED by the oracle (bus #5773) and escrow (bus #5785), "
      + '2026-10-03. Escrow\'s ratification added two decisions -- (1) ERC-1271 operators cannot mint '
      + 'under v1, D1 fails closed for them; (2) the escrow clone is bound through fundedEscrowOf '
      + 'before operator() is trusted -- neither of which changes the struct/domain/digest bytes '
      + 'here. These vectors cover the ECDSA recovery path only. Sample body is '
      + "finalmilestonepackage-v2-preview-mirror.cjs's body object, copied verbatim; packageBodyHash "
      + 'is re-implemented (same framing) and pinned equal to that file\'s own EXPECT value.',
    contract: {
      doc: 'returns/pcc-evidence-work/d1-eip712-struct-proposal.md',
      status: 'RATIFIED by the oracle (bus #5773) and escrow (bus #5785), 2026-10-03',
      escrowRatificationDecisions: [
        'ERC-1271 (contract) operators cannot mint under v1 -- D1 fails closed for them; the ratified rule is 65-byte ECDSA recovery only.',
        'The escrow clone must be bound through fundedEscrowOf(policyKey(payer, operator, jobIdHash)) before operator() is trusted.',
      ],
      scopeNote: 'Neither escrow decision changes these struct/domain/digest bytes. These vectors cover the ECDSA recovery path only.',
    },
    typeString: TYPE_STRING,
    typeHash,
    domain,
    domainSeparator,
    sampleBody: {
      source: 'finalmilestonepackage-v2-preview-mirror.cjs (read-only; body object + framing copied verbatim, re-implemented here, not required as a module)',
      body,
      packageBodyHash,
      packageBodyHashPinnedBy: "finalmilestonepackage-v2-preview-mirror.cjs EXPECT.packageBodyHash",
      packageBodyHashMatchesPreviewMirror: packageBodyHash.toLowerCase() === PREVIEW_MIRROR_PINNED_PACKAGE_BODY_HASH.toLowerCase(),
    },
    keys: {
      operator: { privateKeyPreimage: 'pcc-d1-golden-operator', privateKey: operatorPrivateKey, address: operatorWallet.address, note: 'PUBLIC TEST DATA -- deterministic, never use for anything but these vectors' },
      nonOperator: { privateKeyPreimage: 'pcc-d1-golden-not-operator', privateKey: nonOperatorPrivateKey, address: nonOperatorWallet.address, note: 'PUBLIC TEST DATA' },
    },
    positive: {
      message,
      structHash,
      digest,
      signature: sigDisplay(positiveSig),
      recovered: positiveResult.recovered,
      operatorPrincipalId,
      signerLabel: positiveResult.recovered,
      result: positiveEntry,
      expected: { accepted: true },
    },
    negatives,
    verification: {
      rules: [
        'signature must be exactly 65 bytes (r || s || v); any other length (including the 64-byte EIP-2098 compact form) is refused',
        '0 < r < secp256k1n; r == 0 is refused outright, never treated as a zero-address recovery',
        '0 < s <= secp256k1n/2 (low-s/canonical only); s == 0 is refused outright; s > n/2 is refused as high-s even though (r, n-s, v flipped) recovers the identical address',
        'v must be exactly 27 or 28; 0/1 (raw recovery id) and any other value are refused even where the underlying math would otherwise recover -- whichever of {0,1} shares yParity with the actual accepted signature\'s v would recover the operator if not gated (which one that is depends on the signature, not fixed in advance; see the v-raw-recid-* vectors, which compute and assert this at generation time rather than assuming it)',
        'the recovered address must be non-zero and equal the authoritative operator (the escrow clone\'s operator(), never the funded policy\'s operatorSettlementAddress -- out of scope for these byte-level vectors, see the contract doc)',
        'producer.operatorPrincipalId must equal eip155:<decimal chainId>:<lowercase address>, compared as a byte-exact string (not case-insensitively)',
        "the D1 entry's signer label must equal the recovered address",
      ],
      constants: {
        secp256k1n: '0x' + SECP256K1_N.toString(16),
        secp256k1n_div2: '0x' + SECP256K1_N2.toString(16),
        secp256k1n_div2_matches_house_constant: SECP256K1_N2 === HOUSE_N2_LITERAL,
      },
    },
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(vectors, null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${OUT_PATH}`);
  console.log(`\n${ok ? 'FinalMilestonePackageV2 D1 EIP-712 GOLDEN + 15 negatives: OK' : 'DIVERGENCE -- blocker'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
