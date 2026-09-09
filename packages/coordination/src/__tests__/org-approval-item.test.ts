import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HumanQueueStore } from "../queue/human-queue.js";
import { listApprovals, resolveApproval, toOrgApprovalItem } from "../queue/org-approval-item.js";

function freshQueue(): HumanQueueStore {
  const dir = mkdtempSync(path.join(tmpdir(), "pcc-coordination-oai-"));
  return new HumanQueueStore({ path: path.join(dir, "queue.sqlite") });
}

describe("contract (a) — OrgApprovalItem mapping", () => {
  let queue: HumanQueueStore;
  afterEach(() => {
    queue?.close();
  });

  it("maps an observe-only escalation (no action) to authorityClass=observe/trustLevel=read/persona=user", () => {
    queue = freshQueue();
    const item = queue.enqueue({
      severity: "medium",
      category: "network_issue",
      title: "1 kernel stale",
      details: "details",
    });
    const mapped = toOrgApprovalItem(item);
    expect(mapped.authorityClass).toBe("observe");
    expect(mapped.trustLevel).toBe("read");
    expect(mapped.persona).toBe("user");
    expect(mapped.source).toBe("reaction-escalation");
    expect(mapped.status).toBe("pending");
    expect(mapped.severity).toBe("warn"); // "medium" collapses to "warn"
    expect(mapped.intent.action).toBe("network_issue"); // falls back to category with no action
    expect(mapped.verdict).toBeUndefined();
  });

  it("maps a dispatchable item (has action) to authorityClass=mutate/trustLevel=write/persona=orchestrator", () => {
    queue = freshQueue();
    const item = queue.enqueue({
      severity: "critical",
      category: "adapter_failure",
      title: "adapter down",
      details: "details",
      action: { workflowName: "retry-adapter", args: { attempt: 1 } },
    });
    const mapped = toOrgApprovalItem(item);
    expect(mapped.authorityClass).toBe("mutate");
    expect(mapped.trustLevel).toBe("write");
    expect(mapped.persona).toBe("orchestrator");
    expect(mapped.severity).toBe("critical");
    expect(mapped.intent.action).toBe("retry-adapter");
    expect(mapped.intent.args).toEqual({ attempt: 1 });
  });

  it("listApprovals filters by status and persona on the mapped shape", () => {
    queue = freshQueue();
    queue.enqueue({ severity: "low", category: "general", title: "a", details: "a" }); // pending, observe -> persona user
    const dispatchable = queue.enqueue({
      severity: "high",
      category: "adapter_failure",
      title: "b",
      details: "b",
      action: { workflowName: "x", args: {} },
    });
    queue.approve(dispatchable.id); // approved, mutate -> persona orchestrator

    expect(listApprovals(queue)).toHaveLength(2);
    expect(listApprovals(queue, { status: "pending" })).toHaveLength(1);
    expect(listApprovals(queue, { status: "approved" })).toHaveLength(1);
    expect(listApprovals(queue, { persona: "orchestrator" })).toHaveLength(1);
    expect(listApprovals(queue, { persona: "user" })).toHaveLength(1);
  });

  it("resolveApproval({approved:true}) approves and returns a mapped item with a verdict", () => {
    queue = freshQueue();
    const item = queue.enqueue({
      severity: "high",
      category: "adapter_failure",
      title: "b",
      details: "b",
      action: { workflowName: "x", args: { n: 1 } },
    });
    const resolved = resolveApproval(queue, item.id, { approved: true, resolvedBy: "op-1" });
    expect(resolved.status).toBe("approved");
    expect(resolved.verdict?.approved).toBe(true);
  });

  it("resolveApproval({approved:true, editedArgs}) replaces the action args before approving", () => {
    queue = freshQueue();
    const item = queue.enqueue({
      severity: "high",
      category: "adapter_failure",
      title: "b",
      details: "b",
      action: { workflowName: "x", args: { n: 1 } },
    });
    const resolved = resolveApproval(queue, item.id, {
      approved: true,
      editedArgs: { n: 2 },
      resolvedBy: "op-1",
    });
    expect(resolved.intent.args).toEqual({ n: 2 });
  });

  it("resolveApproval({approved:false}) rejects and returns verdict.approved=false", () => {
    queue = freshQueue();
    const item = queue.enqueue({ severity: "low", category: "general", title: "a", details: "a" });
    const resolved = resolveApproval(queue, item.id, { approved: false, resolvedBy: "op-1" });
    expect(resolved.status).toBe("rejected");
    expect(resolved.verdict?.approved).toBe(false);
  });
});
