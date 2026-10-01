/**
 * services/kernel-emergency-stop.ts: the one answer to "may this kernel be given
 * work right now?" (adk #4446). Every job-creating path and both node queues ask
 * it, so its three outcomes are pinned here:
 *
 *   stored policy with emergencyStop -> 409 kernel_emergency_stopped
 *   no policy row                    -> not stopped
 *   policy cannot be read            -> 503 policy_unavailable, never "not stopped"
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "@pcc/store";
import {
  KernelNotAcceptingJobsError,
  assertKernelAcceptsJobs,
  checkKernelAcceptsJobs,
} from "../services/kernel-emergency-stop.js";
import * as dbModule from "../db.js";
import { closeStore, getStore, initStore } from "../db.js";

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
});

afterAll(() => {
  closeStore();
});

/** Store `policyText` verbatim as the kernel's policy column (JSON text, or garbage). */
function storePolicyText(kernelId: string, policyText: string): void {
  getStore().db.run(
    sql`INSERT OR REPLACE INTO operator_policies (kernel_id, policy, updated_at, updated_by)
        VALUES (${kernelId}, ${policyText}, ${new Date().toISOString()}, ${"test"})`,
  );
}
const storePolicy = (kernelId: string, policy: unknown) => storePolicyText(kernelId, JSON.stringify(policy));

const STOPPED = { ok: false, status: 409, error: "kernel_emergency_stopped" };
const UNAVAILABLE = { ok: false, status: 503, error: "policy_unavailable" };

describe("checkKernelAcceptsJobs", () => {
  it("no policy row is not stopped", () => {
    expect(checkKernelAcceptsJobs(uid("none"))).toEqual({ ok: true });
  });

  it("a stored policy with emergencyStop false is not stopped", () => {
    const id = uid("false");
    storePolicy(id, { version: 1, emergencyStop: false });
    expect(checkKernelAcceptsJobs(id)).toEqual({ ok: true });
  });

  it("a stored policy without an emergencyStop field is not stopped", () => {
    const id = uid("absent");
    storePolicy(id, { version: 1, approvalMode: "manual" });
    expect(checkKernelAcceptsJobs(id)).toEqual({ ok: true });
  });

  it("a stored policy with emergencyStop true is 409 kernel_emergency_stopped, and says which kernel", () => {
    const id = uid("true");
    storePolicy(id, { version: 1, emergencyStop: true });
    const verdict = checkKernelAcceptsJobs(id);
    expect(verdict).toMatchObject(STOPPED);
    expect((verdict as { message: string }).message).toContain(id);
  });

  it.each([
    ["the string 'true'", "true"],
    ["the string 'false' (any truthy value stops: the safe direction)", "false"],
    ["the number 1", 1],
    ["an object", {}],
  ])("a truthy non-boolean emergencyStop stops the kernel: %s", (_label, value) => {
    const id = uid("truthy");
    storePolicy(id, { version: 1, emergencyStop: value });
    expect(checkKernelAcceptsJobs(id)).toMatchObject(STOPPED);
  });

  it.each([
    ["JSON that cannot be parsed", "{not json"],
    ["a JSON null", "null"],
    ["a JSON number", "5"],
    ["a JSON string", '"stopped"'],
  ])("a stored policy that is not a readable object is 503 policy_unavailable, never 'not stopped': %s", (_label, text) => {
    const id = uid("unreadable");
    storePolicyText(id, text);
    expect(checkKernelAcceptsJobs(id)).toMatchObject(UNAVAILABLE);
  });

  it("a policy table that cannot be queried is 503 policy_unavailable (a real SQLite error)", () => {
    const { db } = getStore();
    db.run(sql`ALTER TABLE operator_policies RENAME TO operator_policies_unavailable`);
    try {
      expect(checkKernelAcceptsJobs(uid("table"))).toMatchObject(UNAVAILABLE);
    } finally {
      db.run(sql`ALTER TABLE operator_policies_unavailable RENAME TO operator_policies`);
    }
  });

  it("a store that cannot be opened is 503 policy_unavailable", () => {
    const spy = vi.spyOn(dbModule, "getStore").mockImplementation(() => {
      throw new Error("store unavailable");
    });
    try {
      expect(checkKernelAcceptsJobs(uid("store"))).toMatchObject(UNAVAILABLE);
    } finally {
      spy.mockRestore();
    }
  });

  it("never throws, whatever the kernel id", () => {
    for (const bad of ["", "   ", "no/such kernel", { a: 1 } as never, null as never, undefined as never]) {
      expect(() => checkKernelAcceptsJobs(bad)).not.toThrow();
    }
  });

  it("a stop is read from the store each time: resuming is seen at once", () => {
    const id = uid("flip");
    storePolicy(id, { version: 1, emergencyStop: true });
    expect(checkKernelAcceptsJobs(id)).toMatchObject(STOPPED);
    storePolicy(id, { version: 1, emergencyStop: false });
    expect(checkKernelAcceptsJobs(id)).toEqual({ ok: true });
  });
});

describe("assertKernelAcceptsJobs", () => {
  it("returns for a kernel that is not stopped", () => {
    expect(() => assertKernelAcceptsJobs(uid("assert-ok"))).not.toThrow();
  });

  it("throws a KernelNotAcceptingJobsError with the code, status and kernel of a stop", () => {
    const id = uid("assert-stop");
    storePolicy(id, { version: 1, emergencyStop: true });
    let thrown: unknown;
    try {
      assertKernelAcceptsJobs(id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(KernelNotAcceptingJobsError);
    expect(thrown).toMatchObject({
      name: "KernelNotAcceptingJobsError",
      code: "kernel_emergency_stopped",
      status: 409,
      kernelId: id,
    });
  });

  it("throws the 503 form when the policy cannot be read", () => {
    const id = uid("assert-unreadable");
    storePolicyText(id, "{not json");
    expect(() => assertKernelAcceptsJobs(id)).toThrowError(KernelNotAcceptingJobsError);
    try {
      assertKernelAcceptsJobs(id);
    } catch (e) {
      expect(e).toMatchObject({ code: "policy_unavailable", status: 503, kernelId: id });
    }
  });
});
