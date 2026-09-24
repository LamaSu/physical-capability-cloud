/**
 * Build provenance: WHICH COMMIT is this gateway process serving?
 *
 * Reported by GET /api/health and its bare alias GET /health (see routes/health.ts) so
 * anyone can verify what prod actually runs.
 *
 * The commit comes ONLY from a file baked into the image at build time
 * (BUILD_INFO_FILE, written by the Dockerfile from a build arg). No runtime environment
 * variable can change it: a service variable set on the host after the build, or a stale
 * value, never reaches `commit`. The file holds
 *
 *   {"commit":"<40 lowercase hex>","buildArg":"PCC_BUILD_SHA" | "RAILWAY_GIT_COMMIT_SHA"}
 *
 * where buildArg names the build argument that supplied the SHA: PCC_BUILD_SHA from the CI
 * image build (github.sha), or RAILWAY_GIT_COMMIT_SHA when Railway builds the Dockerfile
 * from that commit. Only a full 40-hex SHA is accepted; a prefix could be ambiguous. A
 * missing, unreadable or malformed file gives { commit: null, commitSource: "unknown" },
 * never a plausible-looking default.
 *
 * Railway's RUNTIME RAILWAY_GIT_COMMIT_SHA is deploy metadata, not proof of the code served
 * (it is not bound to the image's files), so it is reported apart, as
 * deployMetadata.railwayGitCommitSha, and never as `commit`.
 *
 * This is a public, unauthenticated endpoint: only validated hex is ever echoed.
 */
import { readFileSync } from "node:fs";

/** Where the Dockerfile writes the build commit. Fixed: no variable can point it elsewhere. */
export const BUILD_INFO_FILE = "/app/BUILD_INFO.json";

export type CommitSource = "image_build" | "unknown";
export type BuildArgName = "PCC_BUILD_SHA" | "RAILWAY_GIT_COMMIT_SHA";

export interface BuildInfo {
  /** Lowercase 40-hex git SHA baked into the image, or null. */
  commit: string | null;
  /** "image_build" exactly when `commit` is set; otherwise "unknown". */
  commitSource: CommitSource;
  /** The build argument that supplied `commit`, or null. */
  buildArg: BuildArgName | null;
  /** Host-provided deploy metadata. Not proof of the code served. */
  deployMetadata: { railwayGitCommitSha: string | null };
}

// No `m` flag: ^ and $ anchor to the whole string, so an embedded newline can never
// smuggle a second line past the check.
const FULL_SHA = /^[0-9a-f]{40}$/;
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
  const unknown: BuildInfo = { commit: null, commitSource: "unknown", buildArg: null, deployMetadata };

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
  const commit = typeof o.commit === "string" && FULL_SHA.test(o.commit) ? o.commit : null;
  const buildArg = BUILD_ARGS.find((a) => a === o.buildArg) ?? null;
  if (commit === null || buildArg === null) return unknown;
  return { commit, commitSource: "image_build", buildArg, deployMetadata };
}
