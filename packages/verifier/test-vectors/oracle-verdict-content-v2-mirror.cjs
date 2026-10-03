#!/usr/bin/env node
/* oracle-verdict-content-v2-mirror.cjs — EVIDENCE lane independent pure-Node mirror for
 * OracleVerdictContent v2 (dealBinding) — the seam's answer to oracle N37 (bus #4879): the
 * signed verdict must bind the accepted v3 deal it settles against. Companion spec:
 * ../../../../../../pcc-reconciliation/returns/pcc-evidence-work/oracle-verdict-content-v2.md
 * (the seam itself, step10-verdict-attestation-seam-contract.md §3/§4.1, stays UNCHANGED — this
 * is an addendum, not an edit).
 *
 * No ethers, no network, no new deps — SHA-256 only (node:crypto), because dealBinding introduces
 * no keccak/ABI surface: dealDigest and dependencySetHash are both SHA-256(JCS(...)) values, same
 * family as packageHash/verdictHash. This file independently re-implements:
 *
 *   1. JCS (RFC 8785) for the subset this content ever carries: null, boolean, safe-integer
 *      number, string, array (order preserved), object (keys sorted by UTF-16 code unit at every
 *      depth, undefined-valued keys omitted) — the same rules as the production
 *      packages/spec/src/util/canonical.ts#canonicalize (object-key sort via bare `.sort()`,
 *      numbers via `String(value)`, strings via `JSON.stringify`). Re-implemented here rather than
 *      required from that ESM module, so this mirror catches drift instead of hiding behind it.
 *   2. verdictHash = SHA-256(JCS(OracleVerdictContent)), rendered "sha256:"+lowercaseHex (seam §4,
 *      §4.1 content-hash form).
 *   3. dependencySetHash re-spelling: composition's PCC-side value is 0x-spelled; the verdict
 *      carries it sha256:-spelled; recomputing it needs the dealDigest INSIDE the preimage
 *      re-spelled back to 0x (THE TRAP — see dependencySetHashCheck below).
 *   4. A minimal reference shape-validator for the v2 surface ONLY (key-presence + dealBinding
 *      field forms). It does NOT implement the v1 content-type rules (unchanged, already covered
 *      elsewhere) or the dynamic chain-read checks (chainId-matches-unit / blockHash-is-canonical /
 *      block-finalized) — those need live chain state, out of scope for a vectors mirror; the spec
 *      addendum states them as prose the gateway/oracle must enforce at runtime.
 *
 * Run: node oracle-verdict-content-v2-mirror.cjs
 * Writes: oracle-verdict-content-v2.vectors.json (beside this file)
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const OUT_PATH = path.join(HERE, 'oracle-verdict-content-v2.vectors.json');

// ── JCS (RFC 8785, subset) — mirrors packages/spec/src/util/canonical.ts#canonicalize ──────────
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(); // default .sort() = UTF-16 code-unit order, not locale
    const pairs = keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k]));
    return '{' + pairs.join(',') + '}';
  }
  throw new Error('canonicalize: unsupported leaf type ' + typeof value);
}
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function verdictHashOf(content) { return 'sha256:' + sha256hex(canonicalize(content)); }

// ── shape rules for the v2 surface (dealBinding only; v1 content-type rules unchanged elsewhere) ──
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const HEX32_RE = /^0x[0-9a-f]{64}$/;
const NODEID_RE = /^[\x21-\x7E]{1,128}$/; // composition's ID_PATTERN (composition-commitment.ts)
const isSafeInt = (n) => typeof n === 'number' && Number.isSafeInteger(n);

function validateRead(read) {
  if (read === null || typeof read !== 'object' || Array.isArray(read)) return { ok: false, reason: 'read_not_object' };
  const keys = Object.keys(read).sort();
  const want = ['blockHash', 'blockNumber', 'chainId'];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return { ok: false, reason: 'read_unknown_key' };
  if (!isSafeInt(read.chainId)) return { ok: false, reason: 'read_chainId_not_safe_integer' };
  if (!isSafeInt(read.blockNumber)) return { ok: false, reason: 'blockNumber_not_safe_integer' };
  if (typeof read.blockHash !== 'string' || !HEX32_RE.test(read.blockHash)) return { ok: false, reason: 'blockHash_bad_form' };
  return { ok: true };
}
function validateDealBinding(db) {
  if (db === null) return { ok: true }; // unit outside an accepted deal
  if (typeof db !== 'object' || Array.isArray(db)) return { ok: false, reason: 'dealBinding_not_object_or_null' };
  const keys = Object.keys(db).sort();
  const want = ['dealDigest', 'dependencySetHash', 'nodeId', 'read'].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return { ok: false, reason: 'dealBinding_unknown_key' };
  if (typeof db.dealDigest !== 'string' || !SHA256_RE.test(db.dealDigest)) return { ok: false, reason: 'dealDigest_bad_form' };
  if (typeof db.dependencySetHash !== 'string' || !SHA256_RE.test(db.dependencySetHash)) return { ok: false, reason: 'dependencySetHash_bad_form' };
  if (typeof db.nodeId !== 'string' || !NODEID_RE.test(db.nodeId)) return { ok: false, reason: 'nodeId_bad_form' };
  const r = validateRead(db.read);
  if (!r.ok) return r;
  return { ok: true };
}
/** Key-presence rule (the v2 bump's core invariant): v1 never carries `dealBinding`; v2 always does
 * (present, value null or object) — checked via hasOwnProperty, NOT `=== undefined`, so an explicit
 * `dealBinding: undefined` does not slip past a JSON-shaped check (JSON has no undefined anyway, but
 * a pre-serialization object might). */
function validateContent(content) {
  const has = Object.prototype.hasOwnProperty.call(content, 'dealBinding');
  if (content.verdictSchemaVersion === 1) {
    if (has) return { ok: false, reason: 'v1_carries_dealBinding' };
    return { ok: true };
  }
  if (content.verdictSchemaVersion === 2) {
    if (!has) return { ok: false, reason: 'v2_missing_dealBinding' };
    return validateDealBinding(content.dealBinding);
  }
  return { ok: false, reason: 'unsupported_verdictSchemaVersion' };
}

// ── sample v1 fields (every OracleVerdictContent key, corrected types per seam §4.1) ──────────────
const settlementDomain = {
  chainId: 8453,
  factoryAddress: '0x' + '11'.repeat(20),
  escrowAddress: '0x' + '22'.repeat(20),
  easSchemaUid: '0x' + '33'.repeat(32),
};
const claims = {
  operatorPrincipalVerified: true, devicePrincipalVerified: true,
  deviceDistinctFromOperator: true, deviceHardwareBindingVerified: true,
  phaseDelegationVerified: true, sessionKeyVerified: true,
  contractWindowCompliant: true, liveGatewayReceiptsVerified: true,
  checkpointChainContinuous: true, evidenceTimeBound: 'point',
  independentWitnessVerified: true, physicalOutcomeVerified: true,
};
const v1Base = {
  verdictSchemaVersion: 1,
  claimsSchemaVersion: 1,
  assurancePolicyVersion: 1,
  verificationPolicyHash: 'sha256:' + '66'.repeat(32), // CORRECTED type per §4.1 (Sha256, not Hex32)
  verifierSetId: 'verifier-set-golden-v1',
  evidenceFormatVersion: 1,
  settlementDomain,
  jobId: 'job-golden-oracle-verdict-v2',
  milestoneIndex: 0,
  stepId: '0x' + '44'.repeat(32),
  settlementUnitId: '0x' + '55'.repeat(32),
  packageHash: 'sha256:' + '77'.repeat(32),
  acceptedEnvelopeHash: 'sha256:' + '88'.repeat(32),
  revealedPayloadHashes: ['sha256:' + '99'.repeat(32), 'sha256:' + 'aa'.repeat(32)], // already sorted ('9' < 'a')
  claims,
  achievedTier: 2,
  requestedTier: 2,
  decision: 'settle',
  contradiction: false,
  feeBps: 235,
  feeRecipient: '0x' + 'cc'.repeat(20),
  feeScheduleHash: '0x' + 'bb'.repeat(32),
  issuedAt: 1700000000,
};

const v1Content = v1Base; // v1: no dealBinding key, ever.
const v2NullContent = { ...v1Base, verdictSchemaVersion: 2, dealBinding: null };

// composition's node P (accepted-deal-v3.vectors.json, cb886fdf): dealDigest and dependencySetHash
// are PCC's own 0x-spelled values; re-spelled to sha256: for the Sha256-typed verdict fields.
const COMPOSITION_NODE_P = {
  nodeId: 'deliver:Bundle_P',
  dealDigest0x: '0x7b65b05581c3acb0ddb1a30696b4c94a6f3218b80a0ffb2a036516fc52af62ed',
  requires: ['Z-print.leg', 'a.mail_leg'], // direct children, sorted by code unit ('Z' 0x5A < 'a' 0x61)
  dependencySetHash0x: '0xc9b919da16c3ce2a6bd1c68a092e904ae11bc23af57396a6cbcf8dec4b973571',
};
const respell = (prefixOld, prefixNew, s) => prefixNew + s.slice(prefixOld.length);
const dealDigestSha256 = respell('0x', 'sha256:', COMPOSITION_NODE_P.dealDigest0x);
const dependencySetHashSha256 = respell('0x', 'sha256:', COMPOSITION_NODE_P.dependencySetHash0x);

const v2DealBindingContent = {
  ...v1Base,
  verdictSchemaVersion: 2,
  dealBinding: {
    dealDigest: dealDigestSha256,
    nodeId: COMPOSITION_NODE_P.nodeId,
    dependencySetHash: dependencySetHashSha256,
    read: { chainId: 8453, blockNumber: 12345678, blockHash: '0x' + 'dd'.repeat(32) },
  },
};

const v1VerdictHash = verdictHashOf(v1Content);
const v2NullVerdictHash = verdictHashOf(v2NullContent);
const v2DealBindingVerdictHash = verdictHashOf(v2DealBindingContent);

let ok = true;
const report = (label, pass, detail) => { ok = ok && pass; console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`); };

console.log('== OracleVerdictContent v2 (dealBinding) -- golden vectors ==\n');
console.log(`  v1              verdictHash ${v1VerdictHash}`);
console.log(`  v2 (null)       verdictHash ${v2NullVerdictHash}`);
console.log(`  v2 (node P)     verdictHash ${v2DealBindingVerdictHash}\n`);

report('v1 content validates (no dealBinding key)', validateContent(v1Content).ok === true);
report('v2-null content validates (dealBinding: null)', validateContent(v2NullContent).ok === true);
report('v2-dealBinding content validates (node P)', validateContent(v2DealBindingContent).ok === true);
report('v1 and v2-null verdictHash differ (schema bump changes the hash)', v1VerdictHash !== v2NullVerdictHash);
report('v2-null and v2-dealBinding verdictHash differ (null vs object)', v2NullVerdictHash !== v2DealBindingVerdictHash);

// ── dependencySetHash re-spelling: THE TRAP, worked over composition's node P ──────────────────────
const correctPreimage = canonicalize({
  domain: 'PCC:dependency-set:v1',
  dealDigest: COMPOSITION_NODE_P.dealDigest0x, // 0x spelling INSIDE the preimage (correct)
  nodeId: COMPOSITION_NODE_P.nodeId,
  requires: COMPOSITION_NODE_P.requires,
});
const correctHash0x = '0x' + sha256hex(correctPreimage);

const wrongPreimage = canonicalize({
  domain: 'PCC:dependency-set:v1',
  dealDigest: dealDigestSha256, // THE TRAP: sha256: spelling left INSIDE the preimage (wrong)
  nodeId: COMPOSITION_NODE_P.nodeId,
  requires: COMPOSITION_NODE_P.requires,
});
const wrongHash0x = '0x' + sha256hex(wrongPreimage);

report('dependencySetHash(node P) recomputed == composition\'s published value', correctHash0x === COMPOSITION_NODE_P.dependencySetHash0x, correctHash0x);
report('THE TRAP: sha256:-spelled preimage gives a DIFFERENT hash than composition\'s', wrongHash0x !== COMPOSITION_NODE_P.dependencySetHash0x, wrongHash0x);
report('THE TRAP: wrong-spelling hash also differs from the correct recompute', wrongHash0x !== correctHash0x);

// ── negatives: each a verifier MUST refuse, each carrying its own recomputed verdictHash so it
// fails for its intended reason (not a coincidental stale-hash mismatch) ──────────────────────────
const clone = (o) => JSON.parse(JSON.stringify(o));
const { dealBinding: _omit, ...v2WithoutKeyContent } = v2NullContent; // same fields as v1, version 2

const negatives = [
  {
    name: 'v2-without-dealBinding-key',
    expectedReason: 'v2_missing_dealBinding',
    content: v2WithoutKeyContent,
  },
  {
    name: 'v1-with-dealBinding-key',
    expectedReason: 'v1_carries_dealBinding',
    content: { ...v1Content, dealBinding: null },
  },
  {
    name: 'dealBinding-unknown-key',
    expectedReason: 'dealBinding_unknown_key',
    content: (() => { const c = clone(v2DealBindingContent); c.dealBinding.extra = 'x'; return c; })(),
  },
  {
    name: 'dealDigest-uppercase-hex',
    expectedReason: 'dealDigest_bad_form',
    content: (() => { const c = clone(v2DealBindingContent); c.dealBinding.dealDigest = c.dealBinding.dealDigest.toUpperCase().replace('SHA256:', 'sha256:'); return c; })(),
  },
  {
    name: 'dealDigest-0x-instead-of-sha256-prefix',
    expectedReason: 'dealDigest_bad_form',
    content: (() => { const c = clone(v2DealBindingContent); c.dealBinding.dealDigest = respell('sha256:', '0x', c.dealBinding.dealDigest); return c; })(),
  },
  {
    name: 'blockNumber-not-safe-integer',
    expectedReason: 'blockNumber_not_safe_integer',
    content: (() => { const c = clone(v2DealBindingContent); c.dealBinding.read.blockNumber = 9007199254740992; /* 2**53, Number.isSafeInteger === false */ return c; })(),
  },
  {
    name: 'nodeId-empty',
    expectedReason: 'nodeId_bad_form',
    content: (() => { const c = clone(v2DealBindingContent); c.dealBinding.nodeId = ''; return c; })(),
  },
];
for (const n of negatives) {
  n.verdictHash = verdictHashOf(n.content);
  const v = validateContent(n.content);
  report(`negative ${n.name}: refused as ${n.expectedReason}`, v.ok === false && v.reason === n.expectedReason, `got=${JSON.stringify(v)}`);
}

// ── write the vectors file ──────────────────────────────────────────────────────────────────────
const vectors = {
  vector: 'pcc.evidence.oracle-verdict-content-v2/mirror',
  note: "Public test data. OracleVerdictContent v2 (dealBinding) per the evidence lane's ruling on oracle N37 "
    + '(bus #4879) + composition\'s dependencySetHash (bus #4940). v1 content fields use the CORRECTED types '
    + 'from seam §4.1 (verificationPolicyHash: Sha256, not the stale §3 Hex32). dealDigest/dependencySetHash '
    + "in dealBinding are composition's node P values (accepted-deal-v3.vectors.json, cb886fdf), re-spelled "
    + 'from 0x to sha256: for the verdict; dependencySetHashCheck recomputes the PCC-side 0x value from the '
    + 'preimage independently and checks it against composition\'s published value byte-for-byte. This mirror '
    + 'validates only the v2 surface (key-presence + dealBinding field forms); v1 content-type rules and the '
    + 'dynamic chain-read checks (chainId-matches-unit / blockHash-canonical / block-finalized) are out of scope.',
  algorithms: {
    verdictHash: 'SHA-256(JCS(OracleVerdictContent)), rendered "sha256:" + lowercaseHex (seam §4/§4.1). JCS = '
      + 'RFC 8785: keys sorted by UTF-16 code unit at every depth, no whitespace, arrays in given order.',
    dealBindingKeyPresence: 'v1 (verdictSchemaVersion 1): dealBinding key never present. v2 (verdictSchemaVersion '
      + '2): dealBinding key always present, value null (unit outside an accepted deal) or a DealBinding object. '
      + 'Any other verdictSchemaVersion: unsupported (seam §9), not this addendum\'s concern.',
    dealBinding: '{ dealDigest: Sha256, nodeId: string (ID_PATTERN /^[\\x21-\\x7E]{1,128}$/), dependencySetHash: '
      + 'Sha256, read: { chainId: number, blockNumber: number, blockHash: Hex32 } } -- exactly these keys at both '
      + 'levels; unknown keys refused. chainId/blockNumber are JSON numbers, safe integers only.',
    dependencySetHash: 'PCC\'s own value is 0x + SHA-256(UTF-8(canonicalize({domain:"PCC:dependency-set:v1", '
      + 'dealDigest, nodeId, requires}))), requires = direct children sorted by code unit, and the PREIMAGE '
      + "embeds dealDigest in the 0x spelling. THE TRAP: a verifier holding the verdict's sha256:-spelled "
      + 'dealDigest must re-spell it to 0x BEFORE building this preimage, and re-spell only the OUTPUT to '
      + 'sha256: for the verdict field. Spelling it sha256: inside the preimage hashes a different string and '
      + 'gives a different, wrong hash (demonstrated below).',
  },
  v1: { content: v1Content, verdictHash: v1VerdictHash },
  v2Null: { content: v2NullContent, verdictHash: v2NullVerdictHash },
  v2DealBinding: { content: v2DealBindingContent, verdictHash: v2DealBindingVerdictHash },
  dependencySetHashCheck: {
    node: COMPOSITION_NODE_P.nodeId,
    dealDigest0x: COMPOSITION_NODE_P.dealDigest0x,
    dealDigestSha256,
    requires: COMPOSITION_NODE_P.requires,
    preimageCorrect: correctPreimage,
    recomputed0x: correctHash0x,
    expectedFromComposition0x: COMPOSITION_NODE_P.dependencySetHash0x,
    dependencySetHashSha256,
    matchesComposition: correctHash0x === COMPOSITION_NODE_P.dependencySetHash0x,
    preimageWrongSpelling: wrongPreimage,
    recomputedWrongSpelling0x: wrongHash0x,
    wrongDiffersFromComposition: wrongHash0x !== COMPOSITION_NODE_P.dependencySetHash0x,
    wrongDiffersFromCorrect: wrongHash0x !== correctHash0x,
  },
  negatives: negatives.map((n) => ({
    name: n.name,
    expected: { refused: true, reason: n.expectedReason },
    content: n.content,
    verdictHash: n.verdictHash,
  })),
};
fs.writeFileSync(OUT_PATH, JSON.stringify(vectors, null, 2) + '\n', 'utf8');
console.log(`\nwrote ${OUT_PATH}`);
console.log(`\n${ok ? 'OracleVerdictContent v2 (dealBinding) GOLDEN + dependencySetHash parity + negatives: OK' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
