/** The pizza demo routes and bridge demo kernel agent run outside production as before.
 * In production they run only when PCC_DEMOS_ENABLED is exactly "true" (N291). */
export function demoSurfacesEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.PCC_DEMOS_ENABLED === "true";
}
