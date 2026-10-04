/**
 * astra pack consume1-576, HIGH: the emergency-stop check and the consume were separate
 * statements. Two gateway processes sharing one SQLite file could interleave: A reads "not
 * stopped", B commits an emergency stop, and A's UPDATE then consumes the approval, answering
 * 200 while the kernel is stopped.
 *
 * Reproduced deterministically with a second better-sqlite3 connection (process B) on the same
 * FILE database, and a hook that fires right after the route's policy check. B tries to commit a
 * stop in exactly that window. The property: a consume never succeeds after a stop committed.
 * Either B commits in the window and A refuses, or A's check and update hold one write lock, so
 * B cannot commit in the window at all (SQLITE_BUSY).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const hooks = vi.hoisted(() => ({ afterCheck: undefined as undefined | ((kernelId: string) => void) }));

vi.mock("../services/kernel-emergency-stop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/kernel-emergency-stop.js")>();
  return {
    ...actual,
    checkKernelAcceptsJobs: (kernelId: string) => {
      const verdict = actual.checkKernelAcceptsJobs(kernelId);
      hooks.afterCheck?.(kernelId);
      return verdict;
    },
  };
});

const dir = mkdtempSync(join("/mnt/sparkbulk/tmp", "consume-race-"));
const dbFile = join(dir, "race.db");
process.env.PCC_DB_PATH = dbFile;
process.env.PCC_SEED_DATA = "false";

type Conn = { prepare(sql: string): { run(...p: unknown[]): unknown }; close(): void };
let connB: Conn;
let app: FastifyInstance;
let ownerKey = "";
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });

let statusOf: (approvalId: string) => string | undefined;
let insertApproved: (kernelId: string) => string;

/** Process B commits an emergency stop for `kernelId` on its own connection (no busy wait). */
function stopViaB(kernelId: string): void {
  connB
    .prepare("INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by) VALUES (?, ?, ?, ?)")
    .run(kernelId, JSON.stringify({ version: 1, emergencyStop: true }), new Date().toISOString(), "process-B");
}

async function ownedKernel(prefix: string): Promise<string> {
  const id = uid(prefix);
  const res = await app.inject({ method: "POST", url: "/api/kernels", headers: asOwner(), payload: { id, name: `Race ${id}` } });
  expect(res.statusCode, res.body).toBe(201);
  return id;
}

beforeAll(async () => {
  const Fastify = (await import("fastify")).default;
  const { initStore, getStore } = await import("../db.js");
  const { schema, eq } = await import("@pcc/store");
  const { apiGate } = await import("../middleware/api-gate.js");
  const { kernelRoutes } = await import("../routes/kernels.js");
  const { operatorRoutes } = await import("../routes/operator.js");
  const { provisionApiKey } = await import("../auth/api-key-auth.js");
  initStore({ seed: false });
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(kernelRoutes);
  await app.register(operatorRoutes);
  await app.ready();
  ownerKey = provisionApiKey({ operatorId: "race-owner", scopes: ["operator"] }).rawKey;
  const { pendingApprovals } = schema;
  statusOf = (approvalId) =>
    getStore().db.select().from(pendingApprovals).where(eq(pendingApprovals.id, approvalId)).get()?.status;
  insertApproved = (kernelId) => {
    const id = uid("race-approval");
    const now = new Date().toISOString();
    getStore().db.insert(pendingApprovals).values({
      id,
      kernelId,
      jobId: uid("race-job"),
      submittedBy: "agent-race",
      jobSummary: { capabilityType: "liquid-handler", parameters: {} },
      status: "approved",
      createdAt: now,
      decidedAt: now,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    } as never).run();
    return id;
  };
  const req = createRequire(new URL("../../../db/package.json", import.meta.url));
  const Database = req("better-sqlite3") as new (file: string, opts: { timeout: number }) => Conn;
  connB = new Database(dbFile, { timeout: 0 });
}, 60_000);

afterAll(async () => {
  hooks.afterCheck = undefined;
  connB?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("approvals consume: the stop check and the consume are one atomic step (astra pack consume1-576)", () => {
  it("[neg] a stop committed between the route's policy check and its update never lets the consume through", async () => {
    const kernelId = await ownedKernel("race");
    const approvalId = insertApproved(kernelId);
    let bCommitted: boolean | null = null;
    let bError = "";
    hooks.afterCheck = (k) => {
      if (k !== kernelId || bCommitted !== null) return;
      try {
        stopViaB(kernelId);
        bCommitted = true;
      } catch (e) {
        bCommitted = false;
        bError = String((e as { code?: string }).code ?? e);
      }
    };
    const res = await app.inject({ method: "POST", url: `/api/operator/approvals/${approvalId}/consume`, headers: asOwner() });
    hooks.afterCheck = undefined;
    expect(bCommitted, "the window hook ran").not.toBeNull();
    if (bCommitted) {
      // B's stop landed inside the window: A must refuse, and the approval stays approved.
      expect(res.statusCode, res.body).toBe(409);
      expect(statusOf(approvalId)).toBe("approved");
    } else {
      // A held the write lock across its check and its update: B could not commit in between.
      expect(bError).toMatch(/SQLITE_BUSY/);
      expect(res.statusCode, res.body).toBe(200);
    }
  });

  it("control: a stop that committed BEFORE the consume is refused (409) and nothing is consumed", async () => {
    const kernelId = await ownedKernel("race-before");
    const approvalId = insertApproved(kernelId);
    stopViaB(kernelId);
    const res = await app.inject({ method: "POST", url: `/api/operator/approvals/${approvalId}/consume`, headers: asOwner() });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("kernel_emergency_stopped");
    expect(statusOf(approvalId)).toBe("approved");
  });
});
