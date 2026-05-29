import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Workflow, WorkflowEngine } from "../../src/workflow/index.js";
import { openSqliteStore } from "../../src/store/sqlite.js";
import { defineActivity } from "../../src/activity/define.js";
import { proxyActivities, createActivityProxy } from "../../src/activity/proxy.js";
import type { Store } from "../../src/store/types.js";
import type { WorkflowContext } from "../../src/shared/types.js";

describe("proxyActivities — outside a run", () => {
  it("rejects with an informative error when invoked outside a workflow", async () => {
    const dummyStore = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
    const act = defineActivity({
      name: "test",
      store: dummyStore,
      handler: async (_a: [number]) => 1,
      sleep: async () => {},
    });
    const proxy = proxyActivities({ test: act });
    await expect((proxy.test as (...args: unknown[]) => Promise<unknown>)(1)).rejects.toThrow(
      /outside a workflow run/,
    );
    await dummyStore.close();
  });
});

describe("createActivityProxy — inside a workflow run", () => {
  let store: Store;
  beforeEach(() => {
    store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });
  });
  afterEach(async () => {
    await store.close();
  });

  it("proxy invocations route through ActivityDefinition.invoke()", async () => {
    const greet = defineActivity({
      name: "greet",
      store,
      sleep: async () => {},
      handler: async (input: [string]) => `hello ${input[0]}`,
    });

    let counter = 0;
    const proxy = createActivityProxy(
      { greet },
      {
        workflowRunId: "run-1",
        actorId: "x",
        nextActivityId: () => `aid-${++counter}`,
      },
    );

    const out = await proxy.greet("world");
    expect(out).toBe("hello world");
  });

  it("proxy preserves argument types and unwraps Result.ok to the raw value", async () => {
    const add = defineActivity({
      name: "add",
      store,
      sleep: async () => {},
      handler: async (input: [number, number]) => input[0] + input[1],
    });

    let counter = 0;
    const proxy = createActivityProxy(
      { add },
      {
        workflowRunId: "run-2",
        actorId: "x",
        nextActivityId: () => `aid-${++counter}`,
      },
    );

    const sum = await proxy.add(2, 3);
    expect(sum).toBe(5);
  });

  it("proxy throws ActivityFailedError when the activity exhausts retries", async () => {
    const alwaysFails = defineActivity({
      name: "always-fails",
      store,
      sleep: async () => {},
      rand: () => 0.5,
      retryPolicy: { maximumAttempts: 2 },
      handler: async (_i: [number]) => {
        throw new Error("boom");
      },
    });

    let counter = 0;
    const proxy = createActivityProxy(
      { alwaysFails },
      {
        workflowRunId: "run-3",
        actorId: "x",
        nextActivityId: () => `aid-${++counter}`,
      },
    );

    await expect(proxy.alwaysFails(1)).rejects.toThrow(/always-fails/);
  });
});

describe("WorkflowContext.activity — engine-wired activity calls", () => {
  it("invoking an unregistered activity name throws", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });

    class BadWf extends Workflow<unknown, number> {
      readonly name = "Bad";
      readonly version = 1;
      async run(ctx: WorkflowContext): Promise<number> {
        return ctx.activity<[number], number>("nonexistent", 1);
      }
    }
    const engine = new WorkflowEngine({ store });
    engine.register(BadWf);
    const h = await engine.start("Bad", {} as never);
    const res = await h.result();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/no activity.*registered/);
    await store.close();
  });

  it("engine routes ctx.activity(name) to the matching ActivityDefinition.invoke()", async () => {
    const store = openSqliteStore({ path: ":memory:", pruneIntervalMs: 0 });

    const double = defineActivity({
      name: "double",
      store,
      sleep: async () => {},
      handler: async (input: [number]) => input[0] * 2,
    });

    class DoubleWf extends Workflow<{ n: number }, number> {
      readonly name = "DoubleWf";
      readonly version = 1;
      async run(ctx: WorkflowContext, args: { n: number }): Promise<number> {
        return ctx.activity<[number], number>("double", args.n);
      }
    }
    const engine = new WorkflowEngine({ store, activities: { double } });
    engine.register(DoubleWf);
    const h = await engine.start("DoubleWf", { n: 21 } as never);
    const res = await h.result();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(42);
    await store.close();
  });
});
