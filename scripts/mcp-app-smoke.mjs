#!/usr/bin/env node
/*
 * Exact-image smoke test for the PCC MCP Apps surface (audit directive 6).
 *
 * Given a RUNNING gateway base URL, it drives the full MCP Apps lifecycle
 * end-to-end and exits NON-ZERO on any failure. Run it against the retagged
 * production IMAGE (a container started from ghcr.io/lamasu/...:<sha|prod>),
 * NOT a source checkout — that is the whole point: prove the assets the gateway
 * loads at request time (manifest.schema.json, pcc-ui.js, committed docs) are
 * actually present in the built image.
 *
 *   node scripts/mcp-app-smoke.mjs https://capability.network
 *   node scripts/mcp-app-smoke.mjs                 # $PCC_SMOKE_BASE_URL or http://127.0.0.1:3200
 *
 * Sequence:
 *   /mcp initialize
 *     -> tools/list                      (existing PCC tools + render_pcc_dashboard present)
 *     -> resources/read ui://pcc/dashboard/{render,saved,gallery}  (HTML + _meta.ui.csp)
 *     -> one pre-existing NON-UI tool    (proxy path still dispatches, not a protocol error)
 *     -> render_pcc_dashboard(valid)     (success + structuredContent.manifest)
 *     -> render_pcc_dashboard(invalid)   (tool-level error, NO crash; server still answers)
 *   /mcp/docs initialize
 *     -> resources/read docs://pcc/agent-guide   (markdown text)
 *
 * The orchestrator attaches this script's output + the image digest to the
 * deploy record as directive-6 evidence. The same sequence is exercised in-source
 * by packages/gateway/src/__tests__/{http-mcp,mcp-apps,mcp-apps-assets}.test.ts;
 * this script is the against-the-real-image counterpart.
 */

const BASE = (process.argv[2] || process.env.PCC_SMOKE_BASE_URL || "http://127.0.0.1:3200").replace(
  /\/+$/,
  "",
);
const PROTOCOL = "2025-06-18";
const RENDER_NAME = "render_pcc_dashboard";
const PCC_ORIGIN = "https://capability.network";

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

async function parseBody(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("text/event-stream")) {
    // The Streamable-HTTP transport may frame the JSON-RPC message as SSE; the
    // last `data:` line is the message.
    const line = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .pop();
    try {
      return line ? JSON.parse(line) : { __raw: text };
    } catch {
      return { __raw: text };
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
}

/** Open one MCP session over a Streamable-HTTP endpoint (/mcp or /mcp/docs). */
async function openSession(path) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "pcc-mcp-app-smoke", version: "1.0.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  const body = await parseBody(res);
  const protocolVersion = body?.result?.protocolVersion || PROTOCOL;
  if (!res.ok || !sessionId || !body?.result) {
    throw new Error(
      `initialize on ${path} failed: status=${res.status} session=${sessionId} body=${JSON.stringify(
        body,
      ).slice(0, 240)}`,
    );
  }
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  };
  // Handshake completion — the SDK expects it before other requests.
  await fetch(BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  let nextId = 2;
  return {
    sessionId,
    protocolVersion,
    async rpc(method, params) {
      const r = await fetch(BASE + path, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
      return { status: r.status, body: await parseBody(r) };
    },
  };
}

function goodManifest() {
  return {
    csd: "pcc://artifacts/dashboard/v1",
    title: "Smoke dashboard",
    sections: [{ windows: [{ kind: "note", text: "hello from the smoke test" }] }],
  };
}

async function main() {
  console.log(`[mcp-app-smoke] target ${BASE}`);

  // --- /mcp product surface -------------------------------------------------
  const mcp = await openSession("/mcp");
  check("/mcp initialize returns a session + protocolVersion", !!mcp.sessionId);

  const tools = (await mcp.rpc("tools/list", {})).body?.result?.tools || [];
  check("tools/list returns the pre-existing PCC tool set (>= 50)", tools.length >= 50, `got ${tools.length}`);
  check(
    "tools/list includes render_pcc_dashboard",
    tools.some((t) => t.name === RENDER_NAME),
  );
  const render = tools.find((t) => t.name === RENDER_NAME);
  check(
    "render_pcc_dashboard declares the fixed ui://pcc/dashboard/render resource",
    render?._meta?.ui?.resourceUri === "ui://pcc/dashboard/render",
  );

  for (const uri of [
    "ui://pcc/dashboard/render",
    "ui://pcc/dashboard/saved",
    "ui://pcc/dashboard/gallery",
  ]) {
    const read = (await mcp.rpc("resources/read", { uri })).body?.result?.contents?.[0];
    check(
      `resources/read ${uri} returns MCP-App HTML`,
      typeof read?.text === "string" && read.text.includes("<!doctype html>"),
      read?.mimeType,
    );
    check(
      `resources/read ${uri} ships _meta.ui.csp.connectDomains=[${PCC_ORIGIN}]`,
      Array.isArray(read?._meta?.ui?.csp?.connectDomains) &&
        read._meta.ui.csp.connectDomains.includes(PCC_ORIGIN),
    );
  }

  // One pre-existing NON-UI read-only tool → the proxy path still dispatches (a
  // result envelope, never a JSON-RPC protocol error). A 401/upstream error is a
  // tool-level isError result and still proves the dispatch path works.
  const nonUi = tools.find(
    (t) => t.name !== RENDER_NAME && t.annotations?.readOnlyHint === true && !/dashboard/i.test(t.name),
  );
  if (nonUi) {
    const call = await mcp.rpc("tools/call", { name: nonUi.name, arguments: {} });
    check(
      `proxy tool ${nonUi.name} dispatches (result envelope, no protocol error)`,
      call.body?.error === undefined && call.body?.result !== undefined,
      JSON.stringify(call.body?.error || "").slice(0, 160),
    );
  } else {
    check("a pre-existing non-UI readOnly tool exists to exercise the proxy", false, "none in tools/list");
  }

  // render_pcc_dashboard with a valid manifest → success + structuredContent.
  const good = (await mcp.rpc("tools/call", { name: RENDER_NAME, arguments: goodManifest() })).body
    ?.result;
  check("render_pcc_dashboard(valid) succeeds", !!good && good.isError !== true);
  check(
    "render_pcc_dashboard(valid) returns structuredContent.manifest",
    good?.structuredContent?.manifest?.title === "Smoke dashboard",
  );

  // invalid manifest → tool-level error, NOT a crash; a following request still works.
  const bad = (
    await mcp.rpc("tools/call", { name: RENDER_NAME, arguments: { csd: "pcc://artifacts/dashboard/v1" } })
  ).body?.result;
  check("render_pcc_dashboard(invalid) returns a tool-level error (no crash)", bad?.isError === true);
  const afterBad = (await mcp.rpc("tools/list", {})).body?.result?.tools || [];
  check("server still serves tools/list after the invalid manifest (no crash)", afterBad.length >= 50);

  // --- /mcp/docs surface ----------------------------------------------------
  const docs = await openSession("/mcp/docs");
  check("/mcp/docs initialize returns a session", !!docs.sessionId);
  const guide = (await docs.rpc("resources/read", { uri: "docs://pcc/agent-guide" })).body?.result
    ?.contents?.[0];
  check(
    "/mcp/docs reads docs://pcc/agent-guide (markdown text)",
    typeof guide?.text === "string" && guide.text.length > 200,
    guide?.mimeType,
  );

  console.log(failures === 0 ? "\n[mcp-app-smoke] PASS" : `\n[mcp-app-smoke] FAIL (${failures} check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[mcp-app-smoke] ERROR", err?.message || err);
  process.exit(1);
});
