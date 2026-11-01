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

const MACHINE_ID = "decision-lathe";
const MACHINE_NAME = "North lathe";
const APPROVAL_ID = "pending-decision";
const SIGN_IN_AGAIN = "Sign in again to enable operator actions.";
const FRESH_SIGN_IN_CODE = "explicit_credential_required";
const UNTRUSTED = "<strong>Untrusted response details</strong>";
const STOPPED = `EMERGENCY STOP ACTIVE for ${MACHINE_NAME}`;
const RESUME_UNCONFIRMED = `Resume wasn't confirmed. ${MACHINE_NAME} may still be stopped, or the resume may have gone through: treat the machine as live, and press Resume Operations again to confirm.`;
type Decision = "approve" | "reject";

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalOperator: ReturnType<typeof useOperatorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function explicitCredentialResponse(status: number): Response {
  return json({ error: FRESH_SIGN_IN_CODE, message: UNTRUSTED }, status);
}

beforeEach(() => {
  vi.useFakeTimers();
  originalAuth = useAuthStore.getState();
  originalOperator = useOperatorStore.getState();
  originalUI = useUIStore.getState();
  setStoredApiKey("decision-pasted-key");
  useAuthStore.setState({ address: null, sessionKeyId: null, sessionToken: null });
  useOperatorStore.setState({ activeTab: "overview" });
  authorizedFetch.mockReset();
  authorizedFetch.mockImplementation(async (path: string) => {
    if (path === "/api/agent/me") return json({
      ok: true,
      identity: { operator: "operator-a" },
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
    throw new Error(`Unexpected request: ${path}`);
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
  vi.useRealTimers();
});

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}

async function click(label: string) {
  const target = button(label);
  expect(target.disabled).toBe(false);
  await act(async () => target.click());
}

async function renderPage() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function showApprovals() {
  await act(async () => useOperatorStore.setState({ activeTab: "approvals" }));
  expect(container.textContent).toContain("agent-a");
}

function label(action: Decision) {
  return action === "approve" ? "Approve" : "Reject";
}

function expectNoResponseDetails() {
  expect(container.textContent).not.toContain(UNTRUSTED);
  expect(container.textContent).not.toContain("Untrusted response details");
}

async function requireSignInAcrossPoll(action: Decision) {
  authorizedFetch.mockResolvedValueOnce(explicitCredentialResponse(403));
  await click(label(action));
  expect(container.textContent).toContain(`Error: ${SIGN_IN_AGAIN}`);
  expect(container.textContent).toContain("agent-a");
  const pollsBefore = authorizedFetch.mock.calls.filter(([path]) => path === "/api/operator/approvals?status=pending").length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  const pollsAfter = authorizedFetch.mock.calls.filter(([path]) => path === "/api/operator/approvals?status=pending").length;
  expect(pollsAfter).toBe(pollsBefore + 1);
  expect(container.textContent).toContain(`Error: ${SIGN_IN_AGAIN}`);
  expect(container.textContent).toContain("agent-a");
  expect(button("Approve").disabled).toBe(false);
  expect(button("Reject").disabled).toBe(false);
  expectNoResponseDetails();
}

describe("OperatorDashboardPage decision notice persistence", () => {
  for (const status of [401, 500]) {
    it(`resume ${status} with the exact code keeps its status-specific result before a decision notice survives polling`, async () => {
      await renderPage();
      await click(`EMERGENCY STOP: ${MACHINE_NAME}`);
      expect(container.textContent).toContain(STOPPED);
      authorizedFetch.mockResolvedValueOnce(explicitCredentialResponse(status));
      await click(`Resume Operations: ${MACHINE_NAME}`);
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(status === 401
        ? `Sign in to resume ${MACHINE_NAME}.`
        : RESUME_UNCONFIRMED);
      expect(container.textContent).toContain(STOPPED);
      expect(container.textContent).not.toContain(SIGN_IN_AGAIN);
      expectNoResponseDetails();
      await showApprovals();
      await requireSignInAcrossPoll("approve");
    });
  }

  for (const action of ["approve", "reject"] as const) {
    for (const status of [401, 500]) {
      it(`${action} ${status} with the exact code keeps today's decision result before a later sign-in notice survives polling`, async () => {
        await renderPage();
        await showApprovals();
        authorizedFetch.mockResolvedValueOnce(explicitCredentialResponse(status));
        await click(label(action));
        expect(container.textContent).toContain("No pending approvals.");
        expect(container.textContent).not.toContain("agent-a");
        expect(container.textContent).not.toContain(SIGN_IN_AGAIN);
        expectNoResponseDetails();
        // The next poll returns a pending decision, as the current response rule allows.
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(container.textContent).toContain("agent-a");
        await requireSignInAcrossPoll(action);
        authorizedFetch.mockResolvedValueOnce(explicitCredentialResponse(status));
        await click(label(action));
        expect(container.textContent).not.toContain("agent-a");
        expect(container.textContent).toContain(`Error: ${SIGN_IN_AGAIN}`);
        expectNoResponseDetails();
      });
    }

    it(`${action} sign-in notice survives a poll and clears on a successful decision`, async () => {
      await renderPage();
      await showApprovals();
      await requireSignInAcrossPoll(action);
      authorizedFetch.mockRejectedValueOnce(new Error("Temporary connection failure"));
      await click(label(action));
      expect(container.textContent).toContain(`Error: ${SIGN_IN_AGAIN}`);
      expect(container.textContent).toContain("agent-a");
      authorizedFetch.mockResolvedValueOnce(json({ ok: true }));
      await click(label(action));
      expect(container.textContent).not.toContain(SIGN_IN_AGAIN);
      expect(container.textContent).toContain("No pending approvals.");
      expect(container.textContent).not.toContain("agent-a");
    });

    it(`${action} sign-in notice survives a poll and clears on a different principal`, async () => {
      await renderPage();
      await showApprovals();
      await requireSignInAcrossPoll(action);
      let finishPreviousDecision!: (response: Response) => void;
      authorizedFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishPreviousDecision = resolve;
      }));
      await click(label(action));
      await act(async () => setStoredApiKey("another-principal-key"));
      expect(container.textContent).not.toContain(SIGN_IN_AGAIN);
      authorizedFetch.mockResolvedValueOnce(explicitCredentialResponse(403));
      await click(label(action));
      expect(container.textContent).toContain(`Error: ${SIGN_IN_AGAIN}`);
      await act(async () => finishPreviousDecision(explicitCredentialResponse(403)));
      expect(container.textContent).toContain(`Error: ${SIGN_IN_AGAIN}`);
      expectNoResponseDetails();
    });
  }
});
