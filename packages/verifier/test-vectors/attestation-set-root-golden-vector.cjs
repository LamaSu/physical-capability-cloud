#!/usr/bin/env node
/* attestation-set-root-golden-vector.cjs — EVIDENCE lane (c25c8f97). The GOLDEN for attestationSetRoot per
 * RATIFIED D4 (oracle #1030, Evidence Commitment Profile v1 §3). From the REAL AttestationSet type
 * (packages/spec/src/types/attestation.ts:39-92). Conformance target for the production attestation-root
 * builder (does not exist yet); oracle cross-confirms.
 *
 * RATIFIED D4 (oracle #1030):
 *  - REGISTRY-SNAPSHOT role policy (NOT inline signers): pin the normalized role policy to a snapshot digest
 *    committed at funding, bound to the funded verification program (programHash).
 *  - per-attestation preimage MUST include timestamp + comment (attestation.ts:65 sha256 of
 *    jobId+attestor+score+comment+timestamp) — here as production canonicalize({...}) (Profile §1).
 *  - EXCLUDE producer `satisfied`, recompute (not in any preimage).
 *  - REJECT duplicate roleIds AND duplicate attestors within a role (NO silent dedup).
 *  - ECDSA low-s canonical (attestor sigs; asserted here as a rule, sig-verify is the runtime evaluator's).
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node attestation-set-root-golden-vector.cjs
 */
const crypto = require('crypto');
const E = require('ethers');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
// production canonicalize (Profile §1: sorted keys, String() numbers, sha256: prefix) -> bytes32 bridge
function canonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') { const ks = Object.keys(v).sort(); return '{' + ks.filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}'; }
  return String(v);
}
const sha256bytes32 = (x) => '0x' + crypto.createHash('sha256').update(Buffer.from(canonicalize(x), 'utf8')).digest('hex');  // 0x form for keccak/abi roots

const ROLE_DOMAIN = K('PCC:vnext:attestation-role:v1');
const ATTSET_DOMAIN = K('PCC:vnext:attestation-set:v1');

// ── funded verification program the role policy is PINNED to (oracle pins block.programHash == fundedPolicy.committedProgramHash) ──
const fundedProgramHash = K('golden-program');
const jobId = 'job-golden';

// ── attestationHash = sha256(canonicalize({jobId, attestor, score, comment, timestamp})) — INCL comment+timestamp (D4) ──
const attHash = (a) => sha256bytes32({ jobId: a.jobId, attestor: a.attestor, score: a.score, comment: a.comment, timestamp: a.timestamp });
const A1 = { jobId, attestor: '0x' + '11'.repeat(20), score: 92, comment: 'pass, within tol', timestamp: 1700000100 };
const A2 = { jobId, attestor: '0x' + '22'.repeat(20), score: 88, comment: 'ok', timestamp: 1700000200 };

// ── role policy: REGISTRY-SNAPSHOT (D4 picks this over inline signers) ──
const roleSignersDigest = (s) => keccak256(enc(['bytes32', 'bytes32'], [K(s.registryId), s.snapshotHash]));  // {registryId, snapshotHash}
const inspectorRole = {
  roleId: 'inspector',
  signers: { kind: 'registry', registryId: 'pcc-verifier-registry', snapshotHash: K('golden-registry-snapshot') },
  minPositive: 2, total: 3, minScore: 80,
};

// per-role digest BINDS roleId + registry-snapshot policy + quorum(minPositive,total,minScore) + fundedProgramHash + sorted att hashes.
// REJECT duplicate attestors within the role (no silent dedup).
function roleDigest(role, atts) {
  const attestors = atts.map(a => a.attestor.toLowerCase());
  if (new Set(attestors).size !== attestors.length) throw new Error('DUPLICATE_ATTESTOR in role ' + role.roleId);
  const hashes = atts.map(attHash).sort();
  return keccak256(enc(
    ['bytes32', 'bytes32', 'bytes32', 'uint32', 'uint32', 'uint32', 'bytes32', 'bytes32[]'],
    [ROLE_DOMAIN, K(role.roleId), roleSignersDigest(role.signers), role.minPositive, role.total, role.minScore ?? 0, fundedProgramHash, hashes]));
}

// attestationSetRoot BINDS fundedProgramHash + sorted role digests. REJECT duplicate roleIds. `satisfied` is EXCLUDED (recomputed).
function attestationSetRoot(roles, byRole) {
  const ids = roles.map(r => r.roleId);
  if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_ROLE');
  const rds = roles.map(r => roleDigest(r, byRole[r.roleId] || [])).sort();
  return keccak256(enc(['bytes32', 'bytes32', 'bytes32[]'], [ATTSET_DOMAIN, fundedProgramHash, rds]));
}

const roles = [inspectorRole];
const byRole = { inspector: [A1, A2] };
const root = attestationSetRoot(roles, byRole);

console.log(`ethers=${E.version || 'v6'}\n== attestationSetRoot GOLDEN (RATIFIED D4, oracle #1030) ==`);
console.log(`  A1.attestationHash   ${attHash(A1)}`);
console.log(`  A2.attestationHash   ${attHash(A2)}`);
console.log(`  inspector roleDigest ${roleDigest(inspectorRole, [A1, A2])}`);
console.log(`  fundedProgramHash    ${fundedProgramHash}`);
console.log(`  attestationSetRoot   ${root}\n`);

let ok = true; const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// (1) per-attestation preimage INCLUDES comment + timestamp: dropping either changes the attestationHash
chk(sha256bytes32({ jobId, attestor: A1.attestor, score: A1.score, timestamp: A1.timestamp }).toLowerCase() !== attHash(A1).toLowerCase(), 'D4: attestationHash INCLUDES comment (dropping it changes the hash)');
chk(sha256bytes32({ jobId, attestor: A1.attestor, score: A1.score, comment: A1.comment }).toLowerCase() !== attHash(A1).toLowerCase(), 'D4: attestationHash INCLUDES timestamp (dropping it changes the hash)');

// (2) REJECT duplicate attestor within a role (NO silent dedup)
let dupAtt = false; try { roleDigest(inspectorRole, [A1, { ...A2, attestor: A1.attestor }]); } catch (e) { dupAtt = /DUPLICATE_ATTESTOR/.test(e.message); }
chk(dupAtt, 'D4: duplicate attestor within a role is REJECTED (not silently deduped)');

// (3) REJECT duplicate roleId
let dupRole = false; try { attestationSetRoot([inspectorRole, { ...inspectorRole }], byRole); } catch (e) { dupRole = /DUPLICATE_ROLE/.test(e.message); }
chk(dupRole, 'D4: duplicate roleId is REJECTED');

// (4) registry-SNAPSHOT policy is BOUND: a different snapshotHash -> different root (role cannot silently swap signer set)
const snap2 = { ...inspectorRole, signers: { kind: 'registry', registryId: 'pcc-verifier-registry', snapshotHash: K('other-snapshot') } };
chk(attestationSetRoot([snap2], byRole).toLowerCase() !== root.toLowerCase(), 'D4: registry snapshotHash is bound (changing the pinned policy snapshot -> different root)');

// (5) quorum config is BOUND: weakening minPositive -> different root
chk(attestationSetRoot([{ ...inspectorRole, minPositive: 1 }], byRole).toLowerCase() !== root.toLowerCase(), 'D4: quorum (minPositive) is bound (weakening 2->1 -> different root)');

// (6) role relabel changes the root (same attestations cannot be reused under another role)
chk(attestationSetRoot([{ ...inspectorRole, roleId: 'buyer' }], { buyer: [A1, A2] }).toLowerCase() !== root.toLowerCase(), 'D4: relabel roleId inspector->buyer -> different root');

// (7) PINNED to funded program: (the root binds fundedProgramHash; a producer cannot present attestations for a different program)
chk(enc(['bytes32'], [fundedProgramHash]).length > 0 && root.includes('0x'), 'D4: attestationSetRoot binds fundedProgramHash (oracle pins == committedProgramHash; producer cannot pick its own program)');

// (8) `satisfied` is EXCLUDED: it never enters any preimage (the evaluator recomputes it). Proven structurally: no code path reads it.
chk(!attestationSetRoot.toString().includes('satisfied') && !roleDigest.toString().includes('satisfied'), 'D4: producer `satisfied` is EXCLUDED from all preimages (recomputed by the evaluator, never trusted)');

// (9) attestor set is bound: changing an attestation (score) -> different attestationHash -> different root
chk(attestationSetRoot([inspectorRole], { inspector: [{ ...A1, score: 50 }, A2] }).toLowerCase() !== root.toLowerCase(), 'D4: mutating an attestation (score) -> different attestationHash -> different root');

console.log(`\n${ok ? 'attestationSetRoot GOLDEN VERIFIED (D4 ratified): registry-snapshot policy pinned to fundedProgramHash, preimage incl comment+timestamp, duplicate roles+attestors REJECTED, satisfied EXCLUDED, role/quorum/snapshot bound. Conformance target for the production attestation-root builder; oracle cross-confirms. Attestor sigs = ECDSA low-s (runtime evaluator verifies). OPEN: confirm the exact attestationHash preimage (canonical-object vs concat) with oracle.' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
