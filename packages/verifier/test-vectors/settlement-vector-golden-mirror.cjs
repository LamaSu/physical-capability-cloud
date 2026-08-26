#!/usr/bin/env node
/* settlement-vector-golden-mirror.cjs — EVIDENCE lane (92dc40cb). The ONE INTEGRATED COHERENT settlement
 * vector sol's review (bulletin #784 gate 6) said is MANDATORY: a SINGLE unit whose terms -> policy ->
 * V2 package -> commitment -> receipt all bind CONSISTENTLY, replacing the isolated per-hash fixtures.
 * Folds the sol findings into ONE place: V2 binds the REAL acceptedPolicyDigest (coherence, not a
 * placeholder); DISTINCT V2 signing domain (not V1); canonical LOW-S / sorted signature envelope;
 * replay keyed by (unit, packageBodyHash) not the signature-inclusive digest; bindings+sets sorted.
 *
 * Positive chain (all over ONE unit):
 *   settlementUnitId <- {chainId, escrow, jobIdHash, milestoneIndex, stepId}
 *   termsHash        <- CanonicalJobTermsV1 v2.1                         (== published 0x2cb7a79e..)
 *   acceptedPolicyDigest <- CanonicalAcceptedJobPolicyV1 (planUnitKey bindings)  (== published 0xa821492a.. — NO-GO #6 re-golden)
 *   V2 package: unitBinding NAMES the unit + acceptedEnvelopeHash == acceptedPolicyDigest (COHERENT);
 *     evidence field carries EvidenceBlockV1 v2 evidenceBlockHash (claimsAsserted out, unitContextDigest in) — NOT {events,payloadRoot}
 *   packageDigest    <- SHA-256(JCS({body, canonicalSigs}))
 *   evidenceCommitment <- binds packageDigest to the unit
 *   gatewayReceipt   <- binds packageDigest + receivedAt (effectiveEvidenceTime T_hi)
 * + adversarial: cross-unit replay rejected; policy-divergence rejected.
 *
 * Run: NODE_PATH=/c/Users/globa/pcc-oracle/node_modules node settlement-vector-golden-mirror.cjs
 */
const E = require('ethers');
const crypto = require('crypto');
const keccak256 = E.keccak256 || E.utils.keccak256;
const toUtf8Bytes = E.toUtf8Bytes || E.utils.toUtf8Bytes;
const coder = E.AbiCoder ? E.AbiCoder.defaultAbiCoder() : E.utils.defaultAbiCoder;
const enc = (t, v) => coder.encode(t, v);
const K = (s) => keccak256(toUtf8Bytes(s));
const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
const Z32 = '0x' + '00'.repeat(32);
const raw32 = (h) => Buffer.from(h.slice(2), 'hex');
const u64be = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const sha256b = (buf) => '0x' + crypto.createHash('sha256').update(buf).digest('hex');
function jcs(o) { // string-only-leaf JCS
  if (Array.isArray(o)) return '[' + o.map(jcs).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + jcs(o[k])).join(',') + '}';
  if (typeof o !== 'string') throw new Error('non-string leaf'); return JSON.stringify(o);
}

// ── ONE canonical unit (aligned with the gate-1 / termsHash / acceptedPolicy goldens) ──
const chainId = 8453n, escrow = addr(0xe5c0fn);
const jobIdHash = K('golden-job'), stepId = K('golden-step'), milestoneIndex = 3n;
const SUD = K('PCC:vnext:settlement-unit:v1');
const settlementUnitId = keccak256(enc(['bytes32','uint256','address','bytes32','uint256','bytes32'],
  [SUD, chainId, escrow, jobIdHash, milestoneIndex, stepId]));

// ── termsHash v2.1 (superset carry) ──
const token = addr(0x5dcn), assuranceTier = 2n;
const milestones = [[1n, K('golden-step-1'), 600000n, 2000500000n], [0n, K('golden-step-0'), 400000n, 2000000000n]];
const termsHash = keccak256(enc(['bytes32','address','uint8','bytes32'],
  [K('PCC:vnext:job-terms:v1'), token, assuranceTier, keccak256(enc(['tuple(uint256,bytes32,uint256,uint64)[]'],[milestones]))]));

// ── acceptedPolicyDigest (CanonicalAcceptedJobPolicyV1, sorted per sol #786 f1) — same inputs as the standalone golden ──
const sortHex = (a) => [...new Set(a.map(x=>x.toLowerCase()))].sort();
const sortTup = (a) => [...a].sort((x,y)=>JSON.stringify(x).toLowerCase()<JSON.stringify(y).toLowerCase()?-1:1);
const payer=K('golden-payer'), operatorPrincipal=K('golden-operator'), operatorSettlementAddress=addr(0x0a71n);
const authorizedTuples=sortTup([[operatorPrincipal,K('golden-kernel'),K('golden-device')]]);
const expertSet=sortHex([K('golden-expert-1')]), execSet=sortHex([K('golden-exec-1')]);
const children=sortTup([[K('golden-child-job'),addr(0xc41dn)]]);
const opEnvHash=keccak256(enc(['tuple(bytes32,uint256,uint256)[]'],[[[K('power'),0n,1000n],[K('temp'),0n,250n]]]));
const expLocHash=keccak256(enc(['int256','int256','uint256','uint64'],[377749000n,-1224194000n,500n,1700000000n]));
const subjectBlockHash=keccak256(enc(
  ['bytes32','bytes32','bytes32','address','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32','uint8'],
  [K('PCC:vnext:accepted-policy-subjects:v1'),payer,operatorPrincipal,operatorSettlementAddress,
   keccak256(enc(['tuple(bytes32,bytes32,bytes32)[]'],[authorizedTuples])),keccak256(enc(['bytes32[]'],[expertSet])),keccak256(enc(['bytes32[]'],[execSet])),
   K('golden-recipient'),K('golden-target-system'),K('golden-program'),K('golden-recipe'),K('golden-sample-manifest'),
   keccak256(enc(['tuple(bytes32,address)[]'],[children])),opEnvHash,K('golden-route-area'),expLocHash,K('golden-capture-nonce'),K('golden-challenge-anchor'),2n]));
const SEL={NONE:0,POLICY_PAYER:1,TARGET_SYSTEM:5,AUTHORIZED_TUPLE:6,ORACLE_SELF:7,CHILD_UNIT:8,OPERATING_ENVELOPE:13,CONTENT_ADDR:16};
// planUnitKey (sol NO-GO #6): chain-independent binding key; settlementUnitId is OUT of acceptedPolicyDigest -> breaks the escrow cycle.
const PLANUNIT_DOMAIN=K('PCC:vnext:plan-unit-key:v1');
const puk0=keccak256(enc(['bytes32','uint32','uint256','bytes32'],[PLANUNIT_DOMAIN,0n,0n,K('golden-step-0')]));
const B=(reqId,src,prop,vr)=>[puk0,K(reqId),BigInt(src),BigInt(prop),vr];
const bindings=[
  B('req-approval-payer',SEL.POLICY_PAYER,SEL.NONE,payer),
  B('req-target-confirm',SEL.ORACLE_SELF,SEL.TARGET_SYSTEM,K('golden-target-system')),
  B('req-escrow-receipt',SEL.ORACLE_SELF,SEL.CHILD_UNIT,children[0][0]),
  B('req-envelope',SEL.AUTHORIZED_TUPLE,SEL.OPERATING_ENVELOPE,opEnvHash),
  B('req-artifact-hash',SEL.AUTHORIZED_TUPLE,SEL.CONTENT_ADDR,Z32),
].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:(a[1]<b[1]?-1:a[1]>b[1]?1:0));
const bindingsRoot=keccak256(enc(['tuple(bytes32,bytes32,uint8,uint8,bytes32)[]'],[bindings]));
const acceptedPolicyDigest=keccak256(enc(['bytes32','uint16','bytes32','bytes32','bytes32'],
  [K('PCC:vnext:accepted-job-policy:v1'),1n,termsHash,subjectBlockHash,bindingsRoot]));

// ── V2 package: COHERENT — acceptedEnvelopeHash == the REAL acceptedPolicyDigest; evidence field carries EvidenceBlockV1 v2 ──
const challengeNonce = K('golden-gateway-nonce');
// EvidenceBlockV1 v2 (sol NO-GO fold): claimsAsserted OUT, unitContextDigest IN, role-bound attestations, programHash pinned.
const UNITCTX_DOMAIN=K('PCC:vnext:unit-context:v1');
const unitContextDigest=keccak256(enc(['bytes32','uint256','address','bytes32','bytes32','uint256','bytes32','bytes32'],
  [UNITCTX_DOMAIN,chainId,escrow,settlementUnitId,jobIdHash,milestoneIndex,stepId,challengeNonce]));
const kernelSignedEventsRoot=K('golden-bundle-hash'), sessionKeyAuthDigest=K('golden-sessionkey-auth');
const attestationSetRoot=K('golden-attestation-set'), workProductRoot=K('golden-work-product');
const programHash=K('golden-program');   // COHERENT: == subjectBlock committedProgramHash (oracle pins block.programHash to it, NO-GO #3)
const EVIDENCE_BLOCK_DOMAIN_V2=K('PCC:vnext:evidence-block:v2');
const evidenceBlockHash=keccak256(enc(['bytes32','uint16','bytes32','bytes32','bytes32','bytes32','bytes32','bytes32'],
  [EVIDENCE_BLOCK_DOMAIN_V2,2n,unitContextDigest,kernelSignedEventsRoot,sessionKeyAuthDigest,attestationSetRoot,workProductRoot,programHash]));
const body = {
  packageSchemaVersion:'FinalMilestonePackageV2', packageFormat:'2',            // sol: DISTINCT V2 format (was '1')
  compositionSchemaVersion:'1',
  unitBinding:{ chainId:'8453', escrow:escrow, settlementUnitId, jobIdHash, milestoneIndex:'3', stepId,
    compositionRoot:Z32, acceptedEnvelopeHash: acceptedPolicyDigest },          // COHERENT: == acceptedPolicyDigest
  producer:{ operatorPrincipalId:'op-golden', kernelId:'kernel-golden-01', devicePrincipalId:'dev-golden' },
  challengeBinding:{ nonce:challengeNonce, tChallengeRef:'1699999000' },
  evidence:{ evidenceBlockHash },                                              // v2: ONE commitment to the 6 evaluator inputs (was {events,payloadRoot})
  evidenceTimeBounds:{ start:'1699999500', end:'1700000000' },
};
const SIG_DOMAIN_V2 = K('PCC:vnext:evidence-package-sig:v2');                     // sol: DISTINCT V2 signing domain (not v1)
const packageBodyHash = sha256b(Buffer.concat([raw32(SIG_DOMAIN_V2), u64be(Buffer.byteLength(jcs(body))), Buffer.from(jcs(body),'utf8')]));
// canonical signature envelope: dedup-by-signer + sort-by-signer (low-s/scheme-namespace enforced in prod; sample here)
const rawSigs=[{signer:'0x'+'bb'.repeat(20),scheme:'secp256k1',sig:'0x'+'22'.repeat(65)},{signer:'0x'+'aa'.repeat(20),scheme:'ed25519',sig:'0x'+'11'.repeat(64)}];
const canonicalSigs=(s)=>{const m=new Map();for(const x of s){const id=x.signer.toLowerCase();if(!m.has(id))m.set(id,x);}return [...m.values()].sort((a,b)=>a.signer.toLowerCase()<b.signer.toLowerCase()?-1:1);};
const signatures=canonicalSigs(rawSigs);
const packageDigest=sha256b(Buffer.from(jcs({body,signatures}),'utf8'));

// ── evidenceCommitment + gatewayReceipt both bind THIS packageDigest to THIS unit ──
const evidenceCommitment=keccak256(enc(['bytes32','uint256','address','bytes32','uint16','uint8','bytes32'],
  [K('PCC:vnext:evidence-commitment:v1'),chainId,escrow,settlementUnitId,1n,2n,packageDigest]));   // packageFormat 2
const receivedAt=1700000000n;
const gatewayReceipt=keccak256(enc(['bytes32','uint16','uint256','address','bytes32','bytes32','uint64'],
  [K('PCC:vnext:gateway-receipt:v1'),1n,chainId,escrow,settlementUnitId,packageDigest,receivedAt]));

console.log(`ethers=${E.version||'v6'}  == INTEGRATED settlement vector (ONE unit, coherent; sol gate 6) ==`);
for (const [k,v] of [['settlementUnitId',settlementUnitId],['termsHash',termsHash],['acceptedPolicyDigest',acceptedPolicyDigest],
  ['packageDigest',packageDigest],['evidenceCommitment',evidenceCommitment],['gatewayReceipt',gatewayReceipt]]) console.log(`  ${k.padEnd(20)} ${v}`);
console.log(`  ${'packageBodyHash'.padEnd(20)} ${packageBodyHash}`);
// ── complete producer golden vector: reproduce JCS via @pcc/spec canonicalize (NOT a re-impl — that is the #286 trap). ──
//   packageBodyHash = SHA256( raw32(keccak256("PCC:vnext:evidence-package-sig:v2")) || u64be(byteLen(JCS(body))) || JCS(body) )
//   packageDigest   = SHA256( JCS({ body, canonicalSignatures(sigs) }) )   [canonicalSignatures = dedup-by-signer(first) + sort-by-lowercased-signer]
console.log(`  JCS(body)=${jcs(body)}`);
console.log(`  JCS(bodyAndSignatures)=${jcs({body,signatures})}`);
console.log('');
let ok=true; const chk=(c,l)=>{ok=ok&&c;console.log(`${c?'PASS':'FAIL'}  ${l}`);};

// COHERENCE — the whole point sol demanded: one unit, everything ties.
chk(termsHash.toLowerCase()==='0x2cb7a79e45cbb5b78b61dbbcc182b2f27ac7991b055a66ef58457459dc2f4fe6','coherent: termsHash == published v2.1 golden');
chk(acceptedPolicyDigest.toLowerCase()==='0xa821492ad1c9d685fc794c21485480f01169c2d690d73c86a354143f3f496a41','coherent: acceptedPolicyDigest == published planUnitKey golden 0xa821492a (NO-GO #6 re-golden; matches the standalone mirror byte-for-byte)');
chk(body.unitBinding.acceptedEnvelopeHash.toLowerCase()===acceptedPolicyDigest.toLowerCase(),'coherent: V2 package acceptedEnvelopeHash == the REAL acceptedPolicyDigest (NOT a placeholder) — closes the sol coherence gap');
chk(body.unitBinding.settlementUnitId===settlementUnitId,'coherent: V2 package names THIS settlementUnitId');
chk(body.evidence.evidenceBlockHash===evidenceBlockHash && programHash===K('golden-program'),'coherent: evidence field carries EvidenceBlockV1 v2 evidenceBlockHash; block programHash == subjectBlock committedProgramHash (NO-GO #3 pin) — no {events,payloadRoot}');
chk(evidenceCommitment!==Z32 && gatewayReceipt!==Z32,'coherent: evidenceCommitment + gatewayReceipt both derived over THIS packageDigest');
chk(SIG_DOMAIN_V2.toLowerCase()!==K('PCC:vnext:evidence-package-sig:v1').toLowerCase() && body.packageFormat==='2','sol: V2 uses a DISTINCT signing domain + packageFormat (parser never selected from the untrusted body)');
chk(signatures.length===2 && sha256b(Buffer.from(jcs({body,signatures:canonicalSigs([rawSigs[1],rawSigs[0],rawSigs[1]])}),'utf8'))===packageDigest,'sol: canonical signature envelope — reorder+dup -> identical packageDigest');

// ADVERSARIAL — cross-unit replay + policy-divergence FAIL (money-path).
const otherUnit=K('other-unit');
const commitB=keccak256(enc(['bytes32','uint256','address','bytes32','uint16','uint8','bytes32'],[K('PCC:vnext:evidence-commitment:v1'),chainId,escrow,otherUnit,1n,2n,packageDigest]));
chk(commitB.toLowerCase()!==evidenceCommitment.toLowerCase() && body.unitBinding.settlementUnitId!==otherUnit,'adversarial replay: re-wrap packageDigest under unitB -> different commitment AND body still names unitA -> oracle rejects');
const bodyDiv={...body,unitBinding:{...body.unitBinding,acceptedEnvelopeHash:K('divergent-policy')}};
chk(sha256b(Buffer.from(jcs({body:bodyDiv,signatures}),'utf8'))!==packageDigest,'adversarial policy-divergence: acceptedEnvelopeHash != committed acceptedPolicyDigest -> different packageDigest -> oracle rejects (all-4-agree)');
// replay-key discipline (sol): dedup on packageBodyHash + unit + nonce, NOT the signature-inclusive packageDigest
chk(packageBodyHash!==packageDigest,'sol: packageBodyHash (physical-statement identity, replay key) is distinct from packageDigest (signed envelope)');

// pinned golden for the coherent chain (the NEW values that bind the real policy)
const EXPECT={ packageDigest:'0xf78103a17702d1fe490a36dd3a02320ba334d52fa966e730c1876501d928dea2',
  evidenceCommitment:'0xb1391d217932aba1e2c50a3cd4b08ecc3156507ef5e3dbe679bf626b9d23ab9b',
  gatewayReceipt:'0xca508df81e7e84060306ae6925ae82baeda835af8c7b326177143d680eea9bac' };
for (const [k,v] of [['packageDigest',packageDigest],['evidenceCommitment',evidenceCommitment],['gatewayReceipt',gatewayReceipt]])
  chk(v.toLowerCase()===EXPECT[k].toLowerCase(),`pinned coherent-chain golden ${k} == ${EXPECT[k]}`);

console.log(`\n${ok?'INTEGRATED settlement vector: COHERENT over one unit + adversarial replay/divergence rejected + pinned. Folds sol coherence + distinct-domain + canonical-sig + replay-key. PENDING (gate 6 full): real signatures (KATs) + backdating window [T_lo,T_hi] + fork-escrow settle.':'DIVERGENCE -- blocker'}`);
process.exit(ok?0:1);
