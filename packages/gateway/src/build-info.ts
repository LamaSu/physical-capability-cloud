/**
 * Build provenance: WHICH SOURCE is this gateway process serving?
 *
 * Reported by GET /api/health and its bare alias GET /health (see routes/health.ts).
 *
 * Everything comes ONLY from a file baked into the image at build time (BUILD_INFO_FILE,
 * written by the Dockerfile). No runtime environment variable can change it. The file holds
 *
 *   {"commit":"<40 lowercase hex>" | null,
 *    "buildArg":"PCC_BUILD_SHA" | "RAILWAY_GIT_COMMIT_SHA" | null,
 *    "sourceDigest":"sha256:<64 hex>",
 *    "sourceDigestSpec":"pcc.source-digest/v1"}
 *
 * - `commit` is a CLAIM: the value of a build argument (CI passes github.sha; Railway passes
 *   the commit it builds). Whoever runs a build chooses it, so it is reported as
 *   commitSource "build_argument", never as proof on its own.
 * - `sourceDigest` binds the report to the code: the Dockerfile computes it from the source as
 *   copied into the image, before anything is built (scripts/source-digest.sh). CI refuses to
 *   push an image whose digest differs from its checkout of github.sha, and
 *   scripts/verify-build-source.sh checks a served digest against any commit.
 * - Neither is proof against whoever controls the deployment, who can replace the image's
 *   files or mount over them (docs/DEPLOY.md, "What this cannot prove").
 *
 * A missing, unreadable or malformed file, or a malformed field, gives nulls and
 * commitSource "unknown", never a plausible-looking default. Railway's RUNTIME
 * RAILWAY_GIT_COMMIT_SHA is deploy metadata, reported apart and never as `commit`.
 *
 * This is a public, unauthenticated endpoint: only validated hex is ever echoed.
 */
import { readFileSync } from "node:fs";

/** Where the Dockerfile writes the build info. Fixed: no variable can point it elsewhere. */
export const BUILD_INFO_FILE = "/app/BUILD_INFO.json";

export const SOURCE_DIGEST_SPEC = "pcc.source-digest/v1" as const;

export type CommitSource = "build_argument" | "unknown";
export type BuildArgName = "PCC_BUILD_SHA" | "RAILWAY_GIT_COMMIT_SHA";

export interface BuildInfo {
  /** Lowercase 40-hex SHA named by a build argument and recorded in the image, or null. */
  commit: string | null;
  /** "build_argument" exactly when `commit` is set; otherwise "unknown". */
  commitSource: CommitSource;
  /** The build argument that supplied `commit`, or null. */
  buildArg: BuildArgName | null;
  /** Digest of the source the image was built from (pcc.source-digest/v1), or null. */
  sourceDigest: string | null;
  sourceDigestSpec: typeof SOURCE_DIGEST_SPEC | null;
  /** Host-provided deploy metadata. Not proof of the code served. */
  deployMetadata: { railwayGitCommitSha: string | null };
}

// No `m` flag: ^ and $ anchor to the whole string, so an embedded newline can never
// smuggle a second line past the check.
const FULL_SHA = /^[0-9a-f]{40}$/;
const SOURCE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const BUILD_ARGS: readonly BuildArgName[] = ["PCC_BUILD_SHA", "RAILWAY_GIT_COMMIT_SHA"];

/** A full lowercase SHA, or null. Case is normalized; length and alphabet are not. */
function fullSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim().toLowerCase();
  return FULL_SHA.test(candidate) ? candidate : null;
}

export interface ReadBuildInfoOptions {
  /** Reads the build-info file; returns null when it does not exist or cannot be read. */
  readFile?: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

const readFileOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export function readBuildInfo(opts: ReadBuildInfoOptions = {}): BuildInfo {
  const env = opts.env ?? process.env;
  const deployMetadata = { railwayGitCommitSha: fullSha(env.RAILWAY_GIT_COMMIT_SHA) };
  const unknown: BuildInfo = {
    commit: null,
    commitSource: "unknown",
    buildArg: null,
    sourceDigest: null,
    sourceDigestSpec: null,
    deployMetadata,
  };

  const raw = (opts.readFile ?? readFileOrNull)(BUILD_INFO_FILE);
  if (raw == null || raw.length > 512) return unknown;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknown;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return unknown;
  const o = parsed as Record<string, unknown>;

  // The digest is reported only with the spec it was computed under.
  const digestOk = typeof o.sourceDigest === "string" && SOURCE_DIGEST.test(o.sourceDigest) && o.sourceDigestSpec === SOURCE_DIGEST_SPEC;
  const source = digestOk
    ? { sourceDigest: o.sourceDigest as string, sourceDigestSpec: SOURCE_DIGEST_SPEC }
    : { sourceDigest: null, sourceDigestSpec: null };

  const commit = typeof o.commit === "string" && FULL_SHA.test(o.commit) ? o.commit : null;
  const buildArg = BUILD_ARGS.find((a) => a === o.buildArg) ?? null;
  if (commit === null || buildArg === null) return { ...unknown, ...source };
  return { commit, commitSource: "build_argument", buildArg, ...source, deployMetadata };
}
