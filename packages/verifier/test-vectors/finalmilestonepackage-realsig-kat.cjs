#!/usr/bin/env node
/* finalmilestonepackage-realsig-kat.cjs — EVIDENCE lane (c25c8f97). REAL-SIGNATURE KAT for the
 * FinalMilestonePackageV2 signature envelope. Folds sol gate-6 "real signatures (KATs)" for the PACKAGE
 * (the receipt half was closed in gateway-receipt-golden-mirror.cjs / b804fe21). This is a MECHANISM proof
 * with its own deterministic keys — it does NOT touch the integrated golden's packageDigest (0xf78103a1),
 * which keeps its sample-sig envelope so oracle's in-flight cross-confirm is undisturbed.
 *
 * Proves, with REAL keys:
 *   - a producer secp256k1 signature (operator) over packageBodyHash verifies + recovers the signer address;
 *   - a producer ed25519 signature (kernel) over packageBodyHash verifies against the kernel pubkey;
 *   - the canonical envelope (dedup-by-signer + sort-by-signer) is deterministic with real sigs;
 *   - TAMPER: mutate the body -> packageBodyHash changes -> both real sigs REJECT (fail-closed);
 *   - WRONG-SIGNER: a sig from a different key REJECTS.
 *
 * packageBodyHash framing is the FROZEN V2 form: SHA-256( raw32(SIG_DOMAIN_V2) || u64be(len(JCS)) || JCS ).
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node finalmilestonepackage-realsig-kat.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const K = (s) => keccak256(toUtf8Bytes(s));
const raw32 = (h) => Buffer.from(h.slice(2), 'hex');
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const sha256b = (buf) => '0x' + crypto.createHash('sha256').update(buf).digest('hex');
function jcs(o) {
  if (Array.isArray(o)) return '[' + o.map(jcs).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + jcs(o[k])).join(',') + '}';
  if (typeof o !== 'string') throw new Error('non-string leaf'); return JSON.stringify(o);
}

// ── FROZEN V2 packageBodyHash framing (same as the integrated vector) ──
const SIG_DOMAIN_V2 = K('PCC:vnext:evidence-package-sig:v1');   // AUTHORITATIVE :v1 (oracle #1414 — V2 = raw32 framing, not suffix)
function packageBodyHash(body) {
  const jcsBytes = Buffer.from(jcs(body), 'utf8');
  return sha256b(Buffer.concat([raw32(SIG_DOMAIN_V2), u64be(jcsBytes.length), jcsBytes]));
}

// ── a minimal but realistic V2 body (KAT-local; NOT the integrated golden's body) ──
const body = {
  packageSchemaVersion: 'FinalMilestonePackageV2', packageFormat: '2', compositionSchemaVersion: '1',
  unitBinding: { settlementUnitId: '0x4453a3d232c24342539bc5ae06089f1cf7ccf93f737cffd67cf0a6ea76904ef1' },
  evidence: { evidenceBlockHash: '0x4605a6e9affa66fd2acd44f5b88d0468f293056573f04e884048f58ba8803a40' },
};
const bodyHash = packageBodyHash(body);
const msg = Buffer.from(bodyHash.slice(2), 'hex');   // the 32-byte digest the producer principals sign

// ── DETERMINISTIC real keys (fixed private material so the KAT is reproducible) ──
// operator: secp256k1 (ethers). kernel: ed25519 (node crypto from a fixed 32-byte seed via PKCS8 DER).
const opWallet = new E.Wallet('0x' + '11'.repeat(32));
const opSigningKey = opWallet.signingKey || new E.SigningKey('0x' + '11'.repeat(32));
const kernelSeed = Buffer.from('22'.repeat(32), 'hex');
const kernelPriv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), kernelSeed]), format: 'der', type: 'pkcs8' });
const kernelPub = crypto.createPublicKey(kernelPriv);
const kernelPubRaw = kernelPub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');   // raw 32-byte ed25519 pubkey
const kernelId = '0x' + keccak256('0x' + kernelPubRaw).slice(-40);   // address-like id derived from the kernel pubkey

// ── REAL signatures over packageBodyHash ──
const opSig = opSigningKey.sign(bodyHash).serialized;                                   // secp256k1 {r,s,v}
const ed25519sign = (m, priv) => '0x' + crypto.sign(null, m, priv).toString('hex');
const kernelSig = ed25519sign(msg, kernelPriv);                                          // ed25519

// ── canonical signature envelope: dedup-by-signer + sort-by-signer ──
const rawSigs = [
  { signer: kernelId, scheme: 'ed25519', sig: kernelSig },
  { signer: opWallet.address, scheme: 'secp256k1', sig: opSig },
  { signer: kernelId, scheme: 'ed25519', sig: kernelSig },   // duplicate signer -> deduped
];
const canonicalSigs = (s) => { const m = new Map(); for (const x of s) { const id = x.signer.toLowerCase(); if (!m.has(id)) m.set(id, x); } return [...m.values()].sort((a, b) => a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1); };
const signatures = canonicalSigs(rawSigs);

console.log(`ethers=${E.version || 'v6'}\n== FinalMilestonePackageV2 REAL-SIGNATURE KAT (secp256k1 operator + ed25519 kernel) ==`);
console.log(`  packageBodyHash   ${bodyHash}`);
console.log(`  operator (secp256k1) ${opWallet.address}`);
console.log(`  kernel   (ed25519)   ${kernelId}  pub ${kernelPubRaw.slice(0, 16)}..`);

let ok = true;
const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// (1) REAL secp256k1: recover the operator address from the sig over packageBodyHash
const recovered = E.recoverAddress ? E.recoverAddress(bodyHash, opSig) : E.utils.recoverAddress(bodyHash, opSig);
chk(recovered.toLowerCase() === opWallet.address.toLowerCase(), 'REAL secp256k1: operator signature over packageBodyHash recovers the operator address (a real producer sig crosses the boundary)');

// (2) REAL ed25519: verify the kernel signature over packageBodyHash against the kernel pubkey
const ed25519verify = (m, pubRawHex, sigHex) => {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubRawHex, 'hex')]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify(null, m, key, Buffer.from(sigHex.slice(2), 'hex'));
};
chk(ed25519verify(msg, kernelPubRaw, kernelSig), 'REAL ed25519: kernel signature over packageBodyHash verifies against the kernel pubkey');

// (3) canonical envelope determinism with REAL sigs (dedup + sort)
chk(signatures.length === 2, 'canonical envelope: duplicate signer deduped (3 raw -> 2)');
const reordered = canonicalSigs([rawSigs[1], rawSigs[2], rawSigs[0]]);
chk(jcs(reordered) === jcs(signatures), 'canonical envelope: reorder+dup -> identical envelope (real-sig malleability closed)');

// (4) TAMPER: mutate the body -> packageBodyHash changes -> both real sigs REJECT (fail-closed)
const tampered = { ...body, unitBinding: { settlementUnitId: K('other-unit') } };
const tHash = packageBodyHash(tampered), tMsg = Buffer.from(tHash.slice(2), 'hex');
const recT = (E.recoverAddress ? E.recoverAddress(tHash, opSig) : E.utils.recoverAddress(tHash, opSig));
chk(recT.toLowerCase() !== opWallet.address.toLowerCase(), 'TAMPER secp256k1: mutated body -> operator sig no longer recovers the operator (rejected)');
chk(!ed25519verify(tMsg, kernelPubRaw, kernelSig), 'TAMPER ed25519: mutated body -> kernel sig rejects (fail-closed)');

// (5) WRONG-SIGNER: a sig from a different key is not the operator's
const other = new E.SigningKey('0x' + '99'.repeat(32));
const otherSig = other.sign(bodyHash).serialized;
const recW = (E.recoverAddress ? E.recoverAddress(bodyHash, otherSig) : E.utils.recoverAddress(bodyHash, otherSig));
chk(recW.toLowerCase() !== opWallet.address.toLowerCase(), 'WRONG-SIGNER: a different key over the same body recovers a different address -> not the authorized operator');

// (6) pinned KAT golden (deterministic keys -> stable)
const EXPECT = {
  packageBodyHash: '0x653fb2e5226092d579def9ae67ed996f64bdd6265113250a55bd1755cb7fe952',
  operator: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  kernel: '0x6544b5fc0eca6431c8133c58c5e8112f530ed520',
};
chk(bodyHash.toLowerCase() === EXPECT.packageBodyHash.toLowerCase(), `pinned KAT: packageBodyHash == ${EXPECT.packageBodyHash}`);
chk(opWallet.address === EXPECT.operator && kernelId === EXPECT.kernel, 'pinned KAT: deterministic operator + kernel ids stable');
chk(recovered.toLowerCase() === opWallet.address.toLowerCase() && ed25519verify(msg, kernelPubRaw, kernelSig), 'KAT: both real producer signatures verify over the frozen packageBodyHash framing');

console.log(`\n${ok ? 'FinalMilestonePackageV2 REAL-SIGNATURE KAT: real secp256k1 (operator) + ed25519 (kernel) producer sigs verify over packageBodyHash; tamper + wrong-signer rejected; canonical envelope deterministic. Folds sol gate-6 real-signatures for the package (mechanism proof; integrated golden keeps its sample-sig envelope, undisturbed).' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
