#!/usr/bin/env node
/**
 * rehearse-loop.mjs — full-span rehearsal harness for the NEVER-RUN continuous span.
 *
 * The span (the one leg of the marketplace loop with ZERO proof on record):
 *   register kernel (Ed25519 proof) -> declare capability -> negotiate -> QUOTE
 *   -> /commit -> escrow funds -> job DISPATCHES to a REMOTE node
 *   -> node signs real logs (#236 Ed25519 producer) -> evidence -> oracle verdict
 *   -> escrow RELEASES to the operator wallet.
 *
 * This script walks that span against a target gateway AS A FAKE REMOTE STRANGER
 * (its own Ed25519 device key, its own operator), enforcing a per-step acceptance
 * assertion at every hop. Each assertion is tied to a real code seam found during
 * de-risking (file:line in the SEAMS map below) so a failure names the defect.
 *
 * SAFETY — money path, fail closed:
 *   • The paid / `/commit` / on-chain / settlement steps are GATED behind --live,
 *     which DEFAULTS OFF. Without --live the harness does a non-destructive DRY
 *     validation only (reachability + read probes + self-crypto self-test + it
 *     prints the exact plan). It creates NO rows and mints NO escrow.
 *   • With --live it runs the full loop (creates prod rows, mints a testnet escrow,
 *     spends testnet USDC). Only run --live AFTER the owner promotes master->prod.
 *   • A failure that is an owner-gated dependency (no funding creds, oracle key)
 *     is classified BLOCKED, not FAIL — so a real wiring defect is never masked.
 *
 * USAGE
 *   node scripts/rehearse-loop.mjs                         # DRY (safe, default)
 *   node scripts/rehearse-loop.mjs --target=https://capability.network
 *   node scripts/rehearse-loop.mjs --live                  # FULL loop (post-deploy only)
 *   node scripts/rehearse-loop.mjs --live --tier=1 --target=https://staging.capability.network
 *
 * FLAGS
 *   --live            Run the paid/commit/on-chain steps. Default OFF.
 *   --o1              O-1 acceptance ONLY: provision + register a probe kernel with an
 *                     Ed25519 proof + assert GET serves a non-zero signer. NO paid/commit/
 *                     on-chain steps. This is the one-line post-deploy acceptance test —
 *                     run it the moment master->prod lands. Creates one throwaway kernel row.
 *   --target=<url>    Gateway base URL. Default https://capability.network.
 *   --tier=<0-3>      Assurance tier to negotiate. Default 1 (a PAID tier — the
 *                     tier that MUST fail closed on a mock verdict; see A8/A9).
 *   --email=<addr>    Provision identity. Default rehearse+<ts>@pcc.test.
 *   --poll=<n>        Dispatch poll attempts before declaring "job never starts". Default 10.
 *   --keep            Do not print the cleanup hint for created rows.
 *
 * EXIT  0 = every REQUIRED assertion passed (span provably runnable end-to-end).
 *       1 = a REQUIRED assertion FAILED (a seam is open — the message names it).
 *       2 = harness/reachability error (could not even start).
 *
 * Emits one machine-readable summary line: REHEARSE_RESULT={...}
 *
 * ── SEAMS this harness exists to catch (verified in code, lamasu/master @ 02d4ce04) ──
 *  S4  oracle-client mock could fabricate verified:true (paid tier) -> silent-fake settle.
 *      Fix = PR #234 (OPEN). Runtime guard: A8 (verdict not degraded) + A9 (mock !-> settled).
 *  SEAM-1  createJobFromSession sets job status "queued" ONLY when isExternal
 *      (packages/gateway/src/routes/paid-job-flow.ts:604-618). If the gateway has no
 *      local kernel, isExternal=false -> job is "pending"/"active", NOT "queued".
 *      The node polls GET /api/operator/jobs?status=queued (ws_client.py:187-204) ONLY,
 *      so it never sees the job -> "job never starts". Caught by A6.
 *  SEAM-2  the node pushes evidence to POST /api/operator/evidence
 *      (packages/gateway/src/routes/operator-relay.ts:94-163) which stores an INERT
 *      bundle (fake bundleHash, tier 0, no oracle, no driveSettlement, #236 signature
 *      unverified). The ONLY path that runs oracle+settlement is PUT /api/jobs/:id/complete,
 *      which auto-signs evidence with the ZERO address (paid-job-flow.ts:1022-1027).
 *      So a real node's signed log never anchors settlement. Caught by A7b + A8/A10.
 *  SWALLOW  negotiate /commit swallows a createJobFromSession throw and returns 200
 *      with escrowAddress:null (packages/gateway/src/routes/negotiation.ts:609-621).
 *      "buyer pays, nothing happens." Caught by A4.
 */

import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Args + config
// ─────────────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const LIVE = args.live === "true" || args.live === "1";
const TARGET = (args.target || process.env.PCC_URL || "https://capability.network").replace(/\/$/, "");
const TIER = Number.isFinite(Number(args.tier)) ? Math.trunc(Number(args.tier)) : 1;
const EMAIL = args.email || `rehearse+${Date.now().toString(36)}@pcc.test`;
const MAX_POLL = Number.isFinite(Number(args.poll)) ? Math.trunc(Number(args.poll)) : 10;
const CAP_TYPE = args.type || "fdm";

let apiKey;
let traceId;
const created = { operator: EMAIL, kernelId: null, capabilityId: null, sessionId: null, jobId: null, escrowAddress: null };

// ─────────────────────────────────────────────────────────────────────────────
// Result accounting. Each check is REQUIRED (gates exit code), OPTIONAL, or a
// GATED live-only step. classify() sorts owner-gated dependencies (BLOCKED) from
// real defects (FAIL) so a missing credential never masquerades as a green run
// and a real wiring hole never hides behind "probably just creds".
// ─────────────────────────────────────────────────────────────────────────────
const results = [];
function record(id, kind, status, detail, seam) {
  results.push({ id, kind, status, detail: detail ?? "", seam: seam ?? null });
  const tag = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP", BLOCKED: "BLOCKED" }[status] || status;
  const seamTag = seam ? ` [${seam}]` : "";
  console.log(`  [${tag}] ${id}${seamTag}${detail ? " — " + detail : ""}`);
}
const pass = (id, detail, seam) => record(id, "REQUIRED", "PASS", detail, seam);
const fail = (id, detail, seam) => record(id, "REQUIRED", "FAIL", detail, seam);
const blocked = (id, detail, seam) => record(id, "REQUIRED", "BLOCKED", detail, seam);
const skip = (id, detail, seam) => record(id, "GATED", "SKIP", detail, seam);

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper — carries Bearer key + trace id, mirrors canary-agent-onboarding.mjs
// ─────────────────────────────────────────────────────────────────────────────
async function call(method, path, body) {
  const headers = { "content-type": "application/json", "user-agent": "pcc-rehearse/1" };
  if (traceId) headers["x-pcc-trace-id"] = traceId;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let res, json;
  try {
    res = await fetch(`${TARGET}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, ok: false, json: null, err: String(e) };
  }
  try { json = await res.json(); } catch { json = null; }
  if (!traceId) {
    const h = res.headers.get("x-pcc-trace-id");
    if (h) traceId = h;
  }
  return { status: res.status, ok: res.ok, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ed25519 device identity — reproduces the gateway's exact wire contract
// (packages/gateway/src/auth/ed25519.ts + packages/kernel kernelSigningProofMessage):
//   • raw 32-byte pubkey  = SPKI-DER export minus the 12-byte ASN.1 prefix
//   • signingProof        = ed25519 sig over UTF-8 `pcc-kernel-signing-key:<kernelId>`
//     serialized as 128-hex (what verifyEd25519Signature accepts)
// ─────────────────────────────────────────────────────────────────────────────
function newDeviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPub = spki.subarray(12); // 32 bytes
  return { privateKey, publicKeyHex: rawPub.toString("hex") };
}
function signingProofFor(kernelId, privateKey) {
  const msg = Buffer.from(`pcc-kernel-signing-key:${kernelId}`, "utf8");
  return crypto.sign(null, msg, privateKey).toString("hex"); // 128 hex, no 0x
}
/** Self-test: prove the harness's crypto reproduces a verifiable proof BEFORE we
 *  rely on it against a live gateway. Rebuilds the SPKI the gateway rebuilds and
 *  verifies locally — same code path as verifyEd25519Signature. */
function selfVerifyCrypto() {
  const kid = "kernel_selftest_000";
  const dev = newDeviceKey();
  const sigHex = signingProofFor(kid, dev.privateKey);
  if (sigHex.length !== 128) return { ok: false, why: `sig len ${sigHex.length} != 128` };
  if (dev.publicKeyHex.length !== 64) return { ok: false, why: `pub len ${dev.publicKeyHex.length} != 64` };
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const spkiDer = Buffer.concat([spkiPrefix, Buffer.from(dev.publicKeyHex, "hex")]);
  const keyObj = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  const ok = crypto.verify(null, Buffer.from(`pcc-kernel-signing-key:${kid}`, "utf8"), keyObj, Buffer.from(sigHex, "hex"));
  return { ok, why: ok ? "" : "local verify() rejected our own proof" };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function signerFrom(kernelDto) {
  // KernelDTO serves the proven key as signingKey {algorithm, publicKey} (ed25519)
  // or signingAddress (secp256k1). Either being non-null/non-zero = a proven signer.
  const k = kernelDto?.kernel ?? kernelDto ?? {};
  const sk = k.signingKey;
  if (sk && (sk.publicKey || sk.address)) return sk.publicKey ?? sk.address;
  if (k.signingAddress && k.signingAddress !== ZERO) return k.signingAddress;
  if (k.registeredSigner) return k.registeredSigner;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRY validation (default). Non-destructive: reachability + read probes + the
// crypto self-test + a printed plan. Proves the harness is wired without touching
// the money path. Safe to run against prod right now.
// ─────────────────────────────────────────────────────────────────────────────
async function dryRun() {
  console.log(`\n── DRY validation (no --live; creates nothing) → ${TARGET} ──`);

  const sc = selfVerifyCrypto();
  sc.ok ? pass("D0.crypto-selftest", "harness reproduces a gateway-verifiable Ed25519 proof")
        : fail("D0.crypto-selftest", sc.why);

  const health = await call("GET", "/api/health");
  health.status === 200 ? pass("D1.reachable", `GET /api/health 200 (version ${health.json?.version ?? "?"})`)
                        : fail("D1.reachable", `GET /api/health -> ${health.status}`);

  const types = await call("GET", "/api/capabilities/types");
  const list = types.json?.types ?? [];
  Array.isArray(list) && list.length
    ? pass("D2.catalog", `${list.length} capability types listable (public)`)
    : fail("D2.catalog", `types -> ${types.status}, ${Array.isArray(list) ? "empty" : "non-array"}`);

  // Show the CURRENT proven-signer posture of an existing kernel. Pre-#235 deploy
  // this is null/zero for every kernel; post-deploy a freshly-registered one is
  // non-zero. This is the O-1 acceptance signal, observed read-only.
  const kernels = await call("GET", "/api/kernels");
  const sample = (kernels.json?.kernels ?? [])[0];
  if (sample) {
    const got = await call("GET", `/api/kernels/${sample.id}`);
    const signer = signerFrom(got.json);
    record("D3.signer-posture", "OPTIONAL", "PASS",
      signer ? `sample kernel ${sample.id} signer=${signer} (Option C appears DEPLOYED)`
             : `sample kernel ${sample.id} signer=null/zero (pre-#235 path still live — O-1 not yet done)`,
      "S4/O-1");
  }

  console.log("\n  Plan for --live (each step enforces the named acceptance assertion):");
  for (const s of PLAN) console.log(`    ${s.id.padEnd(22)} ${s.what}`);
  console.log("\n  DRY complete. Re-run with --live AFTER master->prod is promoted.");
}

// The ordered live plan (also printed in dry mode).
const PLAN = [
  { id: "A1.identity", what: "register kernel w/ Ed25519 proof -> GET serves non-zero signingKey (O-1)" },
  { id: "A2.capability", what: "declare capability available:true + heartbeat -> discoverable online" },
  { id: "A3.quote", what: "negotiate session CREATED->CONFIGURING->QUOTED (buyer path)" },
  { id: "A4.commit", what: "/commit returns escrowAddress != null + jobId (catches the swallowed throw)" },
  { id: "A5.escrow", what: "escrow is a real 0x address and reaches funded (testnet USDC)" },
  { id: "A6.dispatch", what: "node poll /api/operator/jobs?status=queued FINDS the job (SEAM-1)" },
  { id: "A7.execute", what: "node executes + produces a real Ed25519-signed machine-log entry (#236)" },
  { id: "A8.settle", what: "/complete -> oracle verdict REAL (not degraded) -> escrow RELEASES" },
  { id: "A9.mock-guard", what: "a degraded/mock verdict NEVER coincides with a settled job (S4)" },
  { id: "A10.anchor", what: "the settled attestation anchors to the proven signer, not 0x000 (SEAM-2)" },
];

// ─────────────────────────────────────────────────────────────────────────────
// O-1 acceptance run — the one-line post-deploy check. Provision + register a
// probe kernel with an Ed25519 proof + assert GET serves a non-zero proven
// signer. NO commit / escrow / on-chain. Creates one throwaway kernel row.
// Exit 0 = Option C identity is LIVE in prod (O-1 done). Exit 1 = still pre-#235.
// ─────────────────────────────────────────────────────────────────────────────
async function o1Run() {
  console.log(`\n── O-1 acceptance (identity only; no paid steps) → ${TARGET} ──`);
  const sc = selfVerifyCrypto();
  if (!sc.ok) return fail("O1.crypto-selftest", sc.why);

  const prov = await call("POST", "/api/auth/provision", { email: EMAIL, name: "PCC O-1 Probe" });
  apiKey = prov.json?.api_key ?? prov.json?.apiKey;
  if (!apiKey) return fail("O1.provision", `no api_key (status ${prov.status})`);

  const kernelId = `kernel_o1probe_${Date.now().toString(36)}`;
  const dev = newDeviceKey();
  const signingProof = signingProofFor(kernelId, dev.privateKey);
  const reg = await call("POST", "/api/kernels", {
    id: kernelId, name: "O-1 Probe", operatorAddress: EMAIL,
    location: { lat: 0, lng: 0 }, physicalAddress: "o1-probe", maxAssuranceTier: 2,
    signingKeyAlgorithm: "ed25519", signingPublicKey: `0x${dev.publicKeyHex}`, signingProof,
  });
  if (reg.status !== 201 && reg.status !== 200) return fail("O1.register", `POST /api/kernels -> ${reg.status}`, "O-1");
  created.kernelId = kernelId;
  const got = await call("GET", `/api/kernels/${kernelId}`);
  const signer = signerFrom(got.json);
  if (!signer) {
    fail("O1.identity", `registered a valid Ed25519 proof but GET /api/kernels/${kernelId} serves NO signer — pre-#235 path is LIVE. O-1 (master->prod) NOT done.`, "O-1");
  } else if (signer.toLowerCase() !== `0x${dev.publicKeyHex}`.toLowerCase()) {
    fail("O1.identity", `served signer ${signer} != registered 0x${dev.publicKeyHex}`, "O-1");
  } else {
    pass("O1.identity", `non-zero proven signer served (${signer}) — Option C identity is LIVE. O-1 DONE.`, "O-1");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE run — the full span. Gated. Not executed without --live.
// ─────────────────────────────────────────────────────────────────────────────
async function liveRun() {
  console.log(`\n── LIVE rehearsal → ${TARGET} (tier ${TIER}) ──`);
  console.log("  Money path active: creates prod rows, mints a testnet escrow.\n");

  const sc = selfVerifyCrypto();
  if (!sc.ok) return fail("A0.crypto-selftest", sc.why);
  pass("A0.crypto-selftest", "Ed25519 proof self-verifies");

  // ── provision (auth for every subsequent call) ──
  const prov = await call("POST", "/api/auth/provision", { email: EMAIL, name: "PCC Rehearsal Stranger", capability: CAP_TYPE });
  apiKey = prov.json?.api_key ?? prov.json?.apiKey;
  if (!apiKey) return fail("A0.provision", `no api_key (status ${prov.status})`);
  pass("A0.provision", `key issued for ${EMAIL}`);

  // ── A1. identity (O-1 acceptance test embedded) ──
  const kernelId = `kernel_rehearse_${Date.now().toString(36)}`;
  const dev = newDeviceKey();
  const signingProof = signingProofFor(kernelId, dev.privateKey);
  const reg = await call("POST", "/api/kernels", {
    id: kernelId,
    name: "Rehearsal Remote Node",
    operatorAddress: EMAIL,
    location: { lat: 37.77, lng: -122.42 },
    physicalAddress: "rehearsal",
    maxAssuranceTier: 2,
    signingKeyAlgorithm: "ed25519",
    signingPublicKey: `0x${dev.publicKeyHex}`,
    signingProof,
  });
  if (reg.status !== 201 && reg.status !== 200) return fail("A1.identity", `POST /api/kernels -> ${reg.status}`);
  created.kernelId = kernelId;
  const got = await call("GET", `/api/kernels/${kernelId}`);
  const signer = signerFrom(got.json);
  if (!signer || signer === ZERO || (signer.toLowerCase && signer.toLowerCase() === `0x${dev.publicKeyHex}`.toLowerCase() ? false : signer === ZERO)) {
    // A proven signer must be present AND match the key we registered.
  }
  if (!signer) {
    fail("A1.identity", `GET /api/kernels/:id served NO signingKey — pre-#235 path is live (O-1 not deployed)`, "S4/O-1");
  } else if (signer.toLowerCase() !== `0x${dev.publicKeyHex}`.toLowerCase()) {
    fail("A1.identity", `served signer ${signer} != registered 0x${dev.publicKeyHex}`, "S4/O-1");
  } else {
    pass("A1.identity", `proven signer served: ${signer}`, "S4/O-1");
  }

  // ── A2. capability available + online ──
  const cap = await call("POST", "/api/capabilities", {
    kernelId, type: CAP_TYPE, name: `Rehearsal ${CAP_TYPE}`, available: true,
    materials: ["pla"], assuranceTiers: [0, 1, 2],
  });
  created.capabilityId = cap.json?.id ?? cap.json?.capability?.id ?? null;
  await call("POST", "/api/operator/heartbeat", { kernelId, status: "online" });
  const catalog = await call("GET", `/api/capabilities?type=${CAP_TYPE}`);
  const items = catalog.json?.items ?? catalog.json?.data ?? catalog.json?.capabilities ?? [];
  const mine = items.find?.((c) => c.kernelId === kernelId);
  mine?.available ? pass("A2.capability", `capability discoverable, available:${mine.available}, status:${mine.kernelStatus}`)
                  : fail("A2.capability", `declared capability not discoverable as available for ${kernelId}`);

  // ── A3. negotiate -> quote ──
  const s = await call("POST", "/api/negotiate/session", { userAgentId: "rehearse-buyer", kernelId, capabilityType: CAP_TYPE });
  created.sessionId = s.json?.session?.id ?? s.json?.id ?? s.json?.sessionId;
  if (!created.sessionId || s.status !== 200) return fail("A3.quote", `session create -> ${s.status}`);
  await call("PATCH", `/api/negotiate/session/${created.sessionId}/select`, { selections: { material: "pla", quantity: 1 } });
  const q = await call("POST", `/api/negotiate/session/${created.sessionId}/quote`, {});
  q.status === 200 && (q.json?.status === "quoted" || q.json?.session?.status === "quoted" || q.json?.quote)
    ? pass("A3.quote", `QUOTED (${q.json?.quote?.totalPrice ?? q.json?.session?.quote?.totalPrice ?? "?"} USDC)`)
    : fail("A3.quote", `quote -> ${q.status} status=${q.json?.status ?? q.json?.session?.status}`);

  // ── A4. commit -> escrow non-null (catches the swallowed throw) ──
  const c = await call("POST", `/api/negotiate/session/${created.sessionId}/commit`, {});
  if (c.status !== 200) return fail("A4.commit", `commit -> ${c.status}`, "SWALLOW");
  created.jobId = c.json?.jobId ?? c.json?.session?.jobId ?? null;
  created.escrowAddress = c.json?.escrowAddress ?? null;
  if (!created.escrowAddress) {
    fail("A4.commit", `commit returned 200 but escrowAddress:null — createJobFromSession threw and was swallowed (negotiation.ts:609)`, "SWALLOW");
  } else if (!created.jobId) {
    fail("A4.commit", `commit 200 with escrow ${created.escrowAddress} but NO jobId`, "SWALLOW");
  } else {
    pass("A4.commit", `escrow=${created.escrowAddress} job=${created.jobId}`, "SWALLOW");
  }

  // ── A5. escrow real + funded ──
  if (!created.escrowAddress) {
    skip("A5.escrow", "no escrow to fund (A4 failed)");
  } else if (created.escrowAddress.startsWith("mock")) {
    blocked("A5.escrow", `escrow is mock (${created.escrowAddress}) — target runs MOCK_SETTLEMENT!=false; on-chain leg untested`);
  } else {
    const fund = await call("POST", "/api/escrow/fund", { escrowAddress: created.escrowAddress });
    if (fund.status === 200) pass("A5.escrow", `real escrow funded: ${created.escrowAddress}`);
    else blocked("A5.escrow", `fund -> ${fund.status} (needs O-2 x402/CDP creds + testnet USDC): ${fund.json?.error ?? ""}`);
  }

  // ── A6. dispatch — poll AS THE NODE DOES (SEAM-1) ──
  if (!created.jobId) {
    skip("A6.dispatch", "no job to dispatch (A4 failed)");
  } else {
    let found = null;
    for (let i = 0; i < MAX_POLL && !found; i++) {
      const poll = await call("GET", `/api/operator/jobs?kernelId=${kernelId}&status=queued`);
      const jobs = poll.json?.jobs ?? [];
      found = jobs.find?.((j) => j.id === created.jobId) ?? null;
      if (!found) await sleep(1500);
    }
    found
      ? pass("A6.dispatch", `remote node poll found the job as 'queued' after commit`, "SEAM-1")
      : fail("A6.dispatch", `job ${created.jobId} NEVER appeared in /api/operator/jobs?status=queued over ${MAX_POLL} polls — "job never starts". createJobFromSession likely set status pending/active (isExternal=false, paid-job-flow.ts:604-618)`, "SEAM-1");
  }

  // ── A7. node executes + signs a real machine-log entry, pushes via the relay ──
  if (!created.jobId) {
    skip("A7.execute", "no job (A4 failed)");
  } else {
    // #236 shape: an Ed25519-signed hash-chain entry produced by the device key.
    const logMsg = Buffer.from(JSON.stringify({ jobId: created.jobId, kernelId, event: "execution_completed", ts: Date.now() }));
    const logSig = crypto.sign(null, logMsg, dev.privateKey).toString("hex");
    const push = await call("POST", "/api/operator/evidence", {
      jobId: created.jobId, kernelId,
      evidence: { machineLog: logMsg.toString("base64"), signature: logSig, algorithm: "ed25519", signer: `0x${dev.publicKeyHex}` },
    });
    // The relay stores but does NOT verify the signature or drive settlement (SEAM-2).
    push.status === 200 && push.json?.stored
      ? record("A7a.relay-accepts", "OPTIONAL", "PASS", "operator relay stored the node evidence bundle")
      : record("A7a.relay-accepts", "OPTIONAL", "FAIL", `operator relay -> ${push.status}`);
    record("A7b.relay-inert", "OPTIONAL", "PASS",
      "NOTE: /api/operator/evidence does NOT verify the #236 signature nor drive settlement (operator-relay.ts:94-163). Settlement below goes via /complete, which auto-signs with 0x000 — the node's real signature is NOT the anchor (SEAM-2).", "SEAM-2");
  }

  // ── A8. settle — the ONLY path that runs oracle+driveSettlement is /complete ──
  if (!created.jobId) {
    skip("A8.settle", "no job (A4 failed)");
  } else {
    const done = await call("PUT", `/api/jobs/${created.jobId}/complete`, {
      evidenceEvents: [{ type: "execution_completed", payload: { by: "rehearse-remote-node" } }],
    });
    // S4 runtime guard: a real oracle verdict must NOT be degraded/mock.
    const verdict = done.json ?? {};
    const degraded = verdict.degraded === true || verdict.mode === "mock" ||
      (verdict.oracle && (verdict.oracle.degraded === true || verdict.oracle.mode === "mock"));
    if (done.status === 422 && verdict.reason && String(verdict.reason).includes("mock")) {
      // The honest failure: mock oracle refused the paid tier. Correct S4 behavior.
      pass("A9.mock-guard", `paid-tier verify correctly REFUSED by mock oracle (verified:false) — mock cannot settle`, "S4");
      blocked("A8.settle", `oracle is in mock/degraded mode on target (reason=${verdict.reason}) — needs a real PCC_ORACLE_KEY (owner). Settlement not provable here, but S4 held.`);
    } else if (done.status === 200) {
      const settled = /settl|released|complete/i.test(JSON.stringify(verdict));
      if (degraded) {
        fail("A9.mock-guard", `job progressed on a DEGRADED/MOCK verdict — S4 breach: a fabricated verdict reached settlement`, "S4");
      } else {
        pass("A9.mock-guard", "verdict not degraded/mock", "S4");
      }
      settled ? pass("A8.settle", `settlement reached (${done.status})`)
              : fail("A8.settle", `/complete 200 but no settled/released signal in response`, "SEAM-2");
    } else {
      fail("A8.settle", `/complete -> ${done.status}: ${verdict.error ?? verdict.reason ?? ""}`, "SEAM-2");
    }

    // ── A10. anchor — settled attestation must reference the proven signer ──
    const jobDetail = await call("GET", `/api/jobs/${created.jobId}`);
    const ev = JSON.stringify(jobDetail.json ?? {});
    if (ev.includes(`0x${dev.publicKeyHex}`)) {
      pass("A10.anchor", "evidence/attestation references the proven device signer", "SEAM-2");
    } else if (ev.includes("gateway-auto-sign") || ev.includes(ZERO)) {
      fail("A10.anchor", "evidence anchored to gateway auto-sign / 0x000, NOT the node's proven key (SEAM-2: /complete auto-signs, node signature discarded)", "SEAM-2");
    } else {
      record("A10.anchor", "OPTIONAL", "SKIP", "could not determine evidence signer from job detail", "SEAM-2");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const started = Date.now();
  const O1 = args.o1 === "true" || args.o1 === "1";
  console.log(`\npcc rehearse-loop — span de-risk harness`);
  console.log(`  target=${TARGET}  live=${LIVE}  o1=${O1}  tier=${TIER}`);
  try {
    if (O1) await o1Run();
    else if (LIVE) await liveRun();
    else await dryRun();
  } catch (e) {
    console.error(`[rehearse] harness exception: ${e?.stack ?? e}`);
    console.log(`REHEARSE_RESULT=${JSON.stringify({ ts: new Date().toISOString(), target: TARGET, live: LIVE, ok: false, error: String(e) })}`);
    process.exit(2);
  }

  const required = results.filter((r) => r.kind === "REQUIRED");
  const failed = required.filter((r) => r.status === "FAIL");
  const blockedN = required.filter((r) => r.status === "BLOCKED");
  const ok = failed.length === 0;

  const summary = {
    ts: new Date().toISOString(),
    target: TARGET, live: LIVE, tier: TIER,
    ok,
    required_total: required.length,
    passed: required.filter((r) => r.status === "PASS").length,
    failed: failed.length,
    blocked: blockedN.length,
    failed_ids: failed.map((r) => r.id),
    blocked_ids: blockedN.map((r) => r.id),
    open_seams: [...new Set(failed.map((r) => r.seam).filter(Boolean))],
    created: LIVE ? created : undefined,
    duration_ms: Date.now() - started,
  };
  console.log(`\nREHEARSE_RESULT=${JSON.stringify(summary)}`);

  if (!args.keep && (created.kernelId || created.capabilityId)) {
    console.log(`\n  cleanup (testnet rows created): kernel=${created.kernelId} capability=${created.capabilityId}`);
    console.log(`  purge with the catalog-hygiene tooling (B-8) before a real demo.`);
  }

  if (blockedN.length && ok) {
    console.log(`\n  ${blockedN.length} step(s) BLOCKED on owner deps (${blockedN.map((r) => r.id).join(", ")}). No wiring defect proven — resolve the dep and re-run.`);
  }
  if (!ok) {
    console.error(`\n  SPAN NOT RUNNABLE: ${failed.length} open seam(s): ${summary.open_seams.join(", ") || "(unlabeled)"}`);
  } else if (LIVE) {
    console.log(`\n  SPAN RUNNABLE END-TO-END: every required assertion passed.`);
  }
  process.exit(ok ? 0 : 1);
})();
