import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBuildInfo } from "../build-info.js";

// N5: the Dockerfile's build-info step, run for real through `sh`, so the rules that decide
// what /api/health can ever report are tested, not only read:
//   - only a full 40-hex SHA is recorded, and a non-empty argument that is anything else
//     FAILS the build (astra round 2: it used to fall through silently);
//   - PCC_BUILD_SHA (CI) wins, else RAILWAY_GIT_COMMIT_SHA (a Railway build of that commit);
//   - two different SHAs fail the build instead of baking a stale one;
//   - the source digest recorded after `COPY . .` is always written, and a missing or
//     malformed one fails the build;
//   - an earlier BUILD_INFO.json is removed first (astra round 2), and the file round-trips
//     through readBuildInfo.

const DOCKERFILE = fileURLToPath(new URL("../../../../Dockerfile", import.meta.url));
const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const OTHER40 = "fedcba9876543210fedcba9876543210fedcba98";
const DIGEST = `sha256:${"ab".repeat(32)}`;

/** The RUN instruction that follows `ARG RAILWAY_GIT_COMMIT_SHA`, as the shell receives it. */
function buildInfoStep(): string {
  const text = readFileSync(DOCKERFILE, "utf8");
  const arg = text.indexOf('ARG RAILWAY_GIT_COMMIT_SHA=""');
  expect(arg, "the Dockerfile declares the Railway build arg").toBeGreaterThan(-1);
  const run = text.indexOf("RUN ", arg);
  const lines: string[] = [];
  for (const line of text.slice(run + "RUN ".length).split("\n")) {
    lines.push(line);
    if (!line.trimEnd().endsWith("\\")) break;
  }
  return lines.join("\n").replace(/\\\n/g, " ");
}

interface StepInput {
  PCC_BUILD_SHA?: string;
  RAILWAY_GIT_COMMIT_SHA?: string;
  /** Content of the recorded source digest; null = no digest file. */
  digest?: string | null;
  /** Content of a BUILD_INFO.json left by an earlier layer. */
  existing?: string;
}

function runStep(args: StepInput) {
  const dir = mkdtempSync(join(tmpdir(), "pcc-build-info-"));
  const out = join(dir, "BUILD_INFO.json");
  const digestFile = join(dir, "source-digest");
  const digest = args.digest === undefined ? `${DIGEST}\n` : args.digest;
  if (digest !== null) writeFileSync(digestFile, digest);
  if (args.existing !== undefined) writeFileSync(out, args.existing);
  const script = buildInfoStep().split("/app/BUILD_INFO.json").join(out).split("/opt/pcc/source-digest").join(digestFile);
  let ok = true;
  let stderr = "";
  try {
    execFileSync("sh", ["-c", script], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PCC_BUILD_SHA: args.PCC_BUILD_SHA ?? "", RAILWAY_GIT_COMMIT_SHA: args.RAILWAY_GIT_COMMIT_SHA ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    ok = false;
    stderr = String((e as { stderr?: Buffer }).stderr ?? "");
  }
  const content = existsSync(out) ? readFileSync(out, "utf8") : null;
  return { ok, stderr, content };
}

const recorded = (commit: string | null, buildArg: string | null) => ({ commit, buildArg, sourceDigest: DIGEST, sourceDigestSpec: "pcc.source-digest/v1" });

describe("Dockerfile build-info step (N5)", () => {
  it("records CI's PCC_BUILD_SHA, lowercased, with the source digest, and it round-trips through readBuildInfo", () => {
    const r = runStep({ PCC_BUILD_SHA: SHA40.toUpperCase() });
    expect(r.ok, r.stderr).toBe(true);
    expect(JSON.parse(r.content!)).toEqual(recorded(SHA40, "PCC_BUILD_SHA"));
    expect(readBuildInfo({ readFile: () => r.content, env: {} })).toMatchObject({
      commit: SHA40,
      commitSource: "build_argument",
      buildArg: "PCC_BUILD_SHA",
      sourceDigest: DIGEST,
      sourceDigestSpec: "pcc.source-digest/v1",
    });
  });

  it("records Railway's build commit when CI's is absent", () => {
    const r = runStep({ RAILWAY_GIT_COMMIT_SHA: OTHER40 });
    expect(JSON.parse(r.content!)).toEqual(recorded(OTHER40, "RAILWAY_GIT_COMMIT_SHA"));
  });

  it("prefers CI's when both are given and agree", () => {
    const r = runStep({ PCC_BUILD_SHA: SHA40, RAILWAY_GIT_COMMIT_SHA: SHA40 });
    expect(JSON.parse(r.content!)).toEqual(recorded(SHA40, "PCC_BUILD_SHA"));
  });

  it("with no build argument, records a null commit and still the source digest", () => {
    const r = runStep({});
    expect(r.ok, r.stderr).toBe(true);
    expect(JSON.parse(r.content!)).toEqual(recorded(null, null));
    expect(readBuildInfo({ readFile: () => r.content, env: {} })).toMatchObject({ commit: null, commitSource: "unknown", sourceDigest: DIGEST });
  });

  it("NEGATIVE (review #2886): two different SHAs fail the build and write nothing", () => {
    const r = runStep({ PCC_BUILD_SHA: SHA40, RAILWAY_GIT_COMMIT_SHA: OTHER40 });
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/disagree/);
    expect(r.content).toBeNull();
  });

  it("NEGATIVE (astra round 2): a non-empty argument that is not a full SHA fails the build, even beside a valid one", () => {
    for (const args of [
      { PCC_BUILD_SHA: "0123456" },
      { PCC_BUILD_SHA: "abc; touch /tmp/pwned" },
      { RAILWAY_GIT_COMMIT_SHA: `${SHA40}\nX: y` },
      { PCC_BUILD_SHA: SHA40, RAILWAY_GIT_COMMIT_SHA: "not-a-sha" },
      { PCC_BUILD_SHA: "zz", RAILWAY_GIT_COMMIT_SHA: SHA40 },
    ]) {
      const r = runStep(args);
      expect(r.ok, JSON.stringify(args)).toBe(false);
      expect(r.stderr, JSON.stringify(args)).toMatch(/is set but is not a full 40-hex SHA/);
      expect(r.content, JSON.stringify(args)).toBeNull();
    }
  });

  it("NEGATIVE (astra round 2): an earlier BUILD_INFO.json is removed, never kept", () => {
    const planted = JSON.stringify(recorded(OTHER40, "PCC_BUILD_SHA"));
    const r = runStep({ existing: planted });
    expect(r.ok, r.stderr).toBe(true);
    expect(JSON.parse(r.content!)).toEqual(recorded(null, null));
    const failed = runStep({ existing: planted, PCC_BUILD_SHA: SHA40, RAILWAY_GIT_COMMIT_SHA: OTHER40 });
    expect(failed.ok).toBe(false);
    expect(failed.content).toBeNull();
  });

  it("NEGATIVE: a missing or malformed source digest fails the build", () => {
    for (const digest of [null, "", "sha256:xyz\n", `sha256:${"ab".repeat(31)}\n`, `md5:${"ab".repeat(32)}\n`]) {
      const r = runStep({ PCC_BUILD_SHA: SHA40, digest });
      expect(r.ok, JSON.stringify(digest)).toBe(false);
      expect(r.stderr, JSON.stringify(digest)).toMatch(/source digest/);
      expect(r.content, JSON.stringify(digest)).toBeNull();
    }
  });

  it("the source digest is recorded right after COPY . . and before the build", () => {
    const text = readFileSync(DOCKERFILE, "utf8");
    const copy = text.indexOf("\nCOPY . .\n");
    const digest = text.indexOf("sh scripts/source-digest.sh /app > /opt/pcc/source-digest");
    const build = text.indexOf("npx turbo build");
    expect(copy).toBeGreaterThan(-1);
    expect(digest).toBeGreaterThan(copy);
    expect(build).toBeGreaterThan(digest);
  });

  it("NEGATIVE: the image no longer sets PCC_BUILD_SHA as a runtime ENV", () => {
    expect(readFileSync(DOCKERFILE, "utf8")).not.toMatch(/^ENV PCC_BUILD_SHA/m);
  });
});
