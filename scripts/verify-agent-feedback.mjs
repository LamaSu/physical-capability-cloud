#!/usr/bin/env node
/**
 * Smoke-test the agent auto-feedback pipeline end-to-end against a running gateway.
 * Runnable against LOCAL now, and PROD (capability.network) AFTER this branch deploys.
 *
 *   PCC_URL=http://localhost:3200 WAITLIST_ADMIN_TOKEN=... node scripts/verify-agent-feedback.mjs
 *   PCC_URL=https://capability.network WAITLIST_ADMIN_TOKEN=... node scripts/verify-agent-feedback.mjs
 *
 * It POSTs ONE clearly-marked report (type: idea, "[VERIFY] …"), then checks it landed
 * in the durable admin export and (if PCC_FUNNEL_ENABLED) the observability view. It
 * makes exactly one write; there is no delete endpoint, so the marked report remains —
 * filter it by the "[VERIFY]" prefix / the printed id.
 */
const BASE = (process.env.PCC_URL ?? "https://capability.network").replace(/\/$/, "");
const ADMIN = process.env.WAITLIST_ADMIN_TOKEN ?? "";
const stamp = new Date().toISOString();
const marker = `[VERIFY] auto-feedback smoke ${stamp}`;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  cond ? pass++ : fail++;
  return cond;
};

async function main() {
  console.log(`agent-feedback smoke → ${BASE}\n`);

  // 1) POST a marked report (public — no key), with the report_hint send{} shape + logs.
  let postJson = {};
  try {
    const res = await fetch(`${BASE}/api/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "idea",
        summary: marker,
        detail: "Automated smoke test of the auto-feedback pipeline. Safe to ignore/delete.",
        endpoint: "/api/build/contract",
        method: "POST",
        status: 500,
        errorCode: "VERIFY_SMOKE",
        agentId: "smoke-verify",
        logs: [
          { step: 1, method: "POST", path: "/api/build/options", status: 200 },
          { step: 2, method: "POST", path: "/api/build/contract", status: 500, note: "verify smoke" },
        ],
      }),
    });
    postJson = await res.json().catch(() => ({}));
    ok("POST /api/feedback accepted (public)", res.status === 201 && postJson.submitted === true, `status ${res.status}, id ${postJson.id ?? "?"}`);
  } catch (e) {
    ok("POST /api/feedback accepted (public)", false, String(e));
  }
  const id = postJson.id;

  if (!ADMIN) {
    console.log("\n  (set WAITLIST_ADMIN_TOKEN to also verify it landed in the admin/observability reads)");
  } else {
    // 2) It landed in the durable admin export (JSONL sink).
    try {
      const res = await fetch(`${BASE}/api/admin/feedback`, { headers: { "x-admin-token": ADMIN } });
      const j = await res.json().catch(() => ({}));
      const mine = (j.items ?? []).find((i) => i.id === id || i.summary === marker);
      ok("report is in GET /api/admin/feedback (durable)", res.status === 200 && !!mine, mine ? `logs=${mine.logs?.length ?? 0}, httpStatus=${mine.httpStatus}` : `status ${res.status}`);
    } catch (e) {
      ok("report is in GET /api/admin/feedback (durable)", false, String(e));
    }

    // 3) It shows in the observability feedback stream (via the agent.report audit event).
    try {
      const res = await fetch(`${BASE}/api/admin/observability/feedback?limit=1000`, { headers: { "x-admin-token": ADMIN } });
      const j = await res.json().catch(() => ({}));
      if (res.status === 404) {
        console.log("  SKIP  observability view (set PCC_FUNNEL_ENABLED=true to enable)");
      } else {
        const mine = (j.reports ?? []).find((r) => r.summary === marker);
        ok("report shows in /api/admin/observability/feedback", res.status === 200 && !!mine, mine ? `errorCode ${mine.last_error_code}` : `status ${res.status}`);
      }
    } catch (e) {
      ok("report shows in observability view", false, String(e));
    }
  }

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : `${fail} CHECK(S) FAILED`}  (${pass} passed, ${fail} failed)`);
  console.log(`marked report id: ${id ?? "(none)"}  — filter by "[VERIFY]" to find/ignore it`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
