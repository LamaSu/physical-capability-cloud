/**
 * @vitest-environment jsdom
 *
 * R4 PR2 — the view→host tools/call BRIDGE and the kit's host-mode operation
 * routing. Two layers here (jsdom); the served-HTML injection (that the render
 * view actually carries __PCC_HOST_OPERATIONS__ + the bridge) is proven in the
 * node-env mcp-typed-operations.test.ts, which owns the /mcp transport:
 *   A. bridge mechanics — connectMcpAppView returns a callHostTool that posts a
 *      tools/call and resolves on the matching-id response; runDashboardViewBoot
 *      wires window.__PCC_HOST_BRIDGE__.callOperation after mount.
 *   C. real-kit routing — the ACTUAL pcc-ui.js, in host mode, routes a REGISTERED
 *      operation button to the bridge and keeps an UNregistered one inert.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_CSD_URL } from "@pcc/spec";
import {
  connectMcpAppView,
  runDashboardViewBoot,
  MCP_APP_TOOL_RESULT_METHOD,
} from "../mcp/mcp-app-view.js";
// The dependency-free id list (NOT operation-policy, which pulls the heavy
// facade/kernel graph that breaks a jsdom module graph). The served-HTML
// injection is proven in the node-env mcp-typed-operations.test.ts.
import { REGISTERED_OPERATION_IDS } from "../mcp/operation-ids.js";

const STUB_KIT = "/* stub kit */ window.__STUB_KIT_RAN__ = true;";

function manifestFor(title: string, sections: unknown[]) {
  return { csd: DASHBOARD_CSD_URL, title, sections };
}

function setupManifestDom(): void {
  document.body.innerHTML = "";
  const main = document.createElement("main");
  main.id = "pcc-root";
  const status = document.createElement("p");
  status.id = "pcc-kit-status";
  status.textContent = "Waiting for the host…";
  main.appendChild(status);
  document.body.appendChild(main);
  const m = document.createElement("script");
  m.type = "application/json";
  m.id = "pcc-manifest";
  m.textContent = "null";
  document.body.appendChild(m);
}

// A controllable window: real jsdom document, an observable parent.postMessage,
// and a captured message handler we can drive (mirrors the lifecycle test).
function makeWin() {
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  let handler: ((event: { source: unknown; data: unknown }) => void) | undefined;
  const win = {
    parent,
    document,
    addEventListener: (type: string, h: (event: { source: unknown; data: unknown }) => void) => {
      if (type === "message") handler = h;
    },
  } as Record<string, unknown>;
  const deliver = (data: unknown, source: unknown = parent) => {
    if (handler) handler({ source, data });
  };
  return { win, parent, posted, deliver };
}

const toolResult = (structuredContent: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: MCP_APP_TOOL_RESULT_METHOD,
  params: { content: [{ type: "text", text: "ok" }], structuredContent },
});

// ── A. bridge mechanics ──────────────────────────────────────────────────────

describe("[bridge] connectMcpAppView returns an outbound tools/call sender", () => {
  it("callHostTool posts a tools/call (id >= 2, distinct from INIT_ID) and resolves on the matching id", async () => {
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callHostTool = connectMcpAppView(win as any, () => {});
    // posted[0] is ui/initialize (id 1).
    expect(posted[0].method).toBe("ui/initialize");

    const p = callHostTool("pcc.op.job.cancel", { jobId: "j1" });
    const sent = posted.find((m) => m.method === "tools/call") as Record<string, unknown>;
    expect(sent).toBeTruthy();
    expect(sent.params).toEqual({ name: "pcc.op.job.cancel", arguments: { jobId: "j1" } });
    expect(Number(sent.id)).toBeGreaterThanOrEqual(2);

    // Host answers with the matching id → the promise resolves with result.
    deliver({ jsonrpc: "2.0", id: sent.id, result: { structuredContent: { job: { status: "cancelled" } } } });
    await expect(p).resolves.toEqual({ structuredContent: { job: { status: "cancelled" } } });
  });

  it("callHostTool REJECTS on a JSON-RPC error response", async () => {
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callHostTool = connectMcpAppView(win as any, () => {});
    const p = callHostTool("pcc.op.job.cancel", {});
    const sent = posted.find((m) => m.method === "tools/call") as Record<string, unknown>;
    deliver({ jsonrpc: "2.0", id: sent.id, error: { code: -32000, message: "boom" } });
    await expect(p).rejects.toThrow("boom");
  });

  it("a response from a FOREIGN source (source !== parent) is ignored (no resolve)", async () => {
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callHostTool = connectMcpAppView(win as any, () => {});
    let settled = false;
    const p = callHostTool("pcc.op.job.cancel", {}).then(() => { settled = true; });
    const sent = posted.find((m) => m.method === "tools/call") as Record<string, unknown>;
    deliver({ jsonrpc: "2.0", id: sent.id, result: {} }, { name: "evil-frame" });
    await Promise.resolve();
    expect(settled).toBe(false); // still pending — the foreign response was dropped
    // A genuine response then resolves it.
    deliver({ jsonrpc: "2.0", id: sent.id, result: {} });
    await p;
    expect(settled).toBe(true);
  });

  it("concurrent calls correlate to their OWN responses by id", async () => {
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callHostTool = connectMcpAppView(win as any, () => {});
    const p1 = callHostTool("pcc.op.capability.request_quote", { type: "fdm" });
    const p2 = callHostTool("pcc.op.job.cancel", { jobId: "j1" });
    const calls = posted.filter((m) => m.method === "tools/call") as Record<string, unknown>[];
    expect(calls).toHaveLength(2);
    // Answer them OUT OF ORDER — each resolves to the right value.
    deliver({ jsonrpc: "2.0", id: calls[1].id, result: { which: "cancel" } });
    deliver({ jsonrpc: "2.0", id: calls[0].id, result: { which: "quote" } });
    await expect(p1).resolves.toEqual({ which: "quote" });
    await expect(p2).resolves.toEqual({ which: "cancel" });
  });
});

describe("[bridge] runDashboardViewBoot wires window.__PCC_HOST_BRIDGE__.callOperation on mount", () => {
  it("after a real tool-result mount, callOperation sends a tools/call for the mapped pcc.op.<id> tool", async () => {
    setupManifestDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);
    deliver({ jsonrpc: "2.0", id: posted[0].id, result: { protocolVersion: "2026-01-26" } });
    deliver(toolResult({ manifest: manifestFor("Ops", [{ windows: [{ kind: "note", text: "hi" }] }]) }));

    const bridge = (win as { __PCC_HOST_BRIDGE__?: { callOperation?: (id: string, a: unknown) => Promise<unknown> } })
      .__PCC_HOST_BRIDGE__;
    expect(bridge && typeof bridge.callOperation).toBe("function");

    void bridge!.callOperation!("job.cancel", { jobId: "j1" });
    const sent = posted.find((m) => m.method === "tools/call") as Record<string, unknown>;
    expect(sent.params).toEqual({ name: "pcc.op.job.cancel", arguments: { jobId: "j1" } });
  });
});

// ── C. real-kit routing (the ACTUAL pcc-ui.js) ───────────────────────────────

describe("[bridge] the real pcc-ui.js routes a registered op via the bridge, keeps others inert", () => {
  const kitPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js",
  );
  const kitSource = readFileSync(kitPath, "utf8");

  function buttonByLabel(label: string): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll<HTMLButtonElement>(".pcc-actionbar button")).find(
      (b) => (b.textContent || "").indexOf(label) !== -1,
    );
  }

  afterEach(() => {
    // Reset the host globals + the kit's once-per-document boot guard between cases.
    delete (window as Record<string, unknown>).__PCC_HOST__;
    delete (window as Record<string, unknown>).__PCC_HOST_OPERATIONS__;
    delete (window as Record<string, unknown>).__PCC_HOST_BRIDGE__;
    delete (window as Record<string, unknown>).__PCC_UI_BOOTED__;
    vi.restoreAllMocks();
  });

  function bootKitWithManifest(manifest: unknown, callOperation: (id: string, a: unknown) => Promise<unknown>) {
    document.body.innerHTML = "";
    const root = document.createElement("main");
    root.id = "pcc-root";
    document.body.appendChild(root);
    const m = document.createElement("script");
    m.type = "application/json";
    m.id = "pcc-manifest";
    m.textContent = JSON.stringify(manifest);
    document.body.appendChild(m);
    (window as Record<string, unknown>).__PCC_HOST__ = true;
    (window as Record<string, unknown>).__PCC_HOST_OPERATIONS__ = [...REGISTERED_OPERATION_IDS];
    (window as Record<string, unknown>).__PCC_HOST_BRIDGE__ = { callOperation };
    delete (window as Record<string, unknown>).__PCC_UI_BOOTED__; // allow a fresh boot
    // Run the ACTUAL kit IIFE against jsdom's window/document (readyState is
    // 'complete', so mount() runs immediately).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(kitSource)();
  }

  const manifest = manifestFor("Ops", [
    {
      windows: [
        {
          kind: "actions",
          actions: [
            { id: "a1", label: "Cancel job", kind: "patch", path: "/api/jobs/j1/status", confirm: "inline", intentText: "pcc: cancel", operation_id: "job.cancel", arguments: { jobId: "j1" } },
            { id: "a2", label: "Release funds", kind: "post", path: "/api/x", confirm: "inline", intentText: "pcc: release", operation_id: "escrow.release_milestone", arguments: {} },
            { id: "a3", label: "Raw write", kind: "post", path: "/api/x", confirm: "inline", intentText: "pcc: raw" },
          ],
        },
      ],
    },
  ]);

  it("a REGISTERED-operation button stays live and, on click, calls the bridge with (operationId, arguments)", () => {
    const spy = vi.fn().mockResolvedValue({ structuredContent: { job: { status: "cancelled" } } });
    bootKitWithManifest(manifest, spy);

    const btn = buttonByLabel("Cancel job");
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(false);
    expect(btn!.className).toContain("pcc-host-op-enabled");

    btn!.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("job.cancel", { jobId: "j1" });
  });

  it("an UNREGISTERED-operation button is disabled (inert) — default-DENY on the client", () => {
    const spy = vi.fn().mockResolvedValue({});
    bootKitWithManifest(manifest, spy);

    const btn = buttonByLabel("Release funds");
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
    expect(btn!.className).not.toContain("pcc-host-op-enabled");
  });

  it("a RAW write button (no operation_id) stays disabled — PR1 lockdown intact", () => {
    const spy = vi.fn().mockResolvedValue({});
    bootKitWithManifest(manifest, spy);

    const btn = buttonByLabel("Raw write");
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
  });

  it("with NO bridge present, even a registered-op button stays inert (belt-and-suspenders)", () => {
    document.body.innerHTML = "";
    const root = document.createElement("main");
    root.id = "pcc-root";
    document.body.appendChild(root);
    const m = document.createElement("script");
    m.type = "application/json";
    m.id = "pcc-manifest";
    m.textContent = JSON.stringify(manifest);
    document.body.appendChild(m);
    (window as Record<string, unknown>).__PCC_HOST__ = true;
    (window as Record<string, unknown>).__PCC_HOST_OPERATIONS__ = [...REGISTERED_OPERATION_IDS];
    // no __PCC_HOST_BRIDGE__
    delete (window as Record<string, unknown>).__PCC_UI_BOOTED__; // allow a fresh boot
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(kitSource)();

    const btn = buttonByLabel("Cancel job");
    expect(btn).toBeTruthy();
    expect(btn!.disabled).toBe(true);
  });
});
