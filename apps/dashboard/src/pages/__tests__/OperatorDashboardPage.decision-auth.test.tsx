// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));
vi.mock("../../components/inbox/InboxPanel.js", () => ({ InboxPanel: () => null }));

import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { setStoredApiKey } from "../../lib/authorized-fetch.js";
import { useAuthStore } from "../../stores/auth-store.js";
import { useOperatorStore } from "../../stores/operator-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIONS = ["resume", "approve", "reject"] as const;
type Action = typeof ACTIONS[number];
const KEY_STATES = ["key held", "no key held"] as const;
type KeyState = typeof KEY_STATES[number];
const MACHINE_ID = "decision-printer";
const MACHINE_NAME = "North printer";
const APPROVAL_ID = "pending-decision";
const SIGN_IN_AGAIN = "Sign in again to enable operator actions.";
const FRESH_SIGN_IN_CODE = "explicit_credential_required";
const RESUME_REFUSED = "Resume was refused for this key. Resuming needs a PCC admin, or proof that you control North printer's operator wallet; a wallet sign-in isn't that proof yet. Ask a PCC admin to resume it, or, if you operate North printer, resume through the API with a PCC-issued key and its self-linked operator wallet (X-PCC-Wallet header).";
const UNTRUSTED = "<strong>Untrusted response details</strong>";
const STOPPED = `EMERGENCY STOP ACTIVE for ${MACHINE_NAME}`;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalOperator: ReturnType<typeof useOperatorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const REFUSALS = [
  { kind: "another error", response: () => json({ error: "operator_access_refused", message: UNTRUSTED }, 403) },
  { kind: "a non-JSON body", response: () => new Response(UNTRUSTED, { status: 403 }) },
  { kind: "a near-match code", response: () => json({ error: `${FRESH_SIGN_IN_CODE}_extra`, message: UNTRUSTED }, 403) },
] as const;

function freshSignInRefusal(): Response {
  return json({ error: FRESH_SIGN_IN_CODE, message: UNTRUSTED }, 403);
}

beforeEach(() => {
  originalAuth = useAuthStore.getState();
  originalOperator = useOperatorStore.getState();
  originalUI = useUIStore.getState();
  setStoredApiKey(null);
  authorizedFetch.mockReset();
  authorizedFetch.mockImplementation(async (path: string) => {
    if (path === "/api/agent/me") return json({
      ok: true,
      kernels: { count: 1, items: [{ id: MACHINE_ID, name: MACHINE_NAME, status: "online", last_heartbeat: null }] },
    });
    if (path === "/api/operator/approvals?status=pending") return json({ approvals: [{
      id: APPROVAL_ID,
      agentId: "agent-a",
      capabilityType: "fdm",
      estimatedCost: 2,
      submittedAt: "2026-10-16T10:00:00.000Z",
      status: "pending",
    }] });
    if (path === "/api/operator/emergency-stop") return json({ stopped: true, kernelId: MACHINE_ID });
    throw new Error("Unexpected request");
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  setStoredApiKey(null);
  useAuthStore.setState(originalAuth);
  useOperatorStore.setState(originalOperator);
  useUIStore.setState(originalUI);
  vi.restoreAllMocks();
});

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}

function actionLabel(action: Action): string {
  return action === "resume" ? `Resume Operations: ${MACHINE_NAME}` : action === "approve" ? "Approve" : "Reject";
}

async function click(action: Action) {
  const target = button(actionLabel(action));
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

async function renderPage(action: Action, keyState: KeyState) {
  act(() => root.unmount());
  client.clear();
  root = createRoot(container);
  setStoredApiKey(keyState === "key held" ? "test-pasted-key" : null);
  useAuthStore.setState({ sessionKeyId: null });
  useOperatorStore.setState({ activeTab: action === "resume" ? "overview" : "approvals" });
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  if (action === "resume") {
    await act(async () => button(`EMERGENCY STOP: ${MACHINE_NAME}`).click());
    expect(container.textContent).toContain(STOPPED);
  }
  authorizedFetch.mockClear();
}

function expectNoResponseDetails() {
  expect(container.textContent).not.toContain(UNTRUSTED);
  expect(container.textContent).not.toContain("Untrusted response details");
}

function expectSignInAgain(action: Action) {
  if (action === "resume") {
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SIGN_IN_AGAIN);
    expect(container.textContent).toContain(STOPPED);
  } else {
    expect(container.textContent).toContain(`Error: ${SIGN_IN_AGAIN}`);
    expect(container.textContent).not.toContain("No pending approvals.");
    expect(container.textContent).toContain("agent-a");
    expect(button("Approve").disabled).toBe(false);
    expect(button("Reject").disabled).toBe(false);
  }
  expect(button(actionLabel(action)).disabled).toBe(false);
  expectNoResponseDetails();
}

function expectApprovedResult(action: Action) {
  if (action === "resume") {
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(RESUME_REFUSED);
    expect(container.textContent).toContain(STOPPED);
    expect(button(actionLabel(action)).disabled).toBe(false);
  } else {
    expect([...container.querySelectorAll("button")].some((element) => element.textContent === actionLabel(action))).toBe(false);
    expect(container.textContent).toContain("No pending approvals.");
    expect(container.textContent).not.toContain("agent-a");
    expect(container.textContent).not.toContain("Error:");
  }
  expect(container.textContent).not.toContain(SIGN_IN_AGAIN);
  expectNoResponseDetails();
}

function expectDecisionRequest(action: Action) {
  expect(authorizedFetch).toHaveBeenCalledTimes(1);
  expect(authorizedFetch).toHaveBeenCalledWith(
    action === "resume" ? "/api/operator/emergency-resume" : `/api/operator/approvals/${APPROVAL_ID}/${action}`,
    action === "resume" ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kernelId: MACHINE_ID }),
    } : { method: "POST" },
  );
}

describe("OperatorDashboardPage decision sign-in notices", () => {
  for (const action of ACTIONS) {
    for (const keyState of KEY_STATES) {
      it(`${action} / ${keyState} / exact code asks for a fresh sign-in and preserves state`, async () => {
        await renderPage(action, keyState);
        authorizedFetch.mockResolvedValueOnce(freshSignInRefusal());
        await click(action);
        expectDecisionRequest(action);
        expectSignInAgain(action);
      });

      for (const refusal of REFUSALS) {
        it(`${action} / ${keyState} / ${refusal.kind} keeps the approved result before an exact code`, async () => {
          await renderPage(action, keyState);
          authorizedFetch.mockResolvedValueOnce(refusal.response());
          await click(action);
          expectDecisionRequest(action);
          expectApprovedResult(action);

          await renderPage(action, keyState);
          authorizedFetch.mockResolvedValueOnce(freshSignInRefusal());
          await click(action);
          expectDecisionRequest(action);
          expectSignInAgain(action);
        });
      }
    }
  }
});
