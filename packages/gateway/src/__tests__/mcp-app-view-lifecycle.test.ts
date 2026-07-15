/**
 * @vitest-environment jsdom
 *
 * MCP Apps view — the STANDARD lifecycle, exercised end-to-end in a real DOM
 * (directive 1/2/15). These drive the ACTUAL exported boot functions
 * (runDashboardViewBoot / runGalleryViewBoot) — the exact logic inlined into the
 * view HTML via `.toString()` — against a jsdom document, and assert on DOM
 * mutations (NOT string-contains). We inject a controllable `win` so we can
 * observe what the view posts to its parent (the real window doesn't expose that).
 *
 * Proven: view sends `ui/initialize`; replies to the host's init result with
 * `ui/notifications/initialized`; a real `ui/notifications/tool-result` MOUNTS
 * the manifest and the waiting placeholder disappears; a hostile-first message
 * cannot latch the view; a token in the message is ignored (no storage write);
 * the gallery renders its entries list.
 *
 * NOT covered here (a LATER round): a real browser / real host, the double-iframe
 * sandbox proxy, and the kit's full live-data render.
 */

import { describe, it, expect } from "vitest";
import { DASHBOARD_CSD_URL } from "@pcc/spec";
import {
  runDashboardViewBoot,
  runGalleryViewBoot,
  MCP_APP_TOOL_RESULT_METHOD,
} from "../mcp/mcp-app-view.js";

// A harmless stand-in for pcc-ui.js — we assert it was injected, not that it runs.
const STUB_KIT = "/* stub kit */ window.__STUB_KIT_RAN__ = true;";

function manifestFor(title: string) {
  return {
    csd: DASHBOARD_CSD_URL,
    title,
    sections: [{ windows: [{ kind: "note", text: "hello" }] }],
  };
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

function setupGalleryDom(): void {
  document.body.innerHTML = "";
  const main = document.createElement("main");
  main.id = "pcc-root";
  const status = document.createElement("p");
  status.id = "pcc-kit-status";
  status.textContent = "Waiting for the host…";
  main.appendChild(status);
  document.body.appendChild(main);
}

// A controllable window: real jsdom `document`, a mock `parent` whose
// postMessage we can observe, and a captured `message` handler we can drive.
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

// Drive the STRICT lifecycle handshake to `waiting_for_tool_result`: answer the
// view's `ui/initialize` with a matching init result (exact protocolVersion), then
// send a complete `ui/notifications/tool-input`. Spec order is
// initialize -> initialized -> tool-input -> tool-result, so any test that expects
// a mount MUST call this after boot and before delivering a tool-result.
function completeInit(
  posted: Array<Record<string, unknown>>,
  deliver: (data: unknown, source?: unknown) => void,
): void {
  const init = posted.find((m) => m.method === "ui/initialize");
  if (!init) throw new Error("no ui/initialize was posted — did the view boot?");
  deliver({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2026-01-26", hostContext: {} } });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
}

describe("MCP Apps lifecycle — single-manifest view (render/saved)", () => {
  it("sends ui/initialize on boot and answers the host init result with ui/notifications/initialized", () => {
    setupManifestDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);

    expect(posted[0].method).toBe("ui/initialize");
    expect((posted[0].params as { protocolVersion?: string }).protocolVersion).toBe("2026-01-26");

    // Host answers our ui/initialize request → we must send `initialized`.
    deliver({ jsonrpc: "2.0", id: posted[0].id, result: { protocolVersion: "2026-01-26", hostContext: {} } });
    expect(posted.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
  });

  it("MOUNTS the manifest from a real tool-result and removes the waiting placeholder", () => {
    setupManifestDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);

    // Before the handoff: the neutral "waiting" placeholder is present.
    expect(document.getElementById("pcc-kit-status")).not.toBeNull();

    // A tool-result is honored only after the full init -> tool-input handshake.
    completeInit(posted, deliver);
    const manifest = manifestFor("Live dashboard");
    deliver(toolResult({ manifest }));

    // After the handoff: placeholder gone, manifest mounted, host bridge announced,
    // kit injected.
    expect(document.getElementById("pcc-kit-status")).toBeNull();
    const node = document.getElementById("pcc-manifest") as HTMLScriptElement;
    expect(JSON.parse(node.textContent || "null")).toEqual(manifest);
    expect((win as { __PCC_HOST__?: boolean }).__PCC_HOST__).toBe(true);
    const kitInjected = Array.from(document.body.querySelectorAll("script")).some(
      (s) => s.textContent === STUB_KIT,
    );
    expect(kitInjected).toBe(true);
  });

  it("does NOT latch on a hostile first message; a later valid one still mounts", () => {
    setupManifestDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);

    // Complete init so the results below are judged on their merits (post-init),
    // not simply dropped by the lifecycle gate — the hostile ones must STILL be
    // refused: (a) by the source check, (b) by in-view projection (unknown kind).
    completeInit(posted, deliver);

    // (a) a valid-looking result from a FOREIGN frame (source !== parent)
    deliver(toolResult({ manifest: manifestFor("phish") }), { name: "evil-frame" });
    // (b) a forged manifest (unknown window kind) from the REAL parent
    deliver(
      toolResult({
        manifest: { csd: DASHBOARD_CSD_URL, title: "x", sections: [{ windows: [{ kind: "evil-iframe" }] }] },
      }),
    );

    // Nothing mounted — the view still waits.
    expect(document.getElementById("pcc-kit-status")).not.toBeNull();
    expect((document.getElementById("pcc-manifest") as HTMLScriptElement).textContent).toBe("null");
    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBeFalsy();

    // The real handoff still succeeds.
    const good = manifestFor("Real dashboard");
    deliver(toolResult({ manifest: good }));
    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBe(true);
    expect(JSON.parse((document.getElementById("pcc-manifest") as HTMLScriptElement).textContent || "null")).toEqual(
      good,
    );
  });

  it("IGNORES a token in the message and never writes a credential to storage", () => {
    setupManifestDom();
    window.sessionStorage.clear();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);

    completeInit(posted, deliver);
    const manifest = manifestFor("Live dashboard");
    deliver(toolResult({ manifest, token: "pcc_live_should_be_ignored", apiBase: "https://evil.example" }));

    // Only the manifest is mounted — no token merged in, no sessionStorage write.
    const mounted = JSON.parse((document.getElementById("pcc-manifest") as HTMLScriptElement).textContent || "null");
    expect(mounted).toEqual(manifest);
    expect(window.sessionStorage.getItem("pcc.key")).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("REJECTS a valid tool-result delivered BEFORE the init handshake; a post-init one still mounts", () => {
    setupManifestDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);

    const manifest = manifestFor("Pre-init dashboard");
    // A VALID parent tool-result BEFORE init completes must be ignored (spec order
    // initialize -> initialized -> tool-input -> tool-result). Nothing mounts.
    deliver(toolResult({ manifest }));
    expect(document.getElementById("pcc-kit-status")).not.toBeNull();
    expect((document.getElementById("pcc-manifest") as HTMLScriptElement).textContent).toBe("null");
    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBeFalsy();

    // Once the handshake completes, the SAME result now mounts.
    completeInit(posted, deliver);
    deliver(toolResult({ manifest }));
    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBe(true);
    expect(document.getElementById("pcc-kit-status")).toBeNull();
  });

  it("REJECTS a tool-result delivered BEFORE a complete tool-input (init done, no tool-input yet)", () => {
    setupManifestDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);

    // Answer init ONLY (no tool-input) → state is waiting_for_tool_input.
    const init = posted.find((m) => m.method === "ui/initialize");
    deliver({ jsonrpc: "2.0", id: init!.id, result: { protocolVersion: "2026-01-26" } });

    // A tool-result now (before any tool-input) is refused — nothing mounts.
    deliver(toolResult({ manifest: manifestFor("Too early") }));
    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBeFalsy();
    expect(document.getElementById("pcc-kit-status")).not.toBeNull();

    // After a complete tool-input, the SAME result mounts.
    deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
    deliver(toolResult({ manifest: manifestFor("Too early") }));
    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBe(true);
  });
});

describe("MCP Apps lifecycle — gallery (search) view", () => {
  it("renders the entries list from a real tool-result and removes the placeholder", () => {
    setupGalleryDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runGalleryViewBoot(win as any);

    expect(document.getElementById("pcc-kit-status")).not.toBeNull();
    completeInit(posted, deliver);
    deliver(
      toolResult({
        entries: [
          { slug: "a-dash-1111", name: "A", title: "Alpha" },
          { slug: "b-dash-2222", name: "B", title: "Bravo" },
        ],
        total: 2,
      }),
    );

    expect(document.getElementById("pcc-kit-status")).toBeNull();
    expect(document.querySelectorAll(".pcc-gallery li").length).toBe(2);
    expect(document.body.textContent).toContain("Alpha");
    expect(document.body.textContent).toContain("a-dash-1111");
  });

  it("shows an empty state for zero entries", () => {
    setupGalleryDom();
    const { win, posted, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runGalleryViewBoot(win as any);
    completeInit(posted, deliver);
    deliver(toolResult({ entries: [], total: 0 }));
    expect(document.body.textContent).toContain("No dashboards found.");
  });
});
