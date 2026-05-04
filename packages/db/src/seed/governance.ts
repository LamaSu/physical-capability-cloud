import type { StoreDB } from "../connection.js";
import { endpointScopes } from "../schema/index.js";

const CONTRIBUTOR_ECONOMICS_SCOPES = [
  {
    id: "scope:contributors:register",
    method: "POST",
    routePattern: "/api/contributors",
    requiredScopes: ["contributor:write"],
    description: "Register a contributor profile (DB persistence; on-chain mint is separate).",
  },
  {
    id: "scope:contributors:list-by-address",
    method: "GET",
    routePattern: "/api/contributors/:address",
    requiredScopes: ["contributor:read"],
    description: "List all profiles for a wallet address.",
  },
  {
    id: "scope:contributors:list-by-role",
    method: "GET",
    routePattern: "/api/contributors/by-role/:role",
    requiredScopes: ["contributor:read"],
    description: "List all addresses holding a specific ContributorRole.",
  },
  {
    id: "scope:schedules:publish",
    method: "POST",
    routePattern: "/api/contributors/schedules",
    requiredScopes: ["schedule:publish"],
    description: "Publish a sealed RateSchedule (sha256-content-addressed, idempotent).",
  },
  {
    id: "scope:schedules:get",
    method: "GET",
    routePattern: "/api/contributors/schedules/:scheduleHash",
    requiredScopes: ["schedule:read"],
    description: "Fetch a published RateSchedule by its content hash.",
  },
  {
    id: "scope:schedules:evaluate",
    method: "POST",
    routePattern: "/api/contributors/schedules/:scheduleHash/evaluate",
    requiredScopes: ["schedule:read"],
    description:
      "Evaluate a RateSchedule at a given (now, jobValueCents?, jobsPerDay?, captureClass?) context.",
  },
  {
    id: "scope:training-manifests:set",
    method: "POST",
    routePattern: "/api/contributors/training-manifests",
    requiredScopes: ["training-manifest:write"],
    description:
      "Set/replace a Model IP's TrainingManifest (dataset weight map for recursive payout).",
  },
  {
    id: "scope:training-manifests:get",
    method: "GET",
    routePattern: "/api/contributors/training-manifests/:modelIpId",
    requiredScopes: ["training-manifest:read"],
    description: "Fetch a Model IP's TrainingManifest.",
  },
] as const;

export function seedGovernance(db: StoreDB): void {
  for (const row of CONTRIBUTOR_ECONOMICS_SCOPES) {
    db.insert(endpointScopes)
      .values({
        id: row.id,
        method: row.method,
        routePattern: row.routePattern,
        requiredScopes: row.requiredScopes as unknown as string[],
        description: row.description,
      })
      .onConflictDoNothing()
      .run();
  }
}
