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
 * The fix is a gate around every name resolution (createDnsGate): at most
 * DNS_MAX_CONCURRENT lookups run, a slot is held until the lookup itself
 * settles, DNS_MAX_QUEUED more wait their turn, and the rest are refused at
 * once with a generic error.
 *
 * Nothing here uses real DNS or a socket that leaves the host: the resolver and
 * the transport are injected, and the production resolver is exercised with
 * dns.promises.lookup replaced by a stub.
 *
 * Groups:
 *   A  the reproduction, written BEFORE the fix: a resolver that counts its
 *      outstanding calls and never settles until released, 50 sends, 40 ms
 *      deadline. The outstanding count used to climb to 50.
 *   B  the gate through guardedFetch: the cap, the queue, prompt refusal, the
 *      lifetime of a slot (it returns when the lookup settles, not when the
 *      caller's deadline passes), leaving the queue, IP literals, normal sends,
 *      the production resolver.
 *   C  the channel send path: a refused send reads like every other refused
 *      destination and leaks nothing.
 *   D  connect time: the pinned lookup resolves nothing, so it needs no gate.
 *   E  the test seam: a fresh gate per install, and an injected gate is used.
 *   F  createDnsGate as a unit: aborted signals and queue departures.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import {
  attachChannel,
  dispatchToChannels,
  _clearOperatorChannelsForTests,
} from "../routes/operator-channels.js";

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
 * The shipped bounds (DNS_MAX_CONCURRENT and DNS_MAX_QUEUED in the guard). Written
 * out here, not imported, so that raising either one is a decision somebody has
 * to make in this file too, and so the reproduction could run against code that
 * had no such constants.
 */
const CAP = 8;
const QUEUE = 16;

const GENERIC_FAILURE = "webhook destination is not reachable or not permitted";

/** A host name no assertion may find in an error, a result or a log line. */
const H = (name: string | number) => `${name}.leakcheck.test`;

/** A macrotask boundary: every promise reaction queued so far has run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

// ── fixtures ─────────────────────────────────────────────────────────────────

interface Held {
  answer: () => void;
  fail: (e: Error) => void;
}

const probes: Array<{ drain: () => Promise<void> }> = [];
const inflight: Array<Promise<unknown>> = [];

/** A resolver that counts its outstanding calls and never settles until released. */
function holdingResolver() {
  const pending: Held[] = [];
  const state = { calls: 0, outstanding: 0, peak: 0, hosts: [] as string[] };
  const resolve = (host: string) => {
    state.calls++;
    state.outstanding++;
    state.peak = Math.max(state.peak, state.outstanding);
    state.hosts.push(host);
    return new Promise<Array<{ address: string; family: 4 | 6 }>>((done, failed) => {
      pending.push({
        answer: () => {
          state.outstanding--;
          done([{ address: PUBLIC_V4, family: 4 }]);
        },
        fail: (e) => {
          state.outstanding--;
          failed(e);
        },
      });
    });
  };
  /** The OLDEST hanging lookup finally answers (its caller may be long gone). */
  const releaseOne = () => pending.shift()?.answer();
  /** Every hanging lookup answers, including those that start because a slot came back. */
  const drain = async () => {
    while (pending.length > 0) {
      pending.shift()!.answer();
      await flush();
    }
  };
  const probe = { state, resolve, releaseOne, drain };
  probes.push(probe);
  return probe;
}

/** A transport that records its calls and answers 200 without a socket. */
function countingTransport() {
  const state = { calls: 0, addresses: [] as unknown[] };
  const transport = async (req: { addresses: unknown }) => {
    state.calls++;
    state.addresses.push(req.addresses);
    return { status: 200, headers: {}, bytesRead: 0, truncated: false };
  };
  return { state, transport };
}

type Outcome = { ok: true; res: { status: number; ok: boolean } } | { ok: false; err: any };

interface Sent {
  host: string;
  /** True once the send has finished, one way or the other. */
  settled: boolean;
  outcome: Promise<Outcome>;
}

/** Starts a guarded send to `host` (a DNS name); the outcome never rejects. */
function send(g: Guard, host: string, over: Record<string, unknown>, timeoutMs = 3000): Sent {
  const sent = { host, settled: false } as Sent;
  sent.outcome = g
    .guardedFetch(`https://${host}/hook`, { ...POST_INIT, timeoutMs }, over as never)
    .then(
      (res): Outcome => ({ ok: true, res }),
      (err): Outcome => ({ ok: false, err }),
    )
    .finally(() => {
      sent.settled = true;
    });
  inflight.push(sent.outcome);
  return sent;
}

const quickResolver = async () => [{ address: PUBLIC_V4, family: 4 as const }];

afterEach(async () => {
  // let everything a test left hanging finish, so no timer or promise outlives it
  for (const p of probes.splice(0)) await p.drain();
  await Promise.allSettled(inflight.splice(0));
  vi.restoreAllMocks();
  (await loadGuard())._setOutboundDepsForTests(null);
  _clearOperatorChannelsForTests();
});

// ── A: the reproduction ──────────────────────────────────────────────────────

describe("N84 DNS bound A: reproduction (a deadline does not stop the lookup)", () => {
  it("50 sends that each time out at 40 ms leave at most CAP resolver calls outstanding (injected resolver that never settles)", async () => {
    const g = await loadGuard();
    const probe = holdingResolver();
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
    await probe.drain();
    expect(sent.calls, "a late DNS answer must not dispatch the timed-out send").toBe(0);

    // the finding: the lookups behind those 50 timeouts were all still running
    expect(
      afterTimeouts.peak,
      `peak outstanding resolver calls after 50 timed-out sends (calls started: ${afterTimeouts.calls}, still outstanding: ${afterTimeouts.outstanding})`,
    ).toBeLessThanOrEqual(CAP);
  }, 20_000);

  it("a burst of 50 sends through the PRODUCTION resolver starts at most CAP native lookups (dns.promises.lookup stubbed, no real DNS)", async () => {
    const g = await loadGuard();
    const native = holdingResolver();
    vi.spyOn(dns.promises, "lookup").mockImplementation(native.resolve as never);
    const { state: sent, transport } = countingTransport();
    g._setOutboundDepsForTests(null); // production resolver, production gate

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => g.guardedFetch(URL_, { ...POST_INIT, timeoutMs: 40 }, { transport } as never)),
    );

    // control: every caller is released at its deadline (or refused), none is dispatched
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(sent.calls).toBe(0);

    // control: late native answers must not resume the sends that gave up
    const afterBurst = { ...native.state };
    await native.drain();
    expect(sent.calls, "a late DNS answer must not dispatch a timed-out send").toBe(0);

    // the finding: 50 callers gave up, 50 native lookups were still running
    expect(
      afterBurst.peak,
      `peak outstanding native lookups after a burst of 50 (calls started: ${afterBurst.calls}, still outstanding: ${afterBurst.outstanding})`,
    ).toBeLessThanOrEqual(CAP);
  });
});

// ── B: the gate through guardedFetch ─────────────────────────────────────────

describe("N84 DNS bound B: the gate through guardedFetch", () => {
  it("[neg] at most maxConcurrent lookups run at once; a queued send starts only when a lookup settles, in arrival order; the rest are refused on the spot", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 2, maxQueued: 3 });
    const probe = holdingResolver();
    const { state: sent, transport } = countingTransport();
    const over = { dnsGate: gate, resolve: probe.resolve, transport };

    const sends = Array.from({ length: 10 }, (_, i) => send(g, H(i), over));
    await flush();

    // 2 lookups running, 3 sends waiting their turn, 5 refused at once
    expect(probe.state.hosts).toEqual([H(0), H(1)]);
    expect(probe.state.outstanding).toBe(2);
    expect(sends.map((s) => s.settled)).toEqual([false, false, false, false, false, true, true, true, true, true]);
    for (const s of sends.slice(5)) {
      const out = await s.outcome;
      expect(out).toMatchObject({ ok: false, err: { code: "dns_busy" } });
    }
    expect(sent.calls).toBe(0);

    // each lookup that settles hands its slot to exactly one waiting send, oldest first
    probe.releaseOne();
    await flush();
    expect(probe.state.hosts).toEqual([H(0), H(1), H(2)]);
    expect(probe.state.outstanding).toBe(2);
    probe.releaseOne();
    await flush();
    expect(probe.state.hosts).toEqual([H(0), H(1), H(2), H(3)]);
    probe.releaseOne();
    await flush();
    expect(probe.state.hosts).toEqual([H(0), H(1), H(2), H(3), H(4)]);
    expect(probe.state.outstanding).toBe(2);

    await probe.drain();
    const admitted = await Promise.all(sends.slice(0, 5).map((s) => s.outcome));
    expect(admitted.every((o) => o.ok)).toBe(true);
    expect(sent.calls).toBe(5);
    expect(probe.state.calls).toBe(5);
    expect(probe.state.peak, "never more than maxConcurrent lookups outstanding").toBe(2);
  });

  it("with the shipped defaults a burst of 50 starts 8 lookups, queues 16 and refuses the other 26 at once", async () => {
    const g = await loadGuard();
    expect([g.DNS_MAX_CONCURRENT, g.DNS_MAX_QUEUED]).toEqual([CAP, QUEUE]);
    const probe = holdingResolver();
    const { state: sent, transport } = countingTransport();
    g._setOutboundDepsForTests({ resolve: probe.resolve, transport }); // a fresh production gate

    const sends = Array.from({ length: 50 }, (_, i) => send(g, H(i), {}));
    await flush();

    expect(probe.state.calls).toBe(CAP);
    const refused = sends.filter((s) => s.settled);
    expect(refused).toHaveLength(50 - CAP - QUEUE);
    for (const s of refused) expect(await s.outcome).toMatchObject({ ok: false, err: { code: "dns_busy" } });

    // each settled lookup lets one queued send start; the count never passes the cap
    for (let i = 0; i < CAP + QUEUE; i++) {
      probe.releaseOne();
      await flush();
      expect(probe.state.outstanding).toBeLessThanOrEqual(CAP);
    }
    expect(probe.state.calls).toBe(CAP + QUEUE);
    expect(probe.state.peak).toBe(CAP);
    await probe.drain();
    const admitted = await Promise.all(sends.slice(0, CAP + QUEUE).map((s) => s.outcome));
    expect(admitted.every((o) => o.ok)).toBe(true);
    expect(sent.calls).toBe(CAP + QUEUE);
  });

  it("[neg] a send refused for want of a slot fails at once with a generic error, long before its deadline, and never reaches the resolver or the transport", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 0 });
    const probe = holdingResolver();
    const { state: sent, transport } = countingTransport();
    const over = { dnsGate: gate, resolve: probe.resolve, transport };
    const holder = send(g, H("holder"), over); // takes the only slot and never answers
    await flush();

    const started = performance.now();
    const refused = await send(g, H("refused"), over, 3000).outcome;
    const elapsed = performance.now() - started;
    expect(elapsed, `refused after ${elapsed.toFixed(0)} ms against a 3000 ms deadline`).toBeLessThan(250);
    expect(refused).toMatchObject({ ok: false, err: { name: "OutboundError", code: "dns_busy", message: "outbound DNS busy" } });
    const err = (refused as { ok: false; err: Error & { reason?: string; cause?: unknown } }).err;
    expect(err.reason).toBeUndefined();
    expect(err.cause).toBeUndefined();
    expect([err.message, err.reason, err.stack, JSON.stringify(err)].join("\n")).not.toMatch(/leakcheck/);
    expect(probe.state.calls, "the refused send never reached the resolver").toBe(1);
    expect(sent.calls).toBe(0);

    // a refusal costs the send that holds the slot nothing
    await probe.drain();
    expect((await holder.outcome).ok).toBe(true);
  });

  it("the deadline frees the caller, not the slot: a slot comes back only when its lookup settles", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 2, maxQueued: 2 });
    const probe = holdingResolver();
    const { state: sent, transport } = countingTransport();
    const over = { dnsGate: gate, resolve: probe.resolve, transport };
    const a = send(g, H("a"), over, 40); // gives up at 40 ms; its lookup keeps running
    const b = send(g, H("b"), over, 40);
    const c = send(g, H("c"), over, 3000); // waits behind a and b
    await flush();
    expect(probe.state.hosts).toEqual([H("a"), H("b")]);

    // a and b are released at their deadline...
    expect(await a.outcome).toMatchObject({ ok: false, err: { code: "timeout" } });
    expect(await b.outcome).toMatchObject({ ok: false, err: { code: "timeout" } });
    // ...but their lookups are still running, so their slots are still taken and c has not started
    expect(probe.state.outstanding).toBe(2);
    expect(probe.state.hosts).toEqual([H("a"), H("b")]);
    expect(c.settled).toBe(false);

    // only when an underlying lookup settles does c get its turn
    probe.releaseOne(); // a's lookup answers, late: a's send is long gone
    await flush();
    expect(probe.state.hosts).toEqual([H("a"), H("b"), H("c")]);
    expect(sent.calls, "a's late answer must not dispatch a's send").toBe(0);
    probe.releaseOne(); // b's late answer
    probe.releaseOne(); // c's answer
    expect((await c.outcome).ok).toBe(true);
    expect(sent.calls, "only c was dispatched").toBe(1);
  });

  it("a lookup that fails, or throws, frees its slot as surely as one that answers", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 0 });
    const { state: sent, transport } = countingTransport();
    const failing = async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    };
    const throwing = () => {
      throw new Error("resolver blew up");
    };
    for (let i = 0; i < 5; i++) {
      for (const resolve of [failing, throwing]) {
        const out = await send(g, H(`f${i}`), { dnsGate: gate, resolve, transport }).outcome;
        // a leaked slot would turn this into dns_busy
        expect(out).toMatchObject({ ok: false, err: { code: "dns_failure", message: "name resolution failed" } });
      }
    }
    const after = await send(g, H("after"), { dnsGate: gate, resolve: quickResolver, transport }).outcome;
    expect(after.ok).toBe(true);
    expect(sent.calls).toBe(1);
  });

  it("[neg] a queued send whose deadline passes leaves the queue and never starts a lookup", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 1 });
    const probe = holdingResolver();
    const { state: sent, transport } = countingTransport();
    const over = { dnsGate: gate, resolve: probe.resolve, transport };
    const a = send(g, H("a"), over, 3000); // holds the only slot
    const b = send(g, H("b"), over, 40); // queued, gives up at 40 ms
    await flush();
    expect(probe.state.hosts).toEqual([H("a")]);
    expect(await b.outcome).toMatchObject({ ok: false, err: { code: "timeout" } });

    // b's place in the queue is free again: c is queued, not refused
    const c = send(g, H("c"), over, 3000);
    await flush();
    expect(c.settled).toBe(false);

    // a's lookup settles: c starts. b's lookup never does.
    probe.releaseOne();
    await flush();
    expect(probe.state.hosts).toEqual([H("a"), H("c")]);
    await probe.drain();
    expect((await a.outcome).ok).toBe(true);
    expect((await c.outcome).ok).toBe(true);
    expect(sent.calls, "a and c were dispatched, b never was").toBe(2);
    expect(probe.state.hosts).not.toContain(H("b"));
  });

  it("an IP-literal destination needs no resolution, so a saturated gate does not touch it", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 0 });
    const probe = holdingResolver();
    const { state: sent, transport } = countingTransport();
    const over = { dnsGate: gate, resolve: probe.resolve, transport };
    send(g, H("holder"), over); // saturates the gate
    await flush();
    const res = await g.guardedFetch(`https://${PUBLIC_V4}/hook`, POST_INIT, over as never);
    expect(res).toMatchObject({ status: 200, ok: true });
    expect(sent.calls).toBe(1);
    expect(probe.state.calls, "the literal was never resolved").toBe(1);
  });

  it("normal sends are untouched: the pinned answer reaches the transport, and successful sends do not leak slots", async () => {
    const g = await loadGuard();
    const { state: sent, transport } = countingTransport();
    // thirty sends one after another through a gate with ONE slot and no queue
    const tight = g.createDnsGate({ maxConcurrent: 1, maxQueued: 0 });
    for (let i = 0; i < 30; i++) {
      const res = await g.guardedFetch(URL_, POST_INIT, { resolve: quickResolver, transport, dnsGate: tight } as never);
      expect(res).toMatchObject({ status: 200, ok: true });
    }
    expect(sent.addresses.at(-1)).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    // a burst that fits (2 running + 4 queued) is served in full
    const roomy = g.createDnsGate({ maxConcurrent: 2, maxQueued: 4 });
    const burst = await Promise.all(
      Array.from({ length: 6 }, () => g.guardedFetch(URL_, POST_INIT, { resolve: quickResolver, transport, dnsGate: roomy } as never)),
    );
    expect(burst.every((r) => r.ok)).toBe(true);
    expect(sent.calls).toBe(36);
  });

  it("the production resolver is gated too: its slots come back as the native lookups settle", async () => {
    const g = await loadGuard();
    const native = holdingResolver();
    vi.spyOn(dns.promises, "lookup").mockImplementation(native.resolve as never);
    const { state: sent, transport } = countingTransport();
    g._setOutboundDepsForTests(null); // production resolver, production gate

    // 30 sends give up after 40 ms: 8 native lookups start and stay hung, 16 queued sends leave, 6 are refused
    const burst = Array.from({ length: 30 }, (_, i) => send(g, H(`n${i}`), { transport }, 40));
    await Promise.all(burst.map((s) => s.outcome));
    expect(native.state.calls).toBe(CAP);

    // a new send waits behind the 8 hung lookups...
    const later = send(g, H("later"), { transport }, 3000);
    await flush();
    expect(native.state.calls).toBe(CAP);
    expect(later.settled).toBe(false);
    // ...and starts when one of them finally settles
    native.releaseOne();
    await flush();
    expect(native.state.calls).toBe(CAP + 1);
    await native.drain();
    expect((await later.outcome).ok).toBe(true);
    expect(sent.calls, "only the send that waited was dispatched").toBe(1);
  });
});

// ── C: the channel send path ─────────────────────────────────────────────────

describe("N84 DNS bound C: through the channel send path", () => {
  it("[neg] a send refused because resolution is saturated reads exactly like any other refused destination and leaks neither the host nor the reason", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 0 });
    const probe = holdingResolver();
    const { state: sent, transport } = countingTransport();
    g._setOutboundDepsForTests({ resolve: probe.resolve, transport, dnsGate: gate });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    send(g, H("holder"), {}); // a lookup that never answers holds the only slot
    await flush();

    const payload = { jobId: "j", contextRef: "c", summary: "s" };
    const endpoint = { url: `https://${H("victim")}/hook` };
    attachChannel("n84-dns-busy", { label: "gate-probe", transport: "webhook", describe: "resolution saturated", endpoint });
    const busy = await dispatchToChannels("n84-dns-busy", payload);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ delivered: false, error: "send_failed", warning: GENERIC_FAILURE });
    expect(JSON.stringify(busy)).not.toMatch(/busy|dns|resolv|victim|leakcheck/i);
    expect(sent.calls).toBe(0);
    expect(probe.state.calls, "the refused send never reached the resolver").toBe(1);

    // the operator log keeps the code (so saturation is visible) and never the host
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain('"code":"dns_busy"');
    expect(logged).not.toMatch(/victim|leakcheck/);

    // word for word what a destination that resolves to a private address reads like
    g._setOutboundDepsForTests({ resolve: async () => [{ address: "10.0.0.5", family: 4 }], transport });
    attachChannel("n84-dns-blocked", { label: "gate-probe", transport: "webhook", describe: "private answer", endpoint });
    const blocked = await dispatchToChannels("n84-dns-blocked", payload);
    const bare = ({ channelId: _id, ...rest }: Record<string, unknown>) => rest;
    expect(bare(busy[0] as never)).toEqual(bare(blocked[0] as never));
  });
});

// ── D: connect time ──────────────────────────────────────────────────────────

describe("N84 DNS bound D: connect time resolves nothing", () => {
  it("the transport can ask for the connect-time lookup any number of times; neither the resolver nor node:dns is consulted again", async () => {
    const g = await loadGuard();
    const spies = [
      vi.spyOn(dns, "lookup"),
      vi.spyOn(dns, "resolve"),
      vi.spyOn(dns, "resolve4"),
      vi.spyOn(dns, "resolve6"),
      vi.spyOn(dns.promises, "lookup"),
    ];
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 0 });
    let resolverCalls = 0;
    const resolve = async () => {
      resolverCalls++;
      return [{ address: PUBLIC_V4, family: 4 as const }];
    };
    const seen: Array<{ sync: boolean; args: unknown[] }> = [];
    const transport = async (req: any) => {
      for (let i = 0; i < 100; i++) {
        const rec = { sync: false, args: [] as unknown[] };
        req.lookup(HOST, i % 2 === 0 ? { all: true } : {}, (...args: unknown[]) => {
          rec.sync = true;
          rec.args = args;
        });
        seen.push(rec);
      }
      return { status: 200, headers: {}, bytesRead: 0, truncated: false };
    };
    const res = await g.guardedFetch(URL_, POST_INIT, { resolve, transport, dnsGate: gate } as never);
    expect(res.ok).toBe(true);
    expect(resolverCalls, "resolved exactly once, at send time").toBe(1);
    expect(seen).toHaveLength(100);
    expect(seen.every((r) => r.sync), "the pinned lookup answers synchronously, from memory").toBe(true);
    expect(seen[0]!.args).toEqual([null, [{ address: PUBLIC_V4, family: 4 }]]);
    expect(seen[1]!.args).toEqual([null, PUBLIC_V4, 4]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("[neg] node's own socket layer, handed the pinned lookup, never falls back to node:dns (real transport, blocked pin, no socket is opened)", async () => {
    const g = await loadGuard();
    // control: WITHOUT a lookup option node does go to dns.lookup. The stub fails at once, so nothing is resolved.
    const stub = vi.spyOn(dns, "lookup").mockImplementation(((_h: string, _o: unknown, cb: (e: Error) => void) => {
      cb(Object.assign(new Error("stubbed"), { code: "ESTUB" }));
    }) as never);
    await new Promise<void>((done) => {
      const r = http.request({ hostname: H("control"), port: 9, agent: false });
      r.on("error", () => done());
      r.end();
    });
    expect(stub, "control: node consults dns.lookup when no lookup option is given").toHaveBeenCalled();
    stub.mockClear();

    const pins = [{ address: "10.0.0.5", family: 4 as const }]; // blocked: the pinned lookup refuses it
    const lookup = vi.fn(g.createPinnedLookup(pins));
    const err = await g
      .nodeTransport({
        url: new URL(`http://${H("pinned")}:9/`),
        addresses: pins,
        lookup,
        method: "POST",
        headers: {},
        body: "x",
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        signal: new AbortController().signal,
      } as never)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "request_failed" });
    expect(lookup, "node asked OUR lookup").toHaveBeenCalled();
    expect(stub, "and never went to dns.lookup").not.toHaveBeenCalled();
  });
});

// ── E: the test seam ─────────────────────────────────────────────────────────

describe("N84 DNS bound E: the test seam", () => {
  it("every install starts from a fresh gate: slots a previous install left held do not count against the next", async () => {
    const g = await loadGuard();
    const probe = holdingResolver();
    const { transport } = countingTransport();
    g._setOutboundDepsForTests({ resolve: probe.resolve, transport }); // gate one, shipped limits
    for (let i = 0; i < CAP + QUEUE; i++) send(g, H(i), {}); // fills it: 8 running, 16 waiting
    const extra = send(g, H("extra"), {});
    await flush();
    expect(await extra.outcome).toMatchObject({ ok: false, err: { code: "dns_busy" } });

    g._setOutboundDepsForTests({ resolve: quickResolver, transport }); // gate two
    const res = await g.guardedFetch(URL_, POST_INIT);
    expect(res.ok).toBe(true);
  });

  it("a gate handed to the seam is the one guardedFetch uses when the call passes none", async () => {
    const g = await loadGuard();
    const probe = holdingResolver();
    const { transport } = countingTransport();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 0 });
    g._setOutboundDepsForTests({ resolve: probe.resolve, transport, dnsGate: gate });
    send(g, H("a"), {});
    const b = send(g, H("b"), {});
    await flush();
    expect(b.settled).toBe(true);
    expect(await b.outcome).toMatchObject({ ok: false, err: { code: "dns_busy" } });
    expect(probe.state.hosts).toEqual([H("a")]);
  });
});

// ── F: createDnsGate as a unit ───────────────────────────────────────────────

describe("N84 DNS bound F: createDnsGate", () => {
  it("[neg] a signal that is already aborted is refused without starting any work", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate();
    const ctl = new AbortController();
    ctl.abort();
    let started = 0;
    await expect(
      gate.run(async () => {
        started++;
        return 1;
      }, ctl.signal),
    ).rejects.toMatchObject({ name: "OutboundError", code: "timeout" });
    expect(started).toBe(0);
  });

  it("[neg] a queued resolution whose signal aborts is rejected, frees its place in the queue and never starts", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 1 });
    let releaseFirst!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((r) => {
          releaseFirst = r;
        }),
      new AbortController().signal,
    );
    const ctl = new AbortController();
    let startedQueued = 0;
    const queued = gate
      .run(async () => {
        startedQueued++;
        return "queued";
      }, ctl.signal)
      .then(
        () => "resolved",
        (e: unknown) => e,
      );
    // the queue holds its one waiter: the next resolution is refused
    await expect(gate.run(async () => "third", new AbortController().signal)).rejects.toMatchObject({ code: "dns_busy" });

    ctl.abort();
    expect(await queued).toMatchObject({ name: "OutboundError", code: "timeout" });
    // its place is free again: a new resolution queues instead of being refused
    const again = gate.run(async () => "again", new AbortController().signal);
    releaseFirst();
    await first;
    expect(await again).toBe("again");
    expect(startedQueued, "the aborted resolution never started").toBe(0);
  });

  it("an abort that arrives after a queued resolution has started does not cancel it: its promise follows the lookup", async () => {
    const g = await loadGuard();
    const gate = g.createDnsGate({ maxConcurrent: 1, maxQueued: 1 });
    let releaseFirst!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((r) => {
          releaseFirst = r;
        }),
      new AbortController().signal,
    );
    const ctl = new AbortController();
    let finishQueued!: (v: string) => void;
    const queued = gate.run(
      () =>
        new Promise<string>((r) => {
          finishQueued = r;
        }),
      ctl.signal,
    );
    releaseFirst();
    await first;
    await flush(); // the queued resolution has its slot and its lookup is running
    ctl.abort(); // too late to leave the queue
    finishQueued("answer");
    expect(await queued).toBe("answer");
  });
});
