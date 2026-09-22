/**
 * Renders Step7_Review for real (react-dom/client + act in jsdom, as in
 * usePointMap3DPlayback.test.ts) and drives the Submit button against a mocked
 * gateway. register-machine.test.ts proves the orchestrator's outcomes; this
 * proves what the operator actually SEES for each outcome — above all that an
 * unreachable gateway never renders "Machine Registered".
 *
 * @pcc/ui is replaced by minimal stand-ins that keep the props contract, so
 * the test exercises Step7's own branching and copy, not the design system.
 *
 * @vitest-environment jsdom
 */

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiPost } from "../../../lib/api.js";
import { useOnboardWizardStore } from "../../../stores/onboard-wizard-store.js";
import { Step7_Review } from "../Step7_Review.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

vi.mock("../../../lib/api.js", () => ({
  apiPost: vi.fn(),
}));

vi.mock("@pcc/ui", async () => {
  const React = await import("react");

  return {
    WizardStepContent: ({
      title,
      subtitle,
      children,
      onBack,
      onNext,
      nextLabel = "Continue",
      backLabel = "Back",
      nextDisabled,
      className,
    }: {
      title: string;
      subtitle?: string;
      children: ReactNode;
      onBack?: () => void;
      onNext?: () => void;
      nextLabel?: string;
      backLabel?: string;
      nextDisabled?: boolean;
      className?: string;
    }) =>
      React.createElement(
        "section",
        { className },
        React.createElement("h1", null, title),
        subtitle ? React.createElement("p", null, subtitle) : null,
        children,
        onBack
          ? React.createElement(
              "button",
              { type: "button", onClick: onBack },
              backLabel,
            )
          : null,
        onNext
          ? React.createElement(
              "button",
              { type: "button", onClick: onNext, disabled: nextDisabled },
              nextLabel,
            )
          : null,
      ),
    GlassPanel: ({
      children,
      className,
    }: {
      padding?: unknown;
      glow?: unknown;
      className?: string;
      children: ReactNode;
    }) => React.createElement("div", { className }, children),
    GlowBadge: ({
      children,
    }: {
      color: unknown;
      children: ReactNode;
    }) => React.createElement("span", null, children),
  };
});

const registrationPaths = [
  "/setup/generate-config",
  "/setup/register-device",
  "/devices/register",
];

function mockReachableGateway(outcome: "rejected" | "confirmed"): void {
  vi.mocked(apiPost).mockImplementation(
    async <T,>(path: string): Promise<T> => {
      switch (path) {
        case "/setup/generate-config":
          return {
            config: {
              kernelId: "kernel_srv",
              devices: [
                {
                  id: "dev_srv",
                  type: "machine",
                  adapterType: "mock",
                  config: {},
                },
              ],
            },
            envLine: "",
            configJson: "{}",
          } as T;
        case "/setup/register-device":
          if (outcome === "rejected") {
            throw new Error("kernel_not_found");
          }

          return {
            registered: true,
            device: {
              id: "dev_confirmed",
              kernelId: "kernel_srv",
              type: "machine",
              model: "Acme M1",
              adapterType: "mock",
              status: "idle",
            },
          } as T;
        case "/devices/register":
          throw new Error("Kernel 'kernel_srv' not found");
        default:
          throw new Error(`Unexpected apiPost path: ${path}`);
      }
    },
  );
}

function apiPaths(): string[] {
  return vi.mocked(apiPost).mock.calls.map(([path]) => path);
}

describe("Step7_Review registration rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.mocked(apiPost).mockReset();
    navigate.mockReset();
    useOnboardWizardStore.getState().reset();
    useOnboardWizardStore.getState().updateIdentity({
      name: "Precision Mill 01",
      manufacturer: "Acme",
      model: "M1",
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<Step7_Review />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.mocked(apiPost).mockReset();
  });

  function findButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === label,
    );
  }

  async function clickButton(label: string): Promise<void> {
    const button = findButton(label);
    if (!button) {
      throw new Error(`Expected a "${label}" button.`);
    }
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  // REGRESSION: an unreachable gateway must never render registration success.
  it("shows unconfirmed registration when every gateway request fails to fetch", async () => {
    vi.mocked(apiPost).mockRejectedValue(new TypeError("Failed to fetch"));

    await clickButton("Submit Registration");

    expect(apiPaths()).toEqual(registrationPaths);
    expect(container.textContent).not.toContain("Machine Registered");
    expect(container.textContent).toContain("Registration Not Confirmed");
    expect(findButton("Run Test Job")).toBeUndefined();
    expect(findButton("Go to Operator Dashboard")).toBeUndefined();
  });

  it("explains the missing kernel when the reachable gateway rejects registration", async () => {
    mockReachableGateway("rejected");

    await clickButton("Submit Registration");

    expect(apiPaths()).toEqual(registrationPaths);
    expect(container.textContent).not.toContain("Machine Registered");

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Registration failed");
    expect(alert?.textContent).toContain("kernel_not_found");
    expect(alert?.textContent).toContain(
      "The gateway has no registered site (kernel) for this machine yet, so the device could not be attached and nothing was registered.",
    );
    expect(findButton("Retry")).toBeDefined();
    expect(findButton("Reset")).toBeDefined();
    expect(findButton("Run Test Job")).toBeUndefined();
    expect(findButton("Go to Operator Dashboard")).toBeUndefined();
  });

  // Positive control: the same rendering harness must detect confirmed success.
  it("shows registration success after the gateway confirms the device", async () => {
    mockReachableGateway("confirmed");

    await clickButton("Submit Registration");

    expect(apiPaths()).toEqual([
      "/setup/generate-config",
      "/setup/register-device",
    ]);
    expect(container.textContent).toContain("Machine Registered");
    expect(container.textContent).toContain("dev_confirmed");
    expect(findButton("Run Test Job")).toBeDefined();
  });

  it("submits again from Try Again and stays unconfirmed while the gateway is unreachable", async () => {
    vi.mocked(apiPost).mockRejectedValue(new TypeError("Failed to fetch"));

    await clickButton("Submit Registration");

    expect(apiPaths()).toEqual(registrationPaths);
    expect(container.textContent).toContain("Registration Not Confirmed");
    expect(container.textContent).not.toContain("Machine Registered");

    await clickButton("Try Again");

    expect(apiPost).toHaveBeenCalledTimes(6);
    expect(apiPaths()).toEqual([
      ...registrationPaths,
      ...registrationPaths,
    ]);
    expect(container.textContent).toContain("Registration Not Confirmed");
    expect(container.textContent).not.toContain("Machine Registered");
    expect(findButton("Try Again")).toBeDefined();
    expect(findButton("Run Test Job")).toBeUndefined();
    expect(findButton("Go to Operator Dashboard")).toBeUndefined();
  });
});
