#!/usr/bin/env node
/**
 * License scan — rejects transitive deps with copyleft licenses that
 * would contaminate the Apache 2.0 monorepo.
 *
 * Hard-blocked SPDX family prefixes (case-insensitive):
 *   GPL-*    (GNU GPL, any version)
 *   AGPL-*   (GNU Affero GPL, any version)
 *   SSPL-*   (Server Side Public License)
 *
 * Warned (does NOT fail, but logged for review):
 *   LGPL-*   (lesser GPL — usually safe for dynamic linking but worth knowing)
 *   EUPL-*   (European Union Public License — weak copyleft)
 *
 * Per-package override: set CI env PCC_LICENSE_ALLOW='pkg1@1.2.3,pkg2@*'
 * to allow specific package+version pairs despite their license. Use
 * sparingly and document in docs/adr/.
 *
 * Invocation:
 *   node scripts/license-scan.mjs
 *
 * Reads JSON from `pnpm licenses list --long --json` so it works across
 * every workspace package in one call.
 */

import { spawnSync } from "node:child_process";

const BLOCKED_PREFIXES = ["GPL-", "AGPL-", "SSPL-"];
const WARN_PREFIXES = ["LGPL-", "EUPL-"];

const allowEnv = process.env.PCC_LICENSE_ALLOW ?? "";
const ALLOW_LIST = new Set(
  allowEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function matchesAllow(name, version) {
  if (ALLOW_LIST.has(`${name}@${version}`)) return true;
  if (ALLOW_LIST.has(`${name}@*`)) return true;
  return false;
}

function classify(license) {
  if (!license) return { level: "unknown" };
  const up = license.toUpperCase();
  for (const p of BLOCKED_PREFIXES) {
    if (up.startsWith(p.toUpperCase())) return { level: "blocked", matched: p };
  }
  for (const p of WARN_PREFIXES) {
    if (up.startsWith(p.toUpperCase())) return { level: "warn", matched: p };
  }
  return { level: "ok" };
}

function main() {
  const r = spawnSync("pnpm", ["licenses", "list", "--long", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  if (r.status !== 0) {
    console.error("[license-scan] pnpm licenses list failed:");
    console.error(r.stderr);
    process.exit(2);
  }

  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch (e) {
    console.error("[license-scan] failed to parse pnpm JSON output:", e.message);
    process.exit(2);
  }

  const blocked = [];
  const warned = [];
  let total = 0;

  for (const [license, entries] of Object.entries(data)) {
    const verdict = classify(license);
    for (const entry of entries) {
      total += 1;
      const name = entry.name ?? "(unknown)";
      const version = entry.version ?? "*";
      if (verdict.level === "blocked") {
        if (matchesAllow(name, version)) {
          console.warn(
            `[license-scan] ALLOWLIST override: ${name}@${version} under ${license} ` +
              "(documented in PCC_LICENSE_ALLOW)",
          );
          continue;
        }
        blocked.push({ name, version, license, matched: verdict.matched });
      } else if (verdict.level === "warn") {
        warned.push({ name, version, license, matched: verdict.matched });
      }
    }
  }

  if (warned.length) {
    console.warn(`[license-scan] ${warned.length} warn-level licenses:`);
    for (const w of warned) {
      console.warn(`  ${w.name}@${w.version}  ${w.license}  (matched ${w.matched})`);
    }
  }

  if (blocked.length) {
    console.error(
      `[license-scan] FAIL — ${blocked.length} packages carry copyleft licenses that would contaminate the Apache 2.0 monorepo:`,
    );
    for (const b of blocked) {
      console.error(`  ${b.name}@${b.version}  ${b.license}  (matched ${b.matched})`);
    }
    console.error("");
    console.error(
      "If you have a documented reason to allow a specific package, add it to PCC_LICENSE_ALLOW (e.g. 'pkg@1.2.3') with ADR-referenced justification.",
    );
    process.exit(1);
  }

  console.log(
    `[license-scan] OK — scanned ${total} dep entries; 0 blocked, ${warned.length} warned.`,
  );
}

main();
