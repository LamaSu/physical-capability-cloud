/**
 * An end-to-end accept trace over REAL SQLite rows, through the REAL HTTP routes (composition R10).
 *
 * Unlike reservations-route.test.ts and agent-plans-route.test.ts (which hold live capability/kernel
 * rows as in-memory arrays), this file inserts them through the REAL gateway store: `initStore()`,
 * `getRepos().kernels.insert(...)`, `getRepos().capabilities.insert(...)` and `.update(...)`, all
 * backed by one real (in-memory) SQLite database, migrated by the real `createStore()` path. The HTTP
 * routes read them back through `productionAgentPlanDeps().revalidation` UNCHANGED — the exact function
 * production calls, re-derived fresh on every request so a mid-trace price UPDATE (step 5) is picked up
 * live, the same way a real operator's price change would be.
 *
 * REAL, and exactly the production code:
 *   - the gateway's own global store (db.ts: initStore/getRepos/getStore), a real SQLite handle;
 *   - kernel and capability rows, inserted/updated through the real repositories;
 *   - the REAL CSD registry (packages/spec/src/csd/registry.ts: CsdRegistry, loadBuiltinCsds,
 *     findUrlByType) via the gateway's shared getCsdRegistry() singleton (routes/csd.ts) — see the GAP
 *     FOUND note below;
 *   - productionAgentPlanDeps().revalidation (routes/agent-plans.ts), used for BOTH /validate and the
 *     accept seam's own internal R10 pass, re-derived fresh per request;
 *   - agentPlanRoutes and reservationRoutes (the real Fastify route handlers);
 *   - the real accept seam (acceptExternalPlan), deal binding (bindDeal) and PlanPresentation
 *     (presentPlan) — "layer" and "sealed" come from real code, not asserted by hand;
 *   - the durable BudgetReservationStore, constructed over the SAME sqlite handle as getStore(), via
 *     the real reservationWiring() adapter (its consume protocol, unchanged);
 *   - parseSealedDeal / BudgetReservationStore.sealedDealPreimage (real integrity check).
 *
 * GAP FOUND (reported, not faked): `loadBuiltinCsds()`
 * (packages/spec/src/csd/registry.ts:394-419, builtins array at 397-406) does NOT include
 * `document-print-and-mail.csd.json` — only fdm/sla/cnc-3axis/laser-cut/2d-print/make-pizza/
 * courier-route/hot-food-prep. `getCsdRegistry()` (packages/gateway/src/routes/csd.ts:28-60) builds its
 * shared singleton from exactly that list (plus a manual dashboard-v1 registration), so
 * `getCsdRegistry().findUrlByType("document-print-and-mail")` is `undefined` today: no capability type
 * maps to this CSD in production. The file itself is schema-valid (proven by its own
 * packages/spec/src/csd/document-print-and-mail.csd.test.ts, on a PRIVATE registry instance — never the
 * shared one routes read). This test proves the gap (asserts `undefined` first), then closes it the
 * same way `POST /api/csd` would in production: `getCsdRegistry().register(CsdSchema.parse(rawJson))` —
 * the real registration method, real CSD content, unmodified. That one seed call is the only thing
 * standing between today's registry and a working document-print-and-mail capability; it is not a
 * faked mapping. The mail leg (`courier-route`) needs no such seeding — it is already a real builtin.
 *
 * STAND-INS, each labelled where used:
 *   - requestTerms and payerFor (gateway-owned, not built; #3503);
 *   - resolveProgram and assertProgramForTier (evidence #349, not merged);
 *   - evidenceFor: derived from the REAL CSD JSON tiers read back off the (now-real) registry — one
 *     requirement per primitive, or the no-primitives fallback (courier-route's tiers carry no
 *     `primitives` array at all, only legacy free-text `required[]`);
 *   - the fee policy ({ feeBps: 235, feeRecipient, reclaimAfterSec });
 *   - the deal encoder (a deterministic sha256 stand-in, exactly as reservations-route.test.ts does;
 *     escrow #367 is not merged).
 *
 * Set PCC_REAL_TRACE_OUT=<path> to write the trace (every step's request/response essentials, and this
 * same REAL vs STAND-IN note) as JSON.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { CsdSchema, parseSealedDeal, tierFromKey, type EvidenceRequirement } from "@pcc/spec";
import { BudgetReservationStore } from "@pcc/store";
import { initStore, getRepos, getStore } from "../db.js";
import { getCsdRegistry, resetCsdRegistry } from "../routes/csd.js";
import { agentPlanRoutes, productionAgentPlanDeps, type AgentPlanRouteDeps } from "../routes/agent-plans.js";
import { reservationRoutes, type ReservationIssueWiring, type RequestTerms } from "../routes/reservations.js";
import type { DealEncoder } from "../services/agent-plan-deal.js";
import type { ExternalPlanNode, ExternalPlanSubmission, SeamDeps } from "../services/external-plan-seam.js";
import { csdSlugFromUrl, type SnapshotClaim } from "../services/plan-snapshot-revalidation.js";
import { reservationWiring } from "../services/reservation-store.js";
// The one raw CSD file loadBuiltinCsds() omits (see the GAP FOUND note above). Real, unmodified content.
import documentPrintAndMailCsdJson from "../../../spec/src/csds/document-print-and-mail.csd.json" with { type: "json" };

// initStore() reads these env vars lazily, only when called below — safe to set here regardless of
// import order, as long as it happens before the first call.
process.env.PCC_DB_PATH = ":memory:";
delete process.env.DATABASE_URL;
delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
initStore({ seed: false });

const A = (b: string) => `0x${b.repeat(20)}` as `0x${string}`;
const NOW = 1_900_000_000;
const BUYER = "agent:buyer-real-1";
const WALLET = A("11");
const OPERATOR = A("aa"); // the print kernel's operator; also its own authenticated principal (MC 9)
const OPERATOR_WALLET = A("a9");
const MAIL_OPERATOR = A("bb");
const FEE_RECIPIENT = A("fe");
const PROGRAM = `0x${"d2".repeat(32)}`;

const PRINT_KERNEL_ID = "k-print-real";
const MAIL_KERNEL_ID = "k-mail-real";
const PRINT_CAP_ID = "cap-print-real";
const MAIL_CAP_ID = "cap-mail-real";
const PRINT_TYPE = "document-print-and-mail";
const MAIL_TYPE = "courier-route";

const AS = (principal: string) => ({ "x-test-principal": principal });

/**
 * evidenceFor, derived from the REAL CSD JSON tiers (see the file header): evidence owns the canonical
 * mapping. One requirement per primitive, keyed on `primitive.bind ?? primitive.id`.
 *
 * DEVIATION FROM THE LITERAL SPEC (reported): keying purely on `primitive.id` (requirementId
 * "<csd>.<tierKey>.<primitive.id>", evidenceTypeId: primitive.id) is what the task describes, but it
 * does not work for real against this CSD. document-print-and-mail's tier1/tier2/tier3 each legitimately
 * declare TWO primitives with `id: "machine.execution_log"`, distinguished only by `bind`
 * (printer_log_captured vs printer_job_verified — asserted by the CSD's own
 * packages/spec/src/csd/document-print-and-mail.csd.test.ts:54-56). Keying evidenceTypeId on `id` alone
 * gives both requirements the SAME evidenceTypeId, and the REAL compiler's uniqueness-per-(evidenceTypeId,
 * tier) check (packages/spec/src/csd/composition-commitment.ts:220) then refuses the plan outright:
 * "UNCOMMITTABLE: invalid plan — node print: duplicate evidence requirement machine.execution_log@2"
 * (confirmed by actually running this test with the literal formula). `bind` is documented
 * (packages/spec/src/csd/schema.ts:136-151) as exactly the field that names a primitive's specific
 * evidence-instance slot, so falling back to `id` only when `bind` is absent (tier0's decl.self_attested
 * has none) is the correct disambiguator, not a workaround — and it matches how this codebase's OWN
 * existing stand-in EVIDENCE maps already key evidenceTypeId (e.g. "execution_completed", which is
 * receipt.kernel_signed's `bind`, not its `id`) in reservations-route.test.ts / agent-plans-route.test.ts.
 */
function evidenceFor(csd: string, tierKey: string): EvidenceRequirement[] | null {
  const url = getCsdRegistry().findUrlByType(csd);
  const def = url ? getCsdRegistry().get(url) : undefined;
  const tier = def?.evidence?.[tierKey];
  if (!tier) return null;
  const t = tierFromKey(tierKey)!;
  const primitives = tier.primitives;
  if (!primitives || primitives.length === 0) {
    // STAND-IN fallback: this tier has no bounded `primitives`, only legacy free-text `required[]`.
    return [{ requirementId: `${csd}.${tierKey}`, evidenceTypeId: "decl.self_attested", tier: t }];
  }
  return primitives.map((p) => {
    const key = p.bind ?? p.id;
    return { requirementId: `${csd}.${tierKey}.${key}`, evidenceTypeId: key, tier: t };
  });
}

describe("external plan accept: REAL SQLite rows, through the REAL HTTP routes (composition R10)", () => {
  it("validate -> issue -> accept -> sealed read-back -> real price change makes it stale -> MC 9 child", async () => {
    // ── Step 0: fixture setup — real DB rows, real CSD registry (with the gap proven, then closed) ──
    resetCsdRegistry();
    expect(getCsdRegistry().findUrlByType(PRINT_TYPE)).toBeUndefined(); // the gap, proven before the fix
    getCsdRegistry().register(CsdSchema.parse(documentPrintAndMailCsdJson)); // real content, real register()
    expect(csdSlugFromUrl(getCsdRegistry().findUrlByType(PRINT_TYPE))).toBe(PRINT_TYPE); // now real-resolves
    expect(csdSlugFromUrl(getCsdRegistry().findUrlByType(MAIL_TYPE))).toBe(MAIL_TYPE); // courier-route: no seed needed

    const nowIso = new Date(NOW * 1000).toISOString();
    getRepos().kernels.insert({
      id: PRINT_KERNEL_ID,
      name: "Real Print Kernel",
      operatorAddress: OPERATOR,
      location: { lat: 37.7749, lng: -122.4194 },
      physicalAddress: "1 Print Way, San Francisco CA",
      maxAssuranceTier: 3,
      publicKey: "0x04realprintkey",
      status: "online",
      registeredAt: nowIso,
      lastHeartbeat: nowIso,
      version: "1.0.0",
    });
    getRepos().kernels.insert({
      id: MAIL_KERNEL_ID,
      name: "Real Mail Kernel",
      operatorAddress: MAIL_OPERATOR,
      location: { lat: 37.78, lng: -122.41 },
      physicalAddress: "2 Mail Way, San Francisco CA",
      maxAssuranceTier: 1,
      publicKey: "0x04realmailkey",
      status: "online",
      registeredAt: nowIso,
      lastHeartbeat: nowIso,
      version: "1.0.0",
    });
    getRepos().capabilities.insert({
      id: PRINT_CAP_ID,
      kernelId: PRINT_KERNEL_ID,
      type: PRINT_TYPE,
      name: "Real Print Capability",
      materials: ["paper", "toner"],
      assuranceTiers: [0, 1, 2, 3],
      pricing: { currency: "USDC", baseCost: "6.50", minimum: "6.50" },
      availability: {},
      location: { lat: 37.7749, lng: -122.4194 },
    });
    getRepos().capabilities.insert({
      id: MAIL_CAP_ID,
      kernelId: MAIL_KERNEL_ID,
      type: MAIL_TYPE,
      name: "Real Mail Capability",
      materials: [],
      assuranceTiers: [0],
      pricing: { currency: "USDC", baseCost: "3.25", minimum: "3.25" },
      availability: {},
      location: { lat: 37.78, lng: -122.41 },
    });

    // The durable reservation store, over the SAME sqlite handle `getStore()` uses (real repos + real
    // reservations share one database, as production does).
    const sqlite = (getStore().db as unknown as { $client: Database.Database }).$client;
    const store = new BudgetReservationStore(sqlite, { clock: () => NOW });
    store.ensureSchema(); // idempotent — the migration already ran inside initStore()
    const wiring = reservationWiring(store);

    // STAND-IN (gateway-owned, not built; #3503): exact request terms and the payer-wallet binding.
    const REQUESTS: Record<string, { owner: string; currency: string; ceilingBaseUnits: bigint; minTier: number }> = {
      "req-real-1": { owner: BUYER, currency: "USDC", ceilingBaseUnits: 30_000_000n, minTier: 0 },
      "req-real-child": { owner: OPERATOR, currency: "USDC", ceilingBaseUnits: 30_000_000n, minTier: 0 },
    };
    const requestTerms: RequestTerms = (requestId, principal) => {
      const r = REQUESTS[requestId];
      return r && r.owner === principal ? { currency: r.currency, ceilingBaseUnits: r.ceilingBaseUnits, minTier: r.minTier } : null;
    };
    const payerFor = (principal: string): string | null => (principal === BUYER ? WALLET : principal === OPERATOR ? OPERATOR_WALLET : null);
    let resvCounter = 0;
    const issueWiring: ReservationIssueWiring = { store, requestTerms, payerFor, newId: () => `resv_real_${++resvCounter}` };

    // STAND-IN (evidence #349, not merged): the program registry and its gate.
    const resolveProgram = (csd: string, tierKey: string): string | null => (csd === PRINT_TYPE && tierKey === "tier2" ? PROGRAM : null);
    const assertProgramForTier: SeamDeps["assertProgramForTier"] = ({ committedProgramHash }) =>
      committedProgramHash === PROGRAM ? { ok: true } : { ok: false, code: "program-hash-mismatch" };
    // STAND-IN (escrow #367 not merged): a deterministic encoder, exactly as reservations-route.test.ts does.
    const encoder: DealEncoder = (plan) =>
      plan.jobs.map((j) => ({ jobId: j.jobId, unitIds: j.units.map((_, m) => `0x${createHash("sha256").update(`${plan.acceptedDealDigest}|${j.jobId}|${m}`).digest("hex")}`) }));

    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const p = req.headers["x-test-principal"];
      if (typeof p === "string" && p) (req as unknown as { operatorId?: string }).operatorId = p;
    });
    await app.register(reservationRoutes, { wiring: () => issueWiring });
    await app.register(agentPlanRoutes, {
      deps: (): AgentPlanRouteDeps => {
        // REAL, re-derived fresh on every request (so step 5's DB price update is picked up live).
        const revalidation = productionAgentPlanDeps().revalidation;
        return {
          revalidation,
          accept: {
            seam: {
              revalidation,
              resolveProgram,
              assertProgramForTier,
              evidenceFor,
              loadReservation: wiring.loadReservation,
              policy: { feeBps: 235, feeRecipient: FEE_RECIPIENT, reclaimAfterSec: 7 * 24 * 3600 },
              now: () => NOW,
            },
            encodeDeal: encoder,
            consumeReservation: wiring.consumeReservation,
          },
        };
      },
    });
    await app.ready();

    const trace: Record<string, unknown> = {
      note:
        "Composition R10 accept trace over REAL SQLite rows (real initStore/getRepos, real CsdRegistry, " +
        "real agentPlanRoutes+reservationRoutes, real accept seam/deal binding/PlanPresentation, real " +
        "durable BudgetReservationStore). GAP FOUND: loadBuiltinCsds() (packages/spec/src/csd/registry.ts:397-406) " +
        "omits document-print-and-mail.csd.json, so the shared getCsdRegistry() singleton didn't know this CSD " +
        "existed until this test registered the real JSON via the real .register() method (the same call " +
        "POST /api/csd would make) — proven with an `undefined` assertion before the fix. courier-route needed " +
        "no such seeding. STAND-INS (labelled): requestTerms/payerFor (#3503), resolveProgram/assertProgramForTier " +
        "(evidence #349), evidenceFor's per-primitive mapping (derived from the real CSD JSON; evidence owns the " +
        "canonical mapping), the fee policy, and the deal encoder (escrow #367 not merged).",
    };

    // ── Step 1: POST /api/agent-plans/validate — every node current, live terms equal the DB rows ──
    const validateNodes: SnapshotClaim[] = [
      { nodeId: "print", capabilityId: PRINT_CAP_ID, price: "6.50", currency: "USDC", tierKey: "tier2", kernelId: PRINT_KERNEL_ID, operator: OPERATOR },
      { nodeId: "mail", capabilityId: MAIL_CAP_ID, price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: MAIL_KERNEL_ID, operator: MAIL_OPERATOR },
    ];
    const validateRes = await app.inject({ method: "POST", url: "/api/agent-plans/validate", payload: { nodes: validateNodes }, headers: AS(BUYER) });
    expect(validateRes.statusCode).toBe(200);
    const validateBody = validateRes.json();
    expect(validateBody.ok).toBe(true);
    expect(validateBody.verdicts.map((v: { nodeId: string; status: string }) => [v.nodeId, v.status])).toEqual([
      ["mail", "current"],
      ["print", "current"],
    ]);
    const printLive1 = validateBody.verdicts.find((v: { nodeId: string }) => v.nodeId === "print").resolved;
    const mailLive1 = validateBody.verdicts.find((v: { nodeId: string }) => v.nodeId === "mail").resolved;
    expect(printLive1.priceDecimal).toBe("6.5");
    expect(printLive1.operator.toLowerCase()).toBe(OPERATOR.toLowerCase());
    expect(mailLive1.priceDecimal).toBe("3.25");
    expect(mailLive1.operator.toLowerCase()).toBe(MAIL_OPERATOR.toLowerCase());
    trace.step1_validate = { request: { nodes: validateNodes }, response: { ok: validateBody.ok, verdicts: validateBody.verdicts } };

    // ── Step 2: POST /api/settlement/reservations — the payer issues ──────────────────────────────
    const issueBody = { requestId: "req-real-1", currency: "USDC", maxAmountBaseUnits: "20000000", purpose: "real print+mail trace", expiresInSec: 3600 };
    const issueRes = await app.inject({ method: "POST", url: "/api/settlement/reservations", payload: issueBody, headers: AS(BUYER) });
    expect(issueRes.statusCode).toBe(201);
    const reservation = issueRes.json().reservation;
    const reservationId: string = reservation.reservationId;
    expect(reservation.state).toBe("issued");
    trace.step2_reservationIssued = { request: { method: "POST", url: "/api/settlement/reservations", principal: BUYER, body: issueBody }, response: reservation };

    // ── Step 3: POST /api/settlement/agent-plans/accept — layer B, sealed; then read it back consumed ──
    const acceptNodes: ExternalPlanNode[] = [
      { nodeId: "print", capabilityId: PRINT_CAP_ID, price: "6.50", currency: "USDC", tierKey: "tier2", kernelId: PRINT_KERNEL_ID, operator: OPERATOR, committedProgramHash: PROGRAM },
      { nodeId: "mail", capabilityId: MAIL_CAP_ID, price: "3.25", currency: "USDC", tierKey: "tier0", kernelId: MAIL_KERNEL_ID, operator: MAIL_OPERATOR },
    ];
    const submission: ExternalPlanSubmission = { requestId: "req-real-1", reservationId, nodes: acceptNodes, edges: [{ from: "print", to: "mail" }] };
    const acceptRes = await app.inject({ method: "POST", url: "/api/settlement/agent-plans/accept", payload: submission, headers: AS(BUYER) });
    expect(acceptRes.statusCode).toBe(200);
    const acceptBody = acceptRes.json();
    expect(acceptBody.presentation.layer).toBe("B");
    expect(acceptBody.presentation.state).toBe("sealed");
    expect(acceptBody.sealed).toEqual({ reservationId, acceptedDealDigest: acceptBody.plan.acceptedDealDigest });
    const digest: string = acceptBody.plan.acceptedDealDigest;
    expect(acceptBody.plan.totalObligationBaseUnits).toBe("9750000"); // 6.50 + 3.25 USDC, exact base units

    const readRes = await app.inject({ method: "GET", url: `/api/settlement/reservations/${reservationId}`, headers: AS(BUYER) });
    expect(readRes.statusCode).toBe(200);
    const readBack = readRes.json().reservation;
    expect(readBack).toMatchObject({ state: "consumed", consumedDealDigest: digest, consumedAt: NOW });
    trace.step3_accepted = {
      request: { method: "POST", url: "/api/settlement/agent-plans/accept", principal: BUYER, body: submission },
      response: { acceptedDealDigest: digest, totalObligationBaseUnits: acceptBody.plan.totalObligationBaseUnits, sealed: acceptBody.sealed, presentation: { layer: acceptBody.presentation.layer, state: acceptBody.presentation.state } },
      reservationReadBack: readBack,
    };

    // ── Step 4: the sealed deal is stored as the digest's own preimage (real store, real parser) ──
    const preimage = store.sealedDealPreimage(reservationId)!;
    expect(preimage).not.toBeNull();
    expect(`0x${createHash("sha256").update(preimage, "utf8").digest("hex")}`).toBe(digest);
    const parsedSealed = parseSealedDeal(preimage);
    expect(parsedSealed.ok).toBe(true);
    if (parsedSealed.ok) {
      expect(parsedSealed.deal.reservationId).toBe(reservationId);
      expect(parsedSealed.deal.totalObligationBaseUnits.toString()).toBe("9750000");
    }
    trace.step4_sealedDealVerified = { digestMatchesPreimage: true, parseOk: parsedSealed.ok };

    // ── Step 5: a REAL provider price change — the OLD claim is now stale, with a live re-quote ──
    getRepos().capabilities.update(PRINT_CAP_ID, { pricing: { currency: "USDC", baseCost: "9.00", minimum: "9.00" } });
    const revalidateRes = await app.inject({ method: "POST", url: "/api/agent-plans/validate", payload: { nodes: validateNodes }, headers: AS(BUYER) });
    expect(revalidateRes.statusCode).toBe(200);
    const revalidateBody = revalidateRes.json();
    expect(revalidateBody.ok).toBe(false);
    const staleVerdict = revalidateBody.verdicts.find((v: { nodeId: string }) => v.nodeId === "print");
    expect(staleVerdict.status).toBe("stale");
    expect(staleVerdict.diffs).toEqual(expect.arrayContaining([expect.objectContaining({ field: "price", claimed: "6.5", live: "9" })]));
    expect(staleVerdict.live.priceDecimal).toBe("9");
    const stillCurrentMail = revalidateBody.verdicts.find((v: { nodeId: string }) => v.nodeId === "mail");
    expect(stillCurrentMail.status).toBe("current"); // unaffected by the print-only price change
    trace.step5_realPriceChangeRevalidation = {
      request: { note: "the SAME old claim as step 1 (price 6.50), after a real DB price update to 9.00", nodes: validateNodes },
      response: { ok: revalidateBody.ok, printVerdict: staleVerdict, mailVerdict: stillCurrentMail },
    };

    // ── Step 6: MC 9 — the print operator carves a child reservation from the sealed parent unit ──
    const printBinding = acceptBody.plan.nodeToUnit.find((b: { nodeId: string }) => b.nodeId === "print");
    const printUnit = `${printBinding.jobId}#${printBinding.milestoneIndex}`;
    const childBody = { unit: printUnit, requestId: "req-real-child", currency: "USDC", maxAmountBaseUnits: "1000000", purpose: "real MC9 child: subcontract envelope stuffing", expiresInSec: 3600 };
    const childRes = await app.inject({ method: "POST", url: `/api/settlement/reservations/${reservationId}/children`, payload: childBody, headers: AS(OPERATOR) });
    expect(childRes.statusCode).toBe(201);
    const child = childRes.json().reservation;
    expect(child).toMatchObject({ parentReservationId: reservationId, parentUnit: printUnit, payerAddress: OPERATOR_WALLET, state: "issued" });
    trace.step6_mc9ChildReservation = { request: { method: "POST", url: `/api/settlement/reservations/${reservationId}/children`, principal: OPERATOR, body: childBody }, response: child };

    if (process.env.PCC_REAL_TRACE_OUT) {
      writeFileSync(process.env.PCC_REAL_TRACE_OUT, JSON.stringify(trace, null, 2) + "\n");
    }
  });
});
