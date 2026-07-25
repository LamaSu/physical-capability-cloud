import { describe, expect, it, vi } from "vitest";

import { ZeonAdapter, TEM1_REQUIRED_LABWARE } from "../adapter.js";
import { ZeonSyncClient, ZeonSyncError, ZEON_ROUTES } from "../sync-client.js";
import { buildZeonTem1Manifest, TEM1_WORKFLOW_STEPS } from "../manifest.js";

const TOKEN = "zat_test_token";

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return vi.fn(async (url: unknown, init?: unknown) => {
    const body = handler(String(url), init as RequestInit);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
}

describe("ZeonSyncClient", () => {
  it("rejects a token that is not zat_-prefixed", () => {
    expect(() => new ZeonSyncClient({ apiToken: "nope" })).toThrow(/zat_/);
  });

  it("requires a token", () => {
    expect(() => new ZeonSyncClient({ apiToken: "" })).toThrow(/apiToken/);
  });

  it("sends a bearer token and resolves /me", async () => {
    let seenAuth = "";
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      seenAuth = ((init as RequestInit).headers as Record<string, string>)
        .Authorization;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ user_id: "u1", email: "a@b.c", org_id: "o1" }),
      } as Response;
    }) as unknown as typeof fetch;

    const c = new ZeonSyncClient({ apiToken: TOKEN, fetchImpl });
    const me = await c.me();
    expect(me.org_id).toBe("o1");
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("surfaces the server detail on error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ detail: "admin only", code: "FORBIDDEN" }),
    } as Response)) as unknown as typeof fetch;
    const c = new ZeonSyncClient({ apiToken: TOKEN, fetchImpl });
    await expect(c.listMeshDatabase()).rejects.toThrow(/admin only/);
    await expect(c.listMeshDatabase()).rejects.toBeInstanceOf(ZeonSyncError);
  });

  it("exposes no execution route", () => {
    const paths = Object.values(ZEON_ROUTES).map((r) => r.path);
    for (const forbidden of ["/runs", "/execute", "/simulate", "/jobs"]) {
      expect(paths.some((p) => p.includes(forbidden))).toBe(false);
    }
  });
});

describe("ZeonAdapter.checkLabware", () => {
  it("splits available from missing and offers near-matches", async () => {
    const fetchImpl = mockFetch(() => ({
      items: [
        { name: "wellplate_96_flat" },
        { name: "wellplate_pcr" },
        { name: "cold_block" },
      ],
    }));
    const a = new ZeonAdapter({ apiToken: TOKEN, projectId: "p1", fetchImpl });
    const res = await a.checkLabware();
    expect(res.available).toContain("wellplate_96_flat");
    expect(res.missing).toContain("tiprack");
    expect(res.ready).toBe(false);
    // wellplate_pcr resembles the round-bottom requirement
    expect(res.candidates["wellplate_96_round"]).toContain("wellplate_pcr");
  });

  it("is ready only when every requirement resolves", async () => {
    const fetchImpl = mockFetch(() => ({
      items: TEM1_REQUIRED_LABWARE.map((n) => ({ name: n })),
    }));
    const a = new ZeonAdapter({ apiToken: TOKEN, projectId: "p1", fetchImpl });
    const res = await a.checkLabware();
    expect(res.ready).toBe(true);
    expect(res.missing).toEqual([]);
  });
});

describe("ZeonAdapter.prepareRun", () => {
  it("always returns a human step and never claims execution", async () => {
    const fetchImpl = mockFetch(() => ({
      files: { "workflows/screen_plate.json": {} },
    }));
    const a = new ZeonAdapter({ apiToken: TOKEN, projectId: "p1", fetchImpl });
    const run = await a.prepareRun({ workflowId: "screen_plate" });
    expect(run.humanStep.kind).toBe("human_step");
    expect(run.humanStep.reason).toMatch(/no execution route/i);
    expect(run.warnings).toEqual([]);
    // The adapter must not grow a start method that pretends otherwise.
    expect((a as unknown as Record<string, unknown>).startRun).toBeUndefined();
  });

  it("warns when the workflow is absent from the snapshot", async () => {
    const fetchImpl = mockFetch(() => ({
      files: { "workflows/other.json": {} },
    }));
    const a = new ZeonAdapter({ apiToken: TOKEN, projectId: "p1", fetchImpl });
    const run = await a.prepareRun({ workflowId: "screen_plate" });
    expect(run.warnings.join(" ")).toMatch(/not in the project snapshot/);
  });

  it("warns on a staged file over Zeon's silent 16 MB push limit", async () => {
    const fetchImpl = mockFetch(() => ({ files: {} }));
    const a = new ZeonAdapter({ apiToken: TOKEN, projectId: "p1", fetchImpl });
    const run = await a.prepareRun({
      workflowId: "screen_plate",
      skipVerify: true,
      files: { "data/big.json": "x".repeat(17 * 1024 * 1024) },
    });
    expect(run.warnings.join(" ")).toMatch(/16 MB/);
  });

  it("refuses analysis calls when no bridge is configured", async () => {
    const a = new ZeonAdapter({ apiToken: TOKEN, projectId: "p1" });
    await expect(a.analyzePlate({ traces: {} })).rejects.toThrow(/bridgeUrl/);
  });
});

describe("manifest", () => {
  it("builds a valid manifest and caps assurance at tier 1", () => {
    const m = buildZeonTem1Manifest({
      endpointURL: "https://example.org/kernel",
      builderAgentId: "eip155:8453:0xabc",
    });
    expect(m.kernelId).toBe("zeon.tem1-screen");
    expect(m.maxAssuranceTier).toBe(1);
    expect(m.workflowSteps).toHaveLength(3);
  });

  it("rejects a non-HTTPS endpoint", () => {
    expect(() =>
      buildZeonTem1Manifest({
        endpointURL: "http://insecure",
        builderAgentId: "eip155:8453:0xabc",
      }),
    ).toThrow(/HTTPS/);
  });

  it("declares a linear DAG with resolvable dependencies", () => {
    const ids = new Set(TEM1_WORKFLOW_STEPS.map((s) => s.stepId));
    for (const s of TEM1_WORKFLOW_STEPS) {
      for (const dep of s.dependsOn) expect(ids.has(dep)).toBe(true);
    }
  });

  it("has no step that claims to execute the robot", () => {
    const text = JSON.stringify(TEM1_WORKFLOW_STEPS).toLowerCase();
    for (const w of ["run_workflow", "start_run", "execute_robot", "drive_arm"]) {
      expect(text).not.toContain(w);
    }
  });
});
