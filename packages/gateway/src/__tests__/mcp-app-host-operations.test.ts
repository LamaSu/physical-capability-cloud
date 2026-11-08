/**
 * astra round 2 on #342, F2: a hosted view (an MCP App) runs an injected typed operation with no
 * kit-side approval and may run it again, so the injected list must hold ONLY read-only,
 * approval-"none" operations. operation-policy.ts enforces that at module load; these tests pin the
 * rule itself and its application to the live registry.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { APP_HOST_OPERATION_IDS, REGISTERED_OPERATION_IDS } from "../mcp/operation-ids.js";
import { appHostOperationViolations, getOperationPolicy } from "../mcp/operation-policy.js";

describe("hosted views are offered only read-only, approval-none typed operations", () => {
  it("every APP_HOST_OPERATION_ID is registered, read-only and approval none (the live registry)", () => {
    expect(appHostOperationViolations(APP_HOST_OPERATION_IDS, getOperationPolicy)).toEqual([]);
    for (const id of APP_HOST_OPERATION_IDS) expect(REGISTERED_OPERATION_IDS as readonly string[]).toContain(id);
    for (const id of APP_HOST_OPERATION_IDS) {
      const p = getOperationPolicy(id)!;
      expect(p.stateChanging, id).toBe(false);
      expect(p.approval, id).toBe("none");
    }
  });

  it("the rule refuses a state-changing, approval-requiring or unregistered operation", () => {
    const pol = (stateChanging: boolean, approval: string) => ({ stateChanging, approval }) as never;
    expect(appHostOperationViolations(["job.cancel"], () => pol(true, "standard"))).toEqual(["job.cancel: state-changing"]);
    expect(appHostOperationViolations(["escrow.release"], () => pol(false, "financial"))).toEqual([`escrow.release: approval "financial"`]);
    expect(appHostOperationViolations(["ghost.op"], () => null)).toEqual(["ghost.op: not registered"]);
    expect(appHostOperationViolations(["ok.op"], () => pol(false, "none"))).toEqual([]);
  });
});

describe("the MCP-App view injects the app-safe list, not every registered id", () => {
  // The two lists are equal today, so the served HTML alone cannot tell which one the view injects:
  // pin the source (a new registered op must never reach a hosted view's allowlist by default).
  const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../mcp/mcp-app-view.ts"), "utf8");
  it("mcp-app-view.ts injects JSON.stringify([...APP_HOST_OPERATION_IDS]) and never REGISTERED_OPERATION_IDS", () => {
    expect(src).toContain("const operationsLiteral = JSON.stringify([...APP_HOST_OPERATION_IDS]);");
    expect(src).not.toContain("REGISTERED_OPERATION_IDS");
  });
});
