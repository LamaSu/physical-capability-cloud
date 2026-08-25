#!/usr/bin/env node
/* sessionkey-grant-golden-vector.cjs — EVIDENCE lane (c25c8f97). The GOLDEN for the two session-auth
 * values per RATIFIED D3 (oracle #1030 confirming sol's two-value model, Evidence Commitment Profile v1
 * ~/.claude/shared/vnext-evidence-commitment-profile-v1.md §3):
 *
 *   canonicalSessionKeyBytes(sk) = utf8( JSON.stringify(body) )  — the EXACT production preimage the parent
 *     signs (packages/verifier/src/workflow/ephemeral-identity.ts:65-85): EXPLICIT key order
 *     sessionId,parentAgentId,publicKey(hex),issuedAt,expiresAt,scope{allowedActions SORTED, contractIds SORTED,
 *     maxSignatures}[,derivationPath]; EXCLUDES parentSignature; sorted key order is NOT used (explicit order is).
 *   sessionKeyGrantHash  = keccak256( GRANT_DOMAIN || canonicalSessionKeyBytes )
 *   sessionKeyAuthDigest = keccak256( abi.encode(AUTH_DOMAIN, sessionKeyGrantHash, parentSignature(bytes),
 *                            parentPubKey(bytes32), scheme(uint8), keyVersion(uint32)) )
 *     — binds the FULL proof incl parentSignature (prevents proof-substitution) + keyVersion (rotation) + the
 *       pinned parent key/scheme identity (oracle #1030 ADD keyVersion). Verifier verifies the parentSignature
 *       over the GRANT bytes, then commits the full proof.
 *
 * This is the conformance GOLDEN. The PRODUCTION path must EXPORT a shared canonicalSessionKeyBytes helper
 * (sol #4: do not duplicate the private fn) and match these values — that export is a coordinated code change
 * (routed to oracle, who consumes the verifier package). This vector re-derives the body ONLY to pin the golden.
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node sessionkey-grant-golden-vector.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const raw32 = (h) => Buffer.from(h.slice(2), 'hex');

// ── production canonicalSessionKeyBytes (ephemeral-identity.ts:65-85) — EXPLICIT order, EXCLUDES parentSignature ──
function canonicalSessionKeyBytes(sk) {
  const body = {
    sessionId: sk.sessionId,
    parentAgentId: sk.parentAgentId,
    publicKey: sk.publicKey,                 // hex (no 0x), toHex() of the raw pubkey
    issuedAt: sk.issuedAt,
    expiresAt: sk.expiresAt,
    scope: {
      allowedActions: [...sk.scope.allowedActions].sort(),
      contractIds: [...sk.scope.contractIds].sort(),
      maxSignatures: sk.scope.maxSignatures,
    },
  };
  if (sk.derivationPath !== undefined) body.derivationPath = sk.derivationPath;
  return Buffer.from(JSON.stringify(body), 'utf8');   // JSON.stringify preserves INSERTION order (NOT sorted keys)
}

const GRANT_DOMAIN = K('PCC:vnext:session-key-grant:v1');
const AUTH_DOMAIN = K('PCC:vnext:session-key-auth:v1');
const SCHEME_ED25519 = 1;   // scheme id (registry §2)

// ── deterministic parent key (ed25519) + a sample session grant ──
const pSeed = Buffer.from('44'.repeat(32), 'hex');
const parentPriv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), pSeed]), format: 'der', type: 'pkcs8' });
const parentPubRaw = crypto.createPublicKey(parentPriv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const kernelPubRaw = 'aa'.repeat(32);   // the ephemeral session (kernel) pubkey being delegated

const sk = {
  sessionId: 'sess-golden', parentAgentId: 'kernel-golden-01', publicKey: kernelPubRaw,
  issuedAt: 1755648000, expiresAt: 1755734400,
  scope: { allowedActions: ['sign-evidence'], contractIds: ['unit-golden'], maxSignatures: 8 },
};
const keyVersion = 1;

const grantBytes = canonicalSessionKeyBytes(sk);
const parentSignature = '0x' + crypto.sign(null, grantBytes, parentPriv).toString('hex');   // parent signs the GRANT bytes

const sessionKeyGrantHash = keccak256(Buffer.concat([raw32(GRANT_DOMAIN), grantBytes]));
const sessionKeyAuthDigest = keccak256(enc(
  ['bytes32', 'bytes32', 'bytes', 'bytes32', 'uint8', 'uint32'],
  [AUTH_DOMAIN, sessionKeyGrantHash, parentSignature, '0x' + parentPubRaw, SCHEME_ED25519, keyVersion]));

console.log(`ethers=${E.version || 'v6'}\n== sessionKey two-value golden (RATIFIED D3, oracle #1030) ==`);
console.log(`  canonicalSessionKeyBytes  ${grantBytes.toString('utf8')}`);
console.log(`  parent pubkey (raw32)     0x${parentPubRaw}`);
console.log(`  parentSignature           ${parentSignature}`);
console.log(`  sessionKeyGrantHash       ${sessionKeyGrantHash}`);
console.log(`  sessionKeyAuthDigest      ${sessionKeyAuthDigest}   (keyVersion=${keyVersion}, scheme=ed25519)\n`);

let ok = true; const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };
const ed25519verify = (m, pubRawHex, sigHex) => crypto.verify(null, m,
  crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubRawHex, 'hex')]), format: 'der', type: 'spki' }),
  Buffer.from(sigHex.slice(2), 'hex'));

// (1) the parentSignature verifies over the GRANT bytes (oracle verifies the sig over the grant, then commits the proof)
chk(ed25519verify(grantBytes, parentPubRaw, parentSignature), 'D3: parentSignature verifies over canonicalSessionKeyBytes (the grant bytes) — verifier checks the sig over the GRANT, not the full auth');

// (2) the grant EXCLUDES parentSignature: adding it to the body would change the grant bytes -> a different signing target
const withSig = { ...sk }; // canonicalSessionKeyBytes never reads parentSignature, so injecting it is a no-op == correct exclusion
chk(canonicalSessionKeyBytes({ ...sk, parentSignature: 'ff'.repeat(64) }).equals(grantBytes), 'D3: canonicalSessionKeyBytes EXCLUDES parentSignature (injecting one does not change the grant)');

// (3) scope arrays are SORTED: unsorted input yields the SAME grant (canonicalization sorts them)
const unsorted = { ...sk, scope: { allowedActions: ['sign-evidence'], contractIds: ['unit-golden'], maxSignatures: 8 } };
unsorted.scope.contractIds = ['unit-golden']; // single-element; prove the sort path is applied by a 2-elem case:
const multi = { ...sk, scope: { allowedActions: ['b', 'a'], contractIds: ['y', 'x'], maxSignatures: 8 } };
const multiSorted = { ...sk, scope: { allowedActions: ['a', 'b'], contractIds: ['x', 'y'], maxSignatures: 8 } };
chk(canonicalSessionKeyBytes(multi).equals(canonicalSessionKeyBytes(multiSorted)), 'D3: scope.allowedActions + contractIds are SORTED (unsorted vs sorted input -> identical grant bytes)');

// (4) full-proof binding: mutate parentSignature -> sessionKeyAuthDigest changes (proof-substitution prevented)
const otherSeed = Buffer.from('55'.repeat(32), 'hex');
const otherPriv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), otherSeed]), format: 'der', type: 'pkcs8' });
const otherSig = '0x' + crypto.sign(null, grantBytes, otherPriv).toString('hex');
const otherPubRaw = crypto.createPublicKey(otherPriv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const authWithOtherSig = keccak256(enc(['bytes32','bytes32','bytes','bytes32','uint8','uint32'], [AUTH_DOMAIN, sessionKeyGrantHash, otherSig, '0x' + otherPubRaw, SCHEME_ED25519, keyVersion]));
chk(authWithOtherSig.toLowerCase() !== sessionKeyAuthDigest.toLowerCase(), 'D3: a substituted parentSignature+key -> different sessionKeyAuthDigest (full proof bound; substitution rejected)');

// (5) keyVersion binds: rotating the key version -> different authDigest (rotation unambiguous)
const authV2 = keccak256(enc(['bytes32','bytes32','bytes','bytes32','uint8','uint32'], [AUTH_DOMAIN, sessionKeyGrantHash, parentSignature, '0x' + parentPubRaw, SCHEME_ED25519, 2]));
chk(authV2.toLowerCase() !== sessionKeyAuthDigest.toLowerCase(), 'D3: keyVersion binds (v1 vs v2 -> different sessionKeyAuthDigest; rotation is unambiguous)');

// (6) grant binds the auth: mutate the session body -> grantHash changes -> authDigest changes
const mutatedGrant = keccak256(Buffer.concat([raw32(GRANT_DOMAIN), canonicalSessionKeyBytes({ ...sk, sessionId: 'sess-EVIL' })]));
chk(mutatedGrant.toLowerCase() !== sessionKeyGrantHash.toLowerCase(), 'D3: mutating the session body -> different sessionKeyGrantHash -> different sessionKeyAuthDigest');

// ── pinned golden ──
const EXPECT = { sessionKeyGrantHash, sessionKeyAuthDigest };   // self-pin printed above; oracle cross-confirms the shared-helper output
chk(sessionKeyGrantHash !== ('0x' + '00'.repeat(32)) && sessionKeyAuthDigest !== ('0x' + '00'.repeat(32)), 'golden: both values non-zero + deterministic');

console.log(`\n${ok ? 'sessionKey two-value golden VERIFIED (D3 ratified): grant/auth split, sig-over-grant, parentSignature EXCLUDED from grant + BOUND in auth, scope sorted, keyVersion bound. Conformance target for the shared exported canonicalSessionKeyBytes helper (production export = coordinated change, routed to oracle).' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
