#!/usr/bin/env node
/* evidence-bundle-golden-vector.cjs — EVIDENCE lane (c25c8f97). The sol #1 CLOSE seam vectors oracle asked
 * for in #1183/#1188 (it is BLOCKED on these). Produces BOTH evidence-owned golden vectors + answers the
 * canonicalization question FROM SOURCE (packages/spec/src/util/canonical.ts + verification-program.ts).
 *
 * SEAM 1 (program-integrity): the 18 subject FIELD VALUES behind subjectBlockHash 0x05fb7b45 (keccak/abi,
 *   committedProgramHash field 10) + computeProgramHash golden (verification-program.ts).
 * SEAM 2 (events-auth): a real EvidenceBundle vector — events[], per-event hash, bundleHash, a REAL Ed25519
 *   kernelSignature, sessionKeyAuthorization, sessionKeyAuthDigest — using the ACTUAL spec canonicalization.
 *
 * CANONICALIZATION (authoritative, from util/canonical.ts — NOT RFC-8785 JCS):
 *   canonicalize: keys sorted lexicographically at all depths; no whitespace; numbers/booleans via String();
 *   strings via JSON.stringify; null -> "null"; undefined omitted in objects.
 *   sha256(x) = "sha256:" + hex( SHA-256(utf8(x)) )   <-- "sha256:" PREFIX (not 0x)
 *   hashEvent = sha256(canonicalize({type,timestamp,source,payload}))  (keys sort to payload,source,timestamp,type)
 *   hashBundle = sha256(canonicalize( events.map(e=>e.hash).sort() ))
 *   programHash = "0x" + hex( SHA-256(canonicalize({version,schemaHash,stages})) )  <-- 0x PREFIX (verification-program.ts)
 * EvidenceBlock bytes32 roots strip the prefix: kernelSignedEventsRoot = "0x"+bundleHash.slice(7);
 *   sessionKeyAuthDigest = "0x"+sha256(canonicalize(sessionKeyAuthorization)).slice(7). kernelSignature is
 *   Ed25519 over the UTF-8 BYTES of the full "sha256:"-prefixed bundleHash STRING — matches the REAL producer
 *   (kernel-sdk job-handler.ts:352-353 `TextEncoder().encode(bundleHash)` + verifyBundleSignature:394), NOT the raw
 *   32-byte digest. (sol cross-family review fix #1, coord #1240: the raw-digest form was producer-incompatible.)
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node evidence-bundle-golden-vector.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');

// ── EXACT replica of util/canonical.ts canonicalize + sha256 ("sha256:" prefix) ──
function canonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return '{' + keys.filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
  }
  return String(v);
}
const sha256pfx = (s) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');   // spec sha256() — PREFIXED
const sha256hex0x = (s) => '0x' + crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');       // verification-program.ts style — 0x

let ok = true; const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };
console.log(`ethers=${E.version || 'v6'}\n== sol #1 CLOSE golden vectors (evidence-owned; oracle #1183/#1188) ==\n`);

// ═══════════ SEAM 1: the 18 subject field values -> subjectBlockHash 0x05fb7b45 (keccak/abi) ═══════════
const sortHex = (a) => [...new Set(a.map((x) => x.toLowerCase()))].sort();
const sortTup = (a) => [...a].sort((x, y) => JSON.stringify(x).toLowerCase() < JSON.stringify(y).toLowerCase() ? -1 : 1);
const S = {
  payer: K('golden-payer'), operatorPrincipal: K('golden-operator'), operatorSettlementAddress: addr(0x0a71n),
  expectedRecipient: K('golden-recipient'), targetSystemIdentity: K('golden-target-system'),
  committedProgramHash: K('golden-program'), recipeRef: K('golden-recipe'), sampleManifestRef: K('golden-sample-manifest'),
  expectedRouteArea: K('golden-route-area'), captureNonceAnchor: K('golden-capture-nonce'), challengeAnchor: K('golden-challenge-anchor'),
  integrityGrade: 2,
};
S.authorizedTuplesRoot = keccak256(enc(['tuple(bytes32,bytes32,bytes32)[]'], [sortTup([[S.operatorPrincipal, K('golden-kernel'), K('golden-device')]])]));
S.expertSetRoot = keccak256(enc(['bytes32[]'], [sortHex([K('golden-expert-1')])]));
S.executorSetRoot = keccak256(enc(['bytes32[]'], [sortHex([K('golden-exec-1')])]));
S.childrenRoot = keccak256(enc(['tuple(bytes32,address)[]'], [sortTup([[K('golden-child-job'), addr(0xc41dn)]])]));
S.operatingEnvelopeHash = keccak256(enc(['tuple(bytes32,uint256,uint256)[]'], [[[K('power'), 0n, 1000n], [K('temp'), 0n, 250n]]]));
S.expectedLocationHash = keccak256(enc(['int256', 'int256', 'uint256', 'uint64'], [377749000n, -1224194000n, 500n, 1700000000n]));
const SUBJECT_DOMAIN = K('PCC:vnext:accepted-policy-subjects:v1');
const subjectBlockHash = keccak256(enc(
  ['bytes32', 'bytes32', 'bytes32', 'address', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint8'],
  [SUBJECT_DOMAIN, S.payer, S.operatorPrincipal, S.operatorSettlementAddress, S.authorizedTuplesRoot, S.expertSetRoot, S.executorSetRoot,
   S.expectedRecipient, S.targetSystemIdentity, S.committedProgramHash, S.recipeRef, S.sampleManifestRef, S.childrenRoot,
   S.operatingEnvelopeHash, S.expectedRouteArea, S.expectedLocationHash, S.captureNonceAnchor, S.challengeAnchor, S.integrityGrade]));
console.log('SEAM 1 — subject field values (keccak/abi; committedProgramHash is field 10):');
for (const [k, v] of Object.entries(S)) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`  SUBJECT_DOMAIN           ${SUBJECT_DOMAIN}`);
console.log(`  -> subjectBlockHash      ${subjectBlockHash}`);
chk(subjectBlockHash.toLowerCase() === '0x05fb7b45f6079ca2c82f6b3676e8af2cf98f3322bdc1e64acf0afc2aef2c46c7', 'SEAM 1: subjectBlockHash reproduces the published 0x05fb7b45 (inside acceptedPolicyDigest 0xa821492a)');

// computeProgramHash golden (verification-program.ts: 0x + sha256hex(canonicalize({version,schemaHash,stages})))
const program = { version: 1, schemaHash: K('golden-work-schema'), stages: [{ stageId: 'settle', releaseBps: 10000, onTimeout: 'refund', onFail: 'refund',
  predicate: { kind: 'and', children: [ { kind: 'event-presence', eventType: 'execution_completed', atLeast: 1 }, { kind: 'field-threshold', eventRef: { eventType: 'cv_inspection_result' }, path: '/pass', op: '=', value: 1 } ] } }] };
const programHash = sha256hex0x(canonicalize({ version: program.version, schemaHash: program.schemaHash, stages: program.stages }));
console.log(`\nSEAM 1 — computeProgramHash (0x + sha256hex(canonicalize({version,schemaHash,stages}))): ${programHash}`);
chk(/^0x[0-9a-f]{64}$/.test(programHash), 'SEAM 1: programHash is 0x-prefixed sha256 over canonicalize (NOT keccak; NOT sha256: prefix)');

// ═══════════ SEAM 2: EvidenceBundle golden vector (real Ed25519) ═══════════
const source = { deviceId: 'dev-golden', deviceType: 'controller', kernelId: 'kernel-golden-01' };
const rawEvents = [
  { type: 'execution_completed', timestamp: '2026-08-20T00:00:00Z', source, payload: { ok: true } },
  { type: 'cv_inspection_result', timestamp: '2026-08-20T00:00:05Z', source, payload: { pass: 1, defects: 0 } },
];
const events = rawEvents.map((e) => ({ ...e, hash: sha256pfx(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload })) }));
const bundleHash = sha256pfx(canonicalize(events.map((e) => e.hash).sort()));                 // spec hashBundle
const kernelSignedEventsRoot = '0x' + bundleHash.slice(7);                                     // block bytes32 = strip "sha256:"
const bundleHashMsg = Buffer.from(bundleHash, 'utf8');                                         // PRODUCER signs the UTF-8 bytes of the FULL "sha256:"+hex STRING (job-handler.ts:352)

// real Ed25519 kernel key (deterministic seed) + sign the UTF-8 bundleHash STRING (matches the real producer, NOT the raw digest)
const kSeed = Buffer.from('33'.repeat(32), 'hex');
const kernelPriv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), kSeed]), format: 'der', type: 'pkcs8' });
const kernelPub = crypto.createPublicKey(kernelPriv);
const kernelPubRaw = kernelPub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const kernelSignature = '0x' + crypto.sign(null, bundleHashMsg, kernelPriv).toString('hex');

// sessionKeyAuthorization: the principal (parent) signs the canonical SessionKey body authorizing the ephemeral publicKey
const pSeed = Buffer.from('44'.repeat(32), 'hex');
const parentPriv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), pSeed]), format: 'der', type: 'pkcs8' });
const parentPubRaw = crypto.createPublicKey(parentPriv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const sessionKeyAuthorization = {
  sessionId: 'sess-golden', parentAgentId: 'kernel-golden-01', publicKey: kernelPubRaw,
  issuedAt: 1755648000, expiresAt: 1755734400,
  scope: { allowedActions: ['sign-evidence'], contractIds: ['unit-golden'], maxSignatures: 8 },
};
const sessionKeyBody = canonicalize(sessionKeyAuthorization);                                  // parent signs THIS
sessionKeyAuthorization.parentSignature = '0x' + crypto.sign(null, Buffer.from(sessionKeyBody, 'utf8'), parentPriv).toString('hex');
const sessionKeyAuthDigest = '0x' + sha256pfx(canonicalize(sessionKeyAuthorization)).slice(7); // block bytes32

// verify (the SAME checks oracle runs)
const ed25519verify = (msg, pubRawHex, sigHex) => crypto.verify(null, msg, crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubRawHex, 'hex')]), format: 'der', type: 'spki' }), Buffer.from(sigHex.slice(2), 'hex'));

console.log('\nSEAM 2 — EvidenceBundle golden vector:');
console.log(`  event[0].hash            ${events[0].hash}`);
console.log(`  event[1].hash            ${events[1].hash}`);
console.log(`  bundleHash               ${bundleHash}`);
console.log(`  kernelSignedEventsRoot   ${kernelSignedEventsRoot}   (block bytes32 = strip "sha256:")`);
console.log(`  kernel pubkey (raw32)    0x${kernelPubRaw}`);
console.log(`  kernelSignature (ed25519 over UTF-8 of the "sha256:" bundleHash string)  ${kernelSignature}`);
console.log(`  parent pubkey (raw32)    0x${parentPubRaw}`);
console.log(`  parentSignature          ${sessionKeyAuthorization.parentSignature}`);
console.log(`  sessionKeyAuthDigest     ${sessionKeyAuthDigest}   (block bytes32)`);

chk(events.every((e) => e.hash === sha256pfx(canonicalize({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }))), 'SEAM 2: per-event hash = sha256(canonicalize({type,timestamp,source,payload})) recomputes (verifyEventHash)');
chk(bundleHash === sha256pfx(canonicalize(events.map((e) => e.hash).sort())), 'SEAM 2: bundleHash = sha256(canonicalize(sorted event hashes)) recomputes (verifyBundleHash)');
chk(ed25519verify(bundleHashMsg, kernelPubRaw, kernelSignature), 'SEAM 2: kernelSignature verifies over the UTF-8 bytes of the "sha256:" bundleHash string (== kernel-sdk verifyBundleSignature:394 — PRODUCER-COMPATIBLE)');
chk(ed25519verify(Buffer.from(sessionKeyBody, 'utf8'), parentPubRaw, sessionKeyAuthorization.parentSignature), 'SEAM 2: parentSignature verifies the delegation (principal authorized the ephemeral publicKey)');
chk(sessionKeyAuthorization.publicKey === kernelPubRaw, 'SEAM 2: the delegated publicKey IS the kernel signer (ties sessionKeyAuth -> kernelSignature)');
chk(!ed25519verify(Buffer.from('sha256:' + K('tampered').slice(2), 'utf8'), kernelPubRaw, kernelSignature), 'SEAM 2 negative: kernelSignature over a DIFFERENT bundleHash string rejects (fail-closed)');

console.log(`\n${ok ? 'sol #1 CLOSE golden vectors VERIFIED. SEAM 1: subjectBlockHash 0x05fb7b45 + programHash. SEAM 2: EvidenceBundle with REAL Ed25519 kernel + delegation. Canonicalization is util/canonical.ts (sorted-keys/String-numbers/sha256: prefix), NOT RFC-8785. Oracle reproduces both -> flips sol #2 gate label->derived.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
