/** @vitest-environment jsdom */

import React, { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOnboardWizardStore } from "../../../stores/onboard-wizard-store.js";
import { apiPost } from "../../../lib/api.js";
import { Step7_Review } from "../Step7_Review.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../../lib/api.js", () => ({ apiPost: vi.fn() }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));

// Only the UI wrappers are mocked: the real Step 7 submits, handles the reply,
// and chooses the panel props. The markers expose the badge color and glow.
vi.mock("@pcc/ui", async () => {
  const { createElement } = await import("react");
  return {
    WizardStepContent: ({ children, onNext, nextLabel }: {
      children?: ReactNode;
      onNext?: () => void;
      nextLabel?: string;
    }) => createElement("div", null,
      createElement("button", { type: "button", onClick: onNext }, nextLabel),
      children,
    ),
    GlassPanel: ({ children, glow }: { children?: ReactNode; glow?: string }) =>
      createElement("section", { "data-test-panel": "yes", "data-glow": glow ?? "none" }, children),
    GlowBadge: ({ children, color = "green" }: { children?: ReactNode; color?: string }) =>
      createElement("span", { "data-test-badge": "yes", "data-color": color }, children),
  };
});

const queuedReply = {
  jobId: "job-1",
  deviceId: null,
  status: "queued",
  reason: "queue_only",
  ran: false,
  passed: false,
  duration: 12,
};

function finalReply(status: string, passed: boolean, simulated: boolean) {
  return {
    jobId: "job-1",
    deviceId: "dev-mill-1",
    status,
    ran: true,
    passed,
    simulated,
    passReason: passed
      ? null
      : simulated
        ? "simulated: a mock/simulator run is not a hardware pass (real verification is D4a)"
        : `not completed: status ${status}`,
    evidenceBundleId: null,
    duration: 12,
  };
}

// Before N59 (#450), the route's final reply had no ran, passed or simulated
// field (packages/gateway/src/routes/setup.ts:863-869 at ac86a404).
const preN59Reply = {
  jobId: "job-1",
  deviceId: "dev-mill-1",
  status: "completed",
  evidenceBundleId: null,
  duration: 12,
};

const stoppedReply = {
  error: "emergency_stop",
  message: "This machine's emergency stop is engaged, so no test job was queued.",
  ran: false,
  passed: false,
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  mounted.length = 0;
  useOnboardWizardStore.getState().reset();
  vi.clearAllMocks();
});

async function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  expect(button, `Missing user-facing button: ${label}`).toBeDefined();
  await act(async () => { button!.click(); });
}

async function throughSubmitAndTestJob(reply: unknown, reject = false) {
  await act(async () => {
    useOnboardWizardStore.getState().reset();
    useOnboardWizardStore.getState().updateIdentity({
      name: "Mill-1", manufacturer: "Example", model: "Mill",
    });
  });

  const post = vi.mocked(apiPost);
  post.mockReset();
  post.mockResolvedValueOnce({
    config: {
      kernelId: "kernel-mill-1",
      devices: [{ id: "dev-mill-1", type: "machine", adapterType: "mock", config: {} }],
      mockMode: true,
    },
    envLine: "",
    configJson: "{}",
  });
  post.mockResolvedValueOnce({
    registered: true,
    device: {
      id: "dev-mill-1", kernelId: "kernel-mill-1", type: "machine",
      model: "Example Mill", adapterType: "mock", status: "registered",
    },
  });
  post.mockResolvedValueOnce({ device: { id: "dev-mill-1" } });
  if (reject) post.mockRejectedValueOnce(new Error(stoppedReply.message));
  else post.mockResolvedValueOnce(reply);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => { root.render(React.createElement(Step7_Review)); });
  await clickButton(container, "Submit Registration");
  await clickButton(container, "Run Test Job");

  expect(post.mock.calls.map(([path]) => path)).toEqual([
    "/setup/generate-config",
    "/setup/register-device",
    "/devices/register",
    "/setup/test-job",
  ]);
  expect(post.mock.calls[3]?.[1]).toEqual({
    kernelId: "kernel-mill-1", deviceId: "dev-mill-1", assuranceTier: 0,
  });
  return container;
}

function jobPanel(container: HTMLElement) {
  const panel = Array.from(container.querySelectorAll<HTMLElement>("[data-test-panel]"))
    .find((candidate) => candidate.textContent?.includes("Job:"));
  expect(panel, "Expected a test-job result panel").toBeDefined();
  return panel!;
}

function expectResult(panel: HTMLElement, heading: string, status: string,
  color: "green" | "gray" | "gold", checked: boolean) {
  const badge = panel.querySelector<HTMLElement>("[data-test-badge]");
  expect(panel.textContent).toContain(heading);
  expect(badge?.textContent).toBe(status);
  expect(badge?.getAttribute("data-color")).toBe(color);
  expect(panel.getAttribute("data-glow")).toBe(checked ? "green" : "none");
  expect(panel.textContent?.includes("\u2713")).toBe(checked);
  if (!checked) expect(panel.textContent).not.toContain("Test job completed");
  expect(panel.textContent).toContain("Job: job-1...");
  expect(panel.textContent).toContain("Duration: 12ms");
}

describe("Step7_Review test-job result", () => {
  it("a real queued 200 says queued, uses gray, and never claims completion", async () => {
    const container = await throughSubmitAndTestJob(queuedReply);
    const panel = jobPanel(container);
    expectResult(panel, "Test job queued", "queued", "gray", false);
    expect(panel.textContent).not.toContain(queuedReply.reason);
  });

  it("completed and passed is green, but a simulated completion is not", async () => {
    const passed = finalReply("completed", true, false);
    const passedContainer = await throughSubmitAndTestJob(passed);
    const passedPanel = jobPanel(passedContainer);
    expectResult(passedPanel, "Test job completed", "completed", "green", true);
    expect(passedPanel.textContent).not.toContain("No pass confirmed");

    // Pair with a negative control so this case also fails against the base,
    // where any 2xx incorrectly received the green success presentation.
    const simulatedContainer = await throughSubmitAndTestJob(finalReply("completed", false, true));
    expectResult(jobPanel(simulatedContainer), "No pass confirmed", "completed", "gold", false);
  });

  it.each([
    ["failed", "failed", false],
    ["completed but simulated", "completed", true],
    ["timeout with running status", "running", false],
    ["unknown", "unknown", false],
  ] as const)("%s reports no confirmed pass, no check, and no server reason", async (_name, status, simulated) => {
    const reply = finalReply(status, false, simulated);
    const container = await throughSubmitAndTestJob(reply);
    const panel = jobPanel(container);
    expectResult(panel, "No pass confirmed", status, "gold", false);
    expect(panel.textContent).not.toContain(reply.passReason);
  });

  it("a completed reply with no passed field (a gateway older than N59) reports no confirmed pass", async () => {
    const container = await throughSubmitAndTestJob(preN59Reply);
    expectResult(jobPanel(container), "No pass confirmed", "completed", "gold", false);
  });

  it("a 409 emergency stop keeps the existing thrown-error panel and message", async () => {
    // apiPost throws the HTTP body's `message` on non-2xx responses.
    const container = await throughSubmitAndTestJob(stoppedReply, true);
    expect(container.textContent).toContain("Test job failed");
    expect(container.textContent).toContain(stoppedReply.message);
    expect(container.textContent).not.toContain("Test job completed");
    expect(container.textContent).not.toContain("No pass confirmed");
    expect(Array.from(container.querySelectorAll("[data-test-panel]"))
      .some((panel) => panel.textContent?.includes("Job:"))).toBe(false);

    // The error presentation already worked on base. Include a queued
    // negative control so this entire new test is red against that base.
    const queuedContainer = await throughSubmitAndTestJob(queuedReply);
    expectResult(jobPanel(queuedContainer), "Test job queued", "queued", "gray", false);
  });
});
