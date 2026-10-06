/**
 * AgentLinkPage shows two quickstart scripts for the user to copy or download
 * and run with node. The page's ?q= becomes the agent's first message, the
 * argument of the script's closing chat(...) call. Whatever ?q= holds, it must
 * arrive there as one string: a crafted link must not add code to a script
 * the user is about to run.
 *
 * The scripts are text the dashboard shows and never runs, so they live in
 * text assets (pages/agent-link/*.js.txt, imported with ?raw) and not in code:
 * no dashboard module builds an Authorization header (N50, astra A03c F1).
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLinkPage } from "../AgentLinkPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_MESSAGE = "I have equipment to put on the network. Help me get set up.";
const TABS = { claude: "Claude Quickstart", openai: "OpenAI Quickstart" } as const;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ tools: [] }), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  delete (globalThis as { __agentLinkInjected?: unknown }).__agentLinkInjected;
});

/** The script the page shows on `tab` for ?q=`q` (no ?q= when null). */
async function shownScript(tab: keyof typeof TABS, q: string | null): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const entry = q === null ? "/agent" : `/agent?q=${encodeURIComponent(q)}`;
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AgentLinkPage />
      </MemoryRouter>,
    );
  });
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === TABS[tab]);
  expect(button, `the ${TABS[tab]} tab`).toBeDefined();
  await act(async () => button!.click());
  return host.querySelector("pre")?.textContent ?? "";
}

/**
 * Run the script's last line with chat() recording its calls. The last line
 * is where ?q= lands; running it shows what the user's node would do there.
 */
function runLastLine(script: string): unknown[][] {
  const lines = script.trimEnd().split("\n");
  const calls: unknown[][] = [];
  new Function("chat", lines[lines.length - 1])((...args: unknown[]) => {
    calls.push(args);
  });
  return calls;
}

const HOSTILE = [
  // Closes the string and the call, runs its own code, then reopens both.
  'x"); globalThis.__agentLinkInjected = true; ("',
  // A newline in ?q= split the old one-line call in two.
  "first line\nsecond line",
  // $& and $1 are expanded by a string (not function) replacement.
  "costs $& and $1 and $$",
  "back\\slash and `backtick` and ${template}",
];

describe("the quickstart scripts take ?q= as data, never as code", () => {
  for (const tab of ["claude", "openai"] as const) {
    it(`${TABS[tab]}: the agent's first message is exactly ?q=, and nothing else runs`, async () => {
      for (const q of HOSTILE) {
        const script = await shownScript(tab, q);
        act(() => root?.unmount());
        host?.remove();
        let calls: unknown[][] = [];
        expect(() => {
          calls = runLastLine(script);
        }, `the script's last line parses for ?q=${JSON.stringify(q)}`).not.toThrow();
        expect(calls, `?q=${JSON.stringify(q)}`).toEqual([[q]]);
        expect((globalThis as { __agentLinkInjected?: unknown }).__agentLinkInjected).toBeUndefined();
      }
    });

    it(`${TABS[tab]}: with no ?q=, the first message is the default ask`, async () => {
      expect(runLastLine(await shownScript(tab, null))).toEqual([[DEFAULT_MESSAGE]]);
    });

    it(`${TABS[tab]}: the script still authenticates the agent with the key it provisions`, async () => {
      const script = await shownScript(tab, "FDM 3D printing");
      expect(script).toContain('if (PCC_API_KEY) headers["Authorization"] = `Bearer ${PCC_API_KEY}`;');
      expect(script).toContain('toolName === "provision_api_key" && data.api_key');
    });
  }
});
