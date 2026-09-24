/**
 * Build provenance: WHICH COMMIT is this gateway process serving?
 *
 * Reported by GET /api/health and its bare alias GET /health (see
 * routes/health.ts) so anyone can verify what prod actually runs.
 *
 * Sources, in precedence order:
 *   1. PCC_BUILD_SHA          baked into the image at build time by CI (the
 *                             build-image job passes github.sha as a docker
 *                             build-arg; see Dockerfile)   -> "image_build"
 *   2. RAILWAY_GIT_COMMIT_SHA set by Railway for GitHub-sourced deploys
 *                             (today's Dockerfile builds)  -> "railway_deploy"
 *   3. neither                -> { commit: null, commitSource: "unknown" }
 *
 * A value is accepted only if, after trim + lowercase, it is a hex git SHA of
 * 7-40 chars. Anything else (empty, whitespace, non-hex, over-long,
 * injection-looking) is treated as ABSENT and falls through to the next
 * source. This is a public, unauthenticated endpoint, so arbitrary env content
 * is never echoed; and a missing fact stays null / "unknown", never a
 * plausible-looking default SHA.
 */

export type CommitSource = "image_build" | "railway_deploy" | "unknown";

export interface BuildInfo {
  /** Lowercase hex git SHA (7-40 chars), or null when no source provides one. */
  commit: string | null;
  /** Where `commit` came from; "unknown" exactly when `commit` is null. */
  commitSource: CommitSource;
}

// No `m` flag: ^ and $ anchor to the whole string, so an embedded newline
// can never smuggle a second line past the check.
const GIT_SHA = /^[0-9a-f]{7,40}$/;

/** A well-formed lowercase SHA, or null if `raw` is absent or malformed. */
function acceptSha(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim().toLowerCase();
  return GIT_SHA.test(candidate) ? candidate : null;
}

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const baked = acceptSha(env.PCC_BUILD_SHA);
  if (baked !== null) return { commit: baked, commitSource: "image_build" };

  const railway = acceptSha(env.RAILWAY_GIT_COMMIT_SHA);
  if (railway !== null) return { commit: railway, commitSource: "railway_deploy" };

  return { commit: null, commitSource: "unknown" };
}
