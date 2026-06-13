/**
 * Operator-policy routes for the pizza demo — each shop / driver configures an
 * agent policy that decides what to do with an incoming job offer instead of
 * reflexively accepting it.
 *
 *   PUT    /api/demo/operator-policy/:assigneeSlug  — set policy
 *   GET    /api/demo/operator-policy/:assigneeSlug  — read policy (or the default)
 *   DELETE /api/demo/operator-policy/:assigneeSlug  — revert to default (always-prompt)
 *
 * Plus the pure {@link decideOnOffer} evaluator, consumed by pizza-demo.ts's
 * dispatch logic and exercised directly by the unit tests.
 *
 * Storage: in-memory Map keyed by assigneeSlug (matches the pizza-demo
 * scaffold). Production would persist these alongside the kernel's production
 * OperatorPolicy (a different, richer type — see @pcc/spec/demo-operator-policy).
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  DemoOperatorPolicy,
  DemoPolicyMode,
  DemoPolicyRules,
  DemoPolicyNegotiation,
  DemoJobOffer,
  PolicyDecision,
} from "@pcc/spec";

// ── State ────────────────────────────────────────────────────────────────────

/** assigneeSlug → configured policy. Absence ⇒ the always-prompt default. */
const policies = new Map<string, DemoOperatorPolicy>();

const VALID_MODES: DemoPolicyMode[] = ["auto", "negotiate", "always-prompt"];

/** Window (seconds) a user agent has to respond to a counter-offer. */
export const COUNTER_OFFER_WINDOW_SEC = 30;

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/** Round to 2 decimals (cents) without floating-point drift. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Keep only the known, non-negative numeric rule fields. */
function sanitizeRules(r: Partial<DemoPolicyRules> | undefined): DemoPolicyRules {
  const out: DemoPolicyRules = {};
  if (!r) return out;
  const minPrice = numOrUndef(r.minPriceUSD);
  if (minPrice !== undefined && minPrice >= 0) out.minPriceUSD = minPrice;
  const maxC = numOrUndef(r.maxConcurrent);
  if (maxC !== undefined && maxC >= 0) out.maxConcurrent = Math.floor(maxC);
  const aau = numOrUndef(r.autoAcceptUnderUSD);
  if (aau !== undefined && aau >= 0) out.autoAcceptUnderUSD = aau;
  const dl = numOrUndef(r.requireDeadlineMinSec);
  if (dl !== undefined && dl >= 0) out.requireDeadlineMinSec = dl;
  return out;
}

/** Keep only valid negotiation fields; return undefined when nothing is set. */
function sanitizeNegotiation(
  n: Partial<DemoPolicyNegotiation> | undefined,
): DemoPolicyNegotiation | undefined {
  if (!n) return undefined;
  const out: DemoPolicyNegotiation = {};
  const mult = numOrUndef(n.counterPriceMultiplier);
  if (mult !== undefined && mult > 0) out.counterPriceMultiplier = mult;
  const maxCo = numOrUndef(n.maxCounterOffers);
  if (maxCo !== undefined && maxCo >= 0) out.maxCounterOffers = Math.floor(maxCo);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The default policy for an assignee with no configured override: defer every
 * decision to the human (matches the original pizza-demo scaffold behaviour).
 */
export function defaultDemoPolicy(
  assigneeSlug: string,
  capabilityType = "",
  ownerId = assigneeSlug,
): DemoOperatorPolicy {
  const ts = nowIso();
  return {
    policyId: `pol_default_${assigneeSlug}`,
    ownerId,
    scope: { capabilityType, assigneeSlug },
    mode: "always-prompt",
    rules: {},
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Look up an assignee's configured policy, or fall back to the default. */
export function getPolicyForAssignee(
  assigneeSlug: string,
  capabilityType = "",
): DemoOperatorPolicy {
  return policies.get(assigneeSlug) ?? defaultDemoPolicy(assigneeSlug, capabilityType);
}

// ── The decision function ────────────────────────────────────────────────────

/**
 * Decide what an operator's agent does with a job offer. Pure — no side
 * effects, no clock reads, no store access — so it's directly unit-testable.
 *
 * Precedence (auto + negotiate modes; always-prompt short-circuits first):
 *   1. Hard operational gates (apply in both modes):
 *        a. capacity   — currentConcurrent ≥ maxConcurrent       → auto-decline
 *        b. deadline   — deadlineSec < requireDeadlineMinSec     → auto-decline
 *   2. Price floor — offer below minPriceUSD:
 *        • auto      → auto-decline (too cheap)
 *        • negotiate → counter-offer at max(offer × multiplier, floor),
 *                      or auto-decline once maxCounterOffers is exhausted
 *   3. Escalation ceiling — offer ≥ autoAcceptUnderUSD           → prompt-human
 *   4. Otherwise (meets floor, under ceiling)                    → auto-accept
 *
 * Notes:
 *   - A missing `minPriceUSD` means there is no floor, so step 2 never fires and
 *     a `negotiate` policy with no floor degrades to plain auto-accept.
 *   - A missing `autoAcceptUnderUSD` means there is no ceiling (step 3 skipped).
 */
export function decideOnOffer(
  policy: DemoOperatorPolicy,
  offer: DemoJobOffer,
): PolicyDecision {
  if (policy.mode === "always-prompt") return { kind: "prompt-human" };

  const rules = policy.rules ?? {};

  // 1. Hard operational gates — physical constraints, independent of price.
  if (
    typeof rules.maxConcurrent === "number" &&
    offer.currentConcurrent >= rules.maxConcurrent
  ) {
    return {
      kind: "auto-decline",
      reason: `at capacity: already running ${offer.currentConcurrent} of max ${rules.maxConcurrent}`,
    };
  }
  if (
    typeof rules.requireDeadlineMinSec === "number" &&
    offer.deadlineSec < rules.requireDeadlineMinSec
  ) {
    return {
      kind: "auto-decline",
      reason: `deadline too tight: ${offer.deadlineSec}s < required ${rules.requireDeadlineMinSec}s`,
    };
  }

  // 2. Price floor.
  const belowFloor =
    typeof rules.minPriceUSD === "number" && offer.priceUSD < rules.minPriceUSD;
  if (belowFloor) {
    if (policy.mode === "auto") {
      return {
        kind: "auto-decline",
        reason: `below price floor: $${offer.priceUSD} < $${rules.minPriceUSD}`,
      };
    }
    // negotiate → counter unless we've run out of attempts.
    const neg = policy.negotiation ?? {};
    const maxCounters =
      typeof neg.maxCounterOffers === "number" ? neg.maxCounterOffers : 1;
    const soFar = offer.counterOffersSoFar ?? 0;
    if (soFar >= maxCounters) {
      return {
        kind: "auto-decline",
        reason: `gave up after ${soFar} counter-offer(s) (max ${maxCounters})`,
      };
    }
    const multiplier =
      typeof neg.counterPriceMultiplier === "number"
        ? neg.counterPriceMultiplier
        : 1.2;
    const floor = rules.minPriceUSD as number; // belowFloor implies it's set
    const counter = Math.max(round2(offer.priceUSD * multiplier), floor);
    return { kind: "counter-offer", newPriceUSD: counter };
  }

  // 3. High-value escalation ceiling.
  if (
    typeof rules.autoAcceptUnderUSD === "number" &&
    offer.priceUSD >= rules.autoAcceptUnderUSD
  ) {
    return { kind: "prompt-human" };
  }

  // 4. Meets the floor, under the ceiling → take it.
  return { kind: "auto-accept" };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function operatorPolicyRoutes(app: FastifyInstance): Promise<void> {
  // PUT /api/demo/operator-policy/:assigneeSlug — create or replace a policy.
  app.put<{
    Params: { assigneeSlug: string };
    Body: Partial<DemoOperatorPolicy>;
  }>("/api/demo/operator-policy/:assigneeSlug", async (req, reply) => {
    const slug = req.params.assigneeSlug;
    const body = (req.body ?? {}) as Partial<DemoOperatorPolicy>;

    const mode = body.mode;
    if (!mode || !VALID_MODES.includes(mode)) {
      return reply.status(400).send({
        error: "invalid_request",
        message: `mode is required and must be one of: ${VALID_MODES.join(", ")}`,
      });
    }

    const rules = sanitizeRules(body.rules);
    const negotiation = sanitizeNegotiation(body.negotiation);

    const existing = policies.get(slug);
    const ts = nowIso();
    const policy: DemoOperatorPolicy = {
      policyId: existing?.policyId ?? `pol_${randomUUID().slice(0, 8)}`,
      ownerId: body.ownerId ?? existing?.ownerId ?? slug,
      scope: {
        // The path slug is the source of truth for who this applies to.
        assigneeSlug: slug,
        capabilityType:
          body.scope?.capabilityType ?? existing?.scope.capabilityType ?? "",
      },
      mode,
      rules,
      ...(negotiation ? { negotiation } : {}),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    policies.set(slug, policy);
    return reply.status(200).send({ policy });
  });

  // GET /api/demo/operator-policy/:assigneeSlug — read the configured policy,
  // or the effective always-prompt default if none is set.
  app.get<{ Params: { assigneeSlug: string } }>(
    "/api/demo/operator-policy/:assigneeSlug",
    async (req, reply) => {
      const slug = req.params.assigneeSlug;
      const policy = policies.get(slug);
      if (!policy) {
        return reply
          .status(200)
          .send({ policy: defaultDemoPolicy(slug), isDefault: true });
      }
      return reply.status(200).send({ policy, isDefault: false });
    },
  );

  // DELETE /api/demo/operator-policy/:assigneeSlug — drop the override; the
  // assignee reverts to the always-prompt default.
  app.delete<{ Params: { assigneeSlug: string } }>(
    "/api/demo/operator-policy/:assigneeSlug",
    async (req, reply) => {
      const slug = req.params.assigneeSlug;
      const existed = policies.delete(slug);
      return reply
        .status(200)
        .send({ ok: true, existed, policy: defaultDemoPolicy(slug) });
    },
  );
}

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Clear the in-memory policy store between test cases. */
export function _clearOperatorPoliciesForTests(): void {
  policies.clear();
}

/** Inject a policy directly (bypass the HTTP route) for tests. */
export function _setPolicyForTests(policy: DemoOperatorPolicy): void {
  policies.set(policy.scope.assigneeSlug, policy);
}
