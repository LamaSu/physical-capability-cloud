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
import { fileURLToPath } from "node:url";

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

async function getJSON(path) {
  try {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) return { __error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { __error: err.message };
  }
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
  const [overview, errors, traffic, pages, events, security, devices, geo] = await Promise.all([
    getJSON(`/api/analytics/overview?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/errors?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/traffic?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/pages?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/events?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/security?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/devices?from=${FROM}&to=${TO}`),
    getJSON(`/api/analytics/geography?from=${FROM}&to=${TO}`),
  ]);

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

  // ── Save snapshot ───────────────────────────────────────────────────────
  const snapshot = {
    generatedAt: new Date().toISOString(),
    range: { from: FROM, to: TO },
    overview, errors, traffic, pages, events, security, devices, geo,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));

  if (SAVE) {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const reportFile = path.join(REPORTS_DIR, `analytics-${TO}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(snapshot, null, 2));
    console.log(c.dim + `  Saved to ${reportFile}` + c.reset);
    console.log();
  }
}

main().catch((err) => {
  console.error(c.red + "Error:" + c.reset, err);
  process.exit(1);
});
