/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @vitest-environment jsdom
 *
 * R4 PR3 — the STRICT MCP-Apps lifecycle state machine (`mcpAppLifecycleTransition`)
 * and the stripping projection (`projectDashboardForMcpApp`). Both are the EXACT
 * logic inlined into the view via `.toString()`, so testing them here tests the
 * shipped browser code.
 *
 *  - The reducer OWNS every ordering REJECT: a tool-result before init; a
 *    tool-result before a complete tool-input; a wrong/absent protocol version;
 *    repeated / out-of-order lifecycle messages; unknown host methods.
 *  - The projection builds a FRESH safe view model (fresh object identity),
 *    strips unknown fields, rejects unknown window kinds and request-bearing
 *    (raw-HTTP / credential) actions, accepts the typed operation_id form, and
 *    bounds depth + node count.
 *  - Interaction: a fully-valid-looking manifest delivered BEFORE init is still
 *    refused — by the state machine, not the projection.
 */

import { describe, it, expect } from "vitest";
import { DASHBOARD_CSD_URL } from "@pcc/spec";
import {
  mcpAppLifecycleTransition,
  projectDashboardForMcpApp,
  MCP_APP_PROTOCOL_VERSION,
  runDashboardViewBoot,
  MCP_APP_TOOL_RESULT_METHOD,
  type McpAppLifecycleState,
} from "../mcp/mcp-app-view.js";

const INIT_ID = 1;
const PV = MCP_APP_PROTOCOL_VERSION; // "2026-01-26"

const initResult = (pv: unknown = PV) => ({ jsonrpc: "2.0", id: INIT_ID, result: { protocolVersion: pv } });
const toolInput = () => ({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
const toolResultMsg = (sc: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  method: MCP_APP_TOOL_RESULT_METHOD,
  params: { structuredContent: sc },
});

const ALL_STATES: McpAppLifecycleState[] = [
  "waiting_for_initialize_result",
  "waiting_for_tool_input",
  "waiting_for_tool_result",
  "rendered",
];

// ===========================================================================
// State machine — the strict ordering, one test per REJECT case.
// ===========================================================================

describe("mcpAppLifecycleTransition — strict lifecycle ordering", () => {
  it("ACCEPTS a valid init result (matching id + exact protocol) → emits `initialized`", () => {
    const d = mcpAppLifecycleTransition("waiting_for_initialize_result", initResult(), INIT_ID, PV);
    expect(d.accept).toBe(true);
    expect(d.next).toBe("waiting_for_tool_input");
    expect(d.emit).toBe("initialized");
  });

  it("REJECTS a tool-result BEFORE init", () => {
    const d = mcpAppLifecycleTransition("waiting_for_initialize_result", toolResultMsg(), INIT_ID, PV);
    expect(d.accept).toBe(false);
    expect(d.emit).toBe("none");
  });

  it("REJECTS an init result with a WRONG protocol version", () => {
    const d = mcpAppLifecycleTransition("waiting_for_initialize_result", initResult("2020-01-01"), INIT_ID, PV);
    expect(d.accept).toBe(false);
  });

  it("REJECTS an init result with an ABSENT protocol version", () => {
    const d = mcpAppLifecycleTransition(
      "waiting_for_initialize_result",
      { jsonrpc: "2.0", id: INIT_ID, result: {} },
      INIT_ID,
      PV,
    );
    expect(d.accept).toBe(false);
  });

  it("ACCEPTS a complete tool-input from `waiting_for_tool_input`", () => {
    const d = mcpAppLifecycleTransition("waiting_for_tool_input", toolInput(), INIT_ID, PV);
    expect(d.accept).toBe(true);
    expect(d.next).toBe("waiting_for_tool_result");
    expect(d.emit).toBe("none");
  });

  it("REJECTS a tool-result BEFORE a complete tool-input", () => {
    const d = mcpAppLifecycleTransition("waiting_for_tool_input", toolResultMsg(), INIT_ID, PV);
    expect(d.accept).toBe(false);
  });

  it("REJECTS an INCOMPLETE tool-input (no params object)", () => {
    const d = mcpAppLifecycleTransition(
      "waiting_for_tool_input",
      { jsonrpc: "2.0", method: "ui/notifications/tool-input" },
      INIT_ID,
      PV,
    );
    expect(d.accept).toBe(false);
  });

  it("REJECTS an INCOMPLETE tool-input when params has no `arguments` object (D1)", () => {
    // params is an object but carries no arguments — the OLD check accepted this;
    // the streaming tool-input is not complete until params.arguments is an object.
    const noArgs = mcpAppLifecycleTransition(
      "waiting_for_tool_input",
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: {} },
      INIT_ID,
      PV,
    );
    expect(noArgs.accept).toBe(false);
    // a non-object arguments (string / array) is likewise incomplete
    for (const bad of ["", 3, [], null]) {
      const d = mcpAppLifecycleTransition(
        "waiting_for_tool_input",
        { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: bad } },
        INIT_ID,
        PV,
      );
      expect(d.accept, JSON.stringify(bad)).toBe(false);
    }
  });

  it("ACCEPTS a tool-input with an EMPTY arguments object (complete)", () => {
    const d = mcpAppLifecycleTransition(
      "waiting_for_tool_input",
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } },
      INIT_ID,
      PV,
    );
    expect(d.accept).toBe(true);
    expect(d.next).toBe("waiting_for_tool_result");
  });

  it("ACCEPTS a tool-result from `waiting_for_tool_result` → emits `tool_result`", () => {
    const d = mcpAppLifecycleTransition("waiting_for_tool_result", toolResultMsg(), INIT_ID, PV);
    expect(d.accept).toBe(true);
    expect(d.next).toBe("rendered");
    expect(d.emit).toBe("tool_result");
  });

  it("REJECTS a REPEATED tool-result once rendered (terminal state)", () => {
    const d = mcpAppLifecycleTransition("rendered", toolResultMsg(), INIT_ID, PV);
    expect(d.accept).toBe(false);
  });

  it("REJECTS an OUT-OF-ORDER init result after rendering", () => {
    const d = mcpAppLifecycleTransition("rendered", initResult(), INIT_ID, PV);
    expect(d.accept).toBe(false);
  });

  it("REJECTS a repeated/out-of-order init result while waiting for tool-input", () => {
    const d = mcpAppLifecycleTransition("waiting_for_tool_input", initResult(), INIT_ID, PV);
    expect(d.accept).toBe(false);
  });

  it("REJECTS an UNKNOWN host method in EVERY state", () => {
    const unknown = { jsonrpc: "2.0", method: "ui/notifications/bogus", params: {} };
    for (const s of ALL_STATES) {
      expect(mcpAppLifecycleTransition(s, unknown, INIT_ID, PV).accept, s).toBe(false);
    }
  });
});

// ===========================================================================
// Stripping projection — projectDashboardForMcpApp.
// ===========================================================================

const noteManifest = (title = "T") => ({
  csd: DASHBOARD_CSD_URL,
  title,
  sections: [{ windows: [{ kind: "note", text: "hi" }] }],
});

describe("projectDashboardForMcpApp — stripping projection", () => {
  it("returns a FRESH object at every level (never the host's own reference)", () => {
    const input = noteManifest();
    const out = projectDashboardForMcpApp(input) as any;
    expect(out).not.toBeNull();
    expect(out).not.toBe(input);
    expect(out.sections).not.toBe(input.sections);
    expect(out.sections[0]).not.toBe(input.sections[0]);
    expect(out.sections[0].windows[0]).not.toBe(input.sections[0].windows[0]);
    // ...but a clean manifest deep-equals its projection.
    expect(out).toEqual(input);
  });

  it("STRIPS unknown fields (top / section / window) + DROPS api_base; manifest stays valid", () => {
    const input: any = {
      csd: DASHBOARD_CSD_URL,
      title: "T",
      evilTop: 1,
      api_base: "https://evil.example",
      sections: [{ heading: "H", evilSection: 2, windows: [{ kind: "note", text: "hi", evilWindow: 3 }] }],
    };
    const out = projectDashboardForMcpApp(input) as any;
    expect(out).not.toBeNull();
    expect(out.evilTop).toBeUndefined();
    expect(out.api_base).toBeUndefined(); // host mode forces the PCC origin
    expect(out.sections[0].heading).toBe("H");
    expect(out.sections[0].evilSection).toBeUndefined();
    expect(out.sections[0].windows[0]).toEqual({ kind: "note", text: "hi" });
  });

  it("ACCEPTS a typed-operation action and STRIPS its raw-HTTP execution fields", () => {
    const input = {
      csd: DASHBOARD_CSD_URL,
      title: "Ops",
      sections: [
        {
          windows: [
            {
              kind: "actions",
              actions: [
                {
                  id: "a1",
                  label: "Cancel",
                  kind: "patch",
                  path: "/api/jobs/j1/status",
                  body: { x: 1 },
                  bodyFrom: "f",
                  idempotencyFrom: "k",
                  confirm: "inline",
                  intentText: "pcc: cancel",
                  operation_id: "job.cancel",
                  arguments: { jobId: "j1" },
                },
              ],
            },
          ],
        },
      ],
    };
    const out = projectDashboardForMcpApp(input) as any;
    expect(out).not.toBeNull();
    const a = out.sections[0].windows[0].actions[0];
    // only display + typed-op fields survive
    expect(a).toEqual({
      id: "a1",
      label: "Cancel",
      confirm: "inline",
      intentText: "pcc: cancel",
      operation_id: "job.cancel",
      arguments: { jobId: "j1" },
    });
    // raw-HTTP execution fields are stripped (never reach the renderer)
    for (const f of ["kind", "path", "body", "bodyFrom", "idempotencyFrom"]) {
      expect(a[f], f).toBeUndefined();
    }
    // the projected argument is a fresh object, not the host's reference
    expect(a.arguments).not.toBe(input.sections[0].windows[0].actions[0].arguments);
  });

  it("REJECTS the WHOLE manifest when an action carries a raw-HTTP / credential INJECTION field", () => {
    const injections: Array<Record<string, unknown>> = [
      { method: "POST" },
      { url: "https://evil.example/drain" },
      { headers: { Authorization: "Bearer x" } },
      { apiBase: "https://evil.example" },
      { token: "abc" },
      { confirmationText: "Trust me, this is only $1" },
    ];
    for (const bad of injections) {
      const input = {
        csd: DASHBOARD_CSD_URL,
        title: "x",
        sections: [
          {
            windows: [
              {
                kind: "actions",
                actions: [
                  { id: "a", label: "L", confirm: "approval", intentText: "i", operation_id: "job.cancel", ...bad },
                ],
              },
            ],
          },
        ],
      };
      expect(projectDashboardForMcpApp(input), JSON.stringify(bad)).toBeNull();
    }
  });

  it("REJECTS an unknown window kind (whole manifest)", () => {
    expect(
      projectDashboardForMcpApp({
        csd: DASHBOARD_CSD_URL,
        title: "x",
        sections: [{ windows: [{ kind: "iframe", src: "https://evil.example" }] }],
      }),
    ).toBeNull();
  });

  it("REJECTS a baked PCC key — in note text, and as a credential-named arg scalar", () => {
    expect(
      projectDashboardForMcpApp({
        csd: DASHBOARD_CSD_URL,
        title: "x",
        sections: [{ windows: [{ kind: "note", text: "pcc_live_leak" }] }],
      }),
    ).toBeNull();
    expect(
      projectDashboardForMcpApp({
        csd: DASHBOARD_CSD_URL,
        title: "x",
        sections: [
          {
            windows: [
              {
                kind: "actions",
                actions: [
                  { id: "a", label: "L", confirm: "inline", intentText: "i", operation_id: "op", arguments: { token: "sekret" } },
                ],
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it("ENFORCES a depth limit (deeply nested arguments → null)", () => {
    let deep: any = {};
    let cur = deep;
    for (let i = 0; i < 40; i++) {
      cur.a = {};
      cur = cur.a;
    }
    const input = {
      csd: DASHBOARD_CSD_URL,
      title: "x",
      sections: [
        {
          windows: [
            {
              kind: "actions",
              actions: [{ id: "a", label: "L", confirm: "inline", intentText: "i", operation_id: "op", arguments: deep }],
            },
          ],
        },
      ],
    };
    expect(projectDashboardForMcpApp(input)).toBeNull();
  });

  it("ENFORCES a node budget (thousands of windows → null)", () => {
    const windows: unknown[] = [];
    for (let i = 0; i < 6000; i++) windows.push({ kind: "note", text: "n" });
    expect(projectDashboardForMcpApp({ csd: DASHBOARD_CSD_URL, title: "x", sections: [{ windows }] })).toBeNull();
  });

  it("preserves a broad-but-valid manifest (metric/list/capability/receipt/run + theme)", () => {
    const input = {
      csd: DASHBOARD_CSD_URL,
      title: "Rich",
      theme: "dark",
      sections: [
        {
          windows: [
            { kind: "metric", label: "Jobs", binding: { path: "/api/status", pollMs: 5000, select: "count" }, format: "int" },
            { kind: "list", binding: { path: "/api/jobs" }, item: { title: "Job", meta: ["a", "b"], statusFrom: "status" }, limit: 5 },
            { kind: "capability", binding: { path: "/api/capabilities/c1" } },
            { kind: "receipt", binding: { path: "/api/escrow/e1" } },
            { kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/job/j1" }, statusFrom: "status", latestFrom: "latest" },
          ],
        },
      ],
    };
    const out = projectDashboardForMcpApp(input) as any;
    expect(out).not.toBeNull();
    expect(out.theme).toBe("dark");
    expect(out.sections[0].windows[0].binding).toEqual({ path: "/api/status", pollMs: 5000, select: "count" });
    expect(out.sections[0].windows[0].format).toBe("int");
    expect(out.sections[0].windows[1].item.meta).toEqual(["a", "b"]);
    expect(out.sections[0].windows[4].binding.sse).toBe("/sse/stream/job/j1");
  });

  it("REJECTS non-objects", () => {
    expect(projectDashboardForMcpApp(null)).toBeNull();
    expect(projectDashboardForMcpApp("nope")).toBeNull();
    expect(projectDashboardForMcpApp([])).toBeNull();
  });
});

// ===========================================================================
// Interaction — a fully-valid-looking manifest delivered BEFORE init is refused
// by the STATE MACHINE (not the projection).
// ===========================================================================

describe("strict lifecycle — a projection-VALID manifest sent pre-init still mounts nothing", () => {
  function setupDom(): void {
    document.body.innerHTML = "";
    const main = document.createElement("main");
    main.id = "pcc-root";
    const status = document.createElement("p");
    status.id = "pcc-kit-status";
    main.appendChild(status);
    document.body.appendChild(main);
    const m = document.createElement("script");
    m.type = "application/json";
    m.id = "pcc-manifest";
    m.textContent = "null";
    document.body.appendChild(m);
  }
  function makeWin() {
    const posted: Array<Record<string, unknown>> = [];
    const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
    let handler: ((e: { source: unknown; data: unknown }) => void) | undefined;
    const win = {
      parent,
      document,
      addEventListener: (t: string, h: (e: { source: unknown; data: unknown }) => void) => {
        if (t === "message") handler = h;
      },
    } as any;
    const deliver = (data: unknown, source: unknown = parent) => handler && handler({ source, data });
    return { win, deliver };
  }

  it("the manifest itself is VALID, yet the pre-init delivery is refused (no mount)", () => {
    setupDom();
    const manifest = noteManifest("Perfectly valid");
    // The projection would accept this manifest on its own — proving the refusal
    // below is the STATE MACHINE's doing, not the validator's.
    expect(projectDashboardForMcpApp(manifest)).not.toBeNull();

    const { win, deliver } = makeWin();
    runDashboardViewBoot(win, "/* kit */");
    // Deliver the tool-result immediately, before answering ui/initialize.
    deliver({ jsonrpc: "2.0", method: MCP_APP_TOOL_RESULT_METHOD, params: { structuredContent: { manifest } } });

    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBeFalsy();
    expect(document.getElementById("pcc-kit-status")).not.toBeNull();
    expect((document.getElementById("pcc-manifest") as HTMLScriptElement).textContent).toBe("null");
  });
});
