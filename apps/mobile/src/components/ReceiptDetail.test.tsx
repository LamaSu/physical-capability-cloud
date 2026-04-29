/**
 * Tests for ReceiptDetail.
 *
 * Mirrors the dependency-light pattern from ApprovalSheet.test: ReactDOM +
 * createRoot + data-testid queries, no @testing-library/react. The fetch
 * call is mocked via the `fetchImpl` prop and the verification primitives
 * are mocked via `verifiers` so we don't need a real signed receipt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReceiptDetail, type ReceiptApiResponse } from "./ReceiptDetail.js";
import type {
  SignedReceipt,
  MerkleProof,
} from "@pcc/transparency-log";

// ── Setup ─────────────────────────────────────────────────────────────

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

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

function fakeSignedReceipt(): SignedReceipt {
  return {
    payload: {
      milestoneId: "sess-w4-001",
      capability: "haircut",
      actorsHashed: {
        user: "aa".repeat(32),
        operator: "bb".repeat(32),
      },
      amountCents: 3200,
      evidenceHash: "cc".repeat(32),
      timestamp: "2026-04-27T12:00:00Z",
      settlementMode: "centralized",
    },
    signature: "ab".repeat(64),
    signerPublicKey: "ef".repeat(32),
  };
}

function fakeMerkleProof(): MerkleProof {
  return {
    index: 0,
    treeSize: 1,
    leafHash: "ff".repeat(32),
    siblings: [],
    root: "ff".repeat(32),
  };
}

function fakeReceiptResponse(
  overrides: Partial<ReceiptApiResponse> = {},
): ReceiptApiResponse {
  return {
    signedReceipt: fakeSignedReceipt(),
    leafJson: JSON.stringify(fakeSignedReceipt()),
    merklePath: fakeMerkleProof(),
    serverPublicKey: "ef".repeat(32),
    leafIndex: 0,
    settledAt: "2026-04-27T12:00:01Z",
    ...overrides,
  };
}

function makeFetch(
  response: ReceiptApiResponse | { ok: false; status: number },
): typeof globalThis.fetch {
  return vi.fn(async () => {
    if ("ok" in response && response.ok === false) {
      return {
        ok: false,
        status: response.status,
        json: async () => ({ error: "fail" }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => response as ReceiptApiResponse,
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

function passingVerifiers(): {
  verifyReceipt: (s: SignedReceipt, p?: string) => boolean;
  verifyProof: (l: string | Uint8Array, p: MerkleProof, r: string) => boolean;
} {
  return {
    verifyReceipt: vi.fn(() => true),
    verifyProof: vi.fn(() => true),
  };
}

function render(
  receiptId: string,
  fetchImpl: typeof globalThis.fetch,
  verifiers: ReturnType<typeof passingVerifiers> = passingVerifiers(),
): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  act(() => {
    root.render(
      <ReceiptDetail
        receiptId={receiptId}
        onClose={close}
        fetchImpl={fetchImpl}
        verifiers={verifiers}
      />,
    );
  });
  return { close };
}

// ── 1. Renders capability + amount in plain language ──────────────────

describe("ReceiptDetail rendering", () => {
  it("renders capability + amount in plain language when loaded", async () => {
    const fetchImpl = makeFetch(fakeReceiptResponse());
    render("sess-w4-001", fetchImpl);
    await flush();

    const summary = container.querySelector("[data-testid='receipt-summary']");
    expect(summary).not.toBeNull();
    const text = summary?.textContent ?? "";
    expect(text).toContain("$32.00");
    expect(text).toContain("haircut");
    expect(text).toContain("centralized");
  });

  it("renders the receipt id in the header (truncated)", async () => {
    const fetchImpl = makeFetch(fakeReceiptResponse());
    render("very-long-receipt-id-1234567890", fetchImpl);
    await flush();

    const title = container.querySelector("[data-testid='receipt-title']");
    expect(title).not.toBeNull();
    // shortId chops to 6 head + 4 tail
    expect(title?.textContent).toContain("very-l");
    expect(title?.textContent).toContain("7890");
  });
});

// ── 2. Verification PASS / FAIL ───────────────────────────────────────

describe("ReceiptDetail verification states", () => {
  it("shows PASS state when both verifiers return true", async () => {
    const fetchImpl = makeFetch(fakeReceiptResponse());
    render("sess-w4-pass", fetchImpl);
    await flush();

    const sig = container.querySelector(
      "[data-testid='receipt-verify-signature']",
    );
    const merkle = container.querySelector(
      "[data-testid='receipt-verify-merkle']",
    );
    expect(sig?.getAttribute("data-status")).toBe("pass");
    expect(merkle?.getAttribute("data-status")).toBe("pass");
    expect(sig?.textContent).toContain("Signature valid");
    expect(merkle?.textContent).toContain("Merkle proof valid");
  });

  it("shows FAIL state when verifyProof returns false", async () => {
    const fetchImpl = makeFetch(fakeReceiptResponse());
    const verifiers = {
      verifyReceipt: vi.fn(() => true),
      verifyProof: vi.fn(() => false),
    };
    render("sess-w4-bad-proof", fetchImpl, verifiers);
    await flush();

    const sig = container.querySelector(
      "[data-testid='receipt-verify-signature']",
    );
    const merkle = container.querySelector(
      "[data-testid='receipt-verify-merkle']",
    );
    expect(sig?.getAttribute("data-status")).toBe("pass");
    expect(merkle?.getAttribute("data-status")).toBe("fail");
    expect(merkle?.textContent).toContain("Merkle proof invalid");
  });

  it("shows FAIL state when verifyReceipt returns false", async () => {
    const fetchImpl = makeFetch(fakeReceiptResponse());
    const verifiers = {
      verifyReceipt: vi.fn(() => false),
      verifyProof: vi.fn(() => true),
    };
    render("sess-w4-bad-sig", fetchImpl, verifiers);
    await flush();

    const sig = container.querySelector(
      "[data-testid='receipt-verify-signature']",
    );
    expect(sig?.getAttribute("data-status")).toBe("fail");
    expect(sig?.textContent).toContain("Signature invalid");
  });
});

// ── 3. Anchoring pending vs anchor link ───────────────────────────────

describe("ReceiptDetail anchor handling", () => {
  it("renders 'Anchoring pending' when no anchorTxHash is present", async () => {
    const fetchImpl = makeFetch(fakeReceiptResponse());
    render("sess-w4-no-anchor", fetchImpl);
    await flush();

    const pending = container.querySelector(
      "[data-testid='receipt-anchor-pending']",
    );
    expect(pending).not.toBeNull();
    expect(pending?.textContent ?? "").toContain("Anchoring pending");
    expect(
      container.querySelector("[data-testid='receipt-anchor-link']"),
    ).toBeNull();
  });

  it("renders a BaseScan link when anchorTxHash is present", async () => {
    const txHash =
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const fetchImpl = makeFetch(
      fakeReceiptResponse({ anchorTxHash: txHash }),
    );
    render("sess-w4-anchored", fetchImpl);
    await flush();

    const link = container.querySelector(
      "[data-testid='receipt-anchor-link']",
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(
      `https://sepolia.basescan.org/tx/${txHash}`,
    );
    expect(
      container.querySelector("[data-testid='receipt-anchor-pending']"),
    ).toBeNull();
  });
});

// ── 4. Error state when fetch fails ───────────────────────────────────

describe("ReceiptDetail error handling", () => {
  it("shows an error panel when the fetch returns non-ok", async () => {
    const fetchImpl = makeFetch({ ok: false, status: 404 });
    render("sess-w4-missing", fetchImpl);
    await flush();

    const err = container.querySelector("[data-testid='receipt-error']");
    expect(err).not.toBeNull();
    expect(err?.textContent ?? "").toContain("404");
  });
});
