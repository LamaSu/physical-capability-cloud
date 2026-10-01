/**
 * N84 follow-up (astra pack 144, MEDIUM): a DNS timeout does not bound the
 * outstanding resolver work.
 *
 * guardedFetch() gives a send a deadline, name resolution included, and
 * withDeadline() makes the CALLER stop waiting when it passes. It cannot stop
 * the lookup: dns.promises.lookup() is a getaddrinfo call on libuv's thread
 * pool (4 threads by default) and runs until the system resolver gives up. So
 * every slow lookup that times out leaves its native work behind, and repeated
 * sends pile that work up without limit even though each one returned after its
 * deadline. This is resource exhaustion, not an SSRF bypass: a late answer
 * never resumes a send that already timed out.
 *
 * This file starts as the reproduction (written BEFORE the fix): a resolver that
 * counts its outstanding calls and never settles until released, driven through
 * guardedFetch() with a 40 ms deadline. Today every call times out while the
 * outstanding count climbs to the number of calls. Nothing here uses real DNS or
 * a socket: the resolver and the transport are injected, and the production
 * resolver is exercised with dns.promises.lookup replaced by a stub.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";

type Guard = typeof import("../services/outbound-url-guard.js");
async function loadGuard(): Promise<Guard> {
  return await import("../services/outbound-url-guard.js");
}

const PUBLIC_V4 = "93.184.216.34";
const HOST = "hooks.n84.test";
const URL_ = `https://${HOST}/hook`;
const POST_INIT = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ hello: "n84" }),
};

/**
 * The bound the fix puts on concurrent resolutions (DNS_MAX_CONCURRENT in the
 * guard). Written out here, not imported, so this reproduction runs against code
 * that has no such constant yet, and so that raising the constant is a decision
 * somebody has to make in this file too.
 */
const CAP = 8;

/** A resolver that counts its outstanding calls and never settles until released. */
function holdingResolver() {
  const releasers: Array<() => void> = [];
  const state = { calls: 0, outstanding: 0, peak: 0 };
  const resolve = (_host: string) => {
    state.calls++;
    state.outstanding++;
    state.peak = Math.max(state.peak, state.outstanding);
    return new Promise<Array<{ address: string; family: 4 | 6 }>>((done) => {
      releasers.push(() => {
        state.outstanding--;
        done([{ address: PUBLIC_V4, family: 4 }]);
      });
    });
  };
  /** Settle every lookup still hanging (a late answer). */
  const releaseAll = () => {
    for (const release of releasers.splice(0)) release();
  };
  return { state, resolve, releaseAll };
}

/** A transport that records calls and answers 200 without a socket. */
function countingTransport() {
  const state = { calls: 0 };
  const transport = async () => {
    state.calls++;
    return { status: 200, headers: {}, bytesRead: 0, truncated: false };
  };
  return { state, transport };
}

const settleTimers = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("N84 DNS bound: reproduction (a deadline does not stop the lookup)", () => {
  let held: Array<{ releaseAll: () => void }> = [];

  afterEach(async () => {
    for (const h of held.splice(0)) h.releaseAll();
    vi.restoreAllMocks();
    (await loadGuard())._setOutboundDepsForTests(null);
  });

  it("50 sends that each time out at 40 ms leave at most CAP resolver calls outstanding (injected resolver that never settles)", async () => {
    const g = await loadGuard();
    const probe = holdingResolver();
    held.push(probe);
    const { state: sent, transport } = countingTransport();
    g._setOutboundDepsForTests({ resolve: probe.resolve, transport });

    const codes: string[] = [];
    for (let i = 0; i < 50; i++) {
      const err = await g.guardedFetch(URL_, { ...POST_INIT, timeoutMs: 40 }).catch((e: { code?: string }) => e);
      codes.push((err as { code?: string }).code ?? "returned");
    }

    // control: the CALLER is always released at its deadline, today and after the fix
    expect(codes.every((c) => c === "timeout"), `every send ends in a timeout, got ${[...new Set(codes)].join(",")}`).toBe(true);
    expect(sent.calls, "no send reaches the transport").toBe(0);

    // control: a late answer must never resume a send that already timed out
    const afterTimeouts = { ...probe.state };
    probe.releaseAll();
    await settleTimers();
    expect(sent.calls, "a late DNS answer must not dispatch the timed-out send").toBe(0);

    // the finding: the lookups behind those 50 timeouts were all still running
    expect(
      afterTimeouts.peak,
      `peak outstanding resolver calls after 50 timed-out sends (calls started: ${afterTimeouts.calls}, still outstanding: ${afterTimeouts.outstanding})`,
    ).toBeLessThanOrEqual(CAP);
  }, 20_000);

  it("a burst of 50 sends through the PRODUCTION resolver starts at most CAP native lookups (dns.promises.lookup stubbed, no real DNS)", async () => {
    const g = await loadGuard();
    const native = { calls: 0, outstanding: 0, peak: 0 };
    const releasers: Array<() => void> = [];
    held.push({ releaseAll: () => releasers.splice(0).forEach((r) => r()) });
    vi.spyOn(dns.promises, "lookup").mockImplementation((() => {
      native.calls++;
      native.outstanding++;
      native.peak = Math.max(native.peak, native.outstanding);
      return new Promise((done) => {
        releasers.push(() => {
          native.outstanding--;
          done([{ address: PUBLIC_V4, family: 4 }]);
        });
      });
    }) as never);
    const { state: sent, transport } = countingTransport();
    g._setOutboundDepsForTests(null); // production resolver, production gate

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => g.guardedFetch(URL_, { ...POST_INIT, timeoutMs: 40 }, { transport })),
    );

    // control: every caller is released at its deadline (or refused), none is dispatched
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(sent.calls).toBe(0);

    // control: late native answers must not resume the sends that gave up
    const afterBurst = { ...native };
    held.forEach((h) => h.releaseAll());
    await settleTimers();
    expect(sent.calls, "a late DNS answer must not dispatch a timed-out send").toBe(0);

    // the finding: 50 callers gave up, 50 native lookups were still running
    expect(
      afterBurst.peak,
      `peak outstanding native lookups after a burst of 50 (calls started: ${afterBurst.calls}, still outstanding: ${afterBurst.outstanding})`,
    ).toBeLessThanOrEqual(CAP);
  });
});
