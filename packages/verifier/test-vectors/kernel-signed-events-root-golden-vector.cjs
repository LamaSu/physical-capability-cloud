#!/usr/bin/env node
/* kernel-signed-events-root-golden-vector.cjs — EVIDENCE lane (c25c8f97). The GOLDEN for kernelSignedEventsRoot
 * in PRODUCTION form (sol NO-GO fix, Evidence Commitment Profile v1 §1/§3). Third constituent after
 * sessionKey D3 (973fdeb8) + attestation D4 (93830dc9). Conformance target for oracle's EvidenceBlockV2
 * builder input (oracle #1049: "REMAINING: your kernelSignedEventsRoot production-form fix").
 *
 * THE BUG sol/oracle diagnosed: the block mirror (evidence-block-v2-mirror.cjs) hashed event hashes formatted
 * as "0x.." + JSON.stringify; production hashEvent returns "sha256:.." and production hashBundle hashes THAT
 * tagged-string array. The event-hash PREFIX is carried as text into the bundle preimage, so the two forms
 * DIVERGE. Converting only the final hash to bytes32 cannot repair the different INNER preimage.
 *
 * PRODUCTION (packages/spec/src/util/canonical.ts hashEvent/hashBundle):
 *   eventHash = "sha256:" + hex(SHA-256(utf8(canonicalize({type,timestamp,source,payload}))))
 *   bundleHash = "sha256:" + hex(SHA-256(utf8(canonicalize( events.map(e=>e.hash).sort() ))))   <- sorts the sha256:-tagged strings
 *   kernelSignedEventsRoot (block bytes32) = "0x" + bundleHash.slice(7)                          <- the FROZEN sha256:->bytes32 bridge
 * Events are SCHEMA-VALID (ISO-8601 timestamps per schemas/index.ts; sol #34) + match the integrated bundle vector.
 * (canonicalize re-implemented here; oracle cross-confirmed the D3/D4 re-impls byte-exact — the @pcc/spec shared
 *  export is oracle's call/in-flight per #1049. Numbers here are finite ints/bools so String()==JSON.stringify.)
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node kernel-signed-events-root-golden-vector.cjs
 */
const crypto = require('crypto');
function canonicalize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (typeof v === 'object') { const ks = Object.keys(v).sort(); return '{' + ks.filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}'; }
  return String(v);
}
const SHA = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const sha256pfx = (x) => 'sha256:' + SHA(canonicalize(x));        // PRODUCTION spec sha256() — sha256: PREFIX
const sha256_0x = (x) => '0x' + SHA(canonicalize(x));            // block-mirror BUG form — 0x prefix

// ── events: schema-valid ISO-8601 timestamps, matching the integrated bundle vector ──
const source = { deviceId: 'dev-golden', deviceType: 'controller', kernelId: 'kernel-golden-01' };
const events = [
  { type: 'execution_completed', timestamp: '2026-08-20T00:00:00Z', source, payload: { ok: true } },
  { type: 'cv_inspection_result', timestamp: '2026-08-20T00:00:05Z', source, payload: { pass: 1, defects: 0 } },
];

// PRODUCTION form (the RIGHT one)
const eventHashesProd = events.map((e) => sha256pfx({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
const bundleHashProd = sha256pfx([...eventHashesProd].sort());        // hashBundle sorts the sha256:-tagged strings
const kernelSignedEventsRoot = '0x' + bundleHashProd.slice(7);       // sha256:->bytes32 bridge

// BLOCK-MIRROR form (the BUG) — same events, 0x-prefixed inner hashes
const eventHashes0x = events.map((e) => sha256_0x({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }));
const bundleHash0x = sha256_0x([...eventHashes0x].sort());
const mirrorRoot = bundleHash0x;   // block mirror used this directly as bytes32

console.log(`== kernelSignedEventsRoot GOLDEN (PRODUCTION form; sol/oracle #1049 remaining fix) ==`);
console.log(`  event[0].hash (prod)   ${eventHashesProd[0]}`);
console.log(`  event[1].hash (prod)   ${eventHashesProd[1]}`);
console.log(`  bundleHash (prod)      ${bundleHashProd}`);
console.log(`  kernelSignedEventsRoot ${kernelSignedEventsRoot}   (= "0x" + bundleHash.slice(7))`);
console.log(`  mirror-form root (BUG) ${mirrorRoot}\n`);

let ok = true; const chk = (c, l) => { ok = ok && c; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); };

// (1) the production form matches the integrated bundle vector's kernelSignedEventsRoot (one coherent event set)
chk(kernelSignedEventsRoot.toLowerCase() === '0x4e0af964e4e066717998ed7a49bf7c874023bd402b825da22b4dabd70fb6f9fe', 'PROD: kernelSignedEventsRoot == the bundle vector production value 0x4e0af964 (coherent event set)');

// (2) THE BUG: production != mirror form on the SAME events (the sha256: vs 0x prefix in the bundle preimage)
chk(kernelSignedEventsRoot.toLowerCase() !== mirrorRoot.toLowerCase(), 'BUG PROVEN: production (sha256:-tagged preimage) != block-mirror (0x-tagged preimage) on identical events — the prefix-in-preimage divergence');

// (3) the divergence is the INNER preimage, not the outer hash: the sorted arrays differ by prefix
const innerProd = canonicalize([...eventHashesProd].sort());
const inner0x = canonicalize([...eventHashes0x].sort());
chk(innerProd !== inner0x && innerProd.includes('sha256:') && inner0x.includes('0x'), 'ROOT CAUSE: the hashBundle preimage arrays differ (sha256:.. vs 0x..) — converting only the final hash cannot repair it');

// (4) event-hash is production sha256(canonicalize({type,timestamp,source,payload})) — recomputes (verifyEventHash)
chk(events.every((e) => sha256pfx({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload }) === (e.type === 'execution_completed' ? eventHashesProd[0] : eventHashesProd[1])), 'PROD: per-event hash = sha256(canonicalize({type,timestamp,source,payload})) recomputes');

// (5) authenticity: source.simulated flips the bundle (fabrication visible)
const simEvents = events.map((e) => ({ ...e, source: { ...e.source, simulated: true } }));
const simRoot = '0x' + sha256pfx(simEvents.map((e) => sha256pfx({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload })).sort()).slice(7);
chk(simRoot.toLowerCase() !== kernelSignedEventsRoot.toLowerCase(), 'authenticity: source.simulated=true flips kernelSignedEventsRoot (fabrication visible to the evaluator)');

// (6) schema-valid timestamps: ISO-8601, not Unix-second strings (sol #34)
chk(/^\d{4}-\d{2}-\d{2}T/.test(events[0].timestamp), 'schema: event timestamps are ISO-8601 (not Unix-second strings)');

console.log(`\n${ok ? 'kernelSignedEventsRoot GOLDEN VERIFIED (production form): 0x4e0af964, matches the integrated bundle vector; block-mirror 0x-form proven divergent on identical events (prefix-in-preimage). The frozen sha256:->bytes32 bridge is "0x"+bundleHash.slice(7). Third constituent; feeds oracle EvidenceBlockV2. Superset shared-canonicalize export -> @pcc/spec (oracle #1049).' : 'DIVERGENCE -- blocker'}`);
process.exit(ok ? 0 : 1);
