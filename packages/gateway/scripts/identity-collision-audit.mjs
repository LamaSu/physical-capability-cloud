// READ-ONLY pre-deploy check (WP-A round 8): which DISTINCT stored identities would the
// new identity normalization (NFKC + Unicode full case folding) join into ONE owner?
//
// Run it BEFORE deploying the WP-A build, against the production database, from /app
// in the production image with the production environment (PCC_DB_PATH):
//   node packages/gateway/scripts/identity-collision-audit.mjs          # hashed spellings
//   node packages/gateway/scripts/identity-collision-audit.mjs --show   # raw spellings (PII)
// Exit code 0: no NEW merge. Exit code 3: at least one group of identities that were
// distinct under master's comparison (trim + lowercase) would be joined. Resolve each
// (for example, revoke or re-issue one side's keys) before deploying.
import { createHash } from "node:crypto";

const show = process.argv.includes("--show");
const { initStore, getStore } = await import("../dist/db.js");
initStore({ seed: false });
const { findIdentityCollisions } = await import("../dist/auth/identity-collisions.js");
const client = getStore().db.$client;
const { collisions, read, skipped } = findIdentityCollisions(client);
const fingerprint = (s) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const out = collisions.map((c) => ({
  normalized: show ? c.normalized : fingerprint(c.normalized),
  spellings: c.spellings.map((s) => (show ? s : fingerprint(s))),
  sources: c.sources,
  newMerge: c.newMerge,
}));
console.log(JSON.stringify({ read, skipped, groups: out.length, newMerges: out.filter((c) => c.newMerge).length, collisions: out }, null, 2));
process.exit(out.some((c) => c.newMerge) ? 3 : 0);
