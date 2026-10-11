import { describe, expect, it, vi } from "vitest";
import { createInboxStore } from "../inbox-store.js";
import { isPinned, type AckOutcome, type ActOutcome, type InboxItem, type InboxSource } from "../../lib/inbox/inbox-model.js";

function item(id = "one", patch: Partial<InboxItem> = {}): InboxItem {
  return { id, sourceId: "fake", kind: "mail_this", urgency: "act_now", createdAt: null, decideBy: null,
    title: id, detail: null, link: null, read: false,
    task: { id: "task:" + id, dueAt: null, ackKinds: ["mailed"], ack: null },
    actions: [{ op: "approve", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/operator/approvals/a/approve" } }], ...patch };
}
const ok = (items: InboxItem[]): Awaited<ReturnType<InboxSource["load"]>> => ({ ok: true, items, notices: [] });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("inbox source reconciliation", () => {
  it("cancels a read even when a source ignores abort, then ignores its late result", async () => {
    const pending = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const load = vi.fn<Parameters<InboxSource["load"]>, ReturnType<InboxSource["load"]>>()
      .mockImplementationOnce(() => pending.promise).mockResolvedValue(ok([item("fresh")]));
    const notify = vi.fn();
    const store = createInboxStore([{ id: "fake", load }], { notify });
    const reading = store.getState().refresh();
    const signal = load.mock.calls[0][0];
    expect(signal).toBeInstanceOf(AbortSignal);
    store.getState().cancelRefresh(reading);
    expect(signal?.aborted).toBe(true);
    await reading;
    expect(store.getState()).toMatchObject({ items: [], loaded: false, errors: {} });
    await store.getState().refresh();
    expect(load).toHaveBeenCalledTimes(2);
    pending.resolve(ok([item("stale")]));
    await pending.promise;
    expect(store.getState().items.map((v) => v.id)).toEqual(["fresh"]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not let an old refresh cancellation or finally release a newer coalesced read", async () => {
    const old = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const current = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const load = vi.fn<Parameters<InboxSource["load"]>, ReturnType<InboxSource["load"]>>()
      .mockImplementationOnce(() => old.promise).mockImplementation(() => current.promise);
    const store = createInboxStore([{ id: "fake", load }]);
    const readingOld = store.getState().refresh();
    store.getState().cancelRefresh(readingOld);
    const readingCurrent = store.getState().refresh(); // begins before the old finally
    store.getState().cancelRefresh(readingOld);
    await readingOld;
    expect(load.mock.calls[1][0]?.aborted).toBe(false);
    expect(store.getState().refresh()).toBe(readingCurrent);
    expect(load).toHaveBeenCalledTimes(2);
    old.resolve(ok([item("stale")]));
    current.resolve(ok([item("current")]));
    await readingCurrent;
    expect(store.getState().items.map((v) => v.id)).toEqual(["current"]);
  });

  it("merges all sources, drops later duplicates and counts them", async () => {
    const first = item();
    const store = createInboxStore([
      { id: "fake", load: async () => ok([first]) },
      { id: "other", load: async () => ok([item("one", { sourceId: "other", title: "duplicate" }), item("two", { sourceId: "other" })]) },
    ]);
    expect(store.getState().loaded).toBe(false);
    await store.getState().refresh();
    expect(store.getState().items).toEqual([first, item("two", { sourceId: "other" })]);
    expect(store.getState().notices).toContainEqual({ code: "unshown_items", count: 1 });
    expect(store.getState().loaded).toBe(true);
  });
  it("keeps successful items and errors for failing sources, drops their old items", async () => {
    const load = vi.fn<[], ReturnType<InboxSource["load"]>>().mockResolvedValueOnce(ok([item("old", { sourceId: "bad" })]))
      .mockResolvedValueOnce({ ok: false, error: "sign_in_wallet" });
    const store = createInboxStore([{ id: "fake", load: async () => ok([item()]) }, { id: "bad", load }]);
    await store.getState().refresh();
    await store.getState().refresh();
    expect(store.getState().items.map((v) => v.id)).toEqual(["one"]);
    expect(store.getState().errors).toEqual({ bad: "sign_in_wallet" });
  });
  it("settles thrown loads as unavailable and still reads sources in parallel", async () => {
    const wait = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const second = vi.fn(async () => { throw new Error("failed read"); });
    const store = createInboxStore([{ id: "fake", load: () => wait.promise }, { id: "bad", load: second }]);
    const refresh = store.getState().refresh();
    expect(second).toHaveBeenCalledTimes(1);
    wait.resolve(ok([item()]));
    await refresh;
    expect(store.getState().errors).toEqual({ bad: "unavailable" });
    expect(store.getState().items).toHaveLength(1);
  });
  it("three refreshes are reads only, even for unread act-now tasks", async () => {
    const act = vi.fn(async (): Promise<ActOutcome> => "done");
    const ack = vi.fn(async (): Promise<AckOutcome> => "acked");
    const markRead = vi.fn(async () => true);
    const load = vi.fn(async () => ok([item()]));
    const store = createInboxStore([{ id: "fake", load, act, ack, markRead }]);
    for (let i = 0; i < 3; i++) await store.getState().refresh();
    expect(load).toHaveBeenCalledTimes(3);
    expect(act).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(markRead).not.toHaveBeenCalled();
  });
  it("coalesces overlapping refreshes so an older read cannot overwrite a newer one", async () => {
    const wait = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const load = vi.fn(() => wait.promise);
    const store = createInboxStore([{ id: "fake", load }]);
    const first = store.getState().refresh();
    const second = store.getState().refresh();
    expect(load).toHaveBeenCalledTimes(1);
    wait.resolve(ok([item()]));
    await Promise.all([first, second]);
    expect(store.getState().loaded).toBe(true);
  });
});

describe("explicit decisions", () => {
  it("locks a pending item against another decision and refreshes success without removing locally", async () => {
    const wait = deferred<ActOutcome>();
    const act = vi.fn(() => wait.promise);
    const load = vi.fn(async () => ok([item()]));
    const store = createInboxStore([{ id: "fake", load, act }]);
    await store.getState().refresh();
    const first = store.getState().decideItem("one", "approve");
    expect(store.getState().pending).toEqual({ one: "acting" });
    await store.getState().decideItem("one", "approve");
    expect(act).toHaveBeenCalledTimes(1);
    wait.resolve("done");
    await first;
    expect(store.getState().outcomes.one).toBe("done");
    expect(store.getState().items).toHaveLength(1);
    expect(store.getState().pending).toEqual({});
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each<ActOutcome>(["done", "already_decided", "expired", "stopped", "unavailable", "failed"])("refreshes only the specified outcome: %s", async (outcome) => {
    const load = vi.fn(async () => ok([item()]));
    const store = createInboxStore([{ id: "fake", load, act: async () => outcome }]);
    await store.getState().refresh();
    await store.getState().decideItem("one", "approve");
    expect(load).toHaveBeenCalledTimes(["done", "already_decided", "expired"].includes(outcome) ? 2 : 1);
    expect(store.getState().outcomes.one).toBe(outcome);
  });
  it("never acts for missing items, absent ops or disallowed actions", async () => {
    const act = vi.fn(async (): Promise<ActOutcome> => "done");
    const store = createInboxStore([{ id: "fake", load: async () => ok([item("one", { actions: [] }), item("two", { actions: [{ ...item().actions[0], allowed: false }] })]), act }]);
    await store.getState().refresh();
    await store.getState().decideItem("missing", "approve");
    await store.getState().decideItem("one", "approve");
    await store.getState().decideItem("two", "approve");
    expect(act).not.toHaveBeenCalled();
  });
  it("maps a throwing action to an unknown outcome and releases the lock", async () => {
    const store = createInboxStore([{ id: "fake", load: async () => ok([item()]), act: async () => { throw new Error("unknown"); } }]);
    await store.getState().refresh();
    await store.getState().decideItem("one", "approve");
    expect(store.getState().outcomes.one).toBe("unavailable");
    expect(store.getState().pending).toEqual({});
  });
});

describe("human task acknowledgment", () => {
  it("refuses an unsupported ack kind and locks double clicks", async () => {
    const wait = deferred<AckOutcome>();
    const ack = vi.fn(() => wait.promise);
    const store = createInboxStore([{ id: "fake", load: async () => ok([item()]), ack }]);
    await store.getState().refresh();
    await store.getState().ackTask("one", "resolved");
    expect(ack).not.toHaveBeenCalled();
    const first = store.getState().ackTask("one", "mailed");
    await store.getState().ackTask("one", "mailed");
    expect(ack).toHaveBeenCalledTimes(1);
    expect(store.getState().pending.one).toBe("acking");
    wait.resolve("unavailable");
    await first;
    expect(store.getState().pending).toEqual({});
  });
  it("reuses the key after unavailable/failed, then makes a new key after acked", async () => {
    const ack = vi.fn<Parameters<NonNullable<InboxSource["ack"]>>, Promise<AckOutcome>>()
      .mockResolvedValueOnce("unavailable").mockResolvedValueOnce("failed").mockResolvedValue("acked");
    const newKey = vi.fn().mockReturnValueOnce("key-one").mockReturnValueOnce("key-two");
    const store = createInboxStore([{ id: "fake", load: async () => ok([item()]), ack }], { newKey });
    await store.getState().refresh();
    for (let i = 0; i < 4; i++) await store.getState().ackTask("one", "mailed");
    expect(ack.mock.calls.map((call) => call[2])).toEqual(["key-one", "key-one", "key-one", "key-two"]);
    expect(newKey).toHaveBeenCalledTimes(2);
  });
  it("stays pinned after acked until a load returns task.ack; never changes the local task", async () => {
    let current = item();
    const store = createInboxStore([{ id: "fake", load: async () => ok([current]), ack: async () => "acked" }]);
    await store.getState().refresh();
    await store.getState().ackTask("one", "mailed");
    expect(store.getState().items[0].task!.ack).toBeNull();
    expect(current.task!.ack).toBeNull();
    expect(isPinned(store.getState().items[0])).toBe(true);
    current = { ...current, task: { ...current.task!, ack: { kind: "mailed", at: "2026-10-10T12:00:00Z" } } };
    await store.getState().refresh();
    expect(isPinned(store.getState().items[0])).toBe(false);
  });
  it("has no ack path for taskless, already-acked or unsupported sources", async () => {
    const ack = vi.fn(async (): Promise<AckOutcome> => "acked");
    const store = createInboxStore([
      { id: "fake", load: async () => ok([item("no-task", { task: null }), item("done", { task: { ...item().task!, ack: { kind: "mailed", at: "now" } } })]), ack },
      { id: "other", load: async () => ok([item("unsupported", { sourceId: "other" })]) },
    ]);
    await store.getState().refresh();
    for (const id of ["no-task", "done", "unsupported", "missing"]) await store.getState().ackTask(id, "mailed");
    expect(ack).not.toHaveBeenCalled();
  });
});

describe("source-owned read state", () => {
  it.each([false, "throw"])("marks optimistically, restores a refusal %s, ignores non-unread items", async (result) => {
    const wait = deferred<boolean>();
    const markRead = vi.fn<[InboxItem[]], Promise<boolean>>(() => result === "throw" ? wait.promise.then(() => { throw new Error("read failed"); }) : wait.promise);
    const current = item();
    const store = createInboxStore([{ id: "fake", load: async () => ok([current, item("unknown", { read: null }), item("read", { read: true })]), markRead }]);
    await store.getState().refresh();
    const reading = store.getState().markItemsRead(["one", "one", "unknown", "read", "missing"]);
    expect(store.getState().items[0].read).toBe(true);
    expect(current.read).toBe(false);
    expect(store.getState().pending.one).toBe("reading");
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0][0]).toEqual([current]);
    wait.resolve(false);
    await reading;
    expect(store.getState().items[0].read).toBe(false);
    expect(store.getState().pending).toEqual({});
  });
  it("keeps confirmed read state and never marks a source without markRead", async () => {
    const markRead = vi.fn(async () => true);
    const store = createInboxStore([{ id: "fake", load: async () => ok([item()]), markRead }, { id: "other", load: async () => ok([item("two", { sourceId: "other" })]) }]);
    await store.getState().refresh();
    await store.getState().markItemsRead(["one", "two"]);
    expect(store.getState().items.map((v) => v.read)).toEqual([true, false]);
  });
  it("keeps a confirmed read through an older in-flight load, then follows later server reads", async () => {
    const wait = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const load = vi.fn<[], ReturnType<InboxSource["load"]>>()
      .mockResolvedValueOnce(ok([item()])).mockImplementationOnce(() => wait.promise).mockResolvedValue(ok([item()]));
    const store = createInboxStore([{ id: "fake", load, markRead: async () => true }]);
    await store.getState().refresh();
    const older = store.getState().refresh();
    await store.getState().markItemsRead(["one"]);
    expect(store.getState().items[0].read).toBe(true);
    expect(store.getState().pending).toEqual({});
    wait.resolve(ok([item()]));
    await older;
    expect(store.getState().items[0].read).toBe(true);
    await store.getState().refresh();
    expect(store.getState().items[0].read).toBe(false);
  });
});

describe("one fixed summary toast per refresh", () => {
  it("establishes a successful baseline separately for each source, including empty successes", async () => {
    const notify = vi.fn();
    const first = vi.fn<[], ReturnType<InboxSource["load"]>>().mockResolvedValue(ok([]));
    const second = vi.fn<[], ReturnType<InboxSource["load"]>>()
      .mockResolvedValueOnce({ ok: false, error: "unavailable" })
      .mockResolvedValueOnce(ok([item("a", { sourceId: "second" })]))
      .mockResolvedValueOnce(ok([item("a", { sourceId: "second" }), item("b", { sourceId: "second" })]));
    const store = createInboxStore([{ id: "fake", load: first }, { id: "second", load: second }], { notify });
    await store.getState().refresh();
    await store.getState().refresh();
    expect(notify).not.toHaveBeenCalled();
    first.mockResolvedValue(ok([item("c")]));
    await store.getState().refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ type: "warning", title: "2 new items in your inbox" });
  });

  it("clears every source's successful baseline on an identity change", async () => {
    const identity = identityChanges();
    const notify = vi.fn();
    const load = vi.fn<[], ReturnType<InboxSource["load"]>>()
      .mockResolvedValueOnce(ok([item("A")]))
      .mockResolvedValueOnce({ ok: false, error: "unavailable" })
      .mockResolvedValueOnce(ok([item("a")]))
      .mockResolvedValueOnce(ok([item("a"), item("b")]));
    const store = createInboxStore([{ id: "fake", load }], { ...identity, notify });
    await store.getState().refresh();
    identity.change();
    await store.getState().refresh();
    await store.getState().refresh();
    expect(notify).not.toHaveBeenCalled();
    await store.getState().refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ type: "warning", title: "1 new item in your inbox" });
  });

  it("does not announce seen items again after a failed read or a temporary absence", async () => {
    const notify = vi.fn();
    const load = vi.fn<[], ReturnType<InboxSource["load"]>>()
      .mockResolvedValueOnce(ok([item()])).mockResolvedValueOnce({ ok: false, error: "unavailable" })
      .mockResolvedValueOnce(ok([item()])).mockResolvedValueOnce(ok([])).mockResolvedValueOnce(ok([item()]));
    const store = createInboxStore([{ id: "fake", load }], { notify });
    for (let i = 0; i < 5; i++) await store.getState().refresh();
    expect(notify).not.toHaveBeenCalled();
  });
  it("skips the first load and FYI news; notifies only new actionable ids", async () => {
    let items = [item("initial")];
    const notify = vi.fn();
    const store = createInboxStore([{ id: "fake", load: async () => ok(items) }], { notify });
    await store.getState().refresh();
    expect(notify).not.toHaveBeenCalled();
    items = [...items, item("decision", { urgency: "decide_soon" })];
    await store.getState().refresh();
    expect(notify).toHaveBeenLastCalledWith({ type: "info", title: "1 new item in your inbox" });
    items = [...items, item("urgent")];
    await store.getState().refresh();
    expect(notify).toHaveBeenLastCalledWith({ type: "warning", title: "1 new item in your inbox" });
    items = [...items, item("fyi", { urgency: "fyi" })];
    await store.getState().refresh();
    await store.getState().refresh();
    expect(notify).toHaveBeenCalledTimes(2);
    items = [...items, item("more-one", { urgency: "decide_soon" }), item("more-two")];
    await store.getState().refresh();
    expect(notify).toHaveBeenLastCalledWith({ type: "warning", title: "2 new items in your inbox" });
    expect(notify).toHaveBeenCalledTimes(3);
  });
});

function identityChanges() {
  let listener = () => {};
  return {
    onIdentityChange: (next: () => void) => { listener = next; return () => { listener = () => {}; }; },
    change: () => listener(),
  };
}

describe("identity-scoped inbox state", () => {
  it("drops all state, ack keys, read marks and toast history immediately on a change", async () => {
    const identity = identityChanges();
    const notify = vi.fn();
    const clearNotifications = vi.fn();
    const newKey = vi.fn().mockReturnValueOnce("A-key").mockReturnValueOnce("B-key");
    const ack = vi.fn<Parameters<NonNullable<InboxSource["ack"]>>, Promise<AckOutcome>>().mockResolvedValue("unavailable");
    const source: InboxSource = { id: "fake", load: async () => ({ ok: true, items: [item()], notices: [{ code: "no_kernels" }] }), ack };
    const store = createInboxStore([source], { ...identity, notify, clearNotifications, newKey });
    await store.getState().refresh();
    await store.getState().ackTask("one", "mailed");
    store.setState({ errors: { other: "failed" }, pending: { old: "reading" } });
    identity.change();
    expect(store.getState()).toMatchObject({ items: [], notices: [], errors: {}, pending: {}, outcomes: {}, loaded: false });
    expect(clearNotifications).toHaveBeenCalledTimes(1);
    await store.getState().refresh();
    expect(notify).not.toHaveBeenCalled();
    await store.getState().ackTask("one", "mailed");
    expect(ack.mock.calls.map((call) => call[2])).toEqual(["A-key", "B-key"]);
    await store.getState().refresh();
    source.load = async () => ok([item(), item("new")]);
    await store.getState().refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    identity.change();
    source.load = async () => ok([]);
    await store.getState().refresh();
    source.load = async () => ok([item("new")]);
    await store.getState().refresh();
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it("discards A's late load without releasing B's coalesced read", async () => {
    const identity = identityChanges();
    const a = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const b = deferred<Awaited<ReturnType<InboxSource["load"]>>>();
    const load = vi.fn<[], ReturnType<InboxSource["load"]>>().mockImplementationOnce(() => a.promise).mockImplementation(() => b.promise);
    const notify = vi.fn();
    const store = createInboxStore([{ id: "fake", load }], { ...identity, notify });
    const readingA = store.getState().refresh();
    identity.change();
    const readingB = store.getState().refresh();
    expect(load).toHaveBeenCalledTimes(2);
    a.resolve(ok([item("private-A")]));
    await readingA;
    expect(store.getState()).toMatchObject({ items: [], loaded: false });
    const coalesced = store.getState().refresh();
    expect(coalesced).toBe(readingB);
    expect(load).toHaveBeenCalledTimes(2);
    b.resolve(ok([item("B")]));
    await Promise.all([readingB, coalesced]);
    expect(store.getState().items.map((v) => v.id)).toEqual(["B"]);
    expect(notify).not.toHaveBeenCalled();
  });
  it.each(["act", "ack"] as const)("ignores A's late %s result and finally while B acts on the same id", async (operation) => {
    const identity = identityChanges();
    const a = deferred<ActOutcome & AckOutcome>();
    const b = deferred<ActOutcome & AckOutcome>();
    const act = vi.fn<Parameters<NonNullable<InboxSource["act"]>>, Promise<ActOutcome>>().mockImplementationOnce(() => a.promise).mockImplementation(() => b.promise);
    const ack = vi.fn<Parameters<NonNullable<InboxSource["ack"]>>, Promise<AckOutcome>>().mockImplementationOnce(() => a.promise).mockImplementation(() => b.promise);
    const load = vi.fn(async () => ok([item()]));
    const store = createInboxStore([{ id: "fake", load, act, ack }], identity);
    await store.getState().refresh();
    const run = () => operation === "act" ? store.getState().decideItem("one", "approve") : store.getState().ackTask("one", "mailed");
    const old = run();
    identity.change();
    await store.getState().refresh();
    const current = run();
    a.resolve("unavailable");
    await old;
    expect(store.getState().outcomes).toEqual({});
    expect(store.getState().pending.one).toBe(operation === "act" ? "acting" : "acking");
    expect(load).toHaveBeenCalledTimes(2);
    b.resolve("failed");
    await current;
    expect(store.getState().outcomes.one).toBe("failed");
  });
  it.each(["act", "ack"] as const)("does not reconcile A's late successful %s under B", async (operation) => {
    const identity = identityChanges();
    const wait = deferred<ActOutcome | AckOutcome>();
    const load = vi.fn(async () => ok([item()]));
    const source: InboxSource = { id: "fake", load,
      act: () => wait.promise as Promise<ActOutcome>, ack: () => wait.promise as Promise<AckOutcome> };
    const store = createInboxStore([source], identity);
    await store.getState().refresh();
    const old = operation === "act" ? store.getState().decideItem("one", "approve") : store.getState().ackTask("one", "mailed");
    identity.change();
    await store.getState().refresh();
    wait.resolve(operation === "act" ? "done" : "acked");
    await old;
    expect(store.getState().outcomes).toEqual({});
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("ignores A's late read mark (%s) while B reads the same id", async (confirmed) => {
    const identity = identityChanges();
    const oldMark = deferred<boolean>();
    const newMark = deferred<boolean>();
    const markRead = vi.fn<[InboxItem[]], Promise<boolean>>().mockImplementationOnce(() => oldMark.promise).mockImplementationOnce(() => newMark.promise);
    const store = createInboxStore([{ id: "fake", load: async () => ok([item()]), markRead }], identity);
    await store.getState().refresh();
    const old = store.getState().markItemsRead(["one"]);
    identity.change();
    await store.getState().refresh();
    const current = store.getState().markItemsRead(["one"]);
    oldMark.resolve(confirmed);
    await old;
    expect(store.getState().items[0].read).toBe(true);
    expect(store.getState().pending.one).toBe("reading");
    newMark.resolve(false);
    await current;
    expect(store.getState().items[0].read).toBe(false);
  });
});

describe("review survivor regressions", () => {
  it.each<ActOutcome>(["unavailable", "failed", "stopped"])("retains an item after %s without re-reading", async (outcome) => {
    const original = item();
    const load = vi.fn(async () => ok([original]));
    const store = createInboxStore([{ id: "fake", load, act: async () => outcome }]);
    await store.getState().refresh();
    await store.getState().decideItem("one", "approve");
    expect(store.getState().items).toEqual([original]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.getState().pending).toEqual({});
  });
});
