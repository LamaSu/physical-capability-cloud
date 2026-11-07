/**
 * Durable, write-once storage for TMP task terms (E11f; the steward's ruling on #6309).
 *
 * A TMP task is authority: its accepted tier and its proof pipeline decide every verdict on its proofs.
 * So it is created once and never replaced, and that has to survive a restart, not only last as long as
 * one process (E11f HIGH 1: a per-app Map let a restart or a second app create a milestone's task again).
 *
 * One file per milestone: `<root>/<sha256 hex of the milestone id>.json`. The name is a hash of the id,
 * so no id can name a path outside the root. Creation is exclusive: the record is written to a fresh
 * temporary file opened with O_EXCL ("wx"), synced, then hard-linked to its final name. link() fails with
 * EEXIST when that name exists, so a second creation is refused, across restarts too, and no reader ever
 * sees a partial record. A record whose milestoneId isn't the one asked for is refused on read.
 *
 * The root resolves like the gateway's other durable stores (registry-snapshot-store.ts):
 * PCC_TMP_TASK_DIR, else RAILWAY_VOLUME_MOUNT_PATH/tmp-tasks, else ./data/tmp-tasks.
 *
 * The boundary: ONE gateway instance on ONE volume, the volume pcc.db (SQLite) lives on. Write-once holds
 * for everything that shares that volume. Two gateways on separate volumes would each keep their own
 * records, exactly as each would keep its own pcc.db, so that deployment isn't supported here either.
 */

import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { MilestoneProcurement } from "@pcc/spec";

/** A TMP task as stored: its terms, and the principal that created it. */
export type TmpTaskRecord = MilestoneProcurement & { owner: string };

export interface TmpTaskStore {
  /** The milestone's task, or undefined when it has none. Throws when its record can't be read or isn't its own. */
  get(milestoneId: string): Promise<TmpTaskRecord | undefined>;
  /** Stores a task once. Returns false, and changes nothing, when the milestone already has one. */
  createOnce(task: TmpTaskRecord): Promise<boolean>;
}

/** The storage root: an explicit override, else the Railway volume, else the local data directory. */
function resolveRoot(): string {
  if (process.env.PCC_TMP_TASK_DIR) return process.env.PCC_TMP_TASK_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "tmp-tasks");
  return path.join("./data", "tmp-tasks");
}

/** A record's file name: the sha256 hex of the milestone id, never the id itself. */
export function tmpTaskFileName(milestoneId: string): string {
  return `${crypto.createHash("sha256").update(milestoneId, "utf8").digest("hex")}.json`;
}

/** The durable store: one write-once file per milestone (see the module comment). */
export class FsTmpTaskStore implements TmpTaskStore {
  readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? resolveRoot();
  }

  async get(milestoneId: string): Promise<TmpTaskRecord | undefined> {
    let raw: string;
    try {
      raw = readFileSync(path.join(this.rootDir, tmpTaskFileName(milestoneId)), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const record: unknown = JSON.parse(raw);
    if (record === null || typeof record !== "object" || (record as { milestoneId?: unknown }).milestoneId !== milestoneId) {
      throw new Error("a stored TMP task record is not this milestone's");
    }
    return record as TmpTaskRecord;
  }

  async createOnce(task: TmpTaskRecord): Promise<boolean> {
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    const finalPath = path.join(this.rootDir, tmpTaskFileName(task.milestoneId));
    const tempPath = path.join(this.rootDir, `.tmp-${crypto.randomUUID()}`);
    try {
      const fd = openSync(tempPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(task));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(tempPath, finalPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // Already removed; the final name, if linked, keeps the record.
      }
    }
    // Persist the new directory entry, so a crash right after the 201 can't lose the record.
    const dirFd = openSync(this.rootDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return true;
  }
}

/** For tests only: a Map, which a restart forgets. The gateway wires FsTmpTaskStore (server.ts). */
export class MemoryTmpTaskStore implements TmpTaskStore {
  private readonly tasks = new Map<string, string>();

  async get(milestoneId: string): Promise<TmpTaskRecord | undefined> {
    const raw = this.tasks.get(milestoneId);
    return raw === undefined ? undefined : (JSON.parse(raw) as TmpTaskRecord);
  }

  async createOnce(task: TmpTaskRecord): Promise<boolean> {
    if (this.tasks.has(task.milestoneId)) return false;
    this.tasks.set(task.milestoneId, JSON.stringify(task));
    return true;
  }
}
