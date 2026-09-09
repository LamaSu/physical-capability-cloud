import { readFileSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { hashEvent, hashBundle } from "../src/util/canonical.js";
import { verifyLogChain } from "../src/evidence/verifiers/log-chain.js";
import { makeExecutionLogVerifier } from "../src/evidence/verifiers/oracle-binding.js";

const env = JSON.parse(readFileSync(process.argv[process.argv.length-1], "utf8"));
const b = env.bundle;
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100","hex"), Buffer.from(env.kernelPublicKeyHex,"hex")]);
const pub = createPublicKey({ key: spki, format: "der", type: "spki" });

// 1. every event hash recomputes
let ok = true;
for (const e of b.events) {
  const h = await hashEvent({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload } as never);
  if (h !== e.hash) { console.log("EVENT HASH MISMATCH", e.type); ok = false; }
}
// 2. bundleHash recomputes
const bh = await hashBundle(b.events as never);
console.log("bundleHash recompute :", bh === b.bundleHash);
// 3. kernel signature over raw32(bundleHash)
const raw32 = Buffer.from(b.bundleHash.replace(/^sha256:/, ""), "hex");
console.log("kernel sig verifies  :", edVerify(null, raw32, pub, Buffer.from(b.kernelSignature, "hex")));
// 4. tamper control
const bad = Buffer.from(raw32); bad[0] ^= 1;
console.log("tampered digest FAILS:", !edVerify(null, bad, pub, Buffer.from(b.kernelSignature, "hex")));
// 5. the #52 verifier over the carried chain
const ev = b.events.find((e:any)=>e.type==="printer_job_verified");
const v = makeExecutionLogVerifier({ verifyKernelSignature: async (entryHash:any, sig:any) =>
  edVerify(null, Buffer.from(entryHash), pub, Buffer.from(sig, "hex")) });
const res = await v.verify(ev.payload.entries, ev.payload.params, { vocabVersion: 2 });
console.log("#52 verifier met     :", res.met, "|", res.detail[0]);
// 6. negative: alter one log line
const tampered = JSON.parse(JSON.stringify(ev.payload.entries)); tampered[1].rawContent = "FORGED";
const neg = await v.verify(tampered, ev.payload.params, { vocabVersion: 2 });
console.log("tampered chain FAILS :", neg.met === false, "|", neg.detail[1] ?? neg.detail[0]);
console.log("execution_failed absent:", !b.events.some((e:any)=>e.type==="execution_failed"));
console.log("all event hashes ok  :", ok);
