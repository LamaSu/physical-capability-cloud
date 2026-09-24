/**
 * Guard for N50: production dashboard code must not hard-code a local gateway
 * origin. A literal http://localhost or http://127.0.0.1 URL is how /setup
 * came to send the signed-in user's API key to their own machine. Use
 * lib/gateway-base.ts (the configured gateway) instead.
 *
 * This is the narrow check. The key itself is guarded by
 * no-direct-auth-headers.test.ts (only fetchWithKey puts it on a request, after
 * checking the destination) and, at runtime, by the egress guard.
 *
 * Comment lines are ignored. KNOWN lists the remaining literals, each with
 * why it is not a key leak and who removes it; the list only shrinks.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_ORIGIN = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?/;

const KNOWN: Record<string, string> = {
  "pages/LandingPage.tsx": "unused API_BASE plus a dev-only base; the page is retire-after-parity (launch #2277)",
  "stores/setup-wizard-store.ts": "the local-chain RPC default (anvil :8545) offered in a config form; it is never fetched, let alone with the key",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const offenders = new Map<string, string[]>();
for (const full of files(SRC)) {
  const rel = relative(SRC, full).split(sep).join("/");
  const hits = readFileSync(full, "utf-8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && LOCAL_ORIGIN.test(line))
    .map(({ line, n }) => `${rel}:${n} ${line.trim().slice(0, 100)}`);
  if (hits.length) offenders.set(rel, hits);
}

describe("no hard-coded local gateway origin (N50 guard)", () => {
  it("no production module outside KNOWN hard-codes localhost or 127.0.0.1", () => {
    const unexpected = [...offenders.entries()].filter(([f]) => !(f in KNOWN)).flatMap(([, h]) => h);
    expect(unexpected, "Use lib/gateway-base.ts; never send the key to a hard-coded origin").toEqual([]);
  });

  it("KNOWN only shrinks: every listed file still has the literal", () => {
    expect(Object.keys(KNOWN).filter((f) => !offenders.has(f))).toEqual([]);
  });

  it("the setup pages are clean", () => {
    expect(offenders.has("pages/SetupWizardPage.tsx")).toBe(false);
    expect(offenders.has("pages/SetupAgentPage.tsx")).toBe(false);
  });
});
