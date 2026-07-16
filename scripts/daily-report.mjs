#!/usr/bin/env node
/**
 * PCC Daily Analytics Report
 * ==========================
 *
 * Fetches analytics + security data from capability.network and prints a
 * formatted report. No cron, no dependencies — just run it:
 *
 *   node scripts/daily-report.mjs
 *   node scripts/daily-report.mjs --days 7
 *   node scripts/daily-report.mjs --save        # also save to ai/reports/
 *   node scripts/daily-report.mjs --compare     # compare to last snapshot
 *
 * On each run it stores a snapshot so the next run can diff against it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(__dirname, ".daily-report-state.json");
const REPORTS_DIR = path.join(PROJECT_ROOT, "ai", "reports");

const BASE = process.env.PCC_URL ?? "https://capability.network";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DAYS = (() => {
  const i = args.indexOf("--days");
  return i >= 0 ? parseInt(args[i + 1], 10) : 1;
})();
const SAVE = args.includes("--save");
const COMPARE = args.includes("--compare");
const OPEN = args.includes("--open");

// ---------------------------------------------------------------------------
// Colors (ANSI)
// ---------------------------------------------------------------------------

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const FROM = daysAgoISO(DAYS);
const TO = todayISO();

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

// Strip terminal control chars from a value before printing it — agent-supplied
// feedback text (even server-scrubbed) shouldn't be able to inject escape sequences
// into an operator's console. Char-code based (keeps TAB/LF, drops C0/DEL/C1).
function stripCtl(v) {
  const s = String(v ?? "");
  let out = "";
  for (let k = 0; k < s.length; k++) {
    const cc = s.charCodeAt(k);
    if (cc === 9 || cc === 10 || (cc >= 32 && cc !== 127 && !(cc >= 128 && cc <= 159))) out += s[k];
  }
  return out;
}

async function getJSON(path) {
  // Route-specific auth: only the admin route gets the admin token; only the analytics
  // routes get the API key — don't hand every endpoint both credentials (r-p3 #3).
  const headers = {};
  if (path.startsWith("/api/admin/")) {
    if (process.env.WAITLIST_ADMIN_TOKEN) headers["X-Admin-Token"] = process.env.WAITLIST_ADMIN_TOKEN;
  } else if (process.env.PCC_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.PCC_API_KEY}`;
  }
  try {
    const res = await fetch(`${BASE}${path}`, { headers });
    if (!res.ok) return { __error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { __error: err.message };
  }
}

/**
 * Summarize the feedback sink (GET /api/admin/feedback → {total, items}) for the
 * report window. Pure + exported so it can be unit-checked without running the report.
 */
export function summarizeFeedback(feedback, fromISO, toISO) {
  const items = Array.isArray(feedback?.items) ? feedback.items : [];
  const from = Date.parse(`${fromISO}T00:00:00Z`);
  // Exclusive next-day bound so the last 999ms of the final day aren't dropped (r-p3 #4).
  const to = Date.parse(`${toISO}T00:00:00Z`) + 86_400_000;
  const inWindow = items.filter((i) => {
    const t = Date.parse(i?.createdAt ?? "");
    return Number.isFinite(t) && t >= from && t < to;
  });
  const tally = (key) => {
    const m = Object.create(null); // prototype-safe: user keys like "__proto__" can't corrupt it (r-p3 #5)
    for (const i of inWindow) {
      const k = i?.[key] || "(none)";
      m[k] = (m[k] ?? 0) + 1;
    }
    return Object.entries(m).map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count);
  };
  return {
    error: feedback?.__error ?? null,
    total: inWindow.length,
    // all-time count from the response's `total` when present (survives any future
    // server-side pagination of `items`); else the item count (r-p3 #1).
    all_time: Number.isFinite(feedback?.total) ? feedback.total : items.length,
    by_type: tally("type"),
    by_severity: tally("severity").filter((r) => r.key !== "(none)"),
    top_endpoints: tally("endpoint").filter((r) => r.key !== "(none)").slice(0, 10),
    top_error_codes: tally("errorCode").filter((r) => r.key !== "(none)").slice(0, 10),
    with_logs: inWindow.filter((i) => Array.isArray(i?.logs) && i.logs.length > 0).length,
    recent: inWindow
      .slice()
      .sort((a, b) => Date.parse(b?.createdAt ?? "") - Date.parse(a?.createdAt ?? ""))
      .slice(0, 10)
      .map((i) => ({ id: i.id, type: i.type, severity: i.severity, endpoint: i.endpoint, errorCode: i.errorCode, httpStatus: i.httpStatus, summary: i.summary, logs: i.logs?.length ?? 0, createdAt: i.createdAt })),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pad(s, n) {
  return String(s).padEnd(n, " ");
}
function num(n) {
  return (n ?? 0).toLocaleString();
}
function delta(curr, prev) {
  if (prev == null) return c.gray + "(baseline)" + c.reset;
  const d = (curr ?? 0) - (prev ?? 0);
  if (d === 0) return c.gray + "±0" + c.reset;
  if (d > 0) return c.green + `+${d}` + c.reset;
  return c.red + `${d}` + c.reset;
}
function bar(n, max, width = 20) {
  const filled = Math.round((n / Math.max(max, 1)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function line(len = 78, char = "─") {
  return c.dim + char.repeat(len) + c.reset;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log();
  console.log(c.bold + c.cyan + "╔══════════════════════════════════════════════════════════════════════════╗" + c.reset);
  console.log(c.bold + c.cyan + "║                     PCC Daily Analytics Report                          ║" + c.reset);
  console.log(c.bold + c.cyan + "╚══════════════════════════════════════════════════════════════════════════╝" + c.reset);
  console.log(c.dim + `  Range: ${FROM} → ${TO}  (${DAYS} day${DAYS === 1 ? "" : "s"})` + c.reset);
  console.log(c.dim + `  Host:  ${BASE}` + c.reset);
  console.log(c.dim + `  Time:  ${new Date().toISOString()}` + c.reset);
  console.log();

  // Fetch everything in parallel
  const [overview, errors, traffic, pages, events, security, devices, geo, feedbackRaw] = await Promise.all([
    getJSON(`/api/analytics/overview?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/errors?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/traffic?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/pages?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/events?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/security?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/devices?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/geography?from=${FROM}&to=${TO}`),
    getJSON(`/api/admin/feedback`), // durable agent+human feedback sink (JSONL)
  ]);
  const feedback = summarizeFeedback(feedbackRaw, FROM, TO);

  // Load previous snapshot for comparison
  let prev = null;
  if (COMPARE && fs.existsSync(STATE_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  }

  // ── SECTION: Overview ───────────────────────────────────────────────────
  console.log(c.bold + "OVERVIEW" + c.reset);
  console.log(line());
  const ph = overview.posthog ?? {};
  const sn = overview.sentry ?? {};
  const prevPh = prev?.overview?.posthog ?? {};
  const prevSn = prev?.overview?.sentry ?? {};

  console.log(`  ${pad("Total events", 22)} ${c.bold}${num(ph.totalEvents)}${c.reset}  ${delta(ph.totalEvents, prevPh.totalEvents)}`);
  console.log(`  ${pad("Unique visitors", 22)} ${c.bold}${num(ph.uniquePersons)}${c.reset}  ${delta(ph.uniquePersons, prevPh.uniquePersons)}`);
  console.log(`  ${pad("Pageviews", 22)} ${c.bold}${num(ph.pageviews)}${c.reset}  ${delta(ph.pageviews, prevPh.pageviews)}`);
  console.log(`  ${pad("Sentry issues (unres)", 22)} ${sn.unresolvedIssues > 0 ? c.yellow : c.green}${num(sn.unresolvedIssues)}${c.reset}  ${delta(sn.unresolvedIssues, prevSn.unresolvedIssues)}`);
  console.log();

  // ── SECTION: Top Events ─────────────────────────────────────────────────
  if ((events.events ?? []).length > 0) {
    console.log(c.bold + "TOP CUSTOM EVENTS" + c.reset);
    console.log(line());
    const max = events.events[0]?.count ?? 1;
    for (const e of events.events.slice(0, 10)) {
      const b = c.cyan + bar(e.count, max, 18) + c.reset;
      console.log(`  ${pad(e.name, 34)} ${b} ${c.bold}${num(e.count)}${c.reset}`);
    }
    console.log();
  }

  // ── SECTION: Top Pages ──────────────────────────────────────────────────
  if ((pages.pages ?? []).length > 0) {
    console.log(c.bold + "TOP PAGES" + c.reset);
    console.log(line());
    const max = pages.pages[0]?.views ?? 1;
    for (const p of pages.pages.slice(0, 10)) {
      const b = c.green + bar(p.views, max, 18) + c.reset;
      console.log(`  ${pad(p.path.slice(0, 34), 34)} ${b} ${c.bold}${num(p.views)}${c.reset}  ${c.dim}(${p.uniqueVisitors} unique)${c.reset}`);
    }
    console.log();
  }

  // ── SECTION: Security ───────────────────────────────────────────────────
  const secTotal = security.totalSecurityEvents ?? 0;
  if (secTotal > 0 || !security.__error) {
    const secColor = secTotal > 0 ? c.yellow : c.green;
    console.log(c.bold + "SECURITY EVENTS" + c.reset);
    console.log(line());
    console.log(`  ${pad("Total security events", 22)} ${secColor}${num(secTotal)}${c.reset}`);
    console.log(`  ${pad("Attacks blocked", 22)} ${(security.attacks ?? []).length > 0 ? c.red : c.green}${num((security.attacks ?? []).length)}${c.reset}`);
    console.log(`  ${pad("Honeypot triggers", 22)} ${(security.honeypots ?? []).length > 0 ? c.yellow : c.green}${num((security.honeypots ?? []).length)}${c.reset}`);
    console.log(`  ${pad("Bot detections", 22)} ${(security.bots ?? []).length > 0 ? c.yellow : c.green}${num((security.bots ?? []).length)}${c.reset}`);
    console.log(`  ${pad("Rate limit hits", 22)} ${(security.rateLimits ?? []).length > 0 ? c.yellow : c.green}${num((security.rateLimits ?? []).length)}${c.reset}`);
    console.log();

    // Show top attacks
    if ((security.attacks ?? []).length > 0) {
      console.log(c.red + "  ⚠ ATTACK ATTEMPTS:" + c.reset);
      for (const a of security.attacks.slice(0, 5)) {
        console.log(`    ${c.red}${pad(a.type, 16)}${c.reset} ${c.dim}${a.ip}${c.reset} → ${a.path}`);
      }
      console.log();
    }

    // Show honeypot triggers
    if ((security.honeypots ?? []).length > 0) {
      console.log(c.yellow + "  🪤 HONEYPOT TRIGGERS:" + c.reset);
      for (const h of security.honeypots.slice(0, 5)) {
        console.log(`    ${c.yellow}${pad(h.path, 24)}${c.reset} ${c.dim}${h.ip}${c.reset} (${h.count}x)`);
      }
      console.log();
    }

    // Show bots
    if ((security.bots ?? []).length > 0) {
      console.log(c.blue + "  🤖 BOT DETECTIONS:" + c.reset);
      for (const b of security.bots.slice(0, 5)) {
        const pct = Math.round((b.confidence ?? 0) * 100);
        console.log(`    ${c.blue}${pad(b.type, 16)}${c.reset} ${c.dim}${b.ip}${c.reset} ${pct}% — ${b.reason?.slice(0, 40)}`);
      }
      console.log();
    }
  }

  // ── SECTION: Sentry Errors ──────────────────────────────────────────────
  if ((errors.issues ?? []).length > 0) {
    console.log(c.bold + "SENTRY ERRORS" + c.reset);
    console.log(line());
    console.log(`  ${pad("Total errors", 22)} ${c.bold}${num(errors.totalErrors)}${c.reset}`);
    console.log();

    // New issues (not in previous snapshot)
    const prevIds = new Set((prev?.errors?.issues ?? []).map((i) => i.id));
    const newIssues = (errors.issues ?? []).filter((i) => !prevIds.has(i.id));
    if (newIssues.length > 0 && COMPARE && prev) {
      console.log(c.red + "  NEW ISSUES SINCE LAST RUN:" + c.reset);
      for (const issue of newIssues.slice(0, 5)) {
        console.log(`    ${c.red}●${c.reset} ${issue.title?.slice(0, 70)} ${c.dim}(${issue.count}x)${c.reset}`);
      }
      console.log();
    }

    console.log(c.bold + "  Top unresolved issues:" + c.reset);
    for (const issue of (errors.issues ?? []).slice(0, 8)) {
      const level = issue.level === "error" || issue.level === "fatal" ? c.red : c.yellow;
      console.log(`    ${level}●${c.reset} ${pad(issue.title?.slice(0, 60), 60)} ${c.dim}${num(issue.count)}x${c.reset}`);
    }
    console.log();
  }

  // ── SECTION: Devices & Geography ────────────────────────────────────────
  if ((devices.browsers ?? []).length > 0 || (geo.countries ?? []).length > 0) {
    console.log(c.bold + "AUDIENCE" + c.reset);
    console.log(line());

    if ((devices.browsers ?? []).length > 0) {
      console.log("  " + c.dim + "Browsers:" + c.reset);
      for (const b of devices.browsers.slice(0, 5)) {
        console.log(`    ${pad(b.name, 24)} ${c.cyan}${num(b.count)}${c.reset}`);
      }
    }
    if ((geo.countries ?? []).length > 0) {
      console.log("  " + c.dim + "Countries:" + c.reset);
      for (const country of geo.countries.slice(0, 5)) {
        console.log(`    ${pad((country.code + "  " + country.name).slice(0, 24), 24)} ${c.cyan}${num(country.visitors)}${c.reset}`);
      }
    }
    console.log();
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  console.log(line(78, "═"));
  const verdict =
    (security.attacks ?? []).length > 0 ? c.red + "● RED — active attacks detected" + c.reset :
    (security.honeypots ?? []).length > 0 || (security.rateLimits ?? []).length > 0 ? c.yellow + "● YELLOW — suspicious activity" + c.reset :
    c.green + "● GREEN — all quiet" + c.reset;
  console.log("  Verdict: " + verdict);
  console.log();

  // ── SECTION: Agent + human feedback (pcc_report) ────────────────────────
  console.log(c.bold + "AGENT FEEDBACK (pcc_report)" + c.reset);
  console.log(line());
  if (feedback.error) {
    console.log(`  ${c.red}unavailable: ${feedback.error}${c.reset}  (set WAITLIST_ADMIN_TOKEN)`);
  } else if (feedback.total === 0) {
    console.log(`  ${c.gray}no feedback in range${c.reset}  (${num(feedback.all_time)} all-time)`);
  } else {
    console.log(`  ${pad("Reports in range", 22)} ${c.bold}${num(feedback.total)}${c.reset}  ${c.gray}(${num(feedback.all_time)} all-time, ${num(feedback.with_logs)} with logs)${c.reset}`);
    const maxT = Math.max(...feedback.by_type.map((r) => r.count), 1);
    for (const r of feedback.by_type) console.log(`    ${pad(stripCtl(r.key), 12)} ${bar(r.count, maxT, 16)} ${num(r.count)}`);
    if (feedback.top_error_codes.length) {
      console.log(`  ${c.dim}top error codes:${c.reset}`);
      for (const r of feedback.top_error_codes.slice(0, 5)) console.log(`    ${pad(stripCtl(r.key), 22)} ${num(r.count)}`);
    }
    if (feedback.top_endpoints.length) {
      console.log(`  ${c.dim}top endpoints:${c.reset}`);
      for (const r of feedback.top_endpoints.slice(0, 5)) console.log(`    ${pad(stripCtl(r.key), 40)} ${num(r.count)}`);
    }
    console.log(`  ${c.dim}recent:${c.reset}`);
    for (const r of feedback.recent.slice(0, 5)) {
      const sev = r.severity ? "/" + stripCtl(r.severity) : "";
      console.log(`    ${c.gray}${stripCtl((r.createdAt ?? "").slice(5, 16))}${c.reset} [${stripCtl(r.type)}${sev}] ${stripCtl(r.endpoint ?? "—")} ${r.errorCode ? c.yellow + stripCtl(r.errorCode) + c.reset : ""} — ${stripCtl(String(r.summary ?? "").slice(0, 60))}`);
    }
  }
  console.log();

  // ── Save snapshot ───────────────────────────────────────────────────────
  const snapshot = {
    generatedAt: new Date().toISOString(),
    range: { from: FROM, to: TO },
    overview, errors, traffic, pages, events, security, devices, geo, feedback,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));

  // Always save when --save OR --open (can't open without something to view)
  if (SAVE || OPEN) {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const reportFile = path.join(REPORTS_DIR, `analytics-${TO}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(snapshot, null, 2));
    console.log(c.dim + `  Saved to ${reportFile}` + c.reset);

    // Generate self-contained HTML viewer
    const allReports = fs.readdirSync(REPORTS_DIR)
      .filter((f) => f.startsWith("analytics-") && f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => {
        try {
          const date = f.replace("analytics-", "").replace(".json", "");
          const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), "utf8"));
          return { date, data };
        } catch { return null; }
      })
      .filter(Boolean);

    const htmlFile = path.join(REPORTS_DIR, "index.html");
    fs.writeFileSync(htmlFile, buildHTML(allReports));
    console.log(c.dim + `  Viewer: ${htmlFile}` + c.reset);
    console.log();

    if (OPEN) {
      const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const args = process.platform === "win32" ? ["/c", "start", "", htmlFile] : [htmlFile];
      spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    }
  }
}

// ---------------------------------------------------------------------------
// HTML Viewer Template (self-contained, no network dependencies)
// ---------------------------------------------------------------------------

function buildHTML(reports) {
  const data = JSON.stringify(reports);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PCC Analytics — Local Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    background: #0a0e14; color: #e6e1dc; padding: 32px;
    max-width: 1200px; margin: 0 auto;
  }
  h1 { font-size: 22px; letter-spacing: 0.5px; margin-bottom: 4px; background: linear-gradient(90deg,#14b8a6,#06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: rgba(255,255,255,0.5); margin: 20px 0 8px; font-weight: 600; }
  .subtitle { color: rgba(255,255,255,0.4); font-size: 12px; margin-bottom: 24px; }
  .controls { display: flex; gap: 12px; align-items: center; margin-bottom: 20px; padding: 12px 16px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
  select { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #e6e1dc; padding: 6px 10px; border-radius: 6px; font: inherit; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge.green { background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3); }
  .badge.yellow { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }
  .badge.red { background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 12px; margin-bottom: 16px; }
  .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 14px 18px; }
  .card .label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: rgba(255,255,255,0.4); margin-bottom: 4px; }
  .card .value { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .card.alert .value { color: #f59e0b; }
  .card.danger .value { color: #ef4444; }
  .panel { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 16px 20px; margin-bottom: 16px; }
  .panel.danger { background: rgba(239,68,68,0.03); border-color: rgba(239,68,68,0.15); }
  .row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
  .row:last-child { border-bottom: none; }
  .row .name { color: rgba(255,255,255,0.65); font-family: "SF Mono", "Consolas", monospace; font-size: 12px; }
  .row .count { color: rgba(255,255,255,0.85); font-variant-numeric: tabular-nums; font-weight: 600; }
  .bar { display: inline-block; height: 6px; background: linear-gradient(90deg,#14b8a6,#06b6d4); border-radius: 3px; margin-right: 10px; vertical-align: middle; }
  .error-row .name { color: #ef4444; }
  .empty { text-align: center; padding: 40px 20px; color: rgba(255,255,255,0.3); font-style: italic; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.06); font-size: 11px; color: rgba(255,255,255,0.3); }
</style>
</head>
<body>
<h1>PCC Analytics — Local Report</h1>
<p class="subtitle">Saved locally. Not published anywhere.</p>

<div class="controls">
  <label>Date: <select id="dateSel"></select></label>
  <span id="verdict" class="badge"></span>
  <span id="generated" style="color: rgba(255,255,255,0.3); font-size: 11px; margin-left: auto;"></span>
</div>

<div id="content"></div>

<div class="footer">
  Viewer generated by <code>scripts/daily-report.mjs</code> — runs locally, reads <code>ai/reports/*.json</code>.
  Nothing leaves your machine.
</div>

<script>
const REPORTS = ${data};

const sel = document.getElementById('dateSel');
const content = document.getElementById('content');
const verdictEl = document.getElementById('verdict');
const genEl = document.getElementById('generated');

REPORTS.forEach((r, i) => {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = r.date;
  sel.appendChild(opt);
});

function num(n) { return (n ?? 0).toLocaleString(); }
function esc(s) { return String(s ?? '').replace(/[<>&"']/g, c => '&#' + c.charCodeAt(0) + ';'); }

function render(i) {
  const r = REPORTS[i];
  if (!r) { content.innerHTML = '<div class="empty">No reports saved yet.</div>'; return; }
  const d = r.data;
  const ph = d.overview?.posthog || {};
  const sn = d.overview?.sentry || {};
  const sec = d.security || {};
  const attacks = (sec.attacks || []).length;
  const honeypots = (sec.honeypots || []).length;
  const bots = (sec.bots || []).length;
  const rates = (sec.rateLimits || []).length;

  // Verdict
  if (attacks > 0) { verdictEl.textContent = '● RED'; verdictEl.className = 'badge red'; }
  else if (honeypots > 0 || rates > 0 || bots > 0) { verdictEl.textContent = '● YELLOW'; verdictEl.className = 'badge yellow'; }
  else { verdictEl.textContent = '● GREEN'; verdictEl.className = 'badge green'; }

  genEl.textContent = 'Generated: ' + new Date(d.generatedAt).toLocaleString();

  let html = '';

  // Overview cards
  html += '<h2>Overview</h2><div class="grid">';
  html += '<div class="card"><div class="label">Total Events</div><div class="value">' + num(ph.totalEvents) + '</div></div>';
  html += '<div class="card"><div class="label">Unique Visitors</div><div class="value">' + num(ph.uniquePersons) + '</div></div>';
  html += '<div class="card"><div class="label">Pageviews</div><div class="value">' + num(ph.pageviews) + '</div></div>';
  html += '<div class="card' + (sn.unresolvedIssues > 0 ? ' alert' : '') + '"><div class="label">Unresolved Errors</div><div class="value">' + num(sn.unresolvedIssues) + '</div></div>';
  html += '</div>';

  // Security
  if ((sec.totalSecurityEvents ?? 0) > 0 || attacks || honeypots || bots || rates) {
    html += '<h2>Security Events</h2><div class="grid">';
    html += '<div class="card' + (attacks > 0 ? ' danger' : '') + '"><div class="label">Attacks Blocked</div><div class="value">' + attacks + '</div></div>';
    html += '<div class="card' + (honeypots > 0 ? ' alert' : '') + '"><div class="label">Honeypot Triggers</div><div class="value">' + honeypots + '</div></div>';
    html += '<div class="card' + (bots > 0 ? ' alert' : '') + '"><div class="label">Bot Detections</div><div class="value">' + bots + '</div></div>';
    html += '<div class="card' + (rates > 0 ? ' alert' : '') + '"><div class="label">Rate Limit Hits</div><div class="value">' + rates + '</div></div>';
    html += '</div>';

    if (attacks > 0) {
      html += '<div class="panel danger"><h2 style="margin-top:0;color:#ef4444;">⚠ Attack Attempts</h2>';
      sec.attacks.slice(0, 10).forEach(a => {
        html += '<div class="row"><span class="name" style="color:#ef4444;">' + esc(a.type) + ' · ' + esc(a.ip) + ' → ' + esc(a.path) + '</span><span class="count">' + a.count + 'x</span></div>';
      });
      html += '</div>';
    }
    if (honeypots > 0) {
      html += '<div class="panel"><h2 style="margin-top:0;">🪤 Honeypot Triggers</h2>';
      sec.honeypots.slice(0, 10).forEach(h => {
        html += '<div class="row"><span class="name">' + esc(h.path) + ' · ' + esc(h.ip) + '</span><span class="count">' + h.count + 'x</span></div>';
      });
      html += '</div>';
    }
    if (bots > 0) {
      html += '<div class="panel"><h2 style="margin-top:0;">🤖 Bot Detections</h2>';
      sec.bots.slice(0, 10).forEach(b => {
        html += '<div class="row"><span class="name">' + esc(b.type) + ' · ' + esc(b.ip) + ' · ' + esc(b.reason) + '</span><span class="count">' + Math.round((b.confidence||0)*100) + '%</span></div>';
      });
      html += '</div>';
    }
  }

  // Agent feedback (pcc_report)
  if (d.feedback && d.feedback.total > 0) {
    html += '<h2>Agent Feedback (pcc_report) — ' + num(d.feedback.total) + ' in range, ' + num(d.feedback.with_logs) + ' with logs</h2><div class="panel">';
    (d.feedback.by_type || []).forEach(t => {
      html += '<div class="row"><span class="name">' + esc(t.key) + '</span><span class="count">' + num(t.count) + '</span></div>';
    });
    (d.feedback.recent || []).slice(0, 8).forEach(r => {
      html += '<div class="row"><span class="name">[' + esc(r.type) + (r.severity ? '/' + esc(r.severity) : '') + '] ' + esc(r.endpoint || '—') + ' ' + esc(r.errorCode || '') + ' — ' + esc((r.summary || '').slice(0, 80)) + '</span><span class="count">' + esc((r.createdAt || '').slice(5, 16)) + '</span></div>';
    });
    html += '</div>';
  }

  // Top events
  if ((d.events?.events || []).length > 0) {
    const maxE = d.events.events[0].count || 1;
    html += '<h2>Top Custom Events</h2><div class="panel">';
    d.events.events.slice(0, 10).forEach(e => {
      const pct = Math.round((e.count / maxE) * 100);
      html += '<div class="row"><span class="name"><span class="bar" style="width:' + pct + 'px;"></span>' + esc(e.name) + '</span><span class="count">' + num(e.count) + '</span></div>';
    });
    html += '</div>';
  }

  // Top pages
  if ((d.pages?.pages || []).length > 0) {
    const maxP = d.pages.pages[0].views || 1;
    html += '<h2>Top Pages</h2><div class="panel">';
    d.pages.pages.slice(0, 10).forEach(p => {
      const pct = Math.round((p.views / maxP) * 100);
      html += '<div class="row"><span class="name"><span class="bar" style="width:' + pct + 'px;"></span>' + esc(p.path) + '</span><span class="count">' + num(p.views) + ' · ' + num(p.uniqueVisitors) + ' unique</span></div>';
    });
    html += '</div>';
  }

  // Sentry errors
  if ((d.errors?.issues || []).length > 0) {
    html += '<h2>Sentry Errors — Top Unresolved</h2><div class="panel">';
    d.errors.issues.slice(0, 10).forEach(issue => {
      html += '<div class="row error-row"><span class="name">● ' + esc(issue.title) + '</span><span class="count">' + num(issue.count) + 'x</span></div>';
    });
    html += '</div>';
  }

  // Devices + geo
  const browsers = d.devices?.browsers || [];
  const countries = d.geo?.countries || [];
  if (browsers.length > 0 || countries.length > 0) {
    html += '<h2>Audience</h2><div class="grid">';
    if (browsers.length > 0) {
      html += '<div class="panel"><div class="label" style="font-size:10px;color:rgba(255,255,255,0.4);margin-bottom:8px;">BROWSERS</div>';
      browsers.slice(0, 5).forEach(b => {
        html += '<div class="row"><span class="name">' + esc(b.name) + '</span><span class="count">' + num(b.count) + '</span></div>';
      });
      html += '</div>';
    }
    if (countries.length > 0) {
      html += '<div class="panel"><div class="label" style="font-size:10px;color:rgba(255,255,255,0.4);margin-bottom:8px;">COUNTRIES</div>';
      countries.slice(0, 5).forEach(c => {
        html += '<div class="row"><span class="name">' + esc(c.code + '  ' + c.name) + '</span><span class="count">' + num(c.visitors) + '</span></div>';
      });
      html += '</div>';
    }
    html += '</div>';
  }

  content.innerHTML = html || '<div class="empty">Report has no data.</div>';
}

sel.addEventListener('change', e => render(parseInt(e.target.value, 10)));
render(0);
</script>
</body>
</html>`;
}

// Only run the report when executed directly — so `summarizeFeedback` can be imported
// (e.g. by a test) without triggering the whole fetch+render.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  main().catch((err) => {
    console.error(c.red + "Error:" + c.reset, err);
    process.exit(1);
  });
}
