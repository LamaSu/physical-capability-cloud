/**
 * Builtin CSD: `pcc://artifacts/dashboard/v1` (kind `extension`).
 *
 * This is the ONE schema mechanism (§5.1 of the On-Ramp spec) registered in the
 * CSD registry so the dashboard-manifest type is discoverable via `/api/csd`,
 * CSD tooling sees it, and future artifact kinds (report templates, operator
 * consoles) version through the same `pcc://artifacts/…` URI scheme.
 *
 * It is a compiled-in TypeScript constant — durable across redeploys — as
 * opposed to a runtime CSD registration (RAM-only, lost on redeploy, G5). The
 * gateway registers it in `getCsdRegistry()` (routes/csd.ts) rather than in the
 * shared `loadBuiltinCsds()` array, so the existing builtin-count tests stay
 * green while the live gateway still exposes the type.
 *
 * The ACTUAL manifest validation is done by `DashboardManifestSchema` (Zod, in
 * ../../types/ui-artifact.ts). This CSD carries no capability parameters — a
 * dashboard is not a priced capability (G9) — so parameters/constraints are
 * empty and pricing is nominal.
 */

import type { CSD } from "../schema.js";

// MUST match DASHBOARD_CSD_URL in ../../types/ui-artifact.ts
export const dashboardV1Csd: CSD = {
  url: "pcc://artifacts/dashboard/v1",
  version: "1.0.0",
  status: "active",
  name: "Dashboard Manifest v1",
  description:
    "Structure definition for PCC UI dashboard artifacts (the DashboardManifest). " +
    "A dashboard is a declarative windows+bindings+actions manifest the person's " +
    "LLM emits and the pcc-ui kit renders; it is stored as a ui_artifact and " +
    "served at /a/:slug. Not a priced capability — kind=extension.",
  kind: "extension",
  baseDefinition: null,
  parameters: [],
  constraints: [],
  pricing: { basePrice: "0", currency: "USD" },
};
