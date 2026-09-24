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
  if (pathname === "/app" || pathname.startsWith("/app/") || pathname === "/spatial") return "spatial";
  if (pathname === "/agent") return "agent";
  return "dashboard";
}

export function nextWorkspace(current: Workspace): Workspace {
  const i = WORKSPACE_CYCLE.indexOf(current);
  return WORKSPACE_CYCLE[(i + 1) % WORKSPACE_CYCLE.length]!;
}

/**
 * Old bookmarks under /legacy/* point at pages that now live at the root:
 * /legacy/jobs/42 -> /jobs/42. Returns null for any other path.
 */
export function legacyRedirect(pathname: string): string | null {
  if (pathname !== "/legacy" && !pathname.startsWith("/legacy/")) return null;
  const rest = pathname.slice("/legacy".length);
  return rest && rest !== "/" ? rest : APP_HOME;
}
