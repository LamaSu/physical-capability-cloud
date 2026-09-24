/**
 * The operator data layer returns only what the gateway returned.
 *
 * Every function here used to live inline in the operator pages with a
 * fallback that invented a value when the request failed or was rejected:
 * an IPFS-looking CID and a 94% anti-spoof score, a 91% "match", an
 * "issue filed" receipt, three sample jobs, and a STOPPED machine. These
 * tests pin the replacement contract: a failure is `{ ok: false }` with a
 * reason, and an action counts as done only when the gateway's answer
 * confirms it.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import {
  base64FromDataUrl,
  kernelsOf,
  checkPhoto,
  comparePhotos,
  decideApproval,
  emergencyResume,
  emergencyStop,
  listKernelJobs,
  listPendingApprovals,
  readRegistration,
  readStopState,
  sendSupportReport,
} from "../operator-api.js";

type Reply = { status: number; body?: unknown; raw?: string } | "network-error";

/** A fetch that answers by "METHOD path?query" first, then by "METHOD path". */
function fakeFetch(routes: Record<string, Reply>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const pathWithQuery = url.replace(/^https?:\/\/[^/]+/, "");
    const path = pathWithQuery.split("?")[0]!;
    calls.push({ url: pathWithQuery, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = routes[`${method} ${pathWithQuery}`] ?? routes[`${method} ${path}`] ?? "network-error";
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => {
        if (reply.raw !== undefined) throw new SyntaxError("Unexpected token");
        return reply.body;
      },
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("kernelsOf: the account's machines, or null (never an empty list by default)", () => {
  const me = (kernels: unknown) => ({ ok: true, as_of: "t", identity: { operator: "o", key_id: "k", key_name: null, scopes: [] }, kernels }) as never;

  it("returns the items when the section is present", () => {
    expect(kernelsOf(me({ count: 1, items: [{ id: "k1", name: "n", status: "online", last_heartbeat: null }] }))).toEqual([
      { id: "k1", name: "n", status: "online", last_heartbeat: null },
    ]);
    expect(kernelsOf(me({ count: 0, items: [] }))).toEqual([]);
  });

  it("is null when the section is missing, malformed or unavailable", () => {
    expect(kernelsOf(undefined)).toBeNull();
    expect(kernelsOf(me(undefined))).toBeNull();
    expect(kernelsOf(me({ count: null, items: [], unavailable: "db timeout" }))).toBeNull();
    expect(kernelsOf(me({ count: 1, items: "nope" }))).toBeNull();
  });
});

describe("emergencyStop: stopped only when the gateway confirms it for this machine", () => {
  it("confirmed stop", async () => {
    const f = fakeFetch({ "POST /api/operator/emergency-stop": { status: 200, body: { stopped: true, kernelId: "k1", timestamp: "2026-09-24T17:00:00Z" } } });
    const r = await emergencyStop("k1", undefined, f.impl);
    expect(r).toEqual({ kernelId: "k1", state: "stopped", at: "2026-09-24T17:00:00Z" });
    expect(f.calls[0]!.body).toMatchObject({ kernelId: "k1" });
  });

  it.each([
    ["network error", "network-error" as Reply],
    ["403 not the kernel's operator", { status: 403, body: { error: "not_kernel_operator", message: "You can only act for a kernel you operate" } } as Reply],
    ["500", { status: 500, body: { error: "Failed to activate emergency stop" } } as Reply],
    ["200 without stopped:true", { status: 200, body: { ok: true } } as Reply],
    ["200 confirming a different kernel", { status: 200, body: { stopped: true, kernelId: "kernel-nanoclaw" } } as Reply],
    ["200 with a body that is not JSON", { status: 200, raw: "<html>" } as Reply],
  ])("%s -> NOT stopped", async (_name, reply) => {
    const f = fakeFetch({ "POST /api/operator/emergency-stop": reply });
    const r = await emergencyStop("k1", undefined, f.impl);
    expect(r.state).toBe("not_stopped");
    expect(r.kernelId).toBe("k1");
  });

  it("a 403 keeps the gateway's own message", async () => {
    const f = fakeFetch({ "POST /api/operator/emergency-stop": { status: 403, body: { error: "not_kernel_operator", message: "You can only act for a kernel you operate" } } });
    const r = await emergencyStop("k1", undefined, f.impl);
    expect(r).toMatchObject({ state: "not_stopped", status: 403 });
    expect(r.state === "not_stopped" && r.reason).toContain("You can only act for a kernel you operate");
  });
});

describe("emergencyResume", () => {
  it("resumed only on { resumed: true } for this machine", async () => {
    expect((await emergencyResume("k1", fakeFetch({ "POST /api/operator/emergency-resume": { status: 200, body: { resumed: true, kernelId: "k1" } } }).impl)).state).toBe("resumed");
    expect((await emergencyResume("k1", fakeFetch({ "POST /api/operator/emergency-resume": { status: 404, body: { error: "No policy found for kernel" } } }).impl)).state).toBe("not_resumed");
    expect((await emergencyResume("k1", fakeFetch({ "POST /api/operator/emergency-resume": { status: 200, body: {} } }).impl)).state).toBe("not_resumed");
    expect((await emergencyResume("k1", fakeFetch({}).impl)).state).toBe("not_resumed");
  });
});

describe("readStopState", () => {
  it("the gateway's default policy means no stop is recorded", async () => {
    const f = fakeFetch({ "GET /api/operator/policy/k1": { status: 200, body: { policy: { emergencyStop: false }, source: "default" } } });
    expect(await readStopState("k1", f.impl)).toEqual({ ok: true, data: { stopped: false, recorded: false, updatedAt: null } });
  });

  it("a recorded stop", async () => {
    const f = fakeFetch({ "GET /api/operator/policy/k1": { status: 200, body: { policy: { emergencyStop: true }, updatedAt: "t" } } });
    expect(await readStopState("k1", f.impl)).toEqual({ ok: true, data: { stopped: true, recorded: true, updatedAt: "t" } });
  });

  it("a failed or malformed read is unavailable, never 'running'", async () => {
    expect((await readStopState("k1", fakeFetch({ "GET /api/operator/policy/k1": { status: 503, body: { error: "read_failed" } } }).impl)).ok).toBe(false);
    expect((await readStopState("k1", fakeFetch({ "GET /api/operator/policy/k1": { status: 200, body: { source: "default" } } }).impl)).ok).toBe(false);
    expect((await readStopState("k1", fakeFetch({}).impl)).ok).toBe(false);
  });
});

describe("approvals", () => {
  const row = (id: string, kernelId: string, status = "pending") => ({
    id,
    kernelId,
    jobId: `job-${id}`,
    submittedBy: "agent-7",
    jobSummary: { capabilityType: "liquid-handler", parameters: {} },
    status,
    createdAt: "2026-09-24T16:00:00Z",
    expiresAt: "2026-09-25T16:00:00Z",
  });

  it("maps the real row shape and keeps only my kernels' pending rows", async () => {
    const f = fakeFetch({
      "GET /api/operator/approvals?kernelId=k1&status=pending": { status: 200, body: { approvals: [row("a1", "k1"), row("x", "someone-elses-kernel"), row("a2", "k1", "approved")] } },
      "GET /api/operator/approvals?kernelId=k2&status=pending": { status: 200, body: { approvals: [row("b1", "k2")] } },
    });
    const r = await listPendingApprovals(["k1", "k2"], f.impl);
    expect(r.ok && r.data.map((a) => a.id)).toEqual(["a1", "b1"]);
    expect(r.ok && r.data[0]).toEqual({
      id: "a1",
      kernelId: "k1",
      jobId: "job-a1",
      requestedBy: "agent-7",
      capabilityType: "liquid-handler",
      createdAt: "2026-09-24T16:00:00Z",
      expiresAt: "2026-09-25T16:00:00Z",
    });
  });

  it("one kernel's failed read makes the whole list unavailable, not shorter", async () => {
    const f = fakeFetch({
      "GET /api/operator/approvals?kernelId=k1&status=pending": { status: 200, body: { approvals: [row("a1", "k1")] } },
      "GET /api/operator/approvals?kernelId=k2&status=pending": { status: 500, body: { error: "boom" } },
    });
    expect((await listPendingApprovals(["k1", "k2"], f.impl)).ok).toBe(false);
  });

  it("approve/reject count as done only on the confirming field", async () => {
    expect(await decideApproval("a1", "approve", fakeFetch({ "POST /api/operator/approvals/a1/approve": { status: 200, body: { approved: true } } }).impl)).toEqual({ ok: true, data: { id: "a1", status: "approved" } });
    expect(await decideApproval("a1", "reject", fakeFetch({ "POST /api/operator/approvals/a1/reject": { status: 200, body: { rejected: true } } }).impl)).toEqual({ ok: true, data: { id: "a1", status: "rejected" } });
    expect((await decideApproval("a1", "approve", fakeFetch({ "POST /api/operator/approvals/a1/approve": { status: 404, body: { error: "Approval not found or already decided" } } }).impl)).ok).toBe(false);
    expect((await decideApproval("a1", "approve", fakeFetch({ "POST /api/operator/approvals/a1/approve": { status: 200, body: {} } }).impl)).ok).toBe(false);
    expect((await decideApproval("a1", "reject", fakeFetch({}).impl)).ok).toBe(false);
  });
});

describe("listKernelJobs", () => {
  it("unwraps { jobs } for each of my kernels", async () => {
    const f = fakeFetch({
      "GET /api/jobs?kernelId=k1": { status: 200, body: { jobs: [{ id: "j1", kernelId: "k1", status: "in_progress" }] } },
      "GET /api/jobs?kernelId=k2": { status: 200, body: { jobs: [{ id: "j2", kernelId: "k2", status: "completed" }] } },
    });
    const r = await listKernelJobs(["k1", "k2"], f.impl);
    expect(r.ok && r.data.map((j) => j.id)).toEqual(["j1", "j2"]);
  });

  it("a bare array or a failure is not a job list", async () => {
    expect((await listKernelJobs(["k1"], fakeFetch({ "GET /api/jobs?kernelId=k1": { status: 200, body: [{ id: "j1" }] } }).impl)).ok).toBe(false);
    expect((await listKernelJobs(["k1"], fakeFetch({}).impl)).ok).toBe(false);
  });
});

describe("readRegistration", () => {
  it("the route's 200 { error: not_found } is 'not found', not an error and not a machine", async () => {
    expect(await readRegistration("reg-1", fakeFetch({ "GET /api/onboard/registrations/reg-1": { status: 200, body: { error: "not_found" } } }).impl)).toEqual({ ok: true, data: { found: false } });
  });

  it("a found registration is returned as the gateway sent it", async () => {
    const r = await readRegistration("reg-1", fakeFetch({ "GET /api/onboard/registrations/reg-1": { status: 200, body: { registration: { id: "reg-1", name: "Bench printer" } } } }).impl);
    expect(r).toEqual({ ok: true, data: { found: true, registration: { id: "reg-1", name: "Bench printer" } } });
  });

  it("a failure is unavailable", async () => {
    expect((await readRegistration("reg-1", fakeFetch({ "GET /api/onboard/registrations/reg-1": { status: 500, body: {} } }).impl)).ok).toBe(false);
  });
});

describe("photo check and compare send the fields the routes read", () => {
  it("checkPhoto posts { imageBase64 } and reports a hash-only reference as not stored", async () => {
    const f = fakeFetch({ "POST /api/photo/upload": { status: 200, body: { imageHash: "sha256:abc", cid: "photo:sha256:abc", antiSpoofScore: 0.42 } } });
    const r = await checkPhoto("QUJD", f.impl);
    expect(f.calls[0]!.body).toEqual({ imageBase64: "QUJD" });
    expect(r).toEqual({ ok: true, data: { imageHash: "sha256:abc", cid: "photo:sha256:abc", stored: false, antiSpoofScore: 0.42 } });
  });

  it("a storage CID is reported as stored", async () => {
    const r = await checkPhoto("QUJD", fakeFetch({ "POST /api/photo/upload": { status: 200, body: { imageHash: "h", cid: "bafy-real" } } }).impl);
    expect(r).toEqual({ ok: true, data: { imageHash: "h", cid: "bafy-real", stored: true, antiSpoofScore: null } });
  });

  it("a rejected or failed upload has no CID and no score", async () => {
    for (const reply of [
      { status: 400, body: { error: "missing_image", message: "Request body must include imageBase64" } },
      { status: 200, body: { ok: true } },
      "network-error" as const,
    ] as Reply[]) {
      const r = await checkPhoto("QUJD", fakeFetch({ "POST /api/photo/upload": reply }).impl);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/bafybei|0\.94/);
    }
  });

  it("comparePhotos posts captured + reference and returns the model's answer as given", async () => {
    const f = fakeFetch({
      "POST /api/photo/compare": { status: 200, body: { verdict: "mismatch", matchScore: 31, discrepancies: ["hole missing"], reasoning: "r", modelUsed: "m" } },
    });
    const r = await comparePhotos("CAP", "REF", f.impl);
    expect(f.calls[0]!.body).toEqual({ capturedImageBase64: "CAP", referenceImageBase64: "REF" });
    expect(r).toEqual({ ok: true, data: { verdict: "mismatch", matchScore: 31, discrepancies: ["hole missing"], reasoning: "r", modelUsed: "m" } });
  });

  it("a failed compare is not a match", async () => {
    const r = await comparePhotos("CAP", "REF", fakeFetch({ "POST /api/photo/compare": { status: 400, body: { error: "missing_reference_image" } } }).impl);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/"match"|0\.91/);
  });

  it("base64FromDataUrl strips the data: prefix", () => {
    expect(base64FromDataUrl("data:image/png;base64,QUJD")).toBe("QUJD");
    expect(base64FromDataUrl("QUJD")).toBe("QUJD");
  });
});

describe("sendSupportReport", () => {
  it("sent only when the gateway returns a thread id", async () => {
    const f = fakeFetch({ "POST /api/operator/support": { status: 200, body: { threadId: "thread-1", messageId: "m", isNewThread: true } } });
    expect(await sendSupportReport({ kernelId: "k1", message: "belt snapped" }, f.impl)).toEqual({ ok: true, data: { threadId: "thread-1", isNewThread: true } });
    expect(f.calls[0]!.body).toMatchObject({ kernelId: "k1", message: "belt snapped" });
  });

  it("a rejected, missing or unconfirmed report is not sent", async () => {
    for (const reply of [
      { status: 404, body: { error: "not_found" } },
      { status: 429, body: { error: "rate_limited", message: "Too many support messages." } },
      { status: 200, body: {} },
      "network-error" as const,
    ] as Reply[]) {
      const r = await sendSupportReport({ kernelId: "k1", message: "x" }, fakeFetch({ "POST /api/operator/support": reply }).impl);
      expect(r.ok).toBe(false);
    }
  });
});
