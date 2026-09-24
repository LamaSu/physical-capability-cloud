/**
 * The chat's client half of gateway WP-D (#381):
 * - /agent runs as the signed-in user: its requests carry the key, and only
 *   to the configured gateway. Public /onboard/chat sends no key.
 * - A write the gateway holds is shown with its summary and whose credential
 *   it would mint (bindsTo). Nothing runs until the person presses Confirm,
 *   which sends one confirmActionId, once. The outcome shown is the gateway's.
 * - A credential the gateway reveals is shown once, with whose it is, and is
 *   never written to storage.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/auth-store.js";
import { OnboardChatPage } from "../OnboardChatPage.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "pcc_test_signedin0123456789abcdef";
const FRESH = "pcc_test_freshly0minted0key0abcdef";
const LATER = new Date(Date.now() + 10 * 60_000).toISOString();

interface Sent {
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

let sent: Sent[];
let replies: Array<{ status: number; body: unknown }>;
let container: HTMLDivElement;
let root: Root;

const HELD = {
  actionId: "act-1",
  tool: "provision_api_key",
  method: "POST",
  target: "/api/auth/provision",
  args: { email: "maker@example.com" },
  summary: "Creates a new PCC credential bound to maker@example.com. Provision an API key.",
  bindsTo: "maker@example.com",
  expiresAt: LATER,
};

function reply(body: Record<string, unknown>, status = 200) {
  replies.push({ status, body: { conversationId: "conv-1", assistant: "", toolCalls: [], done: false, ...body } });
}

beforeEach(() => {
  sent = [];
  replies = [];
  useAuthStore.setState({ apiKey: KEY, isAuthenticated: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/onboard/chat/health")) {
        return new Response(JSON.stringify({ hasApiKey: true, hasSdk: true, agentPackageStatus: { loaded: true } }));
      }
      sent.push({
        url,
        authorization: new Headers(init?.headers).get("Authorization"),
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      const next = replies.shift() ?? { status: 200, body: { conversationId: "conv-1", assistant: "ok", toolCalls: [], done: false } };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAuthStore.setState({ apiKey: null, isAuthenticated: false });
});

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

async function render(variant: "agent" | "onboard") {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <OnboardChatPage variant={variant} />
      </MemoryRouter>,
    );
  });
  await flush();
}

async function say(text: string) {
  const input = container.querySelector('input[aria-label="Chat message"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

const text = () => container.textContent ?? "";

describe("who the chat runs as", () => {
  it("/agent sends the signed-in key, to the gateway only", async () => {
    await render("agent");
    await say("What jobs do I have?");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("/api/onboard/chat");
    expect(sent[0]!.authorization).toBe(`Bearer ${KEY}`);
  });

  it("public onboarding sends no key, even when someone is signed in", async () => {
    await render("onboard");
    await say("I run a print shop");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.authorization).toBeNull();
  });
});

describe("held actions", () => {
  it("shows what would run and whose credential it mints, and runs nothing until Confirm", async () => {
    reply({ assistant: "I can create your key.", pendingActions: [HELD] });
    await render("agent");
    await say("Make me an API key");
    expect(text()).toContain("Waiting for your confirmation");
    expect(text()).toContain(HELD.summary);
    expect(text()).toContain("This creates a credential for maker@example.com.");
    expect(text()).toContain("POST /api/auth/provision");
    expect(sent).toHaveLength(1); // only the message itself
    expect(sent[0]!.body).not.toHaveProperty("confirmActionId");
  });

  it("Confirm sends the action id once, and shows the gateway's outcome", async () => {
    reply({ assistant: "I can create your key.", pendingActions: [HELD] });
    reply({ assistant: "Done.", confirmedAction: { actionId: "act-1", tool: "provision_api_key", status: 201 } });
    await render("agent");
    await say("Make me an API key");
    const confirm = button("Confirm")!;
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await flush();
    const confirms = sent.filter((s) => s.body && "confirmActionId" in s.body);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.body).toEqual({ conversationId: "conv-1", confirmActionId: "act-1" });
    expect(confirms[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(text()).toContain("Done: the gateway ran provision_api_key and it answered 201.");
    expect(button("Confirm")).toBeUndefined();
  });

  it("a refused confirmation says why and claims nothing ran", async () => {
    reply({ assistant: "I can create your key.", pendingActions: [HELD] });
    reply({ error: "action_not_found", message: "That action expired or was already used." }, 404);
    await render("agent");
    await say("Make me an API key");
    await act(async () => button("Confirm")!.click());
    await flush();
    expect(text()).toContain("Not run: That action expired or was already used.");
    expect(text()).not.toContain("Done:");
  });

  it("a reply that doesn't say whether it ran is not shown as done", async () => {
    reply({ assistant: "I can create your key.", pendingActions: [HELD] });
    reply({ assistant: "Hmm." });
    await render("agent");
    await say("Make me an API key");
    await act(async () => button("Confirm")!.click());
    await flush();
    expect(text()).toContain("without saying whether it ran");
    expect(text()).not.toContain("Done:");
  });

  it("an expired action offers no Confirm", async () => {
    reply({ assistant: "I can create your key.", pendingActions: [{ ...HELD, expiresAt: new Date(Date.now() - 1000).toISOString() }] });
    await render("agent");
    await say("Make me an API key");
    expect(text()).toContain("Expired without running.");
    expect(button("Confirm")).toBeUndefined();
  });
});

describe("revealed secrets", () => {
  it("shows a new credential once, with whose it is, and never stores it", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    reply({ assistant: "I can create your key.", pendingActions: [HELD] });
    reply({
      assistant: "Your key is ready.",
      confirmedAction: { actionId: "act-1", tool: "provision_api_key", status: 201 },
      revealedSecrets: [{ tool: "provision_api_key", path: "api_key", value: FRESH, boundTo: "maker@example.com" }],
    });
    await render("onboard");
    await say("Make me an API key");
    await act(async () => button("Confirm")!.click());
    await flush();
    const panel = container.querySelector("[data-revealed-secret]");
    expect(panel?.textContent).toContain(FRESH);
    expect(panel?.textContent).toContain("for maker@example.com");
    expect(panel?.textContent).toContain("shown once");
    const stored = setItem.mock.calls.filter(([, v]) => String(v).includes(FRESH));
    expect(stored).toEqual([]);
  });
});
