// READ-ONLY pre-deploy check (WP-A round 8): which DISTINCT stored identities would the
// new identity normalization (NFKC + Unicode full case folding) join into ONE owner?
//
// Run it BEFORE deploying the WP-A build, against the production database, from /app
// in the production image with the production environment (PCC_DB_PATH):
//   node packages/gateway/scripts/identity-collision-audit.mjs          # hashed spellings
//   node packages/gateway/scripts/identity-collision-audit.mjs --show   # raw spellings (PII)
// Exit 0: read every required source, no NEW merge. Exit 3: at least one group of
// identities that were distinct under master's comparison (trim + lowercase) would be
// joined; resolve each (revoke or re-issue one side's keys) before deploying. Exit 4
// (AZ-9, fail closed): an identity source could not be read, so the audit is INCOMPLETE
// and must NOT be read as safe. A required source (api_keys, shop_kernels) is never
// allowlistable; an optional table that is legitimately absent goes in
// PCC_COLLISION_AUDIT_ALLOW_ABSENT=<comma-separated sources>.
import { createHash } from "node:crypto";

const show = process.argv.includes("--show");
const { initStore, getStore } = await import("../dist/db.js");
initStore({ seed: false });
const { findIdentityCollisions, collisionAuditExit } = await import("../dist/auth/identity-collisions.js");
const allowedAbsent = (process.env.PCC_COLLISION_AUDIT_ALLOW_ABSENT ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const client = getStore().db.$client;
const { collisions, read, skipped } = findIdentityCollisions(client);
const fingerprint = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const out = collisions.map((c) => ({
  normalized: show ? c.normalized : fingerprint(c.normalized),
  spellings: c.spellings.map((s) => (show ? s : fingerprint(s))),
  sources: c.sources,
  newMerge: c.newMerge,
}));
const verdict = collisionAuditExit({ newMerges: out.filter((c) => c.newMerge).length, read, skipped, allowedAbsent });
console.log(JSON.stringify({ read, skipped, groups: out.length, newMerges: out.filter((c) => c.newMerge).length, exit: verdict.code, reason: verdict.reason, collisions: out }, null, 2));
process.exit(verdict.code);
