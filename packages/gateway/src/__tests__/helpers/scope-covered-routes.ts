/** Master's scope-covered registrations, verified against routes, defaults and concrete governance matches. */
export interface ScopeCoveredRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  url: string;
  class: "money-write" | "admin" | "other-write" | "scoped-read";
  requirement: readonly string[] | "money-default-deny";
}

export const SCOPE_COVERED_ROUTES: readonly ScopeCoveredRoute[] = [
  { method: "DELETE", path: "/api/fiat-ramp/cdp/spend-permission/:id", url: "/api/fiat-ramp/cdp/spend-permission/permission1", class: "money-write", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/beta-apply", url: "/api/admin/beta-apply", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/demand/composite/:signature", url: "/api/admin/demand/composite/signature1", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/demand/composites", url: "/api/admin/demand/composites", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/demand/snapshot/:window", url: "/api/admin/demand/snapshot/24h", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/demand/status", url: "/api/admin/demand/status", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/feedback", url: "/api/admin/feedback", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/observability/attempts", url: "/api/admin/observability/attempts", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/observability/errors", url: "/api/admin/observability/errors", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/observability/feedback", url: "/api/admin/observability/feedback", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/observability/funnel", url: "/api/admin/observability/funnel", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/observability/journey/:traceId", url: "/api/admin/observability/journey/trace1", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/observability/operator-funnel", url: "/api/admin/observability/operator-funnel", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/admin/waitlist", url: "/api/admin/waitlist", class: "admin", requirement: ["admin"] },
  { method: "GET", path: "/api/audit/log", url: "/api/audit/log", class: "scoped-read", requirement: ["auditor", "admin"] },
  { method: "GET", path: "/api/audit/stats", url: "/api/audit/stats", class: "scoped-read", requirement: ["auditor", "admin"] },
  { method: "POST", path: "/api/build/contract", url: "/api/build/contract", class: "other-write", requirement: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", path: "/api/build/options", url: "/api/build/options", class: "other-write", requirement: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", path: "/api/build/price", url: "/api/build/price", class: "other-write", requirement: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", path: "/api/contributors", url: "/api/contributors", class: "other-write", requirement: ["contributor:write"] },
  { method: "POST", path: "/api/contributors/schedules", url: "/api/contributors/schedules", class: "other-write", requirement: ["schedule:publish"] },
  { method: "POST", path: "/api/contributors/training-manifests", url: "/api/contributors/training-manifests", class: "other-write", requirement: ["training-manifest:write"] },
  { method: "POST", path: "/api/escrow/chain/:address/approve", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/approve", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/escrow/chain/:address/approve-release/:milestoneIndex", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/approve-release/0", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/escrow/chain/:address/attestation/:milestoneIndex", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/attestation/0", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/escrow/chain/:address/deposit-bond/:milestoneIndex", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/deposit-bond/0", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/escrow/chain/:address/dispute/:milestoneIndex", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/dispute/0", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/escrow/chain/:address/evidence/:milestoneIndex", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/evidence/0", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/escrow/chain/:address/fund", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/fund", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/escrow/chain/:address/release/:milestoneIndex", url: "/api/escrow/chain/0x1111111111111111111111111111111111111111/release/0", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/evidence/archive", url: "/api/evidence/archive", class: "other-write", requirement: ["operator", "verifier", "admin"] },
  { method: "POST", path: "/api/evidence/embed", url: "/api/evidence/embed", class: "other-write", requirement: ["operator", "verifier", "admin"] },
  { method: "POST", path: "/api/evidence/search", url: "/api/evidence/search", class: "other-write", requirement: ["operator", "verifier", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/cdp/provision", url: "/api/fiat-ramp/cdp/provision", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/cdp/spend-permission", url: "/api/fiat-ramp/cdp/spend-permission", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/cdp/wallet", url: "/api/fiat-ramp/cdp/wallet", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/coinbase/onramp", url: "/api/fiat-ramp/coinbase/onramp", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/stripe/credits/deposit", url: "/api/fiat-ramp/stripe/credits/deposit", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/stripe/onramp", url: "/api/fiat-ramp/stripe/onramp", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/webhook/stripe", url: "/api/fiat-ramp/webhook/stripe", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/webhook/yellowcard", url: "/api/fiat-ramp/webhook/yellowcard", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/wise/batch-payout", url: "/api/fiat-ramp/wise/batch-payout", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/wise/payout", url: "/api/fiat-ramp/wise/payout", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/yellowcard/deposit", url: "/api/fiat-ramp/yellowcard/deposit", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/fiat-ramp/yellowcard/withdraw", url: "/api/fiat-ramp/yellowcard/withdraw", class: "money-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/jobs/:jobId/attestations/aggregate", url: "/api/jobs/job1/attestations/aggregate", class: "other-write", requirement: ["verifier", "admin"] },
  { method: "POST", path: "/api/jobs/submit", url: "/api/jobs/submit", class: "other-write", requirement: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", path: "/api/jobs/submit-from-discovery", url: "/api/jobs/submit-from-discovery", class: "other-write", requirement: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", path: "/api/kernels/register", url: "/api/kernels/register", class: "other-write", requirement: ["operator", "admin"] },
  { method: "POST", path: "/api/negotiate/session", url: "/api/negotiate/session", class: "other-write", requirement: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", path: "/api/settlement/agent-plans/accept", url: "/api/settlement/agent-plans/accept", class: "money-write", requirement: "money-default-deny" },
  { method: "POST", path: "/api/settlement/flush", url: "/api/settlement/flush", class: "money-write", requirement: "money-default-deny" },
  { method: "POST", path: "/api/settlement/release", url: "/api/settlement/release", class: "money-write", requirement: "money-default-deny" },
  { method: "POST", path: "/api/settlement/submit", url: "/api/settlement/submit", class: "money-write", requirement: "money-default-deny" },
  { method: "POST", path: "/api/templates/capabilities", url: "/api/templates/capabilities", class: "other-write", requirement: ["template_author", "operator", "admin"] },
  { method: "POST", path: "/api/templates/machines", url: "/api/templates/machines", class: "other-write", requirement: ["template_author", "operator", "admin"] },
  { method: "POST", path: "/api/templates/verification", url: "/api/templates/verification", class: "other-write", requirement: ["template_author", "operator", "admin"] },
];

// apiGate leaves this route without a principal; its own handler supplies its authentication gate.
export const PUBLIC_SCOPED_URL = "/api/admin/feedback";

export const UNSCOPED_ROUTES: readonly Pick<ScopeCoveredRoute, "method" | "path" | "url">[] = [
  { method: "GET", path: "/api/escrow", url: "/api/escrow" },
  { method: "GET", path: "/api/settlement/status", url: "/api/settlement/status" },
  { method: "GET", path: "/api/fiat-ramp/sessions", url: "/api/fiat-ramp/sessions" },
  { method: "POST", path: "/api/kernels", url: "/api/kernels" },
  { method: "POST", path: "/api/kernels/:id/heartbeat", url: "/api/kernels/k1/heartbeat" },
  { method: "POST", path: "/api/kernels/:id/capabilities", url: "/api/kernels/k1/capabilities" },
];
