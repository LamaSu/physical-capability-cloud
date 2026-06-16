#!/usr/bin/env node
/**
 * alert-evaluator.mjs — agent-onboarding observability piece 5 (alerts).
 *
 * REFERENCE DRAFT. Reads the troubleshooting views in the private
 * observability DB (ops/observability/schema.sql) and fires alerts on:
 *
 *   1. NEW ERROR CLASS  — an error_code seen in the last 1h that never
 *                         appeared in the prior 30 days.            (notify)
 *   2. FUNNEL DROP      — a stage's conversion today is >DROP_PCT below its
 *                         trailing 7-day mean.                       (page)
 *   3. REPORT SPIKE     — agent_reports/hour > REPORT_SPIKE.          (page)
 *   4. CANARY DOWN      — no agent_canary_runs row with ok=true in the
 *                         last 15 minutes.                           (page)
 *
 *   node scripts/observability/alert-evaluator.mjs [--dry-run]
 *
 * Env:
 *   OBSERVABILITY_DB_URL   postgres connection string (required unless --dry-run)
 *   SLACK_WEBHOOK_URL      incoming-webhook for notify/page (optional → logs only)
 *   ALERT_FUNNEL_DROP_PCT  default 20
 *   ALERT_REPORT_SPIKE     default 10  (reports/hour)
 *
 * `pg` is loaded via dynamic import + graceful degrade (no new hard dep).
 * Exit code is non-zero if any PAGE-severity alert fired (so a cron wrapper
 * can escalate).
 */

const DRY_RUN = process.argv.includes("--dry-run");
const PG_URL = process.env.OBSERVABILITY_DB_URL;
const SLACK = process.env.SLACK_WEBHOOK_URL;
const DROP_PCT = Number.parseFloat(process.env.ALERT_FUNNEL_DROP_PCT ?? "20");
const REPORT_SPIKE = Number.parseFloat(process.env.ALERT_REPORT_SPIKE ?? "10");

const alerts = []; // { severity: "notify"|"page", title, body }
const fire = (severity, title, body) => alerts.push({ severity, title, body });

async function notifySlack(a) {
  const emoji = a.severity === "page" ? ":rotating_light:" : ":mag:";
  const text = `${emoji} *[observability ${a.severity}]* ${a.title}\n${a.body}`;
  if (!SLACK) { console.log(`[alert:${a.severity}] ${a.title} — ${a.body}`); return; }
  try {
    await fetch(SLACK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) { console.error("[alert] slack post failed", e); }
}

async function main() {
  if (!PG_URL && !DRY_RUN) {
    console.error("[alert] OBSERVABILITY_DB_URL required (or --dry-run).");
    process.exit(2);
  }
  if (DRY_RUN) {
    console.log("[alert] dry-run: would evaluate 4 rules against", PG_URL ?? "(no DB)");
    console.log("  thresholds:", { DROP_PCT, REPORT_SPIKE });
    return;
  }

  let pg;
  try { pg = await import("pg"); }
  catch { console.error("[alert] pg not available."); process.exit(2); }

  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO pcc_observability, public");

    // 1. NEW ERROR CLASS
    const newErr = await client.query(`
      SELECT DISTINCT last_error_code AS code
      FROM agent_reports
      WHERE ts > now() - INTERVAL '1 hour' AND last_error_code IS NOT NULL
        AND last_error_code NOT IN (
          SELECT DISTINCT last_error_code FROM agent_reports
          WHERE ts <= now() - INTERVAL '1 hour' AND ts > now() - INTERVAL '30 days'
            AND last_error_code IS NOT NULL)`);
    for (const r of newErr.rows) {
      fire("notify", "New error class", `\`${r.code}\` appeared in the last hour and was not seen in the prior 30 days.`);
    }

    // 2. FUNNEL DROP — today's per-stage distinct journeys vs trailing 7d mean.
    const drop = await client.query(`
      WITH today AS (
        SELECT stage, count(DISTINCT trace_id)::float AS n
        FROM agent_funnel_events WHERE ts > date_trunc('day', now()) GROUP BY stage),
      base AS (
        SELECT stage, count(DISTINCT trace_id)::float / 7 AS mean
        FROM agent_funnel_events
        WHERE ts > now() - INTERVAL '7 days' AND ts <= date_trunc('day', now()) GROUP BY stage)
      SELECT b.stage, t.n, b.mean,
             round(100.0 * (b.mean - coalesce(t.n,0)) / NULLIF(b.mean,0), 1) AS drop_pct
      FROM base b LEFT JOIN today t USING (stage)
      WHERE b.mean > 0`);
    for (const r of drop.rows) {
      if (Number(r.drop_pct) > DROP_PCT) {
        fire("page", "Funnel stage drop", `Stage \`${r.stage}\` is down ${r.drop_pct}% today (${r.n ?? 0} vs 7d mean ${r.mean.toFixed(1)}).`);
      }
    }

    // 3. REPORT SPIKE
    const spike = await client.query(`SELECT count(*)::float AS n FROM agent_reports WHERE ts > now() - INTERVAL '1 hour'`);
    const rph = Number(spike.rows[0]?.n ?? 0);
    if (rph > REPORT_SPIKE) fire("page", "pcc_report spike", `${rph} agent reports in the last hour (threshold ${REPORT_SPIKE}).`);

    // 4. CANARY DOWN
    const canary = await client.query(`SELECT count(*)::int AS n FROM agent_canary_runs WHERE ok = true AND ts > now() - INTERVAL '15 minutes'`);
    if (Number(canary.rows[0]?.n ?? 0) === 0) fire("page", "Canary down", "No successful canary run in the last 15 minutes.");
  } finally {
    await client.end();
  }

  for (const a of alerts) await notifySlack(a);
  console.log(`[alert] evaluated. fired ${alerts.length} alert(s).`);
  if (alerts.some((a) => a.severity === "page")) process.exit(3); // escalate
}

main().catch((err) => { console.error("[alert] fatal", err); process.exit(1); });
