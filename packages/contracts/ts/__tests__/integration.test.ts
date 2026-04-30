/**
 * integration.test.ts — TypeScript ↔ Solidity end-to-end seam test for
 * the contributor-economics splitPayout pipeline.
 *
 * What it proves:
 *
 *   The off-chain orchestration flow that produces a Payout[] from a
 *   real CompositionManifest + RateSchedule registry + TrainingManifest
 *   produces the EXACT SAME on-chain shape the forge test
 *   `MilestoneEscrow.contributorEconomics.integration.t.sol` hand-built.
 *
 * This is the second half of Approach A + B per the integration brief:
 *
 *   - Approach A (forge .t.sol): hand-built equivalent Payout[] runs
 *     through MilestoneEscrow.release() and balances are exact.
 *
 *   - Approach B (THIS FILE): drive a real LicensingEngine in memory,
 *     register schedules + composition manifest + training manifest,
 *     call buildPayoutMap with the engine's resolvers, and compare the
 *     resulting Payout[] to the array Test 2 hand-built.
 *
 * If both halves agree, we have an end-to-end seam: the off-chain math
 * actually produces the same numbers the on-chain test asserts.
 *
 * The TypeScript-side compaction (model-author REPLACED by datasets)
 * is performed by an explicit "flatten" step in the test that mirrors
 * what an orchestrator would do before calling setPayoutMap. This is
 * NOT (yet) a published library function — Wave 4 of the
 * contributor-economics work treats orchestration as caller-side
 * responsibility, while this test pins down the exact transform.
 */
import { describe, it, expect } from "vitest";
import { keccak256, stringToHex } from "viem";
import {
  computeManifestHash,
  computeScheduleHash,
  computeTrainingManifestHash,
  type CompositionEntry,
  type CompositionManifest,
  type RateSchedule,
  type RateScheduleEvaluationContext,
  type TrainingManifest,
} from "@pcc/spec";
import {
  buildPayoutMap,
  ROLE_TAGS,
  type Payout,
} from "../payouts.js";
import { LicensingEngine } from "../licensing-engine.js";

// ── Shared fixtures ──────────────────────────────────────────────────────

const PUBLISHED = "2026-04-27T00:00:00.000Z";
const NOW = 1_700_000_000;

const ADDR = (n: number): `0x${string}` =>
  ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;

const BYTES32 = (n: number): `0x${string}` =>
  ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;

// Mirror the forge test's actor addresses + IP IDs so a side-by-side
// review reads cleanly.
const VERIFIER_RECIPIENT = ADDR(0x10);
const INTEGRATOR_RECIPIENT = ADDR(0x11);
const PROTOCOL_AUTHOR_RECIPIENT = ADDR(0x12);
const MODEL_AUTHOR_RECIPIENT = ADDR(0x13);
const DATASET_1_RECIPIENT = ADDR(0x20);
const DATASET_2_RECIPIENT = ADDR(0x21);
const DATASET_3_RECIPIENT = ADDR(0x22);

// IP IDs as 32-byte hex (matches the bytes32 forge fixtures)
const IP_VERIFIER = BYTES32(0xaa01);
const IP_INTEGRATOR = BYTES32(0xaa02);
const IP_PROTOCOL_AUTHOR = BYTES32(0xaa03);
const IP_MODEL_AUTHOR = BYTES32(0xaa04);
const IP_DATASET_1 = BYTES32(0xbb01);
const IP_DATASET_2 = BYTES32(0xbb02);
const IP_DATASET_3 = BYTES32(0xbb03);
const IP_CAPABILITY = BYTES32(0x0aaa);

/**
 * Build a constant-bps RateSchedule that runs from t=0 to forever and is
 * trivially well-formed for the integration scenarios.
 */
function constantSchedule(bps: number): RateSchedule {
  const partial = {
    version: 1 as const,
    segments: [
      {
        kind: "constant" as const,
        startTime: 0,
        endTime: null,
        bps,
      },
    ],
    publishedAt: PUBLISHED,
  };
  return {
    ...partial,
    scheduleHash: computeScheduleHash(partial),
  };
}

const ctx = (): RateScheduleEvaluationContext => ({
  now: NOW,
  jobValueCents: 1000,
  jobsPerDay: 100,
});

// ── Test 1 mirror: 4-recipient cohort via buildPayoutMap ─────────────────

describe("Approach B integration — 4-recipient cohort matches forge fixture", () => {
  it("buildPayoutMap produces the same Payout[] the forge integration test 1 asserts", () => {
    // Schedules: each contributor at their hardcoded bps.
    const sVerifier = constantSchedule(300);
    const sIntegrator = constantSchedule(500);
    const sProtocolAuthor = constantSchedule(400);
    const sModelAuthor = constantSchedule(300);

    // CompositionManifest: 4 entries, identical order to the forge fixture
    // (verifier, integrator, protocol-author, model-author).
    const entries: CompositionEntry[] = [
      {
        ipId: IP_VERIFIER,
        role: "verifier",
        contributorAddress: VERIFIER_RECIPIENT,
        rateScheduleHash: sVerifier.scheduleHash,
      },
      {
        ipId: IP_INTEGRATOR,
        role: "integrator",
        contributorAddress: INTEGRATOR_RECIPIENT,
        rateScheduleHash: sIntegrator.scheduleHash,
      },
      {
        ipId: IP_PROTOCOL_AUTHOR,
        role: "protocol-author",
        contributorAddress: PROTOCOL_AUTHOR_RECIPIENT,
        rateScheduleHash: sProtocolAuthor.scheduleHash,
      },
      {
        ipId: IP_MODEL_AUTHOR,
        role: "model-author",
        contributorAddress: MODEL_AUTHOR_RECIPIENT,
        rateScheduleHash: sModelAuthor.scheduleHash,
      },
    ];
    const partial = {
      capabilityIpId: IP_CAPABILITY,
      entries,
      builtAt: PUBLISHED,
    };
    const manifest: CompositionManifest = {
      ...partial,
      manifestHash: computeManifestHash(partial),
    };

    // Resolver map keyed by schedule hash.
    const byHash = new Map<string, RateSchedule>([
      [sVerifier.scheduleHash, sVerifier],
      [sIntegrator.scheduleHash, sIntegrator],
      [sProtocolAuthor.scheduleHash, sProtocolAuthor],
      [sModelAuthor.scheduleHash, sModelAuthor],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 100_000_000n,
      capabilityIpId: IP_CAPABILITY,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      scheduleByHash: byHash,
    });

    // ── Shape assertions ───────────────────────────────────────────────
    expect(result.payouts).toHaveLength(4);
    expect(result.operatorResidualBps).toBe(8500);

    // Each entry matches the forge Test 1 fixture by recipient + bps + role + ip.
    const expected: Payout[] = [
      {
        recipient: VERIFIER_RECIPIENT,
        bps: 300n,
        roleTag: ROLE_TAGS.verifier,
        ipId: IP_VERIFIER,
      },
      {
        recipient: INTEGRATOR_RECIPIENT,
        bps: 500n,
        roleTag: ROLE_TAGS.integrator,
        ipId: IP_INTEGRATOR,
      },
      {
        recipient: PROTOCOL_AUTHOR_RECIPIENT,
        bps: 400n,
        roleTag: ROLE_TAGS["protocol-author"],
        ipId: IP_PROTOCOL_AUTHOR,
      },
      {
        recipient: MODEL_AUTHOR_RECIPIENT,
        bps: 300n,
        roleTag: ROLE_TAGS["model-author"],
        ipId: IP_MODEL_AUTHOR,
      },
    ];
    expect(result.payouts).toEqual(expected);

    // The role tag values match keccak256(stringToHex("<role>")).
    expect(result.payouts[0].roleTag).toBe(keccak256(stringToHex("verifier")));
    expect(result.payouts[3].roleTag).toBe(keccak256(stringToHex("model-author")));
  });
});

// ── Test 2 mirror: TrainingManifest expansion via LicensingEngine ────────

describe("Approach B integration — TrainingManifest expansion matches forge fixture", () => {
  it("LicensingEngine.getRoyaltyDistributionRich expands model-author into 3 datasets with bps 150/90/60", () => {
    // 1. Set up the LicensingEngine with rate schedules for everyone in the
    //    composition (including the model author and EACH dataset).
    const engine = new LicensingEngine();

    const sVerifier = constantSchedule(300);
    const sIntegrator = constantSchedule(500);
    const sProtocolAuthor = constantSchedule(400);
    const sModelAuthor = constantSchedule(300);
    // Datasets ALSO need a registered schedule per the engine's contract
    // (expandTrainingManifest skips datasets without one). Use a 1bps stub
    // — the actual bps comes from modelBps * weightBps / 10000 inside
    // expandTrainingManifest, the schedule presence is just a gate.
    const sDataset = constantSchedule(1);

    engine.setRateSchedule(IP_VERIFIER, sVerifier);
    engine.setRateSchedule(IP_INTEGRATOR, sIntegrator);
    engine.setRateSchedule(IP_PROTOCOL_AUTHOR, sProtocolAuthor);
    engine.setRateSchedule(IP_MODEL_AUTHOR, sModelAuthor);
    engine.setRateSchedule(IP_DATASET_1, sDataset);
    engine.setRateSchedule(IP_DATASET_2, sDataset);
    engine.setRateSchedule(IP_DATASET_3, sDataset);

    // 2. Hand-rolled LicensingTerms-like seed so expandTrainingManifest
    //    can resolve each dataset's recipient via designerAddress.
    //    (LicensingEngine.expandTrainingManifest looks up
    //    this.terms.get(ds.datasetIpId)?.designerAddress.)
    engine.setTerms(IP_DATASET_1, {
      id: "terms-ds1",
      ipId: IP_DATASET_1,
      designerAddress: DATASET_1_RECIPIENT,
      autoLicense: {
        minRevSharePercent: 0,
        minAssuranceTier: 0,
        allowedCapabilityTypes: [],
        allowedKinds: [],
        cloneThreshold: 0.95,
        derivativeThreshold: 0.6,
        commercialUse: true,
        allowedRegions: [],
      },
      standingOffers: [],
      defaultRevShare: 0,
      allowSubDerivatives: true,
      derivativeDecayRate: 0.5,
      createdAt: PUBLISHED,
      updatedAt: PUBLISHED,
    });
    engine.setTerms(IP_DATASET_2, {
      id: "terms-ds2",
      ipId: IP_DATASET_2,
      designerAddress: DATASET_2_RECIPIENT,
      autoLicense: {
        minRevSharePercent: 0,
        minAssuranceTier: 0,
        allowedCapabilityTypes: [],
        allowedKinds: [],
        cloneThreshold: 0.95,
        derivativeThreshold: 0.6,
        commercialUse: true,
        allowedRegions: [],
      },
      standingOffers: [],
      defaultRevShare: 0,
      allowSubDerivatives: true,
      derivativeDecayRate: 0.5,
      createdAt: PUBLISHED,
      updatedAt: PUBLISHED,
    });
    engine.setTerms(IP_DATASET_3, {
      id: "terms-ds3",
      ipId: IP_DATASET_3,
      designerAddress: DATASET_3_RECIPIENT,
      autoLicense: {
        minRevSharePercent: 0,
        minAssuranceTier: 0,
        allowedCapabilityTypes: [],
        allowedKinds: [],
        cloneThreshold: 0.95,
        derivativeThreshold: 0.6,
        commercialUse: true,
        allowedRegions: [],
      },
      standingOffers: [],
      defaultRevShare: 0,
      allowSubDerivatives: true,
      derivativeDecayRate: 0.5,
      createdAt: PUBLISHED,
      updatedAt: PUBLISHED,
    });

    // 3. Link the model to its training manifest. Weights mirror the forge
    //    fixture: 5000 / 3000 / 2000 bps (must sum to exactly 10000).
    const tmPartial = {
      modelIpId: IP_MODEL_AUTHOR,
      datasets: [
        { datasetIpId: IP_DATASET_1, weightBps: 5000 },
        { datasetIpId: IP_DATASET_2, weightBps: 3000 },
        { datasetIpId: IP_DATASET_3, weightBps: 2000 },
      ],
      trainedAt: PUBLISHED,
    };
    const trainingManifest: TrainingManifest = {
      ...tmPartial,
      manifestHash: computeTrainingManifestHash(tmPartial),
    };
    engine.linkModel(IP_MODEL_AUTHOR, trainingManifest);

    // 4. Build the CompositionManifest (same 4 entries as Test 1).
    const entries: CompositionEntry[] = [
      {
        ipId: IP_VERIFIER,
        role: "verifier",
        contributorAddress: VERIFIER_RECIPIENT,
        rateScheduleHash: sVerifier.scheduleHash,
      },
      {
        ipId: IP_INTEGRATOR,
        role: "integrator",
        contributorAddress: INTEGRATOR_RECIPIENT,
        rateScheduleHash: sIntegrator.scheduleHash,
      },
      {
        ipId: IP_PROTOCOL_AUTHOR,
        role: "protocol-author",
        contributorAddress: PROTOCOL_AUTHOR_RECIPIENT,
        rateScheduleHash: sProtocolAuthor.scheduleHash,
      },
      {
        ipId: IP_MODEL_AUTHOR,
        role: "model-author",
        contributorAddress: MODEL_AUTHOR_RECIPIENT,
        rateScheduleHash: sModelAuthor.scheduleHash,
      },
    ];
    const compPartial = {
      capabilityIpId: IP_CAPABILITY,
      entries,
      builtAt: PUBLISHED,
    };
    const composition: CompositionManifest = {
      ...compPartial,
      manifestHash: computeManifestHash(compPartial),
    };

    // 5. Drive getRoyaltyDistributionRich — the engine returns ADDITIVE
    //    rows: each direct entry plus dataset expansions for model-author
    //    (model-author still appears as its own row).
    const distributions = engine.getRoyaltyDistributionRich({
      childIpId: IP_CAPABILITY,
      jobRevenue: 100_000_000n,
      context: ctx(),
      manifest: composition,
    });

    // ── Cross-check the engine's expansion math directly ───────────────
    // Filter: pull out rows where role === "dataset-contributor".
    const datasetRows = distributions.filter(
      (d) => d.role === "dataset-contributor",
    );
    expect(datasetRows).toHaveLength(3);

    // Order from expandTrainingManifest matches the manifest's dataset order.
    expect(datasetRows[0].recipientAddress).toBe(DATASET_1_RECIPIENT);
    expect(datasetRows[0].ipId).toBe(IP_DATASET_1);
    expect(datasetRows[1].recipientAddress).toBe(DATASET_2_RECIPIENT);
    expect(datasetRows[1].ipId).toBe(IP_DATASET_2);
    expect(datasetRows[2].recipientAddress).toBe(DATASET_3_RECIPIENT);
    expect(datasetRows[2].ipId).toBe(IP_DATASET_3);

    // The bps math matches the forge fixture exactly:
    //   d1: 300 * 5000 / 10000 = 150
    //   d2: 300 * 3000 / 10000 =  90
    //   d3: 300 * 2000 / 10000 =  60
    // sharePercent = bps / 100 (per LicensingEngine.pushDistribution)
    expect(datasetRows[0].sharePercent).toBeCloseTo(1.5, 6); // 150 bps = 1.5%
    expect(datasetRows[1].sharePercent).toBeCloseTo(0.9, 6); //  90 bps = 0.9%
    expect(datasetRows[2].sharePercent).toBeCloseTo(0.6, 6); //  60 bps = 0.6%

    // Amounts at jobRevenue=100_000_000:
    //   d1: 100_000_000 * 150 / 10000 = 1_477_500
    //   d2: 100_000_000 *  90 / 10000 =   886_500   (note: NOT scaled
    //                                                 against post-fee
    //                                                 distributable —
    //                                                 the engine works
    //                                                 in gross-job space;
    //                                                 the forge test
    //                                                 works in post-fee
    //                                                 distributable
    //                                                 space. Different
    //                                                 reference frames,
    //                                                 same bps.)
    //
    // The on-chain MilestoneEscrow recomputes bps * distributable / 10000
    // at release time; the off-chain engine's `amount` field is purely
    // for UI/audit display. The bps proof is what makes both sides agree.
    expect(datasetRows[0].amount).toBe(String((100_000_000n * 150n) / 10000n));
    expect(datasetRows[1].amount).toBe(String((100_000_000n * 90n) / 10000n));
    expect(datasetRows[2].amount).toBe(String((100_000_000n * 60n) / 10000n));

    // Conservation: the dataset rows' bps sum to the model-author bps EXACTLY.
    const datasetBpsSum = datasetRows.reduce(
      (s, r) => s + Math.round(r.sharePercent * 100),
      0,
    );
    expect(datasetBpsSum).toBe(300);
  });

  it("the on-chain Payout[] passed to setPayoutMap (post-flatten) matches the forge Test 2 fixture", () => {
    // This sub-test reproduces the flatten step an orchestrator would do
    // before calling setPayoutMap: take the engine's distributions array,
    // remove the model-author top-level row (it has been replaced by its
    // dataset expansion), and emit the resulting Payout[] in the order
    // the forge test asserts.
    const engine = new LicensingEngine();

    const sVerifier = constantSchedule(300);
    const sIntegrator = constantSchedule(500);
    const sProtocolAuthor = constantSchedule(400);
    const sModelAuthor = constantSchedule(300);
    const sDataset = constantSchedule(1);

    engine.setRateSchedule(IP_VERIFIER, sVerifier);
    engine.setRateSchedule(IP_INTEGRATOR, sIntegrator);
    engine.setRateSchedule(IP_PROTOCOL_AUTHOR, sProtocolAuthor);
    engine.setRateSchedule(IP_MODEL_AUTHOR, sModelAuthor);
    engine.setRateSchedule(IP_DATASET_1, sDataset);
    engine.setRateSchedule(IP_DATASET_2, sDataset);
    engine.setRateSchedule(IP_DATASET_3, sDataset);

    for (const [ip, addr] of [
      [IP_DATASET_1, DATASET_1_RECIPIENT],
      [IP_DATASET_2, DATASET_2_RECIPIENT],
      [IP_DATASET_3, DATASET_3_RECIPIENT],
    ] as const) {
      engine.setTerms(ip, {
        id: `terms-${ip}`,
        ipId: ip,
        designerAddress: addr,
        autoLicense: {
          minRevSharePercent: 0,
          minAssuranceTier: 0,
          allowedCapabilityTypes: [],
          allowedKinds: [],
          cloneThreshold: 0.95,
          derivativeThreshold: 0.6,
          commercialUse: true,
          allowedRegions: [],
        },
        standingOffers: [],
        defaultRevShare: 0,
        allowSubDerivatives: true,
        derivativeDecayRate: 0.5,
        createdAt: PUBLISHED,
        updatedAt: PUBLISHED,
      });
    }

    const tmPartial = {
      modelIpId: IP_MODEL_AUTHOR,
      datasets: [
        { datasetIpId: IP_DATASET_1, weightBps: 5000 },
        { datasetIpId: IP_DATASET_2, weightBps: 3000 },
        { datasetIpId: IP_DATASET_3, weightBps: 2000 },
      ],
      trainedAt: PUBLISHED,
    };
    engine.linkModel(IP_MODEL_AUTHOR, {
      ...tmPartial,
      manifestHash: computeTrainingManifestHash(tmPartial),
    });

    // Composition manifest with the model-author entry — same as before.
    const entries: CompositionEntry[] = [
      {
        ipId: IP_VERIFIER,
        role: "verifier",
        contributorAddress: VERIFIER_RECIPIENT,
        rateScheduleHash: sVerifier.scheduleHash,
      },
      {
        ipId: IP_INTEGRATOR,
        role: "integrator",
        contributorAddress: INTEGRATOR_RECIPIENT,
        rateScheduleHash: sIntegrator.scheduleHash,
      },
      {
        ipId: IP_PROTOCOL_AUTHOR,
        role: "protocol-author",
        contributorAddress: PROTOCOL_AUTHOR_RECIPIENT,
        rateScheduleHash: sProtocolAuthor.scheduleHash,
      },
      {
        ipId: IP_MODEL_AUTHOR,
        role: "model-author",
        contributorAddress: MODEL_AUTHOR_RECIPIENT,
        rateScheduleHash: sModelAuthor.scheduleHash,
      },
    ];
    const compPartial = {
      capabilityIpId: IP_CAPABILITY,
      entries,
      builtAt: PUBLISHED,
    };
    const composition: CompositionManifest = {
      ...compPartial,
      manifestHash: computeManifestHash(compPartial),
    };

    const distributions = engine.getRoyaltyDistributionRich({
      childIpId: IP_CAPABILITY,
      jobRevenue: 100_000_000n,
      context: ctx(),
      manifest: composition,
    });

    // Filter: keep direct (non-model-author) entries, plus dataset rows
    // (model-author top-level row is dropped because the orchestrator
    // pre-flattens to avoid double-paying).
    const flattened = distributions.filter((d) => d.role !== "model-author");

    // Convert each row to a Payout in the exact order the forge fixture
    // asserts: verifier, integrator, protocol-author, dataset-1,
    // dataset-2, dataset-3.
    function findRow(role: string, ipId: string) {
      const row = flattened.find((d) => d.role === role && d.ipId === ipId);
      if (!row) throw new Error(`missing row for role=${role} ipId=${ipId}`);
      return row;
    }

    const orchestratorPayouts: Payout[] = [
      (() => {
        const r = findRow("verifier", IP_VERIFIER);
        return {
          recipient: r.recipientAddress as `0x${string}`,
          bps: BigInt(Math.round(r.sharePercent * 100)),
          roleTag: ROLE_TAGS.verifier,
          ipId: IP_VERIFIER,
        };
      })(),
      (() => {
        const r = findRow("integrator", IP_INTEGRATOR);
        return {
          recipient: r.recipientAddress as `0x${string}`,
          bps: BigInt(Math.round(r.sharePercent * 100)),
          roleTag: ROLE_TAGS.integrator,
          ipId: IP_INTEGRATOR,
        };
      })(),
      (() => {
        const r = findRow("protocol-author", IP_PROTOCOL_AUTHOR);
        return {
          recipient: r.recipientAddress as `0x${string}`,
          bps: BigInt(Math.round(r.sharePercent * 100)),
          roleTag: ROLE_TAGS["protocol-author"],
          ipId: IP_PROTOCOL_AUTHOR,
        };
      })(),
      (() => {
        const r = findRow("dataset-contributor", IP_DATASET_1);
        return {
          recipient: r.recipientAddress as `0x${string}`,
          bps: BigInt(Math.round(r.sharePercent * 100)),
          roleTag: ROLE_TAGS["dataset-contributor"],
          ipId: IP_DATASET_1,
        };
      })(),
      (() => {
        const r = findRow("dataset-contributor", IP_DATASET_2);
        return {
          recipient: r.recipientAddress as `0x${string}`,
          bps: BigInt(Math.round(r.sharePercent * 100)),
          roleTag: ROLE_TAGS["dataset-contributor"],
          ipId: IP_DATASET_2,
        };
      })(),
      (() => {
        const r = findRow("dataset-contributor", IP_DATASET_3);
        return {
          recipient: r.recipientAddress as `0x${string}`,
          bps: BigInt(Math.round(r.sharePercent * 100)),
          roleTag: ROLE_TAGS["dataset-contributor"],
          ipId: IP_DATASET_3,
        };
      })(),
    ];

    // ── EXACT match against the forge Test 2 fixture ───────────────────
    // (See MilestoneEscrow.contributorEconomics.integration.t.sol
    //  → _expandedTrainingManifestPayoutMap.)
    const expected: Payout[] = [
      {
        recipient: VERIFIER_RECIPIENT,
        bps: 300n,
        roleTag: ROLE_TAGS.verifier,
        ipId: IP_VERIFIER,
      },
      {
        recipient: INTEGRATOR_RECIPIENT,
        bps: 500n,
        roleTag: ROLE_TAGS.integrator,
        ipId: IP_INTEGRATOR,
      },
      {
        recipient: PROTOCOL_AUTHOR_RECIPIENT,
        bps: 400n,
        roleTag: ROLE_TAGS["protocol-author"],
        ipId: IP_PROTOCOL_AUTHOR,
      },
      {
        recipient: DATASET_1_RECIPIENT,
        bps: 150n,
        roleTag: ROLE_TAGS["dataset-contributor"],
        ipId: IP_DATASET_1,
      },
      {
        recipient: DATASET_2_RECIPIENT,
        bps: 90n,
        roleTag: ROLE_TAGS["dataset-contributor"],
        ipId: IP_DATASET_2,
      },
      {
        recipient: DATASET_3_RECIPIENT,
        bps: 60n,
        roleTag: ROLE_TAGS["dataset-contributor"],
        ipId: IP_DATASET_3,
      },
    ];

    expect(orchestratorPayouts).toEqual(expected);

    // Conservation: total bps still 1500 (same cohort allocation as Test 1).
    const total = orchestratorPayouts.reduce((s, p) => s + Number(p.bps), 0);
    expect(total).toBe(1500);
  });
});

// ── Independent buildPayoutMap re-encoding sanity ────────────────────────

describe("Approach B integration — buildPayoutMap recovers the same shape", () => {
  it("buildPayoutMap on a manifest with the dataset cohort matches expected", () => {
    // What this proves: if the orchestrator builds a CompositionManifest
    // with the FULLY FLATTENED contributor cohort (model-author replaced
    // by its dataset rows in-place), and registers the dataset
    // schedules, buildPayoutMap returns the exact Payout[] the forge
    // test asserts. This codifies the "flattened manifest → buildPayoutMap"
    // path as an alternative to "rich manifest → engine →
    // post-process" — both produce the same on-chain Payout[].
    const sVerifier = constantSchedule(300);
    const sIntegrator = constantSchedule(500);
    const sProtocolAuthor = constantSchedule(400);
    const sDataset1 = constantSchedule(150);
    const sDataset2 = constantSchedule(90);
    const sDataset3 = constantSchedule(60);

    const entries: CompositionEntry[] = [
      {
        ipId: IP_VERIFIER,
        role: "verifier",
        contributorAddress: VERIFIER_RECIPIENT,
        rateScheduleHash: sVerifier.scheduleHash,
      },
      {
        ipId: IP_INTEGRATOR,
        role: "integrator",
        contributorAddress: INTEGRATOR_RECIPIENT,
        rateScheduleHash: sIntegrator.scheduleHash,
      },
      {
        ipId: IP_PROTOCOL_AUTHOR,
        role: "protocol-author",
        contributorAddress: PROTOCOL_AUTHOR_RECIPIENT,
        rateScheduleHash: sProtocolAuthor.scheduleHash,
      },
      {
        ipId: IP_DATASET_1,
        role: "dataset-contributor",
        contributorAddress: DATASET_1_RECIPIENT,
        rateScheduleHash: sDataset1.scheduleHash,
      },
      {
        ipId: IP_DATASET_2,
        role: "dataset-contributor",
        contributorAddress: DATASET_2_RECIPIENT,
        rateScheduleHash: sDataset2.scheduleHash,
      },
      {
        ipId: IP_DATASET_3,
        role: "dataset-contributor",
        contributorAddress: DATASET_3_RECIPIENT,
        rateScheduleHash: sDataset3.scheduleHash,
      },
    ];
    const partial = {
      capabilityIpId: IP_CAPABILITY,
      entries,
      builtAt: PUBLISHED,
    };
    const manifest: CompositionManifest = {
      ...partial,
      manifestHash: computeManifestHash(partial),
    };

    const byHash = new Map<string, RateSchedule>([
      [sVerifier.scheduleHash, sVerifier],
      [sIntegrator.scheduleHash, sIntegrator],
      [sProtocolAuthor.scheduleHash, sProtocolAuthor],
      [sDataset1.scheduleHash, sDataset1],
      [sDataset2.scheduleHash, sDataset2],
      [sDataset3.scheduleHash, sDataset3],
    ]);

    const result = buildPayoutMap({
      milestoneIndex: 0,
      jobValue: 100_000_000n,
      capabilityIpId: IP_CAPABILITY,
      compositionManifest: manifest,
      evaluationContext: ctx(),
      scheduleByHash: byHash,
    });

    expect(result.payouts).toHaveLength(6);
    const sum = result.payouts.reduce((a, p) => a + Number(p.bps), 0);
    expect(sum).toBe(1500);
    expect(result.operatorResidualBps).toBe(8500);

    // Each individual entry matches the forge fixture
    expect(result.payouts[0].bps).toBe(300n);
    expect(result.payouts[1].bps).toBe(500n);
    expect(result.payouts[2].bps).toBe(400n);
    expect(result.payouts[3].bps).toBe(150n);
    expect(result.payouts[4].bps).toBe(90n);
    expect(result.payouts[5].bps).toBe(60n);

    expect(result.payouts[3].roleTag).toBe(ROLE_TAGS["dataset-contributor"]);
    expect(result.payouts[4].roleTag).toBe(ROLE_TAGS["dataset-contributor"]);
    expect(result.payouts[5].roleTag).toBe(ROLE_TAGS["dataset-contributor"]);
  });
});
