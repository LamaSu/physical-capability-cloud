/**
 * Server-level context — per-process identity for the federation runtime.
 *
 * Per scope §3.3 + §11.5. The "server" is the OS process — the unit of
 * deployment / restart / memory boundary. It holds an immutable
 * (region, mesh, server-id, namespace defaults) tuple read at boot from
 * env vars.
 *
 * The aggregator reads this at gateway boot and injects it into the
 * IndexedToolRegistry constructor so every upsert is tagged with the
 * current (region, mesh, namespace) triple.
 *
 * Phase 1: in-memory only, no persistence. Phase 2 adds @pcc/store
 * persistence for the MeshConfig table.
 */

import type { RegionId, MeshId } from "./region/types.js";
import type { NamespaceId } from "./namespace.js";
import { DEFAULT_PCC_PUBLIC_NAMESPACE_ID } from "./namespace.js";

export interface ServerContext {
  /** This region's id (e.g. "us-east-1"). */
  regionId: RegionId;
  /** This mesh's id (e.g. "us-east-1-mesh-a"). */
  meshId: MeshId;
  /** Unique id for this process. */
  serverId: string;
  /**
   * Default namespace for tools ingested without an explicit namespace
   * tag. Defaults to "pcc-public".
   */
  defaultNamespaceId: NamespaceId;
  /**
   * Logical mesh role: a leader can accept writes; followers serve
   * reads only (modulo Postgres sync replication, which makes any
   * follower's view linearizable up to its applied LSN).
   */
  role: "leader" | "follower";
}

/**
 * Load the server context from env vars with sane Phase-1 defaults.
 *
 * - PCC_REGION_ID         (default "us-east-1")
 * - PCC_MESH_ID           (default "us-east-1-mesh-a")
 * - PCC_SERVER_ID         (default "server-<pid>")
 * - PCC_DEFAULT_NAMESPACE (default "pcc-public")
 * - PCC_MESH_ROLE         (default "leader" — Phase 1 is single-process)
 *
 * Callers can also pass overrides — useful for tests that don't want
 * to fork the env.
 */
export function loadServerContext(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<ServerContext> = {},
): ServerContext {
  return {
    regionId: overrides.regionId ?? env.PCC_REGION_ID ?? "us-east-1",
    meshId: overrides.meshId ?? env.PCC_MESH_ID ?? "us-east-1-mesh-a",
    serverId:
      overrides.serverId ??
      env.PCC_SERVER_ID ??
      `server-${typeof process !== "undefined" ? process.pid : Date.now()}`,
    defaultNamespaceId:
      overrides.defaultNamespaceId ??
      env.PCC_DEFAULT_NAMESPACE ??
      DEFAULT_PCC_PUBLIC_NAMESPACE_ID,
    role:
      overrides.role ??
      ((env.PCC_MESH_ROLE === "follower" ? "follower" : "leader") as
        | "leader"
        | "follower"),
  };
}

/**
 * Compose a stable replica-id from the server context for CRDT slots.
 *
 * Format: `<regionId>:<meshId>`. Server-id is intentionally NOT part of
 * the replica-id because the CRDT slot must survive process restarts —
 * tying it to the OS pid would create a new slot on every restart and
 * defeat the point.
 */
export function replicaIdFromContext(ctx: ServerContext): string {
  return `${ctx.regionId}:${ctx.meshId}`;
}
