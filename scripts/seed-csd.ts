#!/usr/bin/env tsx
/**
 * seed-csd.ts — Register the top-50 CSD catalog against a PCC gateway.
 *
 * Reads scripts/seed-csd-catalog.json and POSTs each CSD to `POST /api/csd`
 * on the target gateway (the register route in
 * packages/gateway/src/routes/csd.ts — NOT /api/csd/register).
 *
 * Idempotent: the in-memory CsdRegistry overwrites on re-register, so a re-run
 * reports everything as "registered" again. A DB-backed gateway that enforces
 * URL uniqueness returns HTTP 409 — those are counted as "skipped".
 *
 * Usage:
 *   PCC_BASE=http://localhost:8080 PCC_API_KEY=pcc_live_... pnpm tsx scripts/seed-csd.ts
 *
 * Env:
 *   PCC_BASE     Gateway base URL (default http://localhost:8080)
 *   PCC_API_KEY  Bearer token (optional; sent as Authorization header when set)
 *
 * No external dependencies — native fetch (Node >= 18) + node:fs.
 */
import { readFileSync } from "node:fs";

interface Csd {
  url: string;
  name: string;
  [key: string]: unknown;
}

const BASE = (process.env.PCC_BASE ?? "http://localhost:8080").replace(/\/+$/, "");
const API_KEY = process.env.PCC_API_KEY ?? "";
const ENDPOINT = `${BASE}/api/csd`;

const catalogUrl = new URL("./seed-csd-catalog.json", import.meta.url);
const catalog = JSON.parse(readFileSync(catalogUrl, "utf8")) as Csd[];

const headers: Record<string, string> = { "content-type": "application/json" };
if (API_KEY) headers["authorization"] = `Bearer ${API_KEY}`;

type Outcome = "registered" | "skipped" | "failed";

function bar(done: number, total: number, width = 24): string {
  const filled = Math.round((done / total) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${done}/${total}`;
}

async function register(csd: Csd): Promise<Outcome> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(csd) });
  } catch (err) {
    process.stderr.write(`\n  x ${csd.url} - network error: ${(err as Error).message}\n`);
    return "failed";
  }
  if (res.status === 409) return "skipped"; // already registered (uniqueness-enforcing backend)
  if (res.ok) return "registered";
  const detail = await res.text().catch(() => "");
  process.stderr.write(`\n  x ${csd.url} - HTTP ${res.status} ${detail.slice(0, 200)}\n`);
  return "failed";
}

async function main(): Promise<void> {
  console.log(
    `Seeding ${catalog.length} CSDs -> ${ENDPOINT}` +
      (API_KEY ? " (authenticated)" : " (no API key)"),
  );
  const counts: Record<Outcome, number> = { registered: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < catalog.length; i++) {
    const outcome = await register(catalog[i]);
    counts[outcome] += 1;
    process.stdout.write(`\r${bar(i + 1, catalog.length)}  ${catalog[i].url.padEnd(46)}`);
  }
  process.stdout.write("\n");
  console.log(
    `Done - ${counts.registered} registered, ${counts.skipped} skipped, ${counts.failed} failed.`,
  );
  if (counts.failed > 0) process.exit(1);
}

main();
