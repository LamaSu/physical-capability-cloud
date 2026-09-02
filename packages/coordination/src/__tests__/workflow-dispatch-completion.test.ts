import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HumanQueueStore } from "../queue/human-queue.js";
import { WorkflowDispatcher } from "../dispatch/workflow-dispatch.js";
import { OrgBus, ORG_SUBJECTS, type OrgEvent } from "../events/org-bus.js";

function freshDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pcc-coordination-dispatch-"));
  return path.join(dir, "brain.sqlite");
}

describe("WorkflowDispatcher — completion closes the loop", () => {
  it("resolves the queue item and publishes org.workflow.completed once acknowledgeCompletion delivers the signal", async () => {
    const dbPath = freshDbPath();
    const queue = new HumanQueueStore({ path: dbPath });
    const bus = OrgBus.withInMemoryBackend();

    const item = queue.enqueue({
      severity: "medium",
      category: "adapter_failure",
      title: "test dispatchable item",
      details: "test",
      action: { workflowName: "noop", args: {} },
    });
    queue.approve(item.id);

    const dispatcher = new WorkflowDispatcher({ dbPath, bus });
    await dispatcher.recover();
    const dispatchResult = await dispatcher.dispatchApproved();
    expect(dispatchResult).toHaveLength(1);
    expect(dispatchResult[0]?.runId).toBeTruthy();

    const completedEvents: OrgEvent[] = [];
    await bus.subscribe(ORG_SUBJECTS.WORKFLOW_COMPLETED, (event) => {
      completedEvents.push(event);
    });

    await dispatcher.acknowledgeCompletion(item.id, "test-operator");

    // handle.signal() only hands the payload off; the workflow body resumes
    // and settles across a few more microtask hops before onWorkflowSettled
    // runs. A short macrotask delay lets everything flush (microtasks
    // always fully drain before a timer fires).
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload).toMatchObject({ queueItemId: item.id });

    const resolvedItem = queue.get(item.id);
    expect(resolvedItem?.status).toBe("resolved");

    queue.close();
    dispatcher.close();
  });
});
