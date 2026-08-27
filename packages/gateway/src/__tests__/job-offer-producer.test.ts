/**
 * Tests for produceJobOffersForRequest — the bridge between request
 * decomposition/matching and the job-offers marketplace (coord #1276:
 * "a decomposed request never becomes a claimable job offer").
 *
 * Covers both "matched" conventions in this codebase (agentic matchStatus,
 * direct-match capabilityId/kernelId), fail-closed skip of unmatched nodes,
 * idempotency, and a mixed DAG.
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

/** Agentic/composite decompose convention — matchStatus + matchedCapabilityId/matchedKernelId. */
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

/** Direct-match decompose convention — RoutedCapabilityNode's capabilityId/kernelId. */
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

  it("creates one open job-offer per MATCHED node (agentic matchStatus convention)", async () => {
    const req = baseRequest([AGENTIC_MATCHED_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(1);
    expect(result.skippedUnmatched).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

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
  });

  it("creates one open job-offer per MATCHED node (direct-match capabilityId/kernelId convention)", async () => {
    const req = baseRequest([DIRECT_MATCH_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(1);
    const open = getJobOffersStore().listOpen({ capabilityType: "fdm" });
    expect(open).toHaveLength(1);
    expect(open[0]!.requirements.matchedKernelId).toBe("kernel_abc");
    expect(open[0]!.requirements.matchedCapabilityId).toBe("cap-kernel_abc-fdm");
  });

  it("never publishes an UNMATCHED node — fail-closed", async () => {
    const req = baseRequest([UNMATCHED_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(0);
    expect(result.skippedUnmatched).toEqual(["node-unmatched"]);
    expect(
      getJobOffersStore().listOpen({ capabilityType: "underwater-basket-weaving" }),
    ).toHaveLength(0);
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

  it("mixed DAG: matched node published, unmatched node skipped, in one call", async () => {
    const req = baseRequest([AGENTIC_MATCHED_NODE, UNMATCHED_NODE]);
    const result = await produceJobOffersForRequest(req);

    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.nodeId).toBe("node-matched");
    expect(result.skippedUnmatched).toEqual(["node-unmatched"]);
  });
});
