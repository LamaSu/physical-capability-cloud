#!/usr/bin/env node
/**
 * etl-audit-to-private-db.mjs — agent-onboarding observability piece 5 (ETL).
 *
 * REFERENCE DRAFT. Copies `agent.*` rows from the gateway's audit log (SQLite)
 * into the centralized PRIVATE observability DB (Postgres + TimescaleDB, see
 * ops/observability/schema.sql). Intended to run on a cron next to the gateway.
 *
 *   node scripts/observability/etl-audit-to-private-db.mjs [--dry-run]
 *
 * Env:
 *   PCC_DB_PATH               gateway SQLite path (default ./data/pcc.sqlite)
 *   OBSERVABILITY_DB_URL      postgres connection string for the private sink
 *   ETL_WATERMARK_FILE        watermark path (default ./.etl-watermark.json)
 *   ETL_BATCH_LIMIT           max rows per run (default 5000)
 *
 * Dependencies are loaded with dynamic import + graceful degrade (mirrors
 * posthog-service.ts) so NO new hard dependency is added to package.json —
 * Gate A stays clean. `better-sqlite3` already ships with the gateway; `pg`
 * is installed wherever the ETL actually runs.
 *
 * Idempotent: agent_funnel_events upsert on (trace_id, stage); agent_reports
 * upsert on id. Re-running over the same window is safe.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = process.env.PCC_DB_PATH ?? "./data/pcc.sqlite";
const PG_URL = process.env.OBSERVABILITY_DB_URL;
const WATERMARK_FILE = process.env.ETL_WATERMARK_FILE ?? "./.etl-watermark.json";
const BATCH_LIMIT = Number.parseInt(process.env.ETL_BATCH_LIMIT ?? "5000", 10);

// Redact obvious secrets before they land in the private DB (reports are
// free-text and PUBLIC-sourced). Mirrors the gateway DLP redactor intent.
const SECRET_RE =
  /(pcc_live_[a-z0-9]+|sk-[a-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|0x[a-fA-F0-9]{40,})/g;
const redact = (s) => (typeof s === "string" ? s.replace(SECRET_RE, "[redacted]") : s);

/** Pull a field that may be camelCase or snake_case. */
const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
};
const parseMeta = (v) => {
  if (v == null) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
};

async function loadDeps() {
  let Database, pg;
  try { ({ default: Database } = await import("better-sqlite3")); }
  catch { console.error("[etl] better-sqlite3 not available — cannot read gateway audit log."); process.exit(2); }
  if (!DRY_RUN) {
    try { pg = await import("pg"); }
    catch { console.error("[etl] pg not available — install it where the ETL runs, or use --dry-run."); process.exit(2); }
  }
  return { Database, pg };
}

function readWatermark() {
  if (!existsSync(WATERMARK_FILE)) return "1970-01-01T00:00:00.000Z";
  try { return JSON.parse(readFileSync(WATERMARK_FILE, "utf8")).since ?? "1970-01-01T00:00:00.000Z"; }
  catch { return "1970-01-01T00:00:00.000Z"; }
}
function writeWatermark(since) {
  if (DRY_RUN) return;
  writeFileSync(WATERMARK_FILE, JSON.stringify({ since, updated_at: new Date().toISOString() }, null, 2));
}

async function main() {
  if (!PG_URL && !DRY_RUN) {
    console.error("[etl] OBSERVABILITY_DB_URL is required (or pass --dry-run).");
    process.exit(2);
  }
  const { Database, pg } = await loadDeps();
  const since = readWatermark();
  console.log(`[etl] reading agent.* audit rows since ${since} from ${DB_PATH}${DRY_RUN ? " (dry-run)" : ""}`);

  // ── Source: gateway SQLite audit_log ───────────────────────────────────────
  const sdb = new Database(DB_PATH, { readonly: true });
  // Defensive: the audit table is `audit_log` (drizzle). SELECT * and pick fields
  // by either naming so this survives a snake/camel schema.
  const rows = sdb
    .prepare(
      `SELECT * FROM audit_log
        WHERE (eventType LIKE 'agent.%' OR event_type LIKE 'agent.%')
          AND timestamp > ?
        ORDER BY timestamp ASC
        LIMIT ?`,
    )
    .all(since, BATCH_LIMIT);
  sdb.close();

  const reports = [];
  const funnels = [];
  let maxTs = since;
  for (const r of rows) {
    const eventType = pick(r, "eventType", "event_type");
    const ts = pick(r, "timestamp");
    const meta = parseMeta(pick(r, "metadata"));
    const resourceId = pick(r, "resourceId", "resource_id");
    const actor = pick(r, "actor");
    if (ts > maxTs) maxTs = ts;

    if (eventType === "agent.report") {
      reports.push({
        id: resourceId,
        trace_id: meta.trace_id ?? null,
        ts,
        summary: redact(meta.summary ?? ""),
        detail: redact(meta.detail ?? null),
        last_endpoint: meta.last_endpoint ?? null,
        last_error_code: meta.last_error_code ?? null,
        agent_kind: meta.agent_kind ?? null,
        confused_about: meta.confused_about ?? null,
        actor: actor ?? null,
      });
    } else if (eventType === "agent.funnel") {
      funnels.push({
        trace_id: resourceId,
        stage: pick(r, "action") ?? meta.stage,
        ts: meta.ts ?? ts,
        route: meta.route ?? null,
        status: meta.status ?? null,
      });
    }
  }

  console.log(`[etl] ${rows.length} rows → ${reports.length} reports, ${funnels.length} funnel events`);

  if (DRY_RUN) {
    console.log(JSON.stringify({ sample_report: reports[0], sample_funnel: funnels[0] }, null, 2));
    console.log(`[etl] dry-run: would advance watermark to ${maxTs}`);
    return;
  }

  // ── Sink: private Postgres ──────────────────────────────────────────────────
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO pcc_observability, public");
    for (const rep of reports) {
      await client.query(
        `INSERT INTO agent_reports
           (id, trace_id, ts, summary, detail, last_endpoint, last_error_code, agent_kind, confused_about, actor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [rep.id, rep.trace_id, rep.ts, rep.summary, rep.detail, rep.last_endpoint,
         rep.last_error_code, rep.agent_kind, rep.confused_about, rep.actor],
      );
    }
    for (const f of funnels) {
      if (!f.trace_id || !f.stage) continue;
      await client.query(
        `INSERT INTO agent_funnel_events (trace_id, stage, ts, route, status)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (trace_id, stage) DO NOTHING`,
        [f.trace_id, f.stage, f.ts, f.route, f.status],
      );
    }
  } finally {
    await client.end();
  }

  writeWatermark(maxTs);
  console.log(`[etl] done. watermark → ${maxTs}`);
}

main().catch((err) => { console.error("[etl] fatal", err); process.exit(1); });
