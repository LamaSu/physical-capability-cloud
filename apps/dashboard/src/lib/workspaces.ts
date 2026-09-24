/**
 * The dashboard's route model: the URL decides what renders.
 *
 * There are three workspaces of one product, each with its own address:
 *   /app     spatial   floating-panel workspace (becomes the adaptive shell)
 *   /agent   agent     the live agent conversation
 *   anything else      dashboard, the page routes with the full navigation
 *                      (Command Center at /dashboard, jobs, kernels, ...)
 *
 * Switching workspace is navigation, so a deep link such as /jobs/:id always
 * opens that page, whatever workspace the user was in last.
 *
 * This is the canonical route model (product-steward decision D1, bus #2373):
 * /app becomes the one authenticated adaptive shell, and /dashboard plus the
 * page routes are the inspect/expert family ("All tools"). /agent is interim:
 * in Wave 4 the agent conversation becomes a component of /app and the
 * three-way mode toggle retires.
 */

export type Workspace = "spatial" | "agent" | "dashboard";

/** Where each workspace starts. */
export const WORKSPACE_HOME: Readonly<Record<Workspace, string>> = {
  spatial: "/app",
  agent: "/agent",
  dashboard: "/dashboard",
};

/** Where a signed-in user lands when no page was asked for (e.g. after /login). */
export const APP_HOME = WORKSPACE_HOME.dashboard;

/** Order the mode toggle cycles through. */
export const WORKSPACE_CYCLE: readonly Workspace[] = ["spatial", "agent", "dashboard"];

export function workspaceForPath(pathname: string): Workspace {
  if (pathname === "/app" || pathname.startsWith("/app/")) return "spatial";
  if (pathname === "/agent") return "agent";
  return "dashboard";
}

export function nextWorkspace(current: Workspace): Workspace {
  const i = WORKSPACE_CYCLE.indexOf(current);
  return WORKSPACE_CYCLE[(i + 1) % WORKSPACE_CYCLE.length]!;
}

/**
 * Addresses that are not canonical, and where each one now lives:
 *   /spatial        -> /app (one address per workspace)
 *   /legacy/jobs/42 -> /jobs/42 (old bookmarks for pages that now live at the root)
 * Returns null when the path is already canonical.
 */
export function canonicalRedirect(pathname: string): string | null {
  if (pathname === "/spatial") return WORKSPACE_HOME.spatial;
  if (pathname !== "/legacy" && !pathname.startsWith("/legacy/")) return null;
  const rest = pathname.slice("/legacy".length);
  return rest && rest !== "/" ? rest : APP_HOME;
}
