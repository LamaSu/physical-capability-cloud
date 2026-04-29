/**
 * Tests for ApprovalSheet.
 *
 * Week 1 deliberately avoided pulling in @testing-library/react to keep the
 * dep surface minimal, so we exercise the component via ReactDOM + the
 * `data-testid` attributes attached in the JSX. Each test renders into a
 * fresh container, runs assertions against the DOM tree, then unmounts.
 *
 * The PasskeyManager is fully mocked through the `manager` prop — no real
 * WebAuthn is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ApprovalSheet,
  type ApprovalSheetProps,
  type SignedReceipt,
} from "./ApprovalSheet.js";
import type { SignResult } from "../wallet/passkey-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function fakeAssertion(): SignResult {
  return {
    signature: "SIG-AAAA",
    credentialId: "CRED-AAAA",
    authenticatorData: "AUTH-AAAA",
    clientDataJSON: "CLIENT-AAAA",
  };
}

function defaultSession(): ApprovalSheetProps["session"] {
  return {
    id: "sess-001",
    capability: "haircut",
    amountUsd: 32,
    operatorName: "Andre's Hair Salon",
    evidenceHash:
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    captureClass: "tier-1-photo",
  };
}

async function flush(): Promise<void> {
  // Allow the useEffect / state transitions to settle
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function render(props: Partial<ApprovalSheetProps> = {}): {
  approve: ReturnType<typeof vi.fn>;
  decline: ReturnType<typeof vi.fn>;
  manager: NonNullable<ApprovalSheetProps["manager"]>;
} {
  const approve = vi.fn();
  const decline = vi.fn();
  const manager = props.manager ?? {
    isAvailable: vi.fn(async () => true),
    enroll: vi.fn(async () => ({
      credentialId: "CRED-AAAA",
      publicKey: "PUB-AAAA",
    })),
    sign: vi.fn(async () => fakeAssertion()),
    getCredentialId: vi.fn(async () => "CRED-AAAA"),
  };
  act(() => {
    root.render(
      <ApprovalSheet
        session={props.session ?? defaultSession()}
        onApprove={approve as (s: SignedReceipt) => void}
        onDecline={decline}
        manager={manager}
        enrollOptions={
          props.enrollOptions ?? { userId: "u-001", displayName: "Tester" }
        }
        open={props.open ?? true}
      />,
    );
  });
  return { approve, decline, manager };
}

// ---------------------------------------------------------------------------
// 1. Renders capability + amount in plain English
// ---------------------------------------------------------------------------

describe("ApprovalSheet rendering", () => {
  it("renders capability + amount + operator in plain English", async () => {
    render();
    await flush();
    const summary = container.querySelector(
      "[data-testid='approval-summary']",
    );
    expect(summary).not.toBeNull();
    const text = summary?.textContent ?? "";
    expect(text).toContain("$32.00");
    expect(text).toContain("Andre's Hair Salon");
    expect(text).toContain("haircut");
  });

  it("renders evidence summary with capture class + short hash", async () => {
    render();
    await flush();
    const ev = container.querySelector("[data-testid='evidence-summary']");
    expect(ev).not.toBeNull();
    const t = ev?.textContent ?? "";
    expect(t).toContain("tier-1-photo");
    // Short hash format: 10 head + ellipsis + 6 tail
    expect(t).toMatch(/abcdef0123…456789/);
  });

  it("renders nothing when open=false", async () => {
    render({ open: false });
    await flush();
    expect(
      container.querySelector("[data-testid='approval-sheet']"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Calls onApprove with signed assertion when biometric succeeds
// ---------------------------------------------------------------------------

describe("ApprovalSheet approval flow", () => {
  it("calls onApprove with the signed receipt when sign succeeds", async () => {
    const { approve, manager } = render();
    await flush();
    const btn = container.querySelector(
      "[data-testid='approval-approve']",
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();
    await act(async () => {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(manager.sign).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
    const arg = approve.mock.calls[0]?.[0] as SignedReceipt;
    expect(arg.sessionId).toBe("sess-001");
    expect(arg.decision).toBe("approve");
    expect(arg.assertion.signature).toBe("SIG-AAAA");
    expect(typeof arg.signedAt).toBe("string");
    expect(arg.signedAt.length).toBeGreaterThan(10); // ISO 8601
  });

  it("calls onDecline on the decline button", async () => {
    const { decline } = render();
    await flush();
    const btn = container.querySelector(
      "[data-testid='approval-decline']",
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    expect(decline).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Shows enroll-prompt state when no credential
// ---------------------------------------------------------------------------

describe("ApprovalSheet enroll-prompt state", () => {
  it("renders the enrollment prompt when no credential is enrolled", async () => {
    const { manager } = render({
      manager: {
        isAvailable: vi.fn(async () => true),
        enroll: vi.fn(async () => ({
          credentialId: "CRED-NEW",
          publicKey: "PUB-NEW",
        })),
        sign: vi.fn(async () => fakeAssertion()),
        getCredentialId: vi.fn(async () => null),
      },
    });
    await flush();
    const prompt = container.querySelector(
      "[data-testid='approval-needs-enroll']",
    );
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent ?? "").toContain("No passkey enrolled");
    const approveBtn = container.querySelector(
      "[data-testid='approval-approve']",
    ) as HTMLButtonElement;
    expect(approveBtn.textContent).toContain("Enroll passkey");
    // Approval should still work — it enrolls then signs
    await act(async () => {
      approveBtn.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(manager.enroll).toHaveBeenCalledTimes(1);
    expect(manager.sign).toHaveBeenCalledTimes(1);
  });

  it("surfaces a friendly message when sign throws NotAllowedError", async () => {
    const cancelErr = Object.assign(new Error("user cancelled"), {
      name: "NotAllowedError",
    });
    render({
      manager: {
        isAvailable: vi.fn(async () => true),
        enroll: vi.fn(async () => ({
          credentialId: "CRED-XYZ",
          publicKey: "PUB-XYZ",
        })),
        sign: vi.fn(async () => {
          throw cancelErr;
        }),
        getCredentialId: vi.fn(async () => "CRED-XYZ"),
      },
    });
    await flush();
    const btn = container.querySelector(
      "[data-testid='approval-approve']",
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
    });
    // After the click, give all the async settling enough time:
    // challengeBytesFromPayload (subtle.digest), the failed sign, and the
    // setState of the error.
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    const errEl = container.querySelector("[data-testid='approval-error']");
    expect(errEl).not.toBeNull();
    expect(errEl?.textContent ?? "").toContain("Cancelled");
  });
});
