/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptApiKey, useAuthStore } from "../../stores/auth-store.js";
import { decideWalletLink, getWalletLinkRequest } from "../wallet-link-api.js";

// Build the test key at runtime, as the existing gateway-boundary tests do.
const KEY = ["pcc", "test", "walletlink0123456789abcdef"].join("_");
const REQUEST_ID = "wallet-link-request-api-test";
const USER_CODE = "WDJBMJHT";
const CONSENT_HASH = "a".repeat(64);
const fetchMock = vi.fn<[input: RequestInfo | URL, init?: RequestInit], Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  adoptApiKey(KEY);
});

afterEach(() => {
  useAuthStore.getState().logout();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("wallet-link API credential isolation through real authorizedFetch", () => {
  it.each(["lookup", "approve", "deny"] as const)("sends the Bearer key with cookies omitted for %s", async (operation) => {
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    const body = operation === "lookup"
      ? {
        requestId: REQUEST_ID,
        consent: { version: "wallet-link-v1", sha256: CONSENT_HASH, text: "Approve this wallet link." },
      }
      : operation === "approve"
        ? { status: "approved", linkId: "wallet-link-api-test" }
        : { status: "denied" };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));

    if (operation === "lookup") {
      await getWalletLinkRequest(USER_CODE);
    } else {
      await decideWalletLink(REQUEST_ID, USER_CODE, operation, CONSENT_HASH);
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
  });
});
