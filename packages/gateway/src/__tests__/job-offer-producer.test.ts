/**
 * Tests for produceJobOffersForRequest — the bridge between request
 * decomposition/matching and the job-offers marketplace (coord #1276:
 * "a decomposed request never becomes a claimable job offer").
 *
 * v2 (coord #1467): produceJobOffersForRequest now calls @pcc/spec's
 * commitmentReportForRequest directly (the canonical module + adapter that
 * also backs GET /api/requests/:id/commitment) instead of a gateway-local
 * copy. Covers both "matched" conventions in this codebase (agentic
 * matchStatus, direct-match capabilityId/kernelId — the adapter only knows
 * the former, so the producer normalizes both before calling in), fail-closed
 * hold of a mixed or structurally-invalid plan (coord #1347), the digest-gap
 * degrade (compositionRoot omitted, capabilityContractRoot stamped
 * regardless — it needs no digest), full dual-root stamping once
 * matchedCapabilityDigest is present (PR #300), and idempotency.
 *
 * v4 (composition 8a0f4de0's #1827 Finding C): a digest that is PRESENT but
 * malformed must HOLD, not degrade like an absent one -- see
 * "holds on a malformed-but-present digest" below.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initJobOffersStore,
  _resetJobOffersStoreForTests,
  getJobOffersStore,
} from "../services/job-offers-store.js";
import { produceJobOffersForRequest } from "../services/job-offer-producer.js";
import type { CapabilityRequest, CapabilityNode } from "@pcc/spec";
import type { RoutedCapabilityNode } from "../services/request-decomposer.js";

function baseRequest(
  capabilityDag: CapabilityNode[],
  overrides: Partial<CapabilityRequest> = {},
): CapabilityRequest {
  const now = new Date().toISOString();
  return {
    id: "req-test-1",
    title: "Test request",
    description: "CNC finish a 6061 aluminium bracket, next day",
    requesterEmail: "buyer@example.com",
    budget: 100,
    currency: "USDC",
    deadline: "2026-12-31T23:59:59Z",
    urgency: "standard",
    status: "decomposed",
    capabilityDag,
    totalEstimatedCost: capabilityDag.reduce((s, n) => s + n.estimatedCost, 0),
    totalEstimatedHours: capabilityDag.reduce((s, n) => s + n.estimatedHours, 0),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const VALID_DIGEST_A = "0x" + "11".repeat(32);
const VALID_DIGEST_B = "0x" + "22".repeat(32);

/** Agentic/composite decompose convention — matchStatus + matchedCapabilityId/matchedKernelId, no digest (pre-PR#300 / today's typical case for older matches). */
const AGENTIC_MATCHED_NODE: CapabilityNode = {
  id: "node-matched",
  requestId: "req-test-1",
  name: "CNC finishing 6061",
  description: "CNC finish a 6061 aluminium bracket",
  capabilityType: "cnc-3axis",
  category: "fabrication",
  estimatedCost: 60,
  estimatedHours: 2,
  dependencies: [],
  parallel: false,
  status: "pending",
  materials: [],
  evidenceRequirements: ["photo_of_completed_work"],
  matchStatus: "matched",
  matchedCapabilityId: "cap-kernel_mtaon2df_ry6r-cnc-3axis",
  matchedKernelId: "kernel_mtaon2df_ry6r",
};

/** Same convention, now WITH a real matchedCapabilityDigest (PR #300 shape). */
const AGENTIC_MATCHED_NODE_WITH_DIGEST: CapabilityNode = {
  ...AGENTIC_MATCHED_NODE,
  matchedCapabilityDigest: VALID_DIGEST_A,
};

/** Direct-match decompose convention — RoutedCapabilityNode's capabilityId/kernelId, no matchStatus at all. */
const DIRECT_MATCH_NODE: RoutedCapabilityNode = {
  id: "node-direct",
  requestId: "req-test-1",
  name: "FDM 3D print (PLA)",
  description: "FDM print",
  capabilityType: "fdm",
  category: "fulfillment",
  estimatedCost: 20,
  estimatedHours: 1,
  dependencies: [],
  parallel: false,
  status: "pending",
  materials: [],
  evidenceRequirements: ["photo_of_completed_work"],
  capabilityId: "cap-kernel_abc-fdm",
  kernelId: "kernel_abc",
};

const UNMATCHED_NODE: CapabilityNode = {
  id: "node-unmatched",
  requestId: "req-test-1",
  name: "Underwater basket weaving",
  description: "no capability registered for this",
  capabilityType: "underwater-basket-weaving",
  category: "fabrication",
  estimatedCost: 40,
  estimatedHours: 1,
  dependencies: [],
  parallel: false,
  status: "pending",
  materials: [],
  evidenceRequirements: [],
  matchStatus: "none",
};

describe("produceJobOffersForRequest (bridge, coord #1276)", () => {
  beforeEach(() => {
    initJobOffersStore({});
  });

  afterEach(() => {
    _resetJobOffersStoreForTests();
  });

  it("creates one open job-offer per MATCHED node (agentic matchStatus convention), degrading gracefully with no digest", async () => {
    const req = baseRequest([AGENTIC_MATCHED_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(1);
    expect(result.skippedUnmatched).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.held).toBeUndefined();

    const open = getJobOffersStore().listOpen({ capabilityType: "cnc-3axis" });
    expect(open).toHaveLength(1);
    expect(open[0]!.pricing).toEqual({ amount: 60, currency: "USDC", model: "fixed" });
    expect(open[0]!.requirements).toMatchObject({
      requestId: "req-test-1",
      nodeId: "node-matched",
      ordinal: 0,
      matchedCapabilityId: "cap-kernel_mtaon2df_ry6r-cnc-3axis",
      matchedKernelId: "kernel_mtaon2df_ry6r",
    });

    // Negative control (gateway's own #1468 gotcha): an unrelated
    // capabilityType must stay empty, so an empty list isn't mistaken for
    // "the feed is broken" rather than "nothing of this type".
    expect(getJobOffersStore().listOpen({ capabilityType: "fdm" })).toHaveLength(0);

    // DEGRADE (no digest -> no compositionRoot), but the contract root needs
    // no digest -- it's still stamped, pinning the buyer's agreement early.
    expect(result.compositionRoot).toBeUndefined();
    expect(open[0]!.requirements.compositionRoot).toBeUndefined();
    expect(result.capabilityContractRoot).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(open[0]!.requirements.capabilityContractRoot).toBe(result.capabilityContractRoot);
  });

  it("creates one open job-offer per MATCHED node (direct-match capabilityId/kernelId convention, normalized for the adapter)", async () => {
    const req = baseRequest([DIRECT_MATCH_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(1);
    expect(result.held).toBeUndefined();
    const open = getJobOffersStore().listOpen({ capabilityType: "fdm" });
    expect(open).toHaveLength(1);
    expect(open[0]!.requirements.matchedKernelId).toBe("kernel_abc");
    expect(open[0]!.requirements.matchedCapabilityId).toBe("cap-kernel_abc-fdm");
    // Still degrades (direct-match carries no digest) but the contract root still stamps.
    expect(result.compositionRoot).toBeUndefined();
    expect(result.capabilityContractRoot).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("never publishes an UNMATCHED node — holds the whole request, fail-closed", async () => {
    const req = baseRequest([UNMATCHED_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.skippedUnmatched).toEqual(["node-unmatched"]);
    expect(result.held).toBeDefined();
    expect(result.held!.unmatchedNodes).toEqual(["node-unmatched"]);
    expect(
      getJobOffersStore().listOpen({ capabilityType: "underwater-basket-weaving" }),
    ).toHaveLength(0);
  });

  it("holds the whole request on a genuine plan violation that is NOT the digest gap (dangling edge reference)", async () => {
    // A dependency pointing at a node that doesn't exist in the plan -- a
    // structural violation @pcc/spec's validatePlan catches, unrelated to
    // matchedCapabilityDigest. Must NOT be mistaken for the safe-to-degrade
    // digest-only case, even though unmatchedNodes is empty here too.
    const dangling: CapabilityNode = {
      ...AGENTIC_MATCHED_NODE_WITH_DIGEST,
      dependencies: ["node-does-not-exist"],
    };
    const req = baseRequest([dangling]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.held).toBeDefined();
    expect(
      result.held!.violations.some((v) => v.includes("references a node not in the plan")),
    ).toBe(true);
    expect(getJobOffersStore().listOpen({ capabilityType: "cnc-3axis" })).toHaveLength(0);
  });

  it("holds (does not degrade) when a digest gap sits ALONGSIDE an unrelated plan violation — the mixed-violation regression (sol round 2)", async () => {
    // node-matched is missing its digest -- a pure digest gap on its own. node-b
    // ALSO has a real structural violation (dangling dependency) unrelated to the
    // digest. Before the v3 hardening, @pcc/spec's blockedOn (a .some() over
    // violations) would have seen node-matched's digest violation and waved the
    // WHOLE plan through as "just degraded" -- silently publishing node-b's
    // broken plan too. It must hold instead.
    const nodeB: CapabilityNode = {
      ...AGENTIC_MATCHED_NODE_WITH_DIGEST,
      id: "node-b",
      dependencies: ["node-does-not-exist"],
    };
    const req = baseRequest([AGENTIC_MATCHED_NODE, nodeB]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.held).toBeDefined();
    expect(
      result.held!.violations.some((v) => v.includes("references a node not in the plan")),
    ).toBe(true);
    expect(getJobOffersStore().listOpen({ capabilityType: "cnc-3axis" })).toHaveLength(0);
  });

  it("clears a stale matchedCapabilityDigest on a direct-match node rather than binding it to the wrong capability (sol round 2)", async () => {
    // A direct-match node carrying a leftover matchedCapabilityDigest from some
    // other match -- current decompose paths don't produce this shape, but the
    // producer must not silently trust it if one ever does.
    const routedWithStaleDigest = {
      ...DIRECT_MATCH_NODE,
      matchedCapabilityDigest: VALID_DIGEST_A, // stale -- belongs to a DIFFERENT capability
    } as unknown as CapabilityNode;
    const req = baseRequest([routedWithStaleDigest]);
    const result = await produceJobOffersForRequest(req);

    // Must NOT commit a compositionRoot bound to the stale digest -- degrades
    // exactly like the no-digest case, proving the digest was cleared rather
    // than trusted.
    expect(result.created).toHaveLength(1);
    expect(result.compositionRoot).toBeUndefined();
    expect(result.capabilityContractRoot).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it("a node claiming matchStatus:'matched' with incomplete agentic fields never falls through to the routed convention (sol round 2)", async () => {
    // matchStatus:'matched' but missing matchedKernelId -- a corrupt/malformed
    // agentic node. It happens to also carry direct-match-shaped fields. Must
    // resolve to unmatched (held), never silently reinterpreted as a routed match.
    const corrupt = {
      ...AGENTIC_MATCHED_NODE,
      matchedKernelId: undefined,
      capabilityId: "cap-should-not-be-used",
      kernelId: "kernel-should-not-be-used",
    } as unknown as CapabilityNode;
    const req = baseRequest([corrupt]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.held).toBeDefined();
    expect(result.held!.unmatchedNodes).toEqual(["node-matched"]);
  });

  it("a node explicitly marked matchStatus:'none' never falls through to the routed convention either (sol round 2, follow-up)", async () => {
    // The decomposer explicitly said "none" -- that must be authoritative even
    // if the node also happens to carry routed-shaped capabilityId/kernelId
    // fields (a hybrid/stale shape). Only a node where matchStatus is truly
    // ABSENT (the real decomposeDirectMatch shape) is a genuine routed match.
    const hybridNone = {
      ...UNMATCHED_NODE,
      capabilityId: "cap-should-not-be-used",
      kernelId: "kernel-should-not-be-used",
    } as unknown as CapabilityNode;
    const req = baseRequest([hybridNone]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.held).toBeDefined();
    expect(result.held!.unmatchedNodes).toEqual(["node-unmatched"]);
  });

  it("does not mistake a digest-shaped node id for a digest-only violation (sol round 2, follow-up: substring spoofing)", async () => {
    // A node id that itself contains the digest-violation substring, but whose
    // ACTUAL violation is an unrelated dangling edge. Must still hold -- the
    // suffix-anchored check must not be fooled by attacker/LLM-influenced node
    // ids landing in the violation string's prefix.
    const spoofy: CapabilityNode = {
      ...AGENTIC_MATCHED_NODE_WITH_DIGEST,
      id: "matchedCapabilityDigest-lookalike-node",
      dependencies: ["node-does-not-exist"],
    };
    const req = baseRequest([spoofy]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.held).toBeDefined();
    expect(
      result.held!.violations.some((v) => v.includes("references a node not in the plan")),
    ).toBe(true);
  });

  it("holds on a malformed-but-present digest, unlike the absent-digest degrade case (Finding C)", async () => {
    // Present but wrong shape (too short, not the 0x+64-hex form) -- distinct
    // from AGENTIC_MATCHED_NODE's genuinely absent digest. @pcc/spec's own
    // violation message is identical for "absent" and "malformed" (both are
    // "matched node missing/invalid matchedCapabilityDigest"), so this producer
    // must draw the distinction itself rather than degrade-publish through
    // what could be a real upstream data-integrity bug.
    const malformed: CapabilityNode = {
      ...AGENTIC_MATCHED_NODE,
      matchedCapabilityDigest: "0xnotarealdigest",
    };
    const req = baseRequest([malformed]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.held).toBeDefined();
    expect(
      result.held!.violations.some((v) => v.includes("missing/invalid matchedCapabilityDigest")),
    ).toBe(true);
    expect(getJobOffersStore().listOpen({ capabilityType: "cnc-3axis" })).toHaveLength(0);
  });

  it("is idempotent — publishing the same request twice does not double-create offers", async () => {
    const req = baseRequest([AGENTIC_MATCHED_NODE]);
    const first = await produceJobOffersForRequest(req);
    const second = await produceJobOffersForRequest(req);

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.alreadyExisted).toHaveLength(1);
    expect(second.alreadyExisted[0]!.offerId).toBe(first.created[0]!.offerId);
    expect(getJobOffersStore().listOpen({ capabilityType: "cnc-3axis" })).toHaveLength(1);
  });

  it("mixed DAG: holds the WHOLE request when >=1 node is unmatched (coord #1347 — no partial publish)", async () => {
    const req = baseRequest([AGENTIC_MATCHED_NODE, UNMATCHED_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.skippedUnmatched).toEqual(["node-unmatched"]);
    expect(result.held).toBeDefined();
    expect(result.held!.unmatchedNodes).toEqual(["node-unmatched"]);
    expect(getJobOffersStore().listOpen({ capabilityType: "cnc-3axis" })).toHaveLength(0);
  });

  it("stamps BOTH roots on every offer once matchedCapabilityDigest is present (PR #300 shape)", async () => {
    const nodeB: CapabilityNode = {
      ...AGENTIC_MATCHED_NODE_WITH_DIGEST,
      id: "node-b",
      capabilityType: "fdm",
      matchedCapabilityId: "cap-kernel_abc-fdm",
      matchedKernelId: "kernel_abc",
      matchedCapabilityDigest: VALID_DIGEST_B,
    };
    const req = baseRequest([AGENTIC_MATCHED_NODE_WITH_DIGEST, nodeB]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(2);
    expect(result.held).toBeUndefined();
    expect(result.compositionRoot).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.capabilityContractRoot).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const cnc = getJobOffersStore().listOpen({ capabilityType: "cnc-3axis" });
    const fdm = getJobOffersStore().listOpen({ capabilityType: "fdm" });
    expect(cnc).toHaveLength(1);
    expect(fdm).toHaveLength(1);
    expect(cnc[0]!.requirements.compositionRoot).toBe(result.compositionRoot);
    expect(fdm[0]!.requirements.compositionRoot).toBe(result.compositionRoot);
    expect(cnc[0]!.requirements.capabilityContractRoot).toBe(result.capabilityContractRoot);
    expect(fdm[0]!.requirements.capabilityContractRoot).toBe(result.capabilityContractRoot);
  });
});
