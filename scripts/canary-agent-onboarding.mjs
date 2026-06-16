#!/usr/bin/env node
/**
 * canary-agent-onboarding.mjs — agent-onboarding observability piece 6.
 *
 * A synthetic agent that consumes the REAL agent-package.json and walks the
 * onboarding funnel against a target (staging) on a loop. Catches regressions
 * before real agents hit them, and dogfoods pieces 1-3:
 *   • echoes x-pcc-trace-id on every call            (piece 1)
 *   • asserts the rich Result<T> error envelope on 4xx (piece 2)
 *   • files pcc_report with agent_kind="canary" on failure (piece 3)
 *
 *   node scripts/canary-agent-onboarding.mjs --target=https://staging.capability.network
 *
 * Env (all optional):
 *   CANARY_TARGET / STAGING_URL   base URL (default https://staging.capability.network)
 *   CANARY_HEARTBEAT_URL          Uptime-Kuma-style push URL (dead-man's-switch)
 *   CANARY_EMAIL                  identity for provision (default canary@pcc.test)
 *
 * Read-mostly: provision → discover → build (options/price/contract). It does
 * NOT fund or submit real jobs on staging. Exit 0 = healthy, 1 = regression.
 * Emits a single JSON summary line to stdout (CANARY_RESULT=...) for the cron
 * wrapper / agent_canary_runs sink.
 */

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const TARGET = (args.target || process.env.CANARY_TARGET || process.env.STAGING_URL ||
  "https://staging.capability.network").replace(/\/$/, "");
const EMAIL = process.env.CANARY_EMAIL || "canary@pcc.test";
const HEARTBEAT_URL = process.env.CANARY_HEARTBEAT_URL;

const STAGES = ["provision", "discover", "build"];
let traceId;
let apiKey;
let furthestStage = null;

const fail = (stage, status, errorCode, detail) => ({ stage, status, errorCode, detail });

/** HTTP helper — always carries the trace_id (piece 1) + key once provisioned. */
async function call(method, path, body) {
  const headers = { "content-type": "application/json", "user-agent": "pcc-canary/1" };
  if (traceId) headers["x-pcc-trace-id"] = traceId;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${TARGET}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  // Capture trace_id from the response header if we don't have one yet (piece 1).
  if (!traceId) {
    const h = res.headers.get("x-pcc-trace-id");
    if (h) traceId = h;
  }
  return { status: res.status, ok: res.ok, json, headers: res.headers };
}

/** Resolve an endpoint from the real package's tool map, with a known fallback. */
function endpoint(pkg, toolName, fallback) {
  const tool = (pkg?.tools ?? []).find((t) => t.name === toolName);
  if (tool?.endpoint?.path) return { method: tool.endpoint.method ?? "GET", path: tool.endpoint.path };
  return fallback;
}

/** A 4xx is acceptable IFF it carries the rich error envelope (piece 2). */
function envelopeOk(json) {
  if (!json) return false;
  const code = json?.error?.code ?? json?.error ?? json?.code;
  return typeof code === "string" && code.length > 0;
}

async function fileReport(failure) {
  try {
    await call("POST", "/api/feedback/agent-report", {
      trace_id: traceId,
      summary: `Canary failed at ${failure.stage} (status ${failure.status}).`.slice(0, 280),
      detail: JSON.stringify(failure).slice(0, 4000),
      last_endpoint: failure.endpoint,
      last_error_code: failure.errorCode,
      agent_kind: "canary",
      confused_about: failure.stage,
    });
  } catch (e) {
    console.error("[canary] failed to file pcc_report", e);
  }
}

async function run() {
  const started = Date.now();

  // ── Fetch the real contract ────────────────────────────────────────────────
  let pkg;
  try {
    const r = await fetch(`${TARGET}/agent-package.json`);
    if (!r.ok) return fail("bootstrap", r.status, "PACKAGE_FETCH_FAILED", `GET /agent-package.json → ${r.status}`);
    pkg = await r.json();
  } catch (e) {
    return fail("bootstrap", 0, "PACKAGE_FETCH_ERROR", String(e));
  }

  // ── 1. provision ────────────────────────────────────────────────────────────
  const prov = endpoint(pkg, "provision_api_key", { method: "POST", path: "/api/auth/provision" });
  const p = await call(prov.method, prov.path, { email: EMAIL, name: "PCC Canary", capability: "canary" });
  if (p.status >= 500 || !p.json) return fail("provision", p.status, p.json?.error?.code, "provision 5xx / empty");
  apiKey = p.json.api_key ?? p.json.apiKey;
  traceId = p.json.trace_id ?? traceId;
  if (!apiKey) return fail("provision", p.status, p.json?.error?.code ?? "NO_API_KEY", "provision returned no api_key");
  if (!traceId) return fail("provision", p.status, "NO_TRACE_ID", "piece-1 regression: no trace_id in body or x-pcc-trace-id header");
  furthestStage = "provision";

  // ── 2. discover ──────────────────────────────────────────────────────────────
  const types = endpoint(pkg, "list_capability_types", { method: "GET", path: "/api/capabilities/types" });
  const d = await call(types.method, types.path);
  if (!d.ok) return fail("discover", d.status, d.json?.error?.code ?? d.json?.error, "capability types not listable");
  const typeList = d.json?.types ?? [];
  if (!Array.isArray(typeList) || typeList.length === 0) return fail("discover", d.status, "NO_CAPABILITY_TYPES", "empty types[]");
  const chosenType = typeList[0];
  furthestStage = "discover";

  // ── 3. build (options → price → contract) ─────────────────────────────────────
  // 4xx WITH an error envelope is acceptable (verifies piece 2); 5xx / missing
  // envelope is a regression.
  const buildSteps = [
    { name: "get_build_options", fb: { method: "POST", path: "/api/build/options" }, body: { type: chosenType } },
    { name: "calculate_price", fb: { method: "POST", path: "/api/build/price" }, body: { type: chosenType, selections: {} } },
    { name: "build_contract", fb: { method: "POST", path: "/api/build/contract" }, body: { type: chosenType, selections: {}, assuranceTier: 0 } },
  ];
  for (const step of buildSteps) {
    const ep = endpoint(pkg, step.name, step.fb);
    const r = await call(ep.method, ep.path, step.body);
    if (r.status >= 500) return { ...fail("build", r.status, r.json?.error?.code ?? "BUILD_5XX", `${step.name} → 5xx`), endpoint: ep.path };
    if (r.status >= 400 && !envelopeOk(r.json)) {
      return { ...fail("build", r.status, "ENVELOPE_MISSING", `${step.name} 4xx without rich error envelope (piece-2 regression)`), endpoint: ep.path };
    }
    // 2xx or 4xx-with-envelope → the API behaved correctly.
  }
  furthestStage = "build";

  return null; // success
  void started;
}

(async () => {
  const started = Date.now();
  let failure = null;
  try { failure = await run(); }
  catch (e) { failure = fail(furthestStage ?? "unknown", 0, "CANARY_EXCEPTION", String(e)); }

  const duration_ms = Date.now() - started;
  const result = {
    ts: new Date().toISOString(),
    target: TARGET,
    ok: !failure,
    stage_reached: furthestStage,
    failed_stage: failure?.stage ?? null,
    last_status: failure?.status ?? null,
    last_error: failure?.errorCode ?? null,
    trace_id: traceId ?? null,
    duration_ms,
  };
  console.log(`CANARY_RESULT=${JSON.stringify(result)}`);

  if (failure) {
    console.error(`[canary] FAIL at ${failure.stage}: ${failure.detail ?? failure.errorCode}`);
    await fileReport(failure);
    process.exit(1);
  }

  // Success: heartbeat (best-effort) + dead-man's-switch push.
  try { await call("POST", "/api/agents/heartbeat", { agentId: "canary" }); } catch { /* optional */ }
  if (HEARTBEAT_URL) { try { await fetch(HEARTBEAT_URL); } catch { /* optional */ } }
  console.log(`[canary] OK — full onboarding loop green in ${duration_ms}ms (trace ${traceId})`);
  process.exit(0);
})();
