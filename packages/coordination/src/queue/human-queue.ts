/**
 * HumanQueueStore — durable human-in-the-loop queue for the coordination Brain.
 *
 * Item shape mirrors `@pcc/agent-support`'s `Escalation` (severity × category
 * × ack/resolve) — see packages/agent-support/src/escalation-manager.ts. That
 * manager is in-memory only; this store adds durability (its own SQLite
 * table, in the Brain's own database file) plus an `approve` step so a
 * queued item can trigger a dispatched action.
 *
 * Persistence model: one `better-sqlite3` connection, WAL mode, a single
 * table namespaced `coordination_human_queue` so it can safely share a
 * SQLite file with `@pcc/workflow`'s own tables (see brain/supervisor.ts —
 * both stores point at the same file; WAL mode supports multiple
 * connections to one file). This mirrors `@pcc/workflow/store/sqlite.ts`'s
 * own persistence style (raw SQL, WAL, no ORM) rather than `@pcc/store`'s
 * Drizzle pattern, since the Brain's DB is not the prod DB.
 *
 * MUST survive a process restart: every mutation is a synchronous SQLite
 * write via better-sqlite3 (fsync'd per SQLite's own durability guarantees),
 * so there is no in-memory buffer to lose on crash.
 */

import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type HumanQueueSeverity = "critical" | "high" | "medium" | "low" | "info";

export type HumanQueueCategory =
  | "adapter_failure"
  | "evidence_issue"
  | "settlement_failure"
  | "network_issue"
  | "capability_error"
  | "security_alert"
  | "onboarding_help"
  | "org_reaction"
  | "general";

export type HumanQueueStatus = "pending" | "acknowledged" | "approved" | "rejected" | "resolved";

/** An action to dispatch (via @pcc/workflow) once a human approves this item. */
export interface HumanQueueAction {
  workflowName: string;
  args: Record<string, unknown>;
}

export interface HumanQueueEnqueueInput {
  severity: HumanQueueSeverity;
  category: HumanQueueCategory;
  title: string;
  details: string;
  suggestedFix?: string;
  action?: HumanQueueAction;
}

export interface HumanQueueItem {
  id: string;
  severity: HumanQueueSeverity;
  category: HumanQueueCategory;
  title: string;
  details: string;
  suggestedFix?: string;
  action?: HumanQueueAction;
  status: HumanQueueStatus;
  acknowledged: boolean;
  /** Set once dispatch has been triggered for this item's action. Populated
   *  by the dispatch module, not by the queue itself — the queue only knows
   *  "approved" vs "has a recorded dispatch run id". */
  dispatchRunId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface HumanQueueRow {
  id: string;
  severity: HumanQueueSeverity;
  category: HumanQueueCategory;
  title: string;
  details: string;
  suggested_fix: string | null;
  action: string | null;
  status: HumanQueueStatus;
  acknowledged: number;
  dispatch_run_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function rowToItem(r: HumanQueueRow): HumanQueueItem {
  return {
    id: r.id,
    severity: r.severity,
    category: r.category,
    title: r.title,
    details: r.details,
    ...(r.suggested_fix !== null ? { suggestedFix: r.suggested_fix } : {}),
    ...(r.action !== null ? { action: JSON.parse(r.action) as HumanQueueAction } : {}),
    status: r.status,
    acknowledged: r.acknowledged === 1,
    dispatchRunId: r.dispatch_run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}

export interface HumanQueueStoreOptions {
  /** Path to the Brain's SQLite file. May be shared with @pcc/workflow's
   *  own store — this class opens its own connection and only touches its
   *  own table. */
  path: string;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS coordination_human_queue (
    id              TEXT PRIMARY KEY,
    severity        TEXT NOT NULL,
    category        TEXT NOT NULL,
    title           TEXT NOT NULL,
    details         TEXT NOT NULL,
    suggested_fix   TEXT,
    action          TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    acknowledged    INTEGER NOT NULL DEFAULT 0,
    dispatch_run_id TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    resolved_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_coord_queue_status ON coordination_human_queue(status);
  CREATE INDEX IF NOT EXISTS idx_coord_queue_dispatch ON coordination_human_queue(status, dispatch_run_id);
`;

function nowIso(): string {
  return new Date().toISOString();
}

export class HumanQueueStore {
  private readonly db: BetterSqliteDatabase;

  constructor(opts: HumanQueueStoreOptions) {
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(CREATE_TABLE_SQL);
  }

  /** Draft-first entry point: record a proposed action. Never executes
   *  anything — enqueue only ever writes a row. */
  enqueue(input: HumanQueueEnqueueInput): HumanQueueItem {
    if (!input.title.trim() || !input.details.trim()) {
      throw new Error("HumanQueueStore.enqueue: title and details are required");
    }
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO coordination_human_queue
           (id, severity, category, title, details, suggested_fix, action, status, acknowledged, dispatch_run_id, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        input.severity,
        input.category,
        input.title,
        input.details,
        input.suggestedFix ?? null,
        input.action ? JSON.stringify(input.action) : null,
        now,
        now,
      );
    const row = this.get(id);
    if (!row) throw new Error(`HumanQueueStore.enqueue: failed to read back item ${id}`);
    return row;
  }

  get(id: string): HumanQueueItem | null {
    const row = this.db
      .prepare<[string]>(`SELECT * FROM coordination_human_queue WHERE id = ?`)
      .get(id) as HumanQueueRow | undefined;
    return row ? rowToItem(row) : null;
  }

  list(filter?: { status?: HumanQueueStatus }): HumanQueueItem[] {
    const rows = filter?.status
      ? (this.db
          .prepare<[string]>(
            `SELECT * FROM coordination_human_queue WHERE status = ? ORDER BY created_at ASC`,
          )
          .all(filter.status) as HumanQueueRow[])
      : (this.db
          .prepare(`SELECT * FROM coordination_human_queue ORDER BY created_at ASC`)
          .all() as HumanQueueRow[]);
    return rows.map(rowToItem);
  }

  /** Items approved but not yet dispatched — what a tick should act on. */
  listApprovedUndispatched(): HumanQueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM coordination_human_queue
           WHERE status = 'approved' AND dispatch_run_id IS NULL
           ORDER BY created_at ASC`,
      )
      .all() as HumanQueueRow[];
    return rows.map(rowToItem);
  }

  ack(id: string): void {
    this.mustUpdate(
      id,
      `UPDATE coordination_human_queue SET status = 'acknowledged', acknowledged = 1, updated_at = ? WHERE id = ?`,
      [nowIso(), id],
    );
  }

  /** Human approves the proposed action. Does NOT dispatch anything itself —
   *  that is the dispatch module's job (separation of concerns: the queue
   *  only ever records human decisions). */
  approve(id: string): HumanQueueItem {
    this.mustUpdate(
      id,
      `UPDATE coordination_human_queue SET status = 'approved', acknowledged = 1, updated_at = ? WHERE id = ?`,
      [nowIso(), id],
    );
    const row = this.get(id);
    if (!row) throw new Error(`HumanQueueStore.approve: item ${id} vanished after update`);
    return row;
  }

  reject(id: string, _reason?: string): void {
    this.mustUpdate(
      id,
      `UPDATE coordination_human_queue SET status = 'rejected', acknowledged = 1, updated_at = ? WHERE id = ?`,
      [nowIso(), id],
    );
  }

  /** Replace a pending item's dispatchable action args (e.g. an operator
   *  edits proposed args before approving — contract (a)'s
   *  `POST /org/approvals/:id/resolve {editedArgs}`). Keeps the existing
   *  `workflowName`; no-op if the item has no action to begin with (nothing
   *  to edit — not an error, since an observe-only escalation legitimately
   *  has no action). */
  replaceActionArgs(id: string, args: Record<string, unknown>): void {
    const row = this.get(id);
    if (!row) throw new Error(`HumanQueueStore.replaceActionArgs: item ${id} not found`);
    if (!row.action) return;
    const nextAction: HumanQueueAction = { workflowName: row.action.workflowName, args };
    this.mustUpdate(
      id,
      `UPDATE coordination_human_queue SET action = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(nextAction), nowIso(), id],
    );
  }

  resolve(id: string): void {
    const now = nowIso();
    this.mustUpdate(
      id,
      `UPDATE coordination_human_queue SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id],
    );
  }

  /** Record which workflow run this item's approved action was dispatched
   *  to. Idempotent — safe to call more than once with the same runId. */
  recordDispatch(id: string, dispatchRunId: string): void {
    this.mustUpdate(
      id,
      `UPDATE coordination_human_queue SET dispatch_run_id = ?, updated_at = ? WHERE id = ?`,
      [dispatchRunId, nowIso(), id],
    );
  }

  private mustUpdate(id: string, sql: string, params: unknown[]): void {
    const info = this.db.prepare(sql).run(...params);
    if (info.changes === 0) {
      throw new Error(`HumanQueueStore: item ${id} not found`);
    }
  }

  close(): void {
    this.db.close();
  }
}
