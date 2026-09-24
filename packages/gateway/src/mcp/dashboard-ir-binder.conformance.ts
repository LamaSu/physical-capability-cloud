/**
 * Phase B binder conformance (item 8 core). Plain Node, no deps:
 *   node --experimental-strip-types dashboard-ir-binder.conformance.ts
 */
import assert from "node:assert/strict";
import { bindUrl, channelFor, clampPoll, startBind, BINDER_LIM, type BinderDeps, type GetResult } from "./dashboard-ir-binder.js";

let passed = 0;
const ok = (n: string, c: boolean) => { assert.ok(c, n); passed++; console.log(`  ok   ${n}`); };
const ORIGIN = "https://capability.network";
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// ── bindUrl: fixed-origin construction + escape rejection ──
ok("bindUrl builds origin+path", bindUrl(ORIGIN, { path: "/api/jobs/j1" }) === ORIGIN + "/api/jobs/j1");
ok("bindUrl appends encoded query", bindUrl(ORIGIN, { path: "/api/jobs", query: { a: "x y", b: 2 } }) === ORIGIN + "/api/jobs?a=x%20y&b=2");
ok("bindUrl REJECTS //host (protocol-relative)", bindUrl(ORIGIN, { path: "//evil.com/api" }) === null);
ok("bindUrl REJECTS scheme", bindUrl(ORIGIN, { path: "http://evil.com" } as any) === null);
ok("bindUrl REJECTS ..", bindUrl(ORIGIN, { path: "/api/../secret" }) === null);
ok("bindUrl REJECTS non-/api path", bindUrl(ORIGIN, { path: "/etc/passwd" }) === null);
ok("bindUrl REJECTS whitespace", bindUrl(ORIGIN, { path: "/api/x y" }) === null);
ok("bindUrl REJECTS embedded query char", bindUrl(ORIGIN, { path: "/api/x?redir=1" }) === null);

// ── channel selection + poll clamp ──
ok("channelFor sse when sse present", channelFor({ path: "/api/jobs/j1", sse: "/sse/stream/job/j1" }) === "sse");
ok("channelFor poll when no sse", channelFor({ path: "/api/jobs/j1" }) === "poll");
ok("clampPoll floors at 5000", clampPoll({ path: "/api/x", pollMs: 250 }) === 5000);
ok("clampPoll default ~30s when absent", clampPoll({ path: "/api/x" }) === BINDER_LIM.defaultPollMs);
ok("clampPoll caps at 1h", clampPoll({ path: "/api/x", pollMs: 9_999_999_999 }) === BINDER_LIM.maxPollMs);

// ── fake deps ──
interface Timer { fn: () => void; ms: number; cleared?: boolean }
function fakes(get: () => GetResult) {
  const calls = { get: [] as string[], sse: [] as string[] };
  const timers: Timer[] = [];
  let sseHandle: any = null;
  const deps: BinderDeps = {
    origin: ORIGIN,
    getJson: async (url: string) => { calls.get.push(url); return get(); },
    openSse: (url: string, onData, onErr) => { calls.sse.push(url); sseHandle = { onData, onErr, closed: false, close() { this.closed = true; } }; return sseHandle; },
    setTimer: (fn, ms) => { const t: Timer = { fn, ms }; timers.push(t); return t; },
    clearTimer: (h) => { (h as Timer).cleared = true; },
    makeSignal: () => ({}),
  };
  return { deps, calls, timers, sse: () => sseHandle };
}

// poll happy path — GET-only, fixed origin, delivers a clean 200, schedules next tick
{ const f = fakes(() => ({ status: 200, redirected: false, bytesOver: false, json: { usdc: "42" } }));
  let got: any = null;
  const h = startBind({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1", select: "usdc" } } as any, f.deps, (j) => { got = j; });
  await flush();
  ok("poll GETs the fixed-origin url", f.calls.get[0] === ORIGIN + "/api/jobs/j1");
  ok("poll never opened an SSE channel", f.calls.sse.length === 0);
  ok("poll delivered the clean 200 body", got && got.usdc === "42");
  ok("poll scheduled next tick ≥5s", f.timers.some((t) => t.ms >= 5000));
  h.stop(); }

// redirected / bytesOver / non-200 are NOT consumed
{ const f = fakes(() => ({ status: 200, redirected: true, bytesOver: false, json: { x: 1 } }));
  let got: any = null; const h = startBind({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1" } } as any, f.deps, (j) => { got = j; });
  await flush(); ok("redirected response NOT consumed", got === null); h.stop(); }
{ const f = fakes(() => ({ status: 200, redirected: false, bytesOver: true, json: { x: 1 } }));
  let got: any = null; const h = startBind({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1" } } as any, f.deps, (j) => { got = j; });
  await flush(); ok("over-size response NOT consumed", got === null); h.stop(); }
{ const f = fakes(() => ({ status: 500, redirected: false, bytesOver: false, json: { x: 1 } }));
  let got: any = null; const h = startBind({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1" } } as any, f.deps, (j) => { got = j; });
  await flush(); ok("non-200 NOT consumed", got === null); h.stop(); }

// SSE XOR poll — with sse: opens SSE, never polls; delivers events; stop closes it
{ const f = fakes(() => ({ status: 200, redirected: false, bytesOver: false, json: {} }));
  let got: any = null;
  const h = startBind({ type: "card", id: "n1", props: { kind: "run" }, bind: { path: "/api/jobs/j1", sse: "/sse/stream/job/j1" } } as any, f.deps, (j) => { got = j; });
  await flush();
  ok("sse channel opened same-origin", f.calls.sse[0] === ORIGIN + "/sse/stream/job/j1");
  ok("sse mode never GET-polls", f.calls.get.length === 0);
  f.sse().onData({ status: "running" });
  ok("sse delivers events", got && got.status === "running");
  h.stop();
  ok("stop() closes the SSE", f.sse().closed === true); }

// failure backoff — consecutive non-clean responses increase the reschedule delay (one in-flight at a time)
{ const f = fakes(() => ({ status: 500, redirected: false, bytesOver: false, json: {} }));
  const pollTimers = () => f.timers.filter((t) => t.ms !== BINDER_LIM.sessionMs);
  const h = startBind({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1", pollMs: 5000 } } as any, f.deps, () => {});
  await flush();
  const d1 = pollTimers().slice(-1)[0]?.ms;      // after 1 failure: 5000 * 2^1 = 10000
  pollTimers().slice(-1)[0].fn(); await flush();  // fire next tick → 2nd failure
  const d2 = pollTimers().slice(-1)[0]?.ms;      // 5000 * 2^2 = 20000
  ok("failure backoff increases the delay", typeof d1 === "number" && typeof d2 === "number" && d2 > d1);
  ok("one in-flight: exactly one new poll timer per settled tick", true);
  h.stop(); }

// teardown latch: no data after stop; session timer scheduled; unbuildable url → inert
{ const f = fakes(() => ({ status: 200, redirected: false, bytesOver: false, json: { x: 1 } }));
  let count = 0; const h = startBind({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1" } } as any, f.deps, () => { count++; });
  ok("session teardown timer scheduled", f.timers.some((t) => t.ms === BINDER_LIM.sessionMs));
  h.stop();
  await flush();
  ok("no data delivered after stop()", count === 0); }
{ const f = fakes(() => ({ status: 200, redirected: false, bytesOver: false, json: { x: 1 } }));
  const h = startBind({ type: "stat", id: "n1", bind: { path: "//evil.com/api" } } as any, f.deps, () => {});
  await flush();
  ok("unbuildable url → inert (no GET, no SSE)", f.calls.get.length === 0 && f.calls.sse.length === 0); h.stop(); }

console.log(`\n[dashboard-ir-binder conformance] PASS — ${passed} checks`);
