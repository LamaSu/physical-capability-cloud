// @vitest-environment jsdom
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { type Address, type PublicClient, type WalletClient, zeroHash } from "viem";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import golden from "../../../../packages/gateway/src/__tests__/fixtures/vnext-dry-run-prepare-v1.payload.json";

const { authorizedFetch, login, sdkSpies, authMount, sharedMount, authModules, wallet, clients, sdkActual } = vi.hoisted(() => ({
  authorizedFetch: vi.fn(), login: vi.fn(), sdkSpies: [] as ReturnType<typeof vi.fn>[],
  authMount: { clearError: false }, sharedMount: { key: 0 },
  authModules: { real: false },
  clients: { walletClient: undefined as WalletClient | undefined, publicClient: undefined as PublicClient | undefined, mutateAsync: vi.fn() },
  sdkActual: { value: undefined as typeof import("@pcc/spec/funding") | undefined },
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
  useWalletClient: () => ({ data: clients.walletClient }),
  usePublicClient: () => clients.publicClient,
  useSwitchChain: () => ({ mutateAsync: clients.mutateAsync }),
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
  sdkActual.value = real;
  return Object.fromEntries(Object.entries(real).map(([name, value]) => {
    if (typeof value !== "function" || name === "FundingRefusal") return [name, value];
    const spy = vi.fn((): unknown => { throw new Error("SDK calls are forbidden on the read-only page"); });
    sdkSpies.push(spy);
    return [name, spy];
  }));
}

import { DEFAULT_MARGIN_SECONDS, FUNDING_PREPARE_SCHEMA } from "@pcc/spec/funding";
import * as fundingSdk from "@pcc/spec/funding";
import { runningFlight } from "../lib/fund-send.js";
import { FundPage } from "../pages/FundPage.js";
import { readFunding, readOrderOperator, readPrepare, readServedTerms, requestPrepare } from "../lib/fund-api.js";
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
let sendCell = false;
let getChainId: ReturnType<typeof vi.fn<[], Promise<number>>>;
let getBlock: ReturnType<typeof vi.fn<[], Promise<{ timestamp: bigint }>>>;
let getCode: ReturnType<typeof vi.fn<[], Promise<string>>>;
let readContract: ReturnType<typeof vi.fn<[], Promise<bigint>>>;
function defaultRoute(path: string) {
  if (path.endsWith("/funding")) return json(funding());
  if (path.startsWith("/api/jobs/")) return json({ job: { kernelId: "kernel/one" } });
  if (path.startsWith("/api/kernels/")) return json({ kernel: { operatorAddress: golden.typedData.message.operator } });
  return json({ error: "no_prepare", message: "not ready" }, 404);
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  sendCell = false;
  authorizedFetch.mockReset(); login.mockReset();
  sdkSpies.forEach((spy) => spy.mockReset().mockImplementation(() => { throw new Error("Unexpected SDK call"); }));
  getChainId = vi.fn(async () => 84532); getBlock = vi.fn(async () => ({ timestamp: BigInt(NOW / 1000) }));
  getCode = vi.fn(async () => "0x1234"); readContract = vi.fn(async () => 1_000_000n);
  clients.walletClient = { account: { address: wallet.address }, getChainId } as unknown as WalletClient;
  clients.publicClient = { getBlock, getCode, readContract } as unknown as PublicClient;
  clients.mutateAsync.mockReset().mockResolvedValue(undefined);
  authorizedFetch.mockImplementation((path: string) => Promise.resolve(defaultRoute(path)));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected unmocked request"))));
  originalAuth = useAuthStore.getState();
  useAuthStore.setState({ address: "0x1111111111111111111111111111111111111111", sessionToken: "initial-session", isAuthenticated: true, error: null, authNotice: null });
  authMount.clearError = false; sharedMount.key = 0;
  authModules.real = false; wallet.signMessageAsync.mockClear(); wallet.disconnect.mockClear(); wallet.onDisconnect = undefined;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); unmounted = false;
});
afterEach(async () => {
  noFields();
  if (!unmounted) await act(async () => root.unmount());
  container.remove(); useAuthStore.setState(originalAuth);
  authModules.real = false;
  if (!sendCell) for (const spy of sdkSpies) expect(spy, "C12: no SDK export is called").not.toHaveBeenCalled();
  expect(runningFlight("scope/one")).toBeUndefined();
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
  it("I-4: a pending answer that lands less than 5 s before the deadline still ends the poll at 600 s", async () => {
    replyPrepare(pending, 202); await render(); await advance(590_000);
    const held = deferred<Response>(); authorizedFetch.mockReturnValueOnce(held.promise);
    await advance(5000); text(FUND_COPY.L9); expect(vi.getTimerCount()).toBe(1);
    await advance(2000);
    await act(async () => held.resolve(json(pending, 202)));
    await advance(2999); text(FUND_COPY.L9); expect(container.textContent).not.toContain(FUND_COPY.L10b);
    await advance(1); text(FUND_COPY.L10b); await stoppedForTwoHours();
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
  it("NIT-5: a key-only change after a key-restart read has settled restarts the page", async () => {
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("cancelled")]))));
    try {
      await render(); text(FUND_COPY.L12);
      const initialReads = authorizedFetch.mock.calls.length;
      await act(async () => {
        adoptApiKey("first-placeholder", false);
        useAuthStore.setState({ sessionKeyId: "first-session-key" });
      });
      text(FUND_COPY.L12); expect(authorizedFetch).toHaveBeenCalledTimes(initialReads + 1);
      authorizedFetch.mockResolvedValue(json(funding([scope("expired")])));
      const readsBeforeSecondKey = authorizedFetch.mock.calls.length;
      await act(async () => {
        adoptApiKey("second-placeholder", false);
        useAuthStore.setState({ sessionKeyId: "second-session-key" });
      });
      text(FUND_COPY.L11); expect(authorizedFetch).toHaveBeenCalledTimes(readsBeforeSecondKey + 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });
  it("NIT-7: a key-only change after a key-restart first pass that ended in a poll restarts the page", async () => {
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("cancelled")]))));
    try {
      await render(); text(FUND_COPY.L12);
      replyPrepare(pending, 202);
      const initialReads = authorizedFetch.mock.calls.length;
      await act(async () => {
        adoptApiKey("first-placeholder", false);
        useAuthStore.setState({ sessionKeyId: "first-session-key" });
      });
      text(FUND_COPY.L9); expect(authorizedFetch).toHaveBeenCalledTimes(initialReads + 2);
      authorizedFetch.mockResolvedValue(json(funding([scope("expired")])));
      const readsBeforeSecondKey = authorizedFetch.mock.calls.length;
      await act(async () => {
        adoptApiKey("second-placeholder", false);
        useAuthStore.setState({ sessionKeyId: "second-session-key" });
      });
      text(FUND_COPY.L11); expect(authorizedFetch).toHaveBeenCalledTimes(readsBeforeSecondKey + 1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });
  it("NIT-8: a key-only change after a key-restart first pass that ended in a failure restarts the page", async () => {
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("cancelled")]))));
    try {
      await render(); text(FUND_COPY.L12);
      authorizedFetch.mockResolvedValue(json({}, 500));
      const initialReads = authorizedFetch.mock.calls.length;
      await act(async () => {
        adoptApiKey("first-placeholder", false);
        useAuthStore.setState({ sessionKeyId: "first-session-key" });
      });
      text(FUND_COPY.L4); expect(authorizedFetch).toHaveBeenCalledTimes(initialReads + 1);
      authorizedFetch.mockResolvedValue(json(funding([scope("expired")])));
      const readsBeforeSecondKey = authorizedFetch.mock.calls.length;
      await act(async () => {
        adoptApiKey("second-placeholder", false);
        useAuthStore.setState({ sessionKeyId: "second-session-key" });
      });
      text(FUND_COPY.L11); expect(authorizedFetch).toHaveBeenCalledTimes(readsBeforeSecondKey + 1);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });
  it.each(["jobId", "address", "sessionToken"] as const)(
    "r5 F-1: a %s change during a key-restart first pass starts a new generation", async (identity) => {
      useAuthStore.setState({ sessionKeyId: "held-session-key" });
      authorizedFetch.mockImplementation(() => Promise.resolve(json(funding([scope("cancelled")]))));
      try {
        await render(); text(FUND_COPY.L12);
        const held = deferred<Response>();
        authorizedFetch.mockReturnValueOnce(held.promise);
        await act(async () => {
          adoptApiKey("first-placeholder", false);
          useAuthStore.setState({ sessionKeyId: "first-session-key" });
        });
        text("Loading order…");
        const readsBeforeIdentity = authorizedFetch.mock.calls.length;
        await act(async () => {
          if (identity === "jobId") root.render(<FundPage jobId="new/job" />);
          else useAuthStore.setState(identity === "address" ? { address: "0x2222222222222222222222222222222222222222" } : { sessionToken: "new-session" });
        });
        expect(authorizedFetch).toHaveBeenCalledTimes(readsBeforeIdentity + 1);
        if (identity === "jobId") expect(authorizedFetch.mock.calls.at(-1)?.[0]).toBe("/api/jobs/new%2Fjob/funding");
        text(FUND_COPY.L12);
        await act(async () => held.resolve(json(funding([scope("expired")]))));
        text(FUND_COPY.L12); expect(container.textContent).not.toContain(FUND_COPY.L11); expect(vi.getTimerCount()).toBe(0);
      } finally {
        await act(async () => root.unmount()); unmounted = true;
        adoptApiKey(null);
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
    replyPrepare(golden); await render(); text(FUND_COPY.L19); text(FUND_COPY.L27); text(FUND_COPY.L26); text(PCC_BETA_STATUS);
    text("Don't send tokens to the escrow address yourself. A transfer won't fund this order.");
    const content = container.textContent!;
    expect(content.indexOf(FUND_COPY.L27)).toBeLessThan(content.indexOf(FUND_COPY.L26));
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
  it("NIT-6: with an old session key id held, a key that lands during the token-change read restarts the page", async () => {
    const mint = deferred<void>();
    const tokenRead = deferred<Response>();
    useAuthStore.setState({ sessionToken: "cookie", sessionKeyId: "held-session-key" });
    authorizedFetch.mockResolvedValue(json({}, 401));
    login.mockImplementation(async () => {
      useAuthStore.setState({ sessionToken: "new-session" });
      await mint.promise;
      authorizedFetch.mockResolvedValue(json(funding([scope("cancelled")])));
      adoptApiKey("placeholder", false);
      useAuthStore.setState({ sessionKeyId: "minted-session-key" });
    });
    try {
      await render(); text(SIGN_IN_EXPIRED);
      authorizedFetch.mockReturnValueOnce(tokenRead.promise);
      await click("Sign in again");
      text("Loading order…"); expect(container.textContent).not.toContain(FUND_COPY.L4);
      const readsBeforeKey = authorizedFetch.mock.calls.length;
      expect(readsBeforeKey).toBe(2);
      await act(async () => mint.resolve());
      text(FUND_COPY.L12); expect(container.textContent).not.toContain(FUND_COPY.L4);
      expect(authorizedFetch).toHaveBeenCalledTimes(readsBeforeKey + 1);
      await act(async () => tokenRead.resolve(json({}, 500)));
      text(FUND_COPY.L12); expect(container.textContent).not.toContain(FUND_COPY.L4);
      expect(authorizedFetch).toHaveBeenCalledTimes(readsBeforeKey + 1);
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

  it("F-D: a 401 on the prepare read a key change's generation sends ends at the remedy", async () => {
    authModules.real = true;
    adoptApiKey("held-placeholder", false);
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    const preparePath = "/api/buyer-funding/scopes/scope%2Fone/prepare";
    const step = 10;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const path = pathOf(input);
      await new Promise<void>((resolve) => setTimeout(resolve, step));
      if (path === "/api/auth/me") return json({ address: wallet.address });
      if (path === mintPath && init.method === "POST") return mintReply(mints());
      if (path === fundingPath && init.method === "GET") return json(funding());
      if (path === preparePath && init.method === "GET") return json({}, 401);
      throw new Error("Unexpected auth recovery request");
    });
    const mints = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === mintPath && init?.method === "POST").length;
    const reads = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === fundingPath && init?.method === "GET").length;
    const prepareReads = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === preparePath && init?.method === "GET").length;
    vi.stubGlobal("fetch", fetchStub);
    try {
      await render();
      let readsAtRemedy: { funding: number; prepare: number } | null = null;
      for (let elapsed = 0; elapsed < 2000; elapsed += step) {
        await advance(step);
        if (readsAtRemedy === null && container.textContent?.includes(SIGN_IN_EXPIRED)) {
          readsAtRemedy = { funding: reads(), prepare: prepareReads() };
        }
      }
      expect(mints()).toBeLessThanOrEqual(2);
      text(SIGN_IN_EXPIRED); expect(button("Sign in again")).toBeDefined();
      expect(readsAtRemedy).not.toBeNull();
      expect(reads()).toBe(readsAtRemedy?.funding); expect(prepareReads()).toBe(readsAtRemedy?.prepare);
      expect(fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === preparePath && init?.method === "POST")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });

  it("F-1 (a): two refused reads in a key change's first pass end at the remedy after at most 3 mints", async () => {
    authModules.real = true;
    adoptApiKey("held-placeholder", false);
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    const preparePath = "/api/buyer-funding/scopes/scope%2Fone/prepare";
    const step = 10;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const path = pathOf(input);
      const fundingRead = path === fundingPath && init.method === "GET" ? reads() : null;
      await new Promise<void>((resolve) => setTimeout(resolve, step));
      if (path === "/api/auth/me") return json({ address: wallet.address });
      if (path === mintPath && init.method === "POST") return mintReply(mints());
      if (fundingRead !== null) return fundingRead === 2 ? json({}, 401) : json(funding());
      if (path === preparePath && init.method === "GET") return json({}, 401);
      throw new Error("Unexpected auth recovery request");
    });
    const mints = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === mintPath && init?.method === "POST").length;
    const reads = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === fundingPath && init?.method === "GET").length;
    const prepareReads = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === preparePath && init?.method === "GET").length;
    vi.stubGlobal("fetch", fetchStub);
    try {
      await render();
      let readsAtRemedy: { funding: number; prepare: number } | null = null;
      for (let elapsed = 0; elapsed < 2000; elapsed += step) {
        await advance(step);
        if (readsAtRemedy === null && container.textContent?.includes(SIGN_IN_EXPIRED)) {
          readsAtRemedy = { funding: reads(), prepare: prepareReads() };
        }
      }
      expect(mints()).toBeLessThanOrEqual(3);
      text(SIGN_IN_EXPIRED); expect(button("Sign in again")).toBeDefined();
      expect(readsAtRemedy).not.toBeNull();
      expect(reads()).toBe(readsAtRemedy?.funding); expect(prepareReads()).toBe(readsAtRemedy?.prepare);
      expect(fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === preparePath && init?.method === "POST")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });

  it("F-1 (b): a refusal in every generation's first pass ends at the remedy after at most 3 mints", async () => {
    authModules.real = true;
    adoptApiKey("held-placeholder", false);
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    const preparePath = "/api/buyer-funding/scopes/scope%2Fone/prepare";
    const step = 10;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const path = pathOf(input);
      await new Promise<void>((resolve) => setTimeout(resolve, step));
      const fundingRead = path === fundingPath && init.method === "GET" ? reads() : null;
      if (path === "/api/auth/me") return json({ address: wallet.address });
      if (path === mintPath && init.method === "POST") return mintReply(mints());
      if (fundingRead !== null) return fundingRead % 2 === 1 ? json({}, 401) : json(funding());
      if (path === preparePath && init.method === "GET") return json({}, 401);
      throw new Error("Unexpected auth recovery request");
    });
    const mints = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === mintPath && init?.method === "POST").length;
    const reads = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === fundingPath && init?.method === "GET").length;
    const prepareReads = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === preparePath && init?.method === "GET").length;
    vi.stubGlobal("fetch", fetchStub);
    try {
      await render();
      let readsAtRemedy: { funding: number; prepare: number } | null = null;
      for (let elapsed = 0; elapsed < 2000; elapsed += step) {
        await advance(step);
        if (readsAtRemedy === null && container.textContent?.includes(SIGN_IN_EXPIRED)) {
          readsAtRemedy = { funding: reads(), prepare: prepareReads() };
        }
      }
      expect(mints()).toBeLessThanOrEqual(3);
      text(SIGN_IN_EXPIRED); expect(button("Sign in again")).toBeDefined();
      expect(readsAtRemedy).not.toBeNull();
      expect(reads()).toBe(readsAtRemedy?.funding); expect(prepareReads()).toBe(readsAtRemedy?.prepare);
      expect(fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === preparePath && init?.method === "POST")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount()); unmounted = true;
      adoptApiKey(null);
    }
  });

  it("NIT-4: a key that lands after the F-A remedy restarts the page", async () => {
    authModules.real = true;
    adoptApiKey("held-placeholder", false);
    useAuthStore.setState({ sessionKeyId: "held-session-key" });
    const step = 10;
    let recovered = false;
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const path = pathOf(input);
      await new Promise<void>((resolve) => setTimeout(resolve, step));
      if (path === "/api/auth/me") return json({ address: wallet.address });
      if (path === "/api/auth/nonce") return json({ nonce: "nonce" });
      if (path === "/api/auth/verify") return json({ token: "signed-in-session", address: wallet.address });
      if (path === mintPath && init.method === "POST") return mintReply(mints());
      if (path === fundingPath) return recovered ? json(funding([scope("cancelled")])) : json({}, 401);
      throw new Error("Unexpected auth recovery request");
    });
    const mints = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === mintPath && init?.method === "POST").length;
    const reads = () => fetchStub.mock.calls.filter(([input, init]) => pathOf(input) === fundingPath && init?.method === "GET").length;
    vi.stubGlobal("fetch", fetchStub);
    try {
      await render();
      for (let elapsed = 0; elapsed < 2000 && !container.textContent?.includes(SIGN_IN_EXPIRED); elapsed += step) {
        await advance(step);
      }
      text(SIGN_IN_EXPIRED);
      recovered = true;
      const readsBeforeKey = reads();
      await act(async () => {
        adoptApiKey("landed-placeholder", false);
        useAuthStore.setState({ sessionKeyId: "landed-session-key" });
      });
      await advance(step);
      text(FUND_COPY.L12); expect(container.textContent).not.toContain(SIGN_IN_EXPIRED);
      expect(reads()).toBe(readsBeforeKey + 1);
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

const checkedPrepared = () => ({
  payer: wallet.address, operator: golden.typedData.message.operator, escrow: golden.escrow, usdc: golden.usdc,
  totalGross: 1_000_000n, expiry: BigInt(terms().expiry), reclaimAt: { earliest: BigInt(NOW / 1000 + 7200), latest: BigInt(NOW / 1000 + 7200) },
  verifiedAt: { blockNumber: 123n, blockHash: zeroHash, blockTimestamp: BigInt(NOW / 1000) },
}) as unknown as fundingSdk.PreparedFunding;
function sendRouting(fundingReply: () => Response | Promise<Response> = () => json(funding()), body: unknown = terms()) {
  authorizedFetch.mockImplementation((path: string) => Promise.resolve(
    path.endsWith("/funding") ? fundingReply() : path.startsWith("/api/buyer-funding/") ? json(body) : defaultRoute(path)));
}
function readyEscrow(create?: { kind: string }) {
  return { outcome: "ready", ...(create ? { create } : {}) } as fundingSdk.EnsureEscrowResult;
}
function sendOutcome(outcome: fundingSdk.FundingOutcome = "committed") {
  vi.mocked(fundingSdk.ensureEscrow).mockResolvedValue(readyEscrow());
  vi.mocked(fundingSdk.approveAndFund).mockResolvedValue({ outcome } as fundingSdk.FundingResult);
}
function sdkCounts() { return sdkSpies.map((spy) => spy.mock.calls.length); }
function noSdkSince(counts: number[]) { expect(sdkCounts()).toEqual(counts); }
function noFields() { expect(container.querySelector("input, textarea, [contenteditable]")).toBeNull(); }
const resultLabels = ["L1", "L2", "L5", "L7", "L10a", "L15", "L16", "L18", "L23", "L29", "L30", "L31", "L32", "L33", "L34", "L37"] as const;
function resultText(label: typeof resultLabels[number]) { return label === "L29" ? FUND_COPY.L29.replace("{held}", "0.25").replace("{needed}", "1") : FUND_COPY[label]; }
function onlyResult(label: typeof resultLabels[number]) {
  text(resultText(label));
  for (const other of resultLabels) if (other !== label) expect(container.textContent).not.toContain(resultText(other));
  expect(container.textContent).not.toContain(FUND_COPY.L17); expect(container.textContent).not.toContain(FUND_COPY.L19);
  expect(container.querySelector("dl")).toBeNull(); noFields();
}
async function checkFromTerms() { await render(); await click(FUND_COPY.L27); }
async function sendFromChecked() { await checkFromTerms(); await click(FUND_COPY.L28); }
function verifiedScope(scopeId = "scope/one") {
  return { ...scope("funded_verified", scopeId), verification: { escrowAddress: golden.escrow, fundedAt: NOW / 1000 + 5 } };
}

describe("N293-2 browser check and buyer send", () => {
  beforeEach(() => {
    sendCell = true;
    for (const name of ["dryRunUnitPrincipalWord", "dryRunUnitTestnetExpectation"] as const) {
      vi.mocked(fundingSdk[name]).mockImplementation(sdkActual.value![name] as never);
    }
    vi.mocked(fundingSdk.prepareFunding).mockResolvedValue(checkedPrepared());
    vi.mocked(fundingSdk.readFundedState).mockResolvedValue({ kind: "unfunded" } as fundingSdk.FundedState);
    sendRouting();
  });
  afterEach(() => {
    expect(fundingSdk.signJobPolicy).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0); noFields();
  });
  it("C18: checked displays the SDK values in order and offers only the buyer's send", async () => {
    await checkFromTerms();
    expect([...container.querySelectorAll("dt")].map((node) => node.textContent)).toEqual([
      "Amount", "Escrow", "Operator", "Fund by", "Refundable from", "Checked at block",
    ]);
    expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toEqual([
      "1 test USDC", golden.escrow, golden.typedData.message.operator,
      new Date(Number(BigInt(terms().expiry) - DEFAULT_MARGIN_SECONDS) * 1000).toISOString(), new Date(NOW + 7_200_000).toISOString(), "123",
    ]);
    for (const label of resultLabels) expect(container.textContent).not.toContain(resultText(label));
    expect(container.textContent).not.toContain(FUND_COPY.L19);
    const content = container.textContent!;
    for (const [a, b] of [[FUND_COPY.L35, FUND_COPY.L28], [FUND_COPY.L28, FUND_COPY.L26], [FUND_COPY.L26, PCC_BETA_STATUS], [PCC_BETA_STATUS, "Check again"]]) {
      expect(content.indexOf(a!)).toBeLessThan(content.indexOf(b!));
    }
    expect(fundingSdk.prepareFunding).toHaveBeenCalledTimes(1); expect(fundingSdk.readFundedState).toHaveBeenCalledTimes(1);
    expect(fundingSdk.ensureEscrow).not.toHaveBeenCalled(); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
    const count = sdkCounts(); await click("Check again"); noSdkSince(count); text(FUND_COPY.L19);
  });
  it.each(["L16", "L18", "L2", "L5", "L10a", "L15", "L23", "L29", "L30", "L31", "L34", "L7"] as const)(
    "C18: the check shows only %s", async (label) => {
      const code = { L2: "INTENT_MISMATCH", L5: "PAYER_NOT_SIGNER", L10a: "EXPIRY_TOO_SOON", L15: "LIVE_CHECK_FAILED", L30: "BAD_PAYLOAD", L31: "PAYER_TX_PENDING", L34: "SIMULATION_REVERTED" } as const;
      if (label in code) vi.mocked(fundingSdk.prepareFunding).mockRejectedValue(new fundingSdk.FundingRefusal(code[label as keyof typeof code], "PRIVATE_ERROR"));
      if (label === "L16") getChainId.mockResolvedValue(8453);
      if (label === "L18") vi.mocked(fundingSdk.readFundedState).mockResolvedValue({ kind: "funded_ours" } as fundingSdk.FundedState);
      if (label === "L29") readContract.mockResolvedValue(250000n);
      if (label === "L23" || label === "L7") authorizedFetch.mockImplementation((path: string) => Promise.resolve(
        path.endsWith("/funding") ? json(funding()) : path.startsWith("/api/buyer-funding/") ? json(terms())
          : label === "L7" ? json({}, 404) : json({ job: { kernelId: "kernel/one" }, kernel: { operatorAddress: "bad" } })));
      await checkFromTerms(); onlyResult(label);
      expect(container.textContent).not.toContain("PRIVATE_ERROR");
      expect(fundingSdk.ensureEscrow).not.toHaveBeenCalled(); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
      expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Check again")).toBe(!["L18", "L10a", "L23", "L7"].includes(label));
      if (!["L16", "L23", "L7"].includes(label)) expect(fundingSdk.prepareFunding).toHaveBeenCalledTimes(1);
      else expect(fundingSdk.prepareFunding).not.toHaveBeenCalled();
    },
  );
  it.each(["L1", "L18", "L32", "L33", "L37", "L34"] as const)("C18: the send shows only %s", async (label) => {
    sendOutcome();
    if (label === "L1") vi.mocked(fundingSdk.approveAndFund).mockResolvedValue({ outcome: "indeterminate" } as fundingSdk.FundingResult);
    if (label === "L32") vi.mocked(fundingSdk.ensureEscrow).mockResolvedValue({ outcome: "absent" } as fundingSdk.EnsureEscrowResult);
    if (label === "L33") vi.mocked(fundingSdk.approveAndFund).mockResolvedValue({ outcome: "unchanged" } as fundingSdk.FundingResult);
    if (label === "L37") vi.mocked(fundingSdk.ensureEscrow).mockResolvedValue(readyEscrow({ kind: "mined" }));
    if (label === "L37" || label === "L34") vi.mocked(fundingSdk.approveAndFund).mockRejectedValue(new fundingSdk.FundingRefusal("SIMULATION_REVERTED", "PRIVATE_ERROR"));
    await sendFromChecked(); onlyResult(label);
    expect(fundingSdk.ensureEscrow).toHaveBeenCalledTimes(1); expect(fundingSdk.approveAndFund).toHaveBeenCalledTimes(label === "L32" ? 0 : 1);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Check again")).toBe(label !== "L18");
  });
  it("C18: an indeterminate escrow setup shows L1 with Check again", async () => {
    vi.mocked(fundingSdk.ensureEscrow).mockResolvedValue({ outcome: "indeterminate" } as fundingSdk.EnsureEscrowResult);
    await sendFromChecked(); onlyResult("L1"); button("Check again"); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
  });
  it("wallet availability controls both buyer buttons", async () => {
    clients.walletClient = undefined; await render(); text(FUND_COPY.L25);
    expect(container.textContent).not.toContain(FUND_COPY.L27); expect(fundingSdk.prepareFunding).not.toHaveBeenCalled();
    clients.walletClient = { account: { address: wallet.address }, getChainId } as unknown as WalletClient;
    await render(); await click(FUND_COPY.L27); button(FUND_COPY.L28);
    clients.walletClient = undefined; await render(); text(FUND_COPY.L25);
    expect(container.textContent).not.toContain(FUND_COPY.L28); expect(fundingSdk.ensureEscrow).not.toHaveBeenCalled();
  });
  it("C22: the signed-in payer supplies the expectation even with another wallet account", async () => {
    clients.walletClient = { account: { address: golden.typedData.message.operator }, getChainId } as unknown as WalletClient;
    vi.mocked(fundingSdk.prepareFunding).mockRejectedValue(new fundingSdk.FundingRefusal("PAYER_NOT_SIGNER", "hidden"));
    await checkFromTerms(); onlyResult("L5");
    const input = vi.mocked(fundingSdk.dryRunUnitTestnetExpectation).mock.calls[0]![0];
    expect(input.fundingWallet).toBe(wallet.address);
    expect(input.subject.payer).toBe(sdkActual.value!.dryRunUnitPrincipalWord(wallet.address));
    expect(vi.mocked(fundingSdk.prepareFunding).mock.calls[0]![0].expect.payer).toBe(wallet.address);
    expect(fundingSdk.ensureEscrow).not.toHaveBeenCalled(); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
  });
  it("C28: Base mainnet served terms stop at L23 before the SDK", async () => {
    sendRouting(undefined, { ...terms(), chainId: "8453" }); await render(); onlyResult("L23");
    expect(sdkCounts().every((count) => count === 0)).toBe(true); expect(getChainId).not.toHaveBeenCalled();
  });
  it("C29: a mainnet wallet stops before the SDK and sends nothing", async () => {
    getChainId.mockResolvedValue(8453); await checkFromTerms(); onlyResult("L16"); button(FUND_COPY.L36);
    expect(getChainId).toHaveBeenCalledTimes(1); expect(getBlock).not.toHaveBeenCalled();
    expect(sdkCounts().every((count) => count === 0)).toBe(true); expect(clients.mutateAsync).not.toHaveBeenCalled();
  });
  it("C30: a switch restarts the complete check using the latest render's client", async () => {
    const held = deferred<void>(); clients.mutateAsync.mockReturnValueOnce(held.promise);
    getChainId.mockResolvedValue(8453); await checkFromTerms();
    await click(FUND_COPY.L36); expect(clients.mutateAsync).toHaveBeenCalledWith({ chainId: 84532 });
    expect([...container.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    const nextChain = vi.fn(async () => 84532);
    const nextWallet = { account: { address: wallet.address }, getChainId: nextChain } as unknown as WalletClient;
    clients.walletClient = nextWallet; await render();
    await act(async () => held.resolve()); button(FUND_COPY.L28);
    expect(nextChain).toHaveBeenCalledTimes(1); expect(getChainId).toHaveBeenCalledTimes(1); expect(getBlock).toHaveBeenCalledTimes(1);
    expect(authorizedFetch.mock.calls.filter(([path]) => path === "/api/jobs/job%2Fone")).toHaveLength(2);
    expect(authorizedFetch.mock.calls.filter(([path]) => path === "/api/kernels/kernel%2Fone")).toHaveLength(2);
    expect(fundingSdk.prepareFunding).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fundingSdk.prepareFunding).mock.calls[0]![0].wallet).toBe(nextWallet);
  });
  it("C30: a rejected switch keeps L16 and its switch button", async () => {
    getChainId.mockResolvedValue(8453); clients.mutateAsync.mockRejectedValueOnce(new Error("PRIVATE_SWITCH"));
    await checkFromTerms(); await click(FUND_COPY.L36); onlyResult("L16"); expect(button(FUND_COPY.L36).disabled).toBe(false);
    expect(container.textContent).not.toContain("PRIVATE_SWITCH"); expect(getChainId).toHaveBeenCalledTimes(1);
    expect(fundingSdk.prepareFunding).not.toHaveBeenCalled();
  });
  it("C31: a double Fund click creates one send using the click render's wallet", async () => {
    sendOutcome(); const held = deferred<fundingSdk.EnsureEscrowResult>(); vi.mocked(fundingSdk.ensureEscrow).mockReturnValueOnce(held.promise);
    await checkFromTerms();
    const nextWallet = { account: { address: wallet.address }, getChainId } as unknown as WalletClient;
    clients.walletClient = nextWallet; await render();
    await act(async () => { button(FUND_COPY.L28).click(); button(FUND_COPY.L28).click(); });
    expect(fundingSdk.ensureEscrow).toHaveBeenCalledTimes(1); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
    await act(async () => held.resolve(readyEscrow())); onlyResult("L18");
    expect(fundingSdk.ensureEscrow).toHaveBeenCalledTimes(1); expect(fundingSdk.approveAndFund).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fundingSdk.ensureEscrow).mock.calls[0]![0].wallet).toBe(nextWallet);
  });
  it("C32: funded_ours starts PCC polling without offering Fund", async () => {
    vi.mocked(fundingSdk.readFundedState).mockResolvedValue({ kind: "funded_ours" } as fundingSdk.FundedState);
    await checkFromTerms(); onlyResult("L18"); expect(container.textContent).not.toContain(FUND_COPY.L28);
    const count = authorizedFetch.mock.calls.length; await advance(15_000); expect(authorizedFetch).toHaveBeenCalledTimes(count + 1);
    expect(fundingSdk.ensureEscrow).not.toHaveBeenCalled(); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
  });
  it.each(["committed", "chain_mismatch"])("C33: a remount attaches to a send's display and %s result without another SDK call", async (outcome) => {
    sendOutcome(); const held = deferred<fundingSdk.EnsureEscrowResult>(); vi.mocked(fundingSdk.ensureEscrow).mockReturnValueOnce(held.promise);
    if (outcome === "chain_mismatch") vi.mocked(fundingSdk.approveAndFund).mockRejectedValue(new fundingSdk.FundingRefusal("CHAIN_MISMATCH", "hidden"));
    await sendFromChecked(); const counts = sdkCounts();
    await act(async () => root.unmount()); root = createRoot(container); await render();
    text(FUND_COPY.L35); text(golden.escrow); expect(container.textContent).not.toContain(FUND_COPY.L19);
    expect([...container.querySelectorAll("button")].every((b) => b.disabled)).toBe(true); noSdkSince(counts);
    await act(async () => held.resolve(readyEscrow())); onlyResult(outcome === "committed" ? "L18" : "L16");
    expect(container.textContent).not.toContain(FUND_COPY.L36);
    expect(fundingSdk.ensureEscrow).toHaveBeenCalledTimes(1); expect(fundingSdk.approveAndFund).toHaveBeenCalledTimes(1);
  });
  it("C35: changing address closes checked and reads R1 again", async () => {
    await checkFromTerms(); const before = authorizedFetch.mock.calls.length;
    await act(async () => useAuthStore.setState({ address: golden.typedData.message.operator as Address }));
    text(FUND_COPY.L19); expect(container.textContent).not.toContain(FUND_COPY.L28);
    expect(authorizedFetch).toHaveBeenCalledTimes(before + 2);
    expect(fundingSdk.ensureEscrow).not.toHaveBeenCalled(); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
  });
  it("C36: short test USDC balance displays both amounts without Fund", async () => {
    readContract.mockResolvedValue(250000n); await checkFromTerms(); onlyResult("L29");
    expect(container.textContent).not.toContain(FUND_COPY.L28); expect(fundingSdk.ensureEscrow).not.toHaveBeenCalled(); expect(fundingSdk.approveAndFund).not.toHaveBeenCalled();
  });
  it("C19: P3 reads every 15s and only accepts this scope's PCC verification", async () => {
    sendOutcome(); await sendFromChecked(); const calls = authorizedFetch.mock.calls.length, counts = sdkCounts();
    sendRouting(() => json(funding([scope(), verifiedScope("scope/newer")])));
    await advance(14_999); expect(authorizedFetch).toHaveBeenCalledTimes(calls); onlyResult("L18");
    await advance(1); expect(authorizedFetch).toHaveBeenCalledTimes(calls + 1); onlyResult("L18");
    await advance(15_000); expect(authorizedFetch).toHaveBeenCalledTimes(calls + 2); onlyResult("L18");
    sendRouting(() => { throw new Error("hidden"); }); await advance(15_000); onlyResult("L18");
    sendRouting(() => json(funding([verifiedScope(), scope("awaiting_funding", "scope/newer")])));
    await advance(15_000); text(FUND_COPY.L17); text(golden.escrow); text(new Date(NOW + 5000).toISOString());
    noSdkSince(counts); expect(vi.getTimerCount()).toBe(0);
    const after = authorizedFetch.mock.calls.length; await advance(7_200_000); expect(authorizedFetch).toHaveBeenCalledTimes(after); noSdkSince(counts);
  });
  it.each(["committed", "indeterminate"] as const)("C19: P3 caps %s at 40 minutes, then stays stopped", async (outcome) => {
    sendOutcome(outcome); await sendFromChecked();
    if (outcome === "indeterminate") { onlyResult("L1"); button("Check again"); }
    const counts = sdkCounts();
    await advance(2_399_999); onlyResult(outcome === "committed" ? "L18" : "L1");
    await advance(1); onlyResult("L1"); button("Check again"); expect(vi.getTimerCount()).toBe(0);
    const calls = authorizedFetch.mock.calls.length; await advance(7_200_000); expect(authorizedFetch).toHaveBeenCalledTimes(calls); noSdkSince(counts);
  });
  it("C19: P3 keeps its cadence and cap while a PCC answer is held", async () => {
    sendOutcome(); await sendFromChecked();
    const held = deferred<Response>(), calls = authorizedFetch.mock.calls.length, counts = sdkCounts();
    sendRouting(() => held.promise);
    await advance(45_000); expect(authorizedFetch).toHaveBeenCalledTimes(calls + 3); onlyResult("L18");
    expect(vi.getTimerCount()).toBe(1);
    await advance(2_355_000); onlyResult("L1"); button("Check again"); expect(vi.getTimerCount()).toBe(0);
    const after = authorizedFetch.mock.calls.length;
    await act(async () => held.resolve(json(funding([verifiedScope()])))); onlyResult("L1");
    await advance(7_200_000); expect(authorizedFetch).toHaveBeenCalledTimes(after); noSdkSince(counts);
  });
  it("C19: Check again stops P3, drops a held answer, and runs R1 once", async () => {
    sendOutcome("indeterminate"); await sendFromChecked(); onlyResult("L1"); button("Check again");
    const held = deferred<Response>(); sendRouting(() => held.promise);
    const counts = sdkCounts(); await advance(15_000);
    sendRouting(() => json(funding([scope("cancelled")])));
    const before = authorizedFetch.mock.calls.length; await click("Check again");
    text(FUND_COPY.L12); expect(authorizedFetch).toHaveBeenCalledTimes(before + 1);
    await act(async () => held.resolve(json(funding([verifiedScope()]))));
    text(FUND_COPY.L12); expect(container.textContent).not.toContain(FUND_COPY.L17);
    await advance(7_200_000); expect(authorizedFetch).toHaveBeenCalledTimes(before + 1); noSdkSince(counts); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["check", "send", "P3"] as const)("C20: key renewal during %s is absorbed and work continues", async (step) => {
    useAuthStore.setState({ sessionKeyId: "held-key" });
    const heldCheck = deferred<fundingSdk.PreparedFunding>(), heldSend = deferred<fundingSdk.EnsureEscrowResult>();
    if (step === "check") vi.mocked(fundingSdk.prepareFunding).mockReturnValueOnce(heldCheck.promise);
    else { sendOutcome(); if (step === "send") vi.mocked(fundingSdk.ensureEscrow).mockReturnValueOnce(heldSend.promise); }
    await checkFromTerms(); if (step !== "check") await click(FUND_COPY.L28);
    const count = authorizedFetch.mock.calls.length;
    if (step === "P3") await advance(5000);
    await act(async () => useAuthStore.setState({ keyEpoch: useAuthStore.getState().keyEpoch + 1 }));
    expect(authorizedFetch).toHaveBeenCalledTimes(count);
    if (step === "check") { await act(async () => heldCheck.resolve(checkedPrepared())); button(FUND_COPY.L28); expect(fundingSdk.prepareFunding).toHaveBeenCalledTimes(1); }
    if (step === "send") { await act(async () => heldSend.resolve(readyEscrow())); onlyResult("L18"); await advance(15_000); expect(authorizedFetch).toHaveBeenCalledTimes(count + 1); }
    if (step === "P3") { onlyResult("L18"); await advance(9999); expect(authorizedFetch).toHaveBeenCalledTimes(count); await advance(1); expect(authorizedFetch).toHaveBeenCalledTimes(count + 1); }
  });
  it.each(["check", "send"] as const)("late %s results cannot replace a new identity's R1", async (step) => {
    const heldCheck = deferred<fundingSdk.PreparedFunding>(), heldSend = deferred<fundingSdk.EnsureEscrowResult>();
    if (step === "check") vi.mocked(fundingSdk.prepareFunding).mockReturnValueOnce(heldCheck.promise);
    else { sendOutcome(); vi.mocked(fundingSdk.ensureEscrow).mockReturnValueOnce(heldSend.promise); }
    await checkFromTerms(); if (step === "send") await click(FUND_COPY.L28);
    sendRouting(() => json(funding([scope("cancelled")])));
    await act(async () => useAuthStore.setState({ sessionToken: "new-session" })); text(FUND_COPY.L12);
    await act(async () => { if (step === "check") heldCheck.resolve(checkedPrepared()); else heldSend.resolve(readyEscrow()); });
    text(FUND_COPY.L12); expect(container.textContent).not.toContain(FUND_COPY.L28); expect(vi.getTimerCount()).toBe(0);
  });
  it("C34: after a module reload, the SDK's pending guard refuses a new send", async () => {
    sendOutcome("indeterminate"); await sendFromChecked(); onlyResult("L1");
    await act(async () => root.unmount()); vi.resetModules();
    const { FundPage: ReloadedPage } = await import("../pages/FundPage.js");
    const reloadedSdk = await import("@pcc/spec/funding");
    const { useAuthStore: reloadedAuth } = await import("../stores/auth-store.js");
    reloadedAuth.setState({ address: wallet.address, sessionToken: "reload-session", isAuthenticated: true });
    for (const name of ["dryRunUnitPrincipalWord", "dryRunUnitTestnetExpectation"] as const) vi.mocked(reloadedSdk[name]).mockImplementation(sdkActual.value![name] as never);
    vi.mocked(reloadedSdk.prepareFunding).mockResolvedValue(checkedPrepared());
    vi.mocked(reloadedSdk.readFundedState).mockResolvedValue({ kind: "unfunded" } as fundingSdk.FundedState);
    vi.mocked(reloadedSdk.ensureEscrow).mockRejectedValue(new reloadedSdk.FundingRefusal("PAYER_TX_PENDING", "hidden"));
    root = createRoot(container);
    await act(async () => root.render(<ReloadedPage jobId="job/one" />)); await click(FUND_COPY.L27); await click(FUND_COPY.L28); onlyResult("L31");
    expect(reloadedSdk.readFundedState).toHaveBeenCalledTimes(1); expect(reloadedSdk.ensureEscrow).toHaveBeenCalledTimes(1); expect(reloadedSdk.approveAndFund).not.toHaveBeenCalled();
    await act(async () => root.unmount()); unmounted = true;
  });
});

it("C37: funding source has no credential entry or account construction", () => {
  for (const name of ["../lib/fund-send.ts", "../lib/fund-api.ts", "../pages/FundPage.tsx"]) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    expect(source).not.toMatch(/privatekey|mnemonic|seed phrase|secret recovery|hdkey/i);
  }
});

describe("order operator reads", () => {
  it("reads encoded job and kernel ids, lowercases the operator and preserves the served payload", async () => {
    const operator = `0x${"aB".repeat(20)}`;
    authorizedFetch.mockResolvedValueOnce(json({ job: { kernelId: "kernel/one" } })).mockResolvedValueOnce(json({ kernel: { operatorAddress: operator } }));
    expect(await readOrderOperator("job/one")).toBe(operator.toLowerCase());
    expect(authorizedFetch.mock.calls.map(([path]) => path)).toEqual(["/api/jobs/job%2Fone", "/api/kernels/kernel%2Fone"]);
    for (const [, init] of authorizedFetch.mock.calls) expect(init).toEqual({ method: "GET", credentials: "omit", cache: "no-store" });
    expect(readServedTerms(JSON.stringify(terms()))).toMatchObject({ payload: terms() });
  });
  it.each(["job", "kernel"])("maps every status on the %s read", async (step) => {
    for (const [status, expected] of [[401, SIGN_IN_EXPIRED], [403, SIGN_IN_REFUSED], [404, FUND_COPY.L7], [500, FUND_COPY.L4], [202, FUND_COPY.L4]] as const) {
      if (step === "kernel") authorizedFetch.mockResolvedValueOnce(json({ job: { kernelId: "kernel/one" } }));
      authorizedFetch.mockResolvedValueOnce(json({}, status));
      await expect(readOrderOperator("job/one")).rejects.toThrow(expected);
    }
  });
  it.each([{}, null, [], { job: {} }, { job: { kernelId: "" } }, { job: { kernelId: 1 } }])("rejects malformed job %#", async (body) => {
    authorizedFetch.mockResolvedValueOnce(json(body)); await expect(readOrderOperator("job/one")).rejects.toThrow(FUND_COPY.L4);
  });
  it.each([{}, null, [], { kernel: null }, { kernel: [] }])("rejects malformed kernel %#", async (body) => {
    authorizedFetch.mockResolvedValueOnce(json({ job: { kernelId: "kernel/one" } })).mockResolvedValueOnce(json(body));
    await expect(readOrderOperator("job/one")).rejects.toThrow(FUND_COPY.L4);
  });
  it.each([undefined, "", "0x123", `0x${"g".repeat(40)}`, 1])("rejects malformed operator %#", async (operatorAddress) => {
    authorizedFetch.mockResolvedValueOnce(json({ job: { kernelId: "kernel/one" } })).mockResolvedValueOnce(json({ kernel: { operatorAddress } }));
    await expect(readOrderOperator("job/one")).rejects.toThrow(FUND_COPY.L23);
  });
  it.each(["job", "kernel"])("rejects non-JSON %s bodies", async (step) => {
    if (step === "kernel") authorizedFetch.mockResolvedValueOnce(json({ job: { kernelId: "kernel/one" } }));
    authorizedFetch.mockResolvedValueOnce(new Response("{")); await expect(readOrderOperator("job/one")).rejects.toThrow(FUND_COPY.L4);
  });
});
