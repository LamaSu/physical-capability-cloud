// snapshot — deterministic-replay contract tests.

import { describe, it, expect } from "vitest";
import { takeSnapshot, serialize, deserialize } from "./snapshot.js";
import type { AppEvent } from "./event-bus.js";

const events: AppEvent[] = [
  { t: 1, kind: "test.begin", sponsor: "sdk", text: "begin" },
  { t: 2, kind: "test.end", sponsor: "sdk", text: "end" },
];

describe("takeSnapshot", () => {
  it("freezes events into an immutable copy", () => {
    const snap = takeSnapshot({ events });
    events.push({ t: 3, kind: "test.extra", sponsor: "sdk", text: "after" });
    expect(snap.events).toHaveLength(2);
  });

  it("includes session_id, state, extras when provided", () => {
    const snap = takeSnapshot({
      session_id: "s-1",
      state: { state: "started" } as never,
      extras: { partial: { name: "Foo" } },
    });
    expect(snap.session_id).toBe("s-1");
    expect(snap.extras).toEqual({ partial: { name: "Foo" } });
  });
});

describe("serialize / deserialize", () => {
  it("excludes timestamp by default for content-addressable hashing", () => {
    const a = takeSnapshot({ session_id: "s-1", events });
    const b = takeSnapshot({ session_id: "s-1", events });
    expect(serialize(a)).toBe(serialize(b));
  });

  it("round-trips when timestamp is included", () => {
    const snap = takeSnapshot({ session_id: "s-1", events, extras: { x: 1 } });
    const json = serialize(snap, { includeTimestamp: true });
    const restored = deserialize(json);
    expect(restored.session_id).toBe("s-1");
    expect(restored.events).toEqual(events);
    expect(restored.extras).toEqual({ x: 1 });
    expect(restored.taken_at).toBe(snap.taken_at);
  });
});
