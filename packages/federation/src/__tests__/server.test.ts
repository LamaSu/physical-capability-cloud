import { describe, expect, it } from "vitest";
import { loadServerContext, replicaIdFromContext } from "../server.js";

describe("loadServerContext", () => {
  it("uses Phase-1 defaults when env is empty", () => {
    const ctx = loadServerContext({});
    expect(ctx.regionId).toBe("us-east-1");
    expect(ctx.meshId).toBe("us-east-1-mesh-a");
    expect(ctx.defaultNamespaceId).toBe("pcc-public");
    expect(ctx.role).toBe("leader");
    expect(ctx.serverId).toMatch(/^server-/);
  });

  it("reads env vars", () => {
    const ctx = loadServerContext({
      PCC_REGION_ID: "eu-west-1",
      PCC_MESH_ID: "eu-west-1-mesh-b",
      PCC_SERVER_ID: "test-srv",
      PCC_DEFAULT_NAMESPACE: "private",
      PCC_MESH_ROLE: "follower",
    });
    expect(ctx.regionId).toBe("eu-west-1");
    expect(ctx.meshId).toBe("eu-west-1-mesh-b");
    expect(ctx.serverId).toBe("test-srv");
    expect(ctx.defaultNamespaceId).toBe("private");
    expect(ctx.role).toBe("follower");
  });

  it("overrides win over env", () => {
    const ctx = loadServerContext(
      { PCC_REGION_ID: "x", PCC_MESH_ID: "y" },
      { regionId: "override-region", meshId: "override-mesh" },
    );
    expect(ctx.regionId).toBe("override-region");
    expect(ctx.meshId).toBe("override-mesh");
  });

  it("unknown PCC_MESH_ROLE falls back to leader", () => {
    const ctx = loadServerContext({ PCC_MESH_ROLE: "weirdrole" });
    expect(ctx.role).toBe("leader");
  });
});

describe("replicaIdFromContext", () => {
  it("composes region:mesh", () => {
    expect(
      replicaIdFromContext({
        regionId: "us-east-1",
        meshId: "us-east-1-mesh-a",
        serverId: "srv-1",
        defaultNamespaceId: "pcc-public",
        role: "leader",
      }),
    ).toBe("us-east-1:us-east-1-mesh-a");
  });

  it("ignores serverId (CRDT slots survive restarts)", () => {
    const a = replicaIdFromContext({
      regionId: "us-east-1",
      meshId: "mesh-a",
      serverId: "srv-1",
      defaultNamespaceId: "pcc-public",
      role: "leader",
    });
    const b = replicaIdFromContext({
      regionId: "us-east-1",
      meshId: "mesh-a",
      serverId: "srv-WAY-DIFFERENT",
      defaultNamespaceId: "pcc-public",
      role: "leader",
    });
    expect(a).toBe(b);
  });
});
