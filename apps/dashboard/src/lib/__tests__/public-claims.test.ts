// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GUARDED_CLAIMS,
  PUBLISHED_SURFACES,
  UNCHECKED_SURFACES,
  findClaimViolations,
  publishedText,
  type GuardedClaim,
} from "../public-claims.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("public claims gate", () => {
  it.each(PUBLISHED_SURFACES.map((path) => [path]))(
    "%s makes no claim that is not live yet",
    (path) => {
      expect(findClaimViolations(publishedText(path, read(path)))).toEqual([]);
    },
  );

  it("ignores full-line comments in compiled source but checks served files whole", () => {
    const source = "  // AEGIS content scanning gate\nconst x = 1;\n";
    expect(findClaimViolations(publishedText("packages/gateway/src/server.ts", source))).toEqual([]);
    expect(findClaimViolations(publishedText("apps/dashboard/public/visualizer.js", source))).toHaveLength(1);
  });

  it("still checks string content in compiled source", () => {
    const source = 'const card = { description: "Supports x402 micropayments on Base Sepolia." };\n';
    expect(
      findClaimViolations(publishedText("packages/gateway/src/routes/well-known.ts", source)).map((v) => v.id),
    ).toEqual(["x402-mpp-payment-gate"]);
  });

  it("lists only files that exist, so a rename cannot drop a surface silently", () => {
    const listed = [...PUBLISHED_SURFACES, ...Object.keys(UNCHECKED_SURFACES)];
    expect(listed.filter((path) => !existsSync(join(REPO_ROOT, path)))).toEqual([]);
  });

  it("never lists a file as both checked and unchecked", () => {
    const unchecked = new Set(Object.keys(UNCHECKED_SURFACES));
    expect(PUBLISHED_SURFACES.filter((path) => unchecked.has(path))).toEqual([]);
  });

  it.each(GUARDED_CLAIMS.map((claim) => [claim.id, claim]))(
    "the %s pattern still catches its own example",
    (_id, claim) => {
      expect(findClaimViolations(claim.example, [claim])).toHaveLength(1);
    },
  );

  it("flags an overclaim seeded into otherwise clean copy", () => {
    const seeded = "Your agent can do real things now. Cryptographic proof on every job.";
    expect(findClaimViolations(seeded).map((v) => v.id)).toEqual(["proof-on-every-job"]);
  });

  it("lets a claim through once the steward marks it live", () => {
    const escrow = GUARDED_CLAIMS.find((claim) => claim.id === "escrow-pays-wallet") as GuardedClaim;
    const armed: GuardedClaim = { ...escrow, status: "live" };
    expect(findClaimViolations(escrow.example, [armed])).toEqual([]);
  });

  it("gives every claim a reason, and says whether a forbidden claim can ever be armed", () => {
    for (const claim of GUARDED_CLAIMS) {
      expect(claim.requires.length).toBeGreaterThan(0);
      if (claim.status === "forbidden") expect(claim.requires).toMatch(/^(Never|Until armed):/);
    }
  });
});
