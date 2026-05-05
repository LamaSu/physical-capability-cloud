/**
 * Wave 4.3 — gateway-side OrchestratorSessionStore adapter tests.
 *
 * These exercise the actual SQLite round-trip via @pcc/store. The
 * orchestrator-sdk's persistence tests use a Map-based simulated store to
 * keep the SDK package free of DB deps; this test fills the SQLite half of
 * the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createStore, type Store } from "@pcc/store";
import type { OnboardSession } from "@pcc/orchestrator-sdk";
import { OrchestratorSessionStore } from "../services/orchestrator-session-store.ts";

let store: Store;
let adapter: OrchestratorSessionStore;

beforeEach(() => {
  store = createStore({ dbPath: ":memory:", seed: false });
  adapter = new OrchestratorSessionStore(store.repos.orchestratorSessions);
});

afterEach(() => {
  store.close();
});

describe("OrchestratorSessionStore — adapter round-trip", () => {
  it("set+get round-trips an OnboardSession through SQLite without dropping fields", () => {
    const session: OnboardSession = {
      id: "sess-1",
      name: "RoundTripCo",
      url: "https://roundtrip.example",
      contact_email: "ops@roundtrip.example",
      state: "interview",
      capabilities: [
        { id: "cap-1", label: "FDM 3D printing", availability: "online" },
        { id: "cap-2", label: "CNC milling" },
      ],
      data_sources: [
        { kind: "postgres", url: "postgres://x" },
        { kind: "csv", path: "/tmp/x.csv" },
      ],
      backend: { project_url: "https://api.x", anon_key: "key-123" },
      agent: { url: "https://agent.x", marketplace_url: "https://market.x" },
      extras: { notes: "wave 4.3 fixture", priority: 7 },
      updated_at: 1714400000000,
    };

    adapter.set(session.id, session);
    const round = adapter.get(session.id);

    expect(round).toBeDefined();
    expect(round!.id).toBe("sess-1");
    expect(round!.name).toBe("RoundTripCo");
    expect(round!.url).toBe("https://roundtrip.example");
    expect(round!.contact_email).toBe("ops@roundtrip.example");
    expect(round!.state).toBe("interview");
    expect(round!.capabilities).toEqual(session.capabilities);
    expect(round!.data_sources).toEqual(session.data_sources);
    expect(round!.backend).toEqual(session.backend);
    expect(round!.agent).toEqual(session.agent);
    expect(round!.extras).toEqual(session.extras);
    expect(round!.updated_at).toBe(1714400000000);
  });

  it("set on existing id replaces the row (Map.set semantics)", () => {
    const v1: OnboardSession = {
      id: "sess-2",
      name: "FirstName",
      state: "started",
      updated_at: 100,
    };
    const v2: OnboardSession = {
      id: "sess-2",
      name: "SecondName",
      state: "data_connected",
      updated_at: 200,
      data_sources: [{ kind: "csv" }],
    };

    adapter.set("sess-2", v1);
    adapter.set("sess-2", v2);

    const found = adapter.get("sess-2");
    expect(found?.name).toBe("SecondName");
    expect(found?.state).toBe("data_connected");
    expect(found?.updated_at).toBe(200);
    expect(found?.data_sources).toEqual([{ kind: "csv" }]);
  });

  it("delete removes a session and is idempotent on missing id", () => {
    adapter.set("d-1", {
      id: "d-1",
      name: "DelMe",
      state: "started",
      updated_at: 1,
    });
    expect(adapter.get("d-1")).toBeDefined();

    adapter.delete("d-1");
    expect(adapter.get("d-1")).toBeUndefined();

    // No throw on missing id — mirrors Map.delete() behaviour.
    expect(() => adapter.delete("never-existed")).not.toThrow();
  });

  it("list returns every persisted session", () => {
    adapter.set("a", { id: "a", name: "A", state: "started", updated_at: 1 });
    adapter.set("b", { id: "b", name: "B", state: "data_connected", updated_at: 2 });
    adapter.set("c", { id: "c", name: "C", state: "built", updated_at: 3 });

    const all = adapter.list();
    expect(all).toHaveLength(3);
    const ids = all.map((s) => s.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("optional fields stay undefined on the round trip (not coerced to null)", () => {
    // Only the required fields. The SDK's OnboardSession contract treats
    // capabilities / data_sources / backend / agent / extras / url /
    // contact_email as optional — round-trip must not surface them as
    // unexpected nulls.
    adapter.set("min", {
      id: "min",
      name: "Minimal",
      state: "started",
      updated_at: 99,
    });
    const min = adapter.get("min");
    expect(min).toBeDefined();
    expect(min!.url).toBeUndefined();
    expect(min!.contact_email).toBeUndefined();
    expect(min!.capabilities).toBeUndefined();
    expect(min!.data_sources).toBeUndefined();
    expect(min!.backend).toBeUndefined();
    expect(min!.agent).toBeUndefined();
    expect(min!.extras).toBeUndefined();
  });
});
