/**
 * Which DISTINCT stored identities would the gateway treat as ONE owner under
 * normalizeIdentity? (WP-A round 8, astra authz r2: "check existing identities
 * for collisions before enabling the broader normalization policy".)
 *
 * READ-ONLY. It reads every identity-bearing column that identity binding
 * covers (auth/reserved-identities.ts CLAIM_QUERIES), groups the raw values by
 * normalizeIdentity, and returns each group holding more than one spelling.
 * `newMerge` marks a group whose spellings were DISTINCT under the comparison
 * master uses (trim + toLowerCase). Those are the principals this change would
 * join, so the operator resolves them before deploying.
 * scripts/identity-collision-audit.mjs runs it against a database.
 */
import { normalizeIdentity } from "./identity-normalize.js";

export interface IdentityCollision {
  normalized: string;
  spellings: string[];
  sources: string[];
  newMerge: boolean;
}

interface Reader {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/**
 * One source per identity column, with the table and column it reads. A source
 * whose table or column the database's own catalog lacks is skipped and
 * reported; see schemaHas().
 */
const SOURCES: ReadonlyArray<{ source: string; table: string; column: string; sql: string }> = [
  { source: "api_keys.operator_id", table: "api_keys", column: "operator_id", sql: "SELECT DISTINCT operator_id AS v FROM api_keys" },
  { source: "shop_kernels.operator_address", table: "shop_kernels", column: "operator_address", sql: "SELECT DISTINCT operator_address AS v FROM shop_kernels" },
  { source: "machine_registrations.tenant_id", table: "machine_registrations", column: "tenant_id", sql: "SELECT DISTINCT tenant_id AS v FROM machine_registrations" },
  {
    source: "machine_registrations.operator.walletAddress",
    table: "machine_registrations",
    column: "operator",
    sql: "SELECT DISTINCT CASE WHEN json_valid(operator) THEN json_extract(operator, '$.walletAddress') END AS v FROM machine_registrations",
  },
  {
    source: "machine_registrations.operator.email",
    table: "machine_registrations",
    column: "operator",
    sql: "SELECT DISTINCT CASE WHEN json_valid(operator) THEN json_extract(operator, '$.email') END AS v FROM machine_registrations",
  },
  { source: "job_offers.poster_did", table: "job_offers", column: "poster_did", sql: "SELECT DISTINCT poster_did AS v FROM job_offers" },
  { source: "ui_artifacts.owner", table: "ui_artifacts", column: "owner", sql: "SELECT DISTINCT owner AS v FROM ui_artifacts" },
];

/**
 * Does this database's schema hold `table`.`column`? Answered by reading SQLite's
 * OWN catalog (sqlite_master, then pragma_table_info), never by interpreting an
 * error: no error's code, class, message or fields can prove an absence, because
 * any code that throws can forge them (AZ-9 rounds 2-4, astra packs 95b-95d). The
 * catalog read itself throwing, or answering with anything but rows, propagates,
 * and the caller reports the source as `failed`.
 */
function schemaHas(db: Reader, table: string, column: string): boolean {
  // Names match the way SQLite itself resolves them (ASCII case-insensitive), and a
  // view counts as present: an exact comparison, or tables only, would report a
  // present source as ABSENT, which an allowlist then excuses (fail open).
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE")
    .all(table);
  if (!Array.isArray(tables)) throw new Error("catalog read returned no rows array");
  if (!tables.some((r) => sameName((r as { name?: unknown } | null)?.name, table))) return false;
  const columns = db.prepare("SELECT name FROM pragma_table_info(?) WHERE name = ? COLLATE NOCASE").all(table, column);
  if (!Array.isArray(columns)) throw new Error("catalog read returned no rows array");
  return columns.some((r) => sameName((r as { name?: unknown } | null)?.name, column));
}

/** SQLite's own identifier comparison: ASCII case-insensitive. */
function sameName(stored: unknown, asked: string): boolean {
  return typeof stored === "string" && stored.toLowerCase() === asked.toLowerCase();
}

export function findIdentityCollisions(db: Reader): {
  collisions: IdentityCollision[];
  read: string[];
  /** Sources whose table or column the database's own catalog lacks: allowlistable. */
  skipped: string[];
  /** Sources that exist (or whose presence the catalog could not answer) but could not be read: NEVER allowlistable. */
  failed: string[];
} {
  const groups = new Map<string, { spellings: Set<string>; sources: Set<string> }>();
  const read: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const { source, table, column, sql } of SOURCES) {
    // 1. The catalog decides presence. Only a POSITIVE "the catalog lacks it" is an
    //    absence (skipped: allowlistable for an optional source); a catalog that
    //    cannot be read is failed.
    let present: boolean;
    try {
      present = schemaHas(db, table, column);
    } catch {
      failed.push(source);
      continue;
    }
    if (!present) {
      skipped.push(source);
      continue;
    }
    // 2. The source EXISTS. Reading and processing its rows are one step, and ANY
    //    failure on the way, of any kind or shape, is failed: never excusable, and a
    //    partly read source contributes nothing.
    const found: Array<{ spelling: string; normalized: string }> = [];
    try {
      const rows = db.prepare(sql).all();
      for (const row of rows as Array<{ v?: unknown }>) {
        const spelling = row.v;
        if (typeof spelling !== "string") continue;
        const normalized = normalizeIdentity(spelling);
        if (!normalized) continue;
        found.push({ spelling, normalized });
      }
    } catch {
      failed.push(source);
      continue;
    }
    read.push(source);
    for (const { spelling, normalized } of found) {
      let g = groups.get(normalized);
      if (!g) groups.set(normalized, (g = { spellings: new Set(), sources: new Set() }));
      g.spellings.add(spelling);
      g.sources.add(source);
    }
  }
  const collisions: IdentityCollision[] = [];
  for (const [normalized, g] of groups) {
    if (g.spellings.size < 2) continue;
    const spellings = [...g.spellings].sort();
    const masterForms = new Set(spellings.map((s) => s.trim().toLowerCase()));
    collisions.push({ normalized, spellings, sources: [...g.sources].sort(), newMerge: masterForms.size > 1 });
  }
  collisions.sort((a, b) => a.normalized.localeCompare(b.normalized));
  return { collisions, read, skipped, failed };
}

/** The identity sources that EXIST in every PCC deployment. If the audit could
 *  not read one of these, it read no real identity data and must fail closed —
 *  reporting "safe to deploy" after reading nothing is the fail-open AZ-9. The
 *  optional tables (machine_registrations, job_offers, ui_artifacts) may be
 *  absent in a minimal deployment; name them in PCC_COLLISION_AUDIT_ALLOW_ABSENT
 *  to permit that, per deployment. */
export const REQUIRED_COLLISION_SOURCES: readonly string[] = [
  "api_keys.operator_id",
  "shop_kernels.operator_address",
];

export type CollisionAuditExit =
  | { code: 0; reason: string }
  | { code: 3; reason: string }
  | { code: 4; reason: string };

/**
 * The pre-deploy audit's exit decision (AZ-9 fix). FAIL CLOSED:
 *   4 — at least one identity source could not be read and was not explicitly
 *       allowlisted as absent (the audit is INCOMPLETE; it may have read no
 *       identities at all). This outranks a clean result.
 *   3 — the audit ran and found at least one NEW merge to resolve.
 *   0 — every non-allowlisted source was read and no new merge exists.
 * A required source (REQUIRED_COLLISION_SOURCES) can never be allowlisted away:
 * if it is unreadable, the audit is always incomplete.
 */
export function collisionAuditExit(params: {
  newMerges: number;
  read: readonly string[];
  skipped: readonly string[];
  /** Sources that exist but failed to read. Any entry makes the audit INCOMPLETE,
   *  whatever the allowlist says. Optional for older callers; absent means none. */
  failed?: readonly string[];
  allowedAbsent: readonly string[];
}): CollisionAuditExit {
  const failed = params.failed ?? [];
  if (failed.length > 0) {
    return {
      code: 4,
      reason:
        `audit INCOMPLETE — could not read (the source exists but the read failed): ${failed.join(", ")}. ` +
        "Only a confirmed missing table or column can be allowlisted; this cannot. Fix the read and re-run.",
    };
  }
  const allowed = new Set(params.allowedAbsent.map((s) => s.trim()).filter(Boolean));
  const blockingSkips = params.skipped.filter(
    (s) => REQUIRED_COLLISION_SOURCES.includes(s) || !allowed.has(s),
  );
  if (blockingSkips.length > 0) {
    return {
      code: 4,
      reason:
        `audit INCOMPLETE — could not read: ${blockingSkips.join(", ")}. ` +
        "A required source is never allowlistable; for a legitimately absent optional table, " +
        "set PCC_COLLISION_AUDIT_ALLOW_ABSENT=<comma-separated sources>. Refusing to report safe after reading it.",
    };
  }
  if (params.read.length === 0) {
    return { code: 4, reason: "audit INCOMPLETE — no identity source was read at all." };
  }
  if (params.newMerges > 0) {
    return { code: 3, reason: `${params.newMerges} NEW merge group(s) to resolve before deploy.` };
  }
  return { code: 0, reason: `no new merges; read ${params.read.length} source(s).` };
}
