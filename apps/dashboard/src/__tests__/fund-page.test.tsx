// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import golden from "../../../../packages/gateway/src/__tests__/fixtures/vnext-dry-run-prepare-v1.payload.json";

const { authorizedFetch, login, sdkSpies, authMount, sharedMount, authModules, wallet } = vi.hoisted(() => ({
  authorizedFetch: vi.fn(), login: vi.fn(), sdkSpies: [] as ReturnType<typeof vi.fn>[],
  authMount: { clearError: false }, sharedMount: { key: 0 },
  authModules: { real: false },
  wallet: {
    address: "0x1111111111111111111111111111111111111111" as `0x${string}`,
    signMessageAsync: vi.fn(async () => "signed"),
    disconnect: vi.fn(),
    onDisconnect: undefined as (() => void) | undefined,
  },
}));
vi.mock("../lib/authorized-fetch.js", async (original) => {
  const real = await original<typeof import("../lib/authorized-fetch.js")>();
  return { ...real, authorizedFetch: (...args: Parameters<typeof real.authorizedFetch>) =>
    authModules.real ? real.authorizedFetch(...args) : authorizedFetch(...args) };
});
vi.mock("../hooks/use-auth.js", async (original) => {
  const real = await original<typeof import("../hooks/use-auth.js")>();
  return { useAuth: () => {
    if (authModules.real) return real.useAuth();
    const state = useAuthStore();
    React.useEffect(() => { if (authMount.clearError) useAuthStore.setState({ error: null }); }, []);
    return { ...state, isConnected: true, login };
  } };
});
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet.address, isConnected: true, chainId: 1 }),
  useSignMessage: () => ({ signMessageAsync: wallet.signMessageAsync }),
  useConnect: () => ({ connectors: [], connect: vi.fn() }),
  useDisconnect: () => ({ disconnect: wallet.disconnect }),
  useConnectionEffect: ({ onDisconnect }: { onDisconnect: () => void }) => { wallet.onDisconnect = onDisconnect; },
}));
vi.mock("../components/ConnectWallet.js", () => ({
  ConnectWallet: () => <span>Connect wallet</span>,
  SignInAgainButton: ({ login: signIn, isVerifying }: { login: () => Promise<void>; isVerifying: boolean }) =>
    <button disabled={isVerifying} onClick={() => void signIn()}>Sign in again</button>,
}));
vi.mock("../components/WalletPageSignInAgain.js", async (original) => {
  const { WalletPageSignInAgain: Shared } = await original<typeof import("../components/WalletPageSignInAgain.js")>();
  return { WalletPageSignInAgain: (props: Parameters<typeof Shared>[0]) => <Shared key={sharedMount.key} {...props} /> };
});
vi.mock("@pcc/spec/funding", async (original) => fundingMock(await original<typeof import("@pcc/spec/funding")>()));

function fundingMock(real: typeof import("@pcc/spec/funding")) {
  return Object.fromEntries(Object.entries(real).map(([name, value]) => {
    if (name === "FUNDING_PREPARE_SCHEMA" || name === "DEFAULT_MARGIN_SECONDS") return [name, value];
    const spy = vi.fn((): unknown => { throw new Error("SDK calls are forbidden on the read-only page"); });
    sdkSpies.push(spy);
    return [name, spy];
  }));
}

import { DEFAULT_MARGIN_SECONDS, FUNDING_PREPARE_SCHEMA } from "@pcc/spec/funding";
import { FundPage } from "../pages/FundPage.js";
import { readFunding, readPrepare, readServedTerms, requestPrepare } from "../lib/fund-api.js";
import { FUND_COPY } from "../lib/fund-copy.js";
import { PCC_BETA_STATUS } from "../lib/positioning.js";
import { SIGN_IN_EXPIRED, SIGN_IN_REFUSED } from "../lib/wallet-link-api.js";
import { adoptApiKey, useAuthStore } from "../stores/auth-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = 1_800_000_000_000;
const pending = { schema: "pcc.vnext.buyer-funding.pending.v1", state: "pending_signature", retryAfterSeconds: 5 };
const terms = () => ({ ...golden, expiry: String(NOW / 1000 + 1200) });
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } }); }
function scope(state = "awaiting_funding", scopeId = "scope/one", expiresAt = new Date(NOW + 7_200_000).toISOString()) {
  return { scopeId, state, scope: { expiresAt }, verification: null as Record<string, unknown> | null };
}
function funding(scopes: unknown[] = [scope()]) { return { jobId: "job/one", scopes }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { resolve, promise };
}
let container: HTMLDivElement;
let root: Root;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let unmounted: boolean;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  authorizedFetch.mockReset(); login.mockReset(); sdkSpies.forEach((spy) => spy.mockClear());
  authorizedFetch.mockImplementation((path: string) => Promise.resolve(path.startsWith("/api/jobs/") ? json(funding()) : json({ error: "no_prepare", message: "not ready" }, 404)));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected unmocked request"))));
  originalAuth = useAuthStore.getState();
  useAuthStore.setState({ address: "0x1111111111111111111111111111111111111111", sessionToken: "initial-session", isAuthenticated: true, error: null, authNotice: null });
  authMount.clearError = false; sharedMount.key = 0;
  authModules.real = false; wallet.signMessageAsync.mockClear(); wallet.disconnect.mockClear(); wallet.onDisconnect = undefined;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); unmounted = false;
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  container.remove(); useAuthStore.setState(originalAuth);
  authModules.real = false;
  for (const spy of sdkSpies) expect(spy, "C12: no SDK export is called").not.toHaveBeenCalled();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function render(jobId: string | null = "job/one") { await act(async () => root.render(<FundPage jobId={jobId} />)); }
function text(label: string) { expect(container.textContent).toContain(label); }
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(found, label).toBeDefined(); return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function posts() { return authorizedFetch.mock.calls.filter(([, init]) => (init as RequestInit).method === "POST"); }
function prepares() { return authorizedFetch.mock.calls.filter(([path]) => (path as string).startsWith("/api/buyer-funding/")); }
function replyPrepare(body: unknown, status = 200) {
  authorizedFetch.mockImplementation((path: string) => Promise.resolve(path.startsWith("/api/jobs/") ? json(funding()) : json(body, status)));
}
async function stoppedForTwoHours() {
  const count = authorizedFetch.mock.calls.length; await advance(7_200_000); expect(authorizedFetch).toHaveBeenCalledTimes(count);
  expect(posts()).toHaveLength(0);
}

describe("funding state order and refusals", () => {
  it("C3 R0: an invalid job id makes no request", async () => { await render(null); text(FUND_COPY.L7); expect(authorizedFetch).not.toHaveBeenCalled(); });
  it.each([[401, SIGN_IN_EXPIRED], [403, SIGN_IN_REFUSED], [404, FUND_COPY.L7], [500, FUND_COPY.L4], [202, FUND_COPY.L4]])(
    "C3 R1: status %s", async (status, expected) => {
      authorizedFetch.mockResolvedValue(json({}, status)); await render(); text(expected as string); await stoppedForTwoHours();
    },
  );
  it("C3 R1: a network failure is safe", async () => { authorizedFetch.mockRejectedValue(new Error("private response")); await render(); text(FUND_COPY.L4); expect(container.textContent).not.toContain("private response"); });
  it.each([
    {}, { jobId: "j", scopes: {} }, { jobId: "j", scopes: [{}] },
    funding([{ ...scope(), scopeId: 1 } as unknown as ReturnType<typeof scope>]),
    funding([scope("unexpected")]), funding([{ ...scope(), scope: { expiresAt: 1 } }]),
    funding([{ ...scope(), verification: [] }]), funding([{ ...scope(), verification: "bad" }]),
  ])("C3 R1: unreadable funding body %#", async (body) => { authorizedFetch.mockResolvedValue(json(body)); await render(); text(FUND_COPY.L4); });
  it("C3 R2: no scopes", async () => { authorizedFetch.mockResolvedValue(json(funding([]))); await render(); text(FUND_COPY.L22); });
  it.each([["cancelled", "L12"], ["expired", "L11"], ["unknown", "L21"], ["prepared", "L3"], ["funded_verified", "L17"]] as const)(
    "C3 R3: %s", async (state, label) => {
      authorizedFetch.mockResolvedValue(json(funding([scope(state)]))); await render(); text(FUND_COPY[label]); expect(prepares()).toHaveLength(0);
      if (state !== "prepared") await stoppedForTwoHours();
    },
  );
  const otherRefusals: [number, string[]][] = [
    [503, ["policy_unavailable", "unit_needs_testnet_record", "rpc_unavailable", "rpc_chain_mismatch", "chain_clock_skew", "deployment_mismatch", "escrow_not_predicted"]],
    [409, ["scope_not_awaiting_funding", "scope_expired", "buyer_not_wallet", "operator_unusable", "total_gross_not_quote", "milestones_not_quote", "tier_not_quote", "window_too_short", "reclaim_window", "ttl_unavailable", "policy_not_compilable", "escrow_already_funded", "nonce_revoked"]],
    [403, ["testnet_buyer_not_allowed"]],
  ];
  const prepareCases: [number, unknown, string][] = [
    [503, { error: "buyer_funding_unavailable" }, FUND_COPY.L6],
    [404, { error: "no_prepare" }, FUND_COPY.L8], [404, { error: "scope_not_found" }, FUND_COPY.L7],
    [403, { error: "forbidden", reason: "buyer_mismatch" }, FUND_COPY.L5],
    [403, { error: "forbidden", reason: "buyer_proof_required" }, SIGN_IN_REFUSED], [403, {}, SIGN_IN_REFUSED],
    [401, {}, SIGN_IN_EXPIRED], [202, pending, FUND_COPY.L9], [410, { error: "prepare_expired" }, FUND_COPY.L10a],
    [202, { ...pending, schema: "bad" }, FUND_COPY.L4], [202, { ...pending, state: "bad" }, FUND_COPY.L4],
    [202, { ...pending, retryAfterSeconds: 1 }, FUND_COPY.L4], [202, { ...pending, retryAfterSeconds: 120 }, FUND_COPY.L4],
    [202, { ...pending, extra: true }, FUND_COPY.L4], [202, null, FUND_COPY.L4],
    [409, { error: "untrusted-code" }, FUND_COPY.L4], [500, {}, FUND_COPY.L4], [404, {}, FUND_COPY.L4],
    [409, { error: "buyer_funding_not_selected" }, FUND_COPY.L24],
    [409, { error: "kernel_emergency_stopped" }, FUND_COPY.L13],
    ...otherRefusals.flatMap(([status, codes]) => codes.map((code): [number, unknown, string] => [status, { error: code }, FUND_COPY.L14.replace("{code}", code)])),
  ];
  it.each(prepareCases)("C3 R4: GET status %s body %j", async (status, body, expected) => {
    replyPrepare(body, status as number); await render(); text(expected as string);
    if (expected !== FUND_COPY.L9) await stoppedForTwoHours();
  });
  it.each(prepareCases)("C3 R4: POST status %s body %j", async (status, body, expected) => {
    await render();
    authorizedFetch.mockResolvedValue(json(body, status as number));
    await click(FUND_COPY.L8); text(expected as string); expect(posts()).toHaveLength(1);
  });
  it.each(["funding", "prepare", "post"] as const)("C3: unreadable %s response is safe", async (call) => {
    if (call === "funding") authorizedFetch.mockResolvedValueOnce(new Response("{"));
    else if (call === "prepare") authorizedFetch.mockResolvedValueOnce(json(funding())).mockResolvedValueOnce(new Response("{", { status: 409 }));
    await render();
    if (call === "post") { authorizedFetch.mockResolvedValueOnce(new Response("{", { status: 409 })); await click(FUND_COPY.L8); }
    text(FUND_COPY.L4);
  });
  it.each(["prepare", "post"] as const)("C3: network failure during %s is safe", async (call) => {
    if (call === "prepare") authorizedFetch.mockResolvedValueOnce(json(funding())).mockRejectedValueOnce(new Error("Private network error"));
    await render();
    if (call === "post") { authorizedFetch.mockRejectedValueOnce(new Error("Private network error")); await click(FUND_COPY.L8); }
    text(FUND_COPY.L4); expect(container.textContent).not.toContain("Private network error");
  });
  it("C3: an unmapped status for a known code is unreadable", async () => { replyPrepare({ error: "policy_unavailable" }, 409); await render(); text(FUND_COPY.L4); });
  it("C3: 403 refusal renders only the sign-out remedy", async () => {
    replyPrepare({}, 403); await render(); text(SIGN_IN_REFUSED); expect(button("Sign out")).toBeDefined();
    expect(container.textContent).not.toContain("Sign in again");
  });
});

describe("requests and newest scope", () => {
  it("C4: only an explicit click POSTs; double clicks are single flight", async () => {
    await render(); expect(posts()).toHaveLength(0); await advance(60_000); expect(posts()).toHaveLength(0);
    const held = deferred<Response>(); authorizedFetch.mockReturnValueOnce(held.promise);
    await act(async () => { const prepare = button(FUND_COPY.L8); prepare.click(); prepare.click(); });
    expect(posts()).toHaveLength(1); expect(button(FUND_COPY.L8).disabled).toBe(true);
    expect(posts()[0][1]).toEqual({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "omit", cache: "no-store" });
    await act(async () => held.resolve(json({ error: "no_prepare" }, 404)));
    expect(button(FUND_COPY.L8).disabled).toBe(false);
    authorizedFetch.mockResolvedValueOnce(json({ error: "no_prepare" }, 404)); await click(FUND_COPY.L8); expect(posts()).toHaveLength(2);
  });
  it.each([readFunding, readPrepare, requestPrepare])("C5: encodes ids and excludes browser credentials %#", async (call) => {
    authorizedFetch.mockResolvedValue(json(call === readFunding ? funding([]) : { error: "no_prepare" }, call === readFunding ? 200 : 404));
    await call("a/b");
    expect(authorizedFetch.mock.calls[0][0]).toBe(call === readFunding ? "/api/jobs/a%2Fb/funding" : "/api/buyer-funding/scopes/a%2Fb/prepare");
    expect(authorizedFetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", cache: "no-store" });
  });
  it("C5: every request, including polls, has explicit credential and cache policy", async () => {
    replyPrepare(pending, 202); await render(); await advance(15_000);
    for (const [, init] of authorizedFetch.mock.calls) expect(init).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(posts()).toHaveLength(0);
  });
  it("C6: newest awaiting scope wins over older verified scope", async () => {
    authorizedFetch.mockResolvedValueOnce(json(funding([scope("funded_verified", "old"), scope("awaiting_funding", "new")])));
    await render(); expect(prepares()[0][0]).toBe("/api/buyer-funding/scopes/new/prepare");
  });
  it("C6: newest verified scope wins, displaying its UTC funding time", async () => {
    const newest = { ...scope("funded_verified", "new"), verification: { escrowAddress: golden.escrow, fundedAt: NOW / 1000 } };
    authorizedFetch.mockResolvedValueOnce(json(funding([scope("awaiting_funding", "old"), newest])));
    await render(); text(FUND_COPY.L17); text(golden.escrow); text(new Date(NOW).toISOString());
    expect(container.textContent).not.toContain(FUND_COPY.L26);
    expect(prepares()).toHaveLength(0); await stoppedForTwoHours();
  });
  it("C4: Check again on unknown only re-runs R1", async () => {
    authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("unknown")])))); await render();
    await click("Check again"); text(FUND_COPY.L21); expect(authorizedFetch).toHaveBeenCalledTimes(2); expect(posts()).toHaveLength(0);
  });
});

describe("time-based polls", () => {
  it("C7 P1: polls at 15 seconds and stops exactly at scope expiry", async () => {
    authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("prepared", "s", new Date(NOW + 45_000).toISOString())]))));
    await render(); await advance(14_999); expect(authorizedFetch).toHaveBeenCalledTimes(1);
    await advance(1); expect(authorizedFetch).toHaveBeenCalledTimes(2);
    await advance(15_000); expect(authorizedFetch).toHaveBeenCalledTimes(3);
    await advance(15_000); text(FUND_COPY.L3); expect(authorizedFetch).toHaveBeenCalledTimes(3); await stoppedForTwoHours();
  });
  it("C7 P1: stops at the one-hour cap even with a later scope expiry", async () => {
    authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("prepared")])))); await render(); await advance(3_600_000);
    text(FUND_COPY.L3); expect(authorizedFetch).toHaveBeenCalledTimes(240); await stoppedForTwoHours();
  });
  it("C7 P1: stops when state changes", async () => {
    authorizedFetch.mockResolvedValueOnce(json(funding([scope("prepared")]))).mockResolvedValue(json(funding([scope("cancelled")])));
    await render(); await advance(15_000); text(FUND_COPY.L12); await stoppedForTwoHours();
  });
  it("C7 P1: keeps the prepared message while a poll is in flight past the cap", async () => {
    authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("prepared")]))));
    await render(); await advance(3_570_000);
    const held = deferred<Response>(); authorizedFetch.mockReturnValueOnce(held.promise);
    await advance(15_000); text(FUND_COPY.L3);
    await advance(30_000); text(FUND_COPY.L3);
    await act(async () => held.resolve(json(funding([scope("prepared")])))); text(FUND_COPY.L3); await stoppedForTwoHours();
  });
  it("C7 P2: polls at five seconds and stops at 600 seconds", async () => {
    replyPrepare(pending, 202); await render(); await advance(4_999); expect(prepares()).toHaveLength(1);
    await advance(1); expect(prepares()).toHaveLength(2); await advance(594_000); text(FUND_COPY.L9);
    await advance(1000); text(FUND_COPY.L10b); expect(prepares()).toHaveLength(120); await stoppedForTwoHours();
  });
  it("C7 P2: a non-202 answer stops the poll", async () => {
    replyPrepare(pending, 202); await render(); authorizedFetch.mockResolvedValue(json({ error: "prepare_expired" }, 410));
    await advance(5_000); text(FUND_COPY.L10a); expect(vi.getTimerCount()).toBe(0);
    await stoppedForTwoHours(); text(FUND_COPY.L10a); expect(container.textContent).not.toContain(FUND_COPY.L10b);
  });
  it("C7 P2: a 401 mid-poll stops the poll and keeps the sign-in remedy", async () => {
    replyPrepare(pending, 202); await render(); authorizedFetch.mockResolvedValue(json({}, 401));
    await advance(5_000); text(SIGN_IN_EXPIRED); expect(vi.getTimerCount()).toBe(0);
    await stoppedForTwoHours(); text(SIGN_IN_EXPIRED); expect(button("Sign in again")).toBeDefined();
    expect(container.textContent).not.toContain(FUND_COPY.L10b);
  });
  it("C7 P2: the deadline also ends an in-flight poll, dropping its late answer", async () => {
    replyPrepare(pending, 202); await render(); await advance(590_000);
    const held = deferred<Response>(); authorizedFetch.mockReturnValueOnce(held.promise);
    await advance(5000); text(FUND_COPY.L9); expect(vi.getTimerCount()).toBe(1);
    await advance(5000); text(FUND_COPY.L10b);
    await act(async () => held.resolve(json(terms()))); text(FUND_COPY.L10b); await stoppedForTwoHours();
  });
  it.each([410, 401])("NIT-2: a late %s cannot replace the in-flight poll deadline", async (status) => {
    replyPrepare(pending, 202); await render(); await advance(590_000);
    const held = deferred<Response>(); authorizedFetch.mockReturnValueOnce(held.promise);
    await advance(5000); text(FUND_COPY.L9); expect(vi.getTimerCount()).toBe(1);
    await advance(5000); text(FUND_COPY.L10b);
    await act(async () => held.resolve(json(status === 410 ? { error: "prepare_expired" } : {}, status)));
    text(FUND_COPY.L10b);
    for (const absent of [FUND_COPY.L10a, SIGN_IN_EXPIRED, FUND_COPY.L4]) expect(container.textContent).not.toContain(absent);
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Sign in again")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await stoppedForTwoHours();
  });
  it("C7: only one poll timer is live and unmount cancels it", async () => {
    replyPrepare(pending, 202); await render(); expect(vi.getTimerCount()).toBe(1);
    await advance(10_000); expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount()); unmounted = true;
    expect(vi.getTimerCount()).toBe(0); await stoppedForTwoHours();
  });
});

describe("generation boundaries", () => {
  it.each((["jobId", "address", "sessionToken", "keyEpoch"] as const).flatMap((identity) => (["funding", "prepare", "post"] as const).map((request) => ({ identity, request }))))(
    "C8: drops late $request after $identity changes", async ({ identity, request }) => {
      const held = deferred<Response>();
      if (request === "funding") authorizedFetch.mockReturnValueOnce(held.promise);
      if (request === "prepare") authorizedFetch.mockResolvedValueOnce(json(funding())).mockReturnValueOnce(held.promise);
      try {
        await render();
        if (request === "post") { authorizedFetch.mockReturnValueOnce(held.promise); await click(FUND_COPY.L8); }
        authorizedFetch.mockResolvedValue(json(funding([scope("cancelled")])));
        await act(async () => {
          if (identity === "jobId") root.render(<FundPage jobId="new/job" />);
          else if (identity === "keyEpoch") adoptApiKey("placeholder", false);
          else useAuthStore.setState(identity === "address" ? { address: "0x2222222222222222222222222222222222222222" } : { sessionToken: "new-session" });
        });
        text(FUND_COPY.L12);
        await act(async () => held.resolve(request === "funding" ? json(funding([scope("prepared")])) : json(pending, 202)));
        text(FUND_COPY.L12); expect(container.textContent).not.toContain(FUND_COPY.L9); expect(vi.getTimerCount()).toBe(0);
      } finally {
        if (identity === "keyEpoch") {
          await act(async () => root.unmount()); unmounted = true;
          adoptApiKey(null);
        }
      }
    },
  );
  it("C8: generation changes cancel an existing timer", async () => {
    replyPrepare(pending, 202); await render();
    authorizedFetch.mockResolvedValue(json(funding([scope("cancelled")])));
    await act(async () => useAuthStore.setState({ sessionToken: "replacement-session" }));
    text(FUND_COPY.L12); expect(vi.getTimerCount()).toBe(0); await stoppedForTwoHours();
  });
  it("C8: an answer after unmount schedules no work or state update", async () => {
    const held = deferred<Response>(); authorizedFetch.mockResolvedValueOnce(json(funding())).mockReturnValueOnce(held.promise);
    await render(); await act(async () => root.unmount()); unmounted = true;
    const consoleError = vi.spyOn(console, "error");
    await act(async () => held.resolve(json(pending, 202))); await stoppedForTwoHours();
    expect(consoleError).not.toHaveBeenCalled(); expect(container.textContent).toBe(""); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("served terms and display boundary", () => {
  it("C9: blocks automatic capture on the root", async () => { await render(); expect(container.querySelector("main.ph-no-capture.sentry-block")).not.toBeNull(); });
  it("C10: the gateway golden displays only amount, escrow and fund-by", async () => {
    vi.setSystemTime((Number(golden.expiry) - Number(DEFAULT_MARGIN_SECONDS) - 1) * 1000);
    replyPrepare(golden); await render(); text(FUND_COPY.L19); text(FUND_COPY.L20); text(FUND_COPY.L26); text(PCC_BETA_STATUS);
    text("Don't send tokens to the escrow address yourself. A transfer won't fund this order.");
    const content = container.textContent!;
    expect(content.indexOf(FUND_COPY.L20)).toBeLessThan(content.indexOf(FUND_COPY.L26));
    expect(content.indexOf(FUND_COPY.L26)).toBeLessThan(content.indexOf(PCC_BETA_STATUS));
    const { formatUnits } = await import("viem");
    text(`${formatUnits(BigInt(golden.totalGross), 6)} test USDC`); text(golden.escrow);
    text(new Date((Number(golden.expiry) - Number(DEFAULT_MARGIN_SECONDS)) * 1000).toISOString());
    expect(container.textContent).not.toContain("typedData"); expect(container.textContent).not.toContain("approve"); expect(container.textContent).not.toContain('"fund"');
    await stoppedForTwoHours();
  });
  it("C10: sensitive payload values are never rendered", async () => {
    replyPrepare({ ...terms(), typedData: { signature: "PRIVATE_OPERATOR_VALUE" }, approve: "PRIVATE_APPROVE_VALUE", fund: "PRIVATE_FUND_VALUE" });
    await render(); text(FUND_COPY.L19);
    for (const value of ["PRIVATE_OPERATOR_VALUE", "PRIVATE_APPROVE_VALUE", "PRIVATE_FUND_VALUE"]) expect(container.innerHTML).not.toContain(value);
  });
  it.each([
    ["schema", "wrong"], ["chainId", "1"], ["chainId", 84532], ["escrow", "0x123"], ["escrow", `0x${"g".repeat(40)}`],
    ["totalGross", "0"], ["totalGross", "1.5"], ["totalGross", "01"], ["totalGross", "-1"], ["totalGross", "1".repeat(32)], ["totalGross", 1],
    ["expiry", "0"], ["expiry", "01"], ["expiry", "1.5"], ["expiry", "1".repeat(17)], ["expiry", 123],
  ])("C10: rejects invalid %s = %s", async (key, value) => { replyPrepare({ ...terms(), [key]: value }); await render(); text(FUND_COPY.L23); });
  it.each(["schema", "chainId", "escrow", "totalGross", "expiry"])("C10: rejects missing %s", async (key) => {
    const body: Record<string, unknown> = terms(); delete body[key]; replyPrepare(body); await render(); text(FUND_COPY.L23);
  });
  it("C10: malformed JSON is unreadable", async () => {
    authorizedFetch.mockResolvedValueOnce(json(funding())).mockResolvedValueOnce(new Response("{")); await render(); text(FUND_COPY.L23);
  });
  it.each([null, [], "payload", 12])("C10: non-object payload %#", async (body) => { replyPrepare(body); await render(); text(FUND_COPY.L23); });
  it.each([[0, "L10a"], [-1000, "L19"]] as const)("C10: fund-by boundary %+d ms", async (offset, label) => {
    const payload = terms(); vi.setSystemTime((Number(payload.expiry) - Number(DEFAULT_MARGIN_SECONDS)) * 1000 + offset);
    replyPrepare(payload); await render(); text(FUND_COPY[label]);
  });
  it("C10: otherwise-valid out-of-range ISO dates are unreadable", () => {
    expect(readServedTerms(JSON.stringify({ ...terms(), expiry: "9999999999999999" }))).toEqual({ kind: "unreadable" });
  });
  it("C4/C7/C12: ready terms stop polling; Check again starts only R1", async () => {
    replyPrepare(pending, 202); await render(); replyPrepare(terms()); await advance(5000); text(FUND_COPY.L19); await stoppedForTwoHours();
    await click("Check again"); text(FUND_COPY.L10a); expect(posts()).toHaveLength(0);
    expect(authorizedFetch.mock.calls.at(-2)?.[0]).toBe("/api/jobs/job%2Fone/funding");
  });
});

describe("sign-in recovery uses a new session token", () => {
  it.each(["signature", "nonce", "mint"] as const)("C15: failed %s keeps an old held key in the 401 UI", async (failure) => {
    authorizedFetch.mockResolvedValue(json({}, 401)); await render(); text(SIGN_IN_EXPIRED);
    login.mockImplementation(async () => {
      useAuthStore.setState(failure === "mint" ? { error: null, authNotice: "Mint was refused" } : { error: failure === "signature" ? "Signature refused" : "Failed nonce" });
    });
    const count = authorizedFetch.mock.calls.length; await click("Sign in again"); text(SIGN_IN_EXPIRED);
    text(failure === "mint" ? "Mint was refused" : failure === "signature" ? "Signature refused" : "Failed nonce");
    expect(useAuthStore.getState().isAuthenticated).toBe(true); expect(authorizedFetch).toHaveBeenCalledTimes(count);
    authorizedFetch.mockResolvedValue(json(funding([scope("cancelled")])));
    login.mockImplementation(async () => { useAuthStore.setState({ sessionToken: "successful-session", error: null, authNotice: null }); });
    await click("Sign in again"); text(FUND_COPY.L12); expect(authorizedFetch).toHaveBeenCalledTimes(count + 1);
  });
  it("C15b: a key minted after the new session token recovers on the first re-sign", async () => {
    const mint = deferred<void>();
    useAuthStore.setState({ sessionToken: "cookie" });
    authorizedFetch.mockImplementation(() => Promise.resolve(json({}, 401)));
    login.mockImplementation(async () => {
      useAuthStore.setState({ sessionToken: "new-session" });
      await mint.promise;
      authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("cancelled")]))));
      adoptApiKey("placeholder", false);
      useAuthStore.setState({ sessionKeyId: "minted-session-key" });
    });
    try {
      await render(); text(SIGN_IN_EXPIRED);
      await click("Sign in again"); text(SIGN_IN_EXPIRED);
      expect(authorizedFetch).toHaveBeenCalledTimes(2);
      await act(async () => mint.resolve());
      text(FUND_COPY.L12); expect(container.textContent).not.toContain(SIGN_IN_EXPIRED);
      expect(login).toHaveBeenCalledTimes(1); expect(posts()).toHaveLength(0);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });
  it("C16: gateway stop survives re-sign and no local stop panel appears", async () => {
    replyPrepare({}, 401); await render(); text(SIGN_IN_EXPIRED);
    replyPrepare({ error: "kernel_emergency_stopped" }, 409);
    login.mockImplementation(async () => useAuthStore.setState({ sessionToken: "fresh-session" }));
    await click("Sign in again"); text(FUND_COPY.L13);
    expect(container.innerHTML).not.toMatch(/EmergencyStopPanel|emergency-stop|Resume work/i);
    expect(authorizedFetch).toHaveBeenCalledTimes(4);
  });
  it("C17: an existing restore notice is hidden before any attempt", async () => {
    useAuthStore.setState({ authNotice: "Old restore notice" }); authorizedFetch.mockResolvedValue(json({}, 401));
    await render(); expect(container.textContent).not.toContain("Old restore notice");
  });
  it("C17: settled signature error survives shared component remount and store error clearing", async () => {
    authorizedFetch.mockResolvedValue(json({}, 401)); await render();
    login.mockImplementation(async () => useAuthStore.setState({ error: "Signature refused" }));
    await click("Sign in again"); text("Signature refused");
    authMount.clearError = true; sharedMount.key++;
    await render(); expect(useAuthStore.getState().error).toBeNull(); text("Signature refused"); text(SIGN_IN_EXPIRED);
  });
  it("C17: a mint notice appears only after this attempt settles; login is single flight", async () => {
    authorizedFetch.mockResolvedValue(json({}, 401)); await render();
    const held = deferred<void>(); login.mockImplementation(() => held.promise);
    await act(async () => { const signIn = button("Sign in again"); signIn.click(); signIn.click(); });
    expect(login).toHaveBeenCalledTimes(1);
    await act(async () => useAuthStore.setState({ error: null, authNotice: "Mint refusal notice" }));
    expect(container.textContent).not.toContain("Mint refusal notice");
    await act(async () => held.resolve()); text("Mint refusal notice"); text(SIGN_IN_EXPIRED);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("real auth funding recovery", () => {
  const fundingPath = "/api/jobs/job%2Fone/funding";
  const mintPath = "/api/auth/session-key";
  const pathOf = (input: RequestInfo | URL) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
  const mintReply = (number: number) => json({
    operator_id: wallet.address, api_key: `placeholder-mint-${number}`, key_id: `session-key-${number}`,
    expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
  }, 201);

  it("F-A: a 401 on the read a key change started ends at the remedy", async () => {
    authModules.real = true;
    adoptApiKey("held-placeholder", false);
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    const step = 10;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const path = pathOf(input);
      await new Promise<void>((resolve) => setTimeout(resolve, step));
      if (path === "/api/auth/me") return json({ address: wallet.address });
      if (path === "/api/auth/nonce") return json({ nonce: "nonce" });
      if (path === "/api/auth/verify") return json({ token: "signed-in-session", address: wallet.address });
      if (path === mintPath && init.method === "POST") return mintReply(mints());
      if (path === fundingPath) return json({}, 401);
      throw new Error("Unexpected auth recovery request");
    });
    const mints = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === mintPath && init?.method === "POST").length;
    const reads = () => fetchStub.mock.calls.filter(([input]) => pathOf(input) === fundingPath).length;
    vi.stubGlobal("fetch", fetchStub);
    try {
      await render();
      let readsAtRemedy: number | null = null;
      for (let elapsed = 0; elapsed < 2000; elapsed += step) {
        await advance(step);
        if (readsAtRemedy === null && container.textContent?.includes(SIGN_IN_EXPIRED)) readsAtRemedy = reads();
      }
      expect(mints()).toBeLessThanOrEqual(2);
      text(SIGN_IN_EXPIRED); expect(button("Sign in again")).toBeDefined();
      expect(readsAtRemedy).not.toBeNull(); expect(reads()).toBe(readsAtRemedy);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });

  it.each(["before", "after"] as const)("F-A control: one Sign in again from a cookie-only session recovers (401 %s mint)", async (order) => {
    authModules.real = true;
    adoptApiKey(null);
    useAuthStore.setState({ address: wallet.address, sessionToken: null, sessionKeyId: null, isAuthenticated: false });
    const mint = deferred<Response>();
    const tokenRead = deferred<Response>();
    let verified = false;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const path = pathOf(input);
      if (path === "/api/auth/me") return json({ address: wallet.address });
      if (path === "/api/auth/nonce") return json({ nonce: "nonce" });
      if (path === "/api/auth/verify") {
        verified = true;
        return json({ token: "signed-in-session", address: wallet.address });
      }
      if (path === mintPath && init.method === "POST") return mint.promise;
      if (path === fundingPath) {
        if (new Headers(init.headers).get("Authorization") === "Bearer placeholder-mint-1") return json(funding([scope("cancelled")]));
        if (verified && order === "after") return tokenRead.promise;
        return json({}, 401);
      }
      throw new Error("Unexpected auth recovery request");
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      await render(); text(SIGN_IN_EXPIRED);
      const readsBeforeClick = fetchStub.mock.calls.filter(([input]) => pathOf(input) === fundingPath).length;
      await click("Sign in again");
      expect(fetchStub.mock.calls.filter(([input]) => pathOf(input) === fundingPath)).toHaveLength(readsBeforeClick + 1);
      if (order === "before") text(SIGN_IN_EXPIRED);
      else text("Loading order…");
      await act(async () => mint.resolve(mintReply(1)));
      text(FUND_COPY.L12); expect(container.textContent).not.toContain(SIGN_IN_EXPIRED);
      if (order === "after") {
        await act(async () => tokenRead.resolve(json({}, 401)));
        text(FUND_COPY.L12); expect(container.textContent).not.toContain(SIGN_IN_EXPIRED);
      }
      expect(fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === mintPath && init?.method === "POST")).toHaveLength(1);
      expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls.filter(([input, init]) => pathOf(input).endsWith("/prepare") && init?.method === "POST")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });
});

describe("browser module loading", () => {
  it.each(["without getBuiltinModule", "bundler shim", "without process"] as const)("C11: %s", async (host) => {
    const originalProcess = globalThis.process;
    const descriptor = Object.getOwnPropertyDescriptor(originalProcess, "getBuiltinModule");
    // React and the identity store must remain the renderer's existing instances.
    vi.doMock("react", () => React);
    vi.doMock("../stores/auth-store.js", () => ({ useAuthStore }));
    vi.doUnmock("@pcc/spec/funding"); vi.resetModules();
    try {
      if (host === "without getBuiltinModule") Reflect.deleteProperty(originalProcess, "getBuiltinModule");
      else if (host === "bundler shim") vi.stubGlobal("process", { env: { ...originalProcess.env } });
      else vi.stubGlobal("process", undefined);
      const { FundPage: BrowserFundPage } = await import("../pages/FundPage.js");
      const constants = await import("@pcc/spec/funding");
      expect(constants.FUNDING_PREPARE_SCHEMA).toBe(FUNDING_PREPARE_SCHEMA);
      expect(constants.DEFAULT_MARGIN_SECONDS).toBe(DEFAULT_MARGIN_SECONDS);
      for (const [index, state] of ["prepared", "cancelled", "expired", "unknown", "funded_verified", "awaiting_funding"].entries()) {
        authorizedFetch.mockResolvedValue(json(funding([scope(state)])));
        if (state === "awaiting_funding") replyPrepare(pending, 202);
        await act(async () => root.render(<BrowserFundPage jobId={`browser/${index}`} />));
        const label = { prepared: "L3", cancelled: "L12", expired: "L11", unknown: "L21", funded_verified: "L17", awaiting_funding: "L9" } as const;
        text(FUND_COPY[label[state as keyof typeof label]]);
      }
      replyPrepare({ error: "policy_unavailable" }, 503);
      await act(async () => root.render(<BrowserFundPage jobId="browser/refusal" />));
      text(FUND_COPY.L14.replace("{code}", "policy_unavailable"));
      replyPrepare(terms()); await act(async () => root.render(<BrowserFundPage jobId="browser/terms" />)); text(FUND_COPY.L19);
    } finally {
      vi.stubGlobal("process", originalProcess);
      if (descriptor) Object.defineProperty(originalProcess, "getBuiltinModule", descriptor);
      else Reflect.deleteProperty(originalProcess, "getBuiltinModule");
      vi.doMock("@pcc/spec/funding", async () => fundingMock(await vi.importActual<typeof import("@pcc/spec/funding")>("@pcc/spec/funding")));
      vi.doUnmock("react"); vi.doUnmock("../stores/auth-store.js");
    }
  });
});
