/**
 * Operator self-service status — the four-slot picture for one operator.
 *
 * GET /api/operators/:slug/status — returns the substrate view for a given
 * operator slug:
 *
 *   {
 *     operatorSlug,
 *     kernels: [{ id, name, status, lastHeartbeat }],
 *     capabilities: [{
 *       id, type, name, sla?, availability?, kernelId,
 *       assuranceTiers, pricing, location
 *     }],
 *     channels: [{ id, label, transport, direction, enabled, ... }],
 *     totals: {
 *       kernelCount, capabilityCount, channelCount,
 *       humanLaneCount, machineLaneCount,
 *       enabledChannelCount
 *     },
 *     agentCardUrls: string[],     // per-kernel A2A cards
 *     readiness: {                 // server-derived (services/onboarding-readiness.ts)
 *       devices: { registered, executable },
 *       adapterReady, verifiedRun,
 *       runEvidence, setupTestEvidence,   // evidence CLASSES, never keys or ids
 *       payout: "not_supported",
 *       openOffers: number | null
 *     },
 *     status: "ready" | "partial" | "unconfigured",
 *     missing: string[]            // human-readable list of unfilled slots
 *   }
 *
 * Operator's onboarding agent uses this to verify all four slots are wired
 * before going live. Also useful for a "is my integration done?" dashboard.
 *
 * Slot identification:
 *   1. Capability:    capabilities exist for this slug's kernels
 *   2. SLA:           capabilities[].sla set (only required for human lane)
 *   3. Channel:       getChannelsByOperator(slug) returns at least one enabled
 *   4. Availability:  capabilities[].availability set (recommended for all)
 *   5. A2A surface:   per-kernel agent-card URLs reachable (always; this is
 *                     PCC-side, not operator-side)
 *
 * "ready" also needs readiness (ADK D4(a), agreed with gateway in bus #2622):
 * no gap from the registered devices, and a VERIFIED run — a completed job on
 * one of the operator's kernels whose evidence verifies against the kernel's
 * registered signing key. A self-attested or test-key setup run never counts.
 *
 * The endpoint needs an API key (any key); it is not on the api-gate public
 * allowlist. The response carries no credential: channel credentialRef values
 * are vault references, and readiness is aggregate only (flags, counts and
 * evidence classes). Test-job evidence and provenance DETAIL is owner-only and
 * waits for WP-A's identity binding (N2); it is not served here.
 */

import type { FastifyInstance } from "fastify";
import { listRegisteredMachineAdapters } from "@pcc/kernel";
import { getStore } from "../db.js";
import { schema, eq, and, desc, sql } from "@pcc/store";
import { getChannelsByOperator } from "./operator-channels.js";
import { getJobOffersStore } from "../services/job-offers-store.js";
import type { KernelSignerColumns } from "../services/device-evidence-settlement.js";
import {
  assessBundle,
  computeOnboardingReadiness,
  readinessGaps,
  strongestEvidence,
  type EvidenceClass,
  type OnboardingReadiness,
  type RunObservation,
} from "../services/onboarding-readiness.js";

const GATEWAY_URL = process.env.PCC_GATEWAY_URL ?? "https://capability.network";

interface OperatorStatusKernel {
  id: string;
  name: string;
  status: string;
  lastHeartbeat: string | null;
}

interface OperatorStatusCapability {
  id: string;
  type: string;
  name: string;
  sla: unknown;
  availability: unknown;
  kernelId: string;
  assuranceTiers: unknown;
  pricing: unknown;
  location: unknown;
}

interface OperatorStatusResponse {
  operatorSlug: string;
  kernels: OperatorStatusKernel[];
  capabilities: OperatorStatusCapability[];
  channels: unknown[];
  totals: {
    kernelCount: number;
    capabilityCount: number;
    channelCount: number;
    humanLaneCount: number;
    machineLaneCount: number;
    enabledChannelCount: number;
  };
  agentCardUrls: string[];
  readiness: OnboardingReadiness;
  status: "ready" | "partial" | "unconfigured";
  missing: string[];
}

/**
 * Completed runs examined per kernel, newest first. The bound keeps the route
 * cheap; more than this many newer completed runs with weaker evidence can
 * hide an older verified run, so it errs toward "not ready", never "ready".
 */
const RUNS_PER_KERNEL = 10;
/** Evidence bundles examined per run (the evidence relay does not deduplicate). */
const BUNDLES_PER_RUN = 10;

/**
 * Readiness from canonical rows. A read failure can only hide a verified run,
 * never invent one.
 */
async function loadReadiness(
  kernelIds: readonly string[],
  signerByKernel: ReadonlyMap<string, KernelSignerColumns>,
  capabilityTypes: readonly string[],
): Promise<OnboardingReadiness> {
  const { kernelDevices, jobs, evidenceBundles } = schema;
  const devices: Array<{ type: string | null; adapterType: string | null }> = [];
  const runs: RunObservation[] = [];
  let latestSetupTest: { startedAt: string; run: RunObservation } | null = null;

  try {
    const { db } = getStore();

    const runEvidence = async (jobId: string, kernelId: string): Promise<EvidenceClass> => {
      const bundles = db
        .select({
          bundleHash: evidenceBundles.bundleHash,
          kernelSignature: evidenceBundles.kernelSignature,
          sessionKeyAuthorization: evidenceBundles.sessionKeyAuthorization,
        })
        .from(evidenceBundles)
        .where(eq(evidenceBundles.jobId, jobId))
        .orderBy(desc(evidenceBundles.createdAt))
        .limit(BUNDLES_PER_RUN)
        .all();
      const classes: EvidenceClass[] = [];
      for (const bundle of bundles) {
        const evidence = await assessBundle(bundle, jobId, signerByKernel.get(kernelId));
        classes.push(evidence);
        if (evidence === "verified") break;
      }
      return strongestEvidence(classes);
    };

    for (const kernelId of kernelIds) {
      devices.push(
        ...db
          .select({ type: kernelDevices.type, adapterType: kernelDevices.adapterType })
          .from(kernelDevices)
          .where(eq(kernelDevices.kernelId, kernelId))
          .all(),
      );

      const completed = db
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(and(eq(jobs.kernelId, kernelId), eq(jobs.status, "completed")))
        .orderBy(desc(jobs.completedAt), desc(jobs.startedAt))
        .limit(RUNS_PER_KERNEL)
        .all();
      for (const job of completed) {
        const evidence = await runEvidence(job.id, kernelId);
        runs.push({ status: job.status, evidence });
        if (evidence === "verified") break;
      }

      // POST /api/setup/test-job ids are "test-job-<uuid>".
      const setup = db
        .select({ id: jobs.id, status: jobs.status, startedAt: jobs.startedAt })
        .from(jobs)
        .where(and(eq(jobs.kernelId, kernelId), sql`${jobs.id} LIKE 'test-job-%'`))
        .orderBy(desc(jobs.startedAt))
        .limit(1)
        .get();
      const setupStartedAt = setup?.startedAt ?? "";
      if (setup && (latestSetupTest === null || setupStartedAt > latestSetupTest.startedAt)) {
        latestSetupTest = {
          startedAt: setupStartedAt,
          run: { status: setup.status, evidence: await runEvidence(setup.id, kernelId) },
        };
      }
    }
  } catch {
    // DB not initialised (test context with nothing seeded): keep what was read.
  }

  let openOffers: number | null = null;
  try {
    const offers = getJobOffersStore();
    openOffers = [...new Set(capabilityTypes)].reduce(
      (count, capabilityType) => count + offers.listOpen({ capabilityType }).length,
      0,
    );
  } catch {
    openOffers = null; // the offer store is not initialised in this process
  }

  return computeOnboardingReadiness({
    devices,
    buildableMachineAdapters: listRegisteredMachineAdapters(),
    runs,
    latestSetupTest: latestSetupTest?.run ?? null,
    openOffers,
  });
}

export async function operatorStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { slug: string } }>(
    "/api/operators/:slug/status",
    async (req, reply) => {
      const slug = req.params.slug;
      const { shopKernels, capabilities } = schema;

      let kernels: OperatorStatusKernel[] = [];
      let caps: OperatorStatusCapability[] = [];
      // Each kernel's proven signer, for verifying run evidence. Never served.
      const signerByKernel = new Map<string, KernelSignerColumns>();

      try {
        const { db } = getStore();
        // Operator slug == kernel operatorAddress OR kernel name slugified.
        // Match on operatorAddress to keep this stable across name changes.
        const kernelRows = db
          .select({
            id: shopKernels.id,
            name: shopKernels.name,
            status: shopKernels.status,
            lastHeartbeat: shopKernels.lastHeartbeat,
            signingKeyAlgorithm: shopKernels.signingKeyAlgorithm,
            signingKeyPublicKey: shopKernels.signingKeyPublicKey,
            signingAddress: shopKernels.signingAddress,
          })
          .from(shopKernels)
          .where(eq(shopKernels.operatorAddress, slug))
          .all();
        kernels = kernelRows.map((r) => ({
          id: r.id as string,
          name: r.name as string,
          status: r.status as string,
          lastHeartbeat: (r.lastHeartbeat as string) ?? null,
        }));
        for (const r of kernelRows) {
          signerByKernel.set(r.id as string, {
            signingKeyAlgorithm: r.signingKeyAlgorithm,
            signingKeyPublicKey: r.signingKeyPublicKey,
            signingAddress: r.signingAddress,
          });
        }

        if (kernels.length > 0) {
          const kernelIds = kernels.map((k) => k.id);
          // Fetch capabilities per kernel — Drizzle .in() is verbose for SQLite;
          // simpler to loop and accumulate.
          for (const kid of kernelIds) {
            const rows = db
              .select({
                id: capabilities.id,
                type: capabilities.type,
                name: capabilities.name,
                sla: capabilities.sla,
                availability: capabilities.availability,
                kernelId: capabilities.kernelId,
                assuranceTiers: capabilities.assuranceTiers,
                pricing: capabilities.pricing,
                location: capabilities.location,
              })
              .from(capabilities)
              .where(eq(capabilities.kernelId, kid))
              .all();
            for (const c of rows) {
              caps.push({
                id: c.id as string,
                type: c.type as string,
                name: c.name as string,
                sla: c.sla,
                availability: c.availability,
                kernelId: c.kernelId as string,
                assuranceTiers: c.assuranceTiers,
                pricing: c.pricing,
                location: c.location,
              });
            }
          }
        }
      } catch {
        // DB not initialised (test context with no kernels seeded). Treat as
        // empty — status will be "unconfigured" with all four slots missing.
        kernels = [];
        caps = [];
      }

      const channels = getChannelsByOperator(slug);
      const enabledChannels = channels.filter((c) => c.enabled);

      const humanLaneCount = caps.filter((c) => c.sla != null).length;
      const machineLaneCount = caps.length - humanLaneCount;

      // Slot status assessment
      const missing: string[] = [];
      if (kernels.length === 0) {
        missing.push("kernel — no kernel registered for this operatorAddress; POST /api/kernels first");
      }
      if (caps.length === 0) {
        missing.push("capability (slot 1) — no capability published; use pcc-author-integration A2A skill");
      }
      // SLA (slot 2) is optional by design — its presence is how we classify
      // human-lane vs machine-lane. A capability with null sla is a machine
      // capability, NOT a human-capability-missing-sla. So there's no
      // "missing SLA" state to flag from this endpoint. Operators who
      // genuinely want human lane on a capability without sla should
      // re-register that capability with sla set.
      void humanLaneCount; // keep humanLaneCount in totals; just not used for missing[]
      if (channels.length === 0) {
        missing.push("channel (slot 3) — no notification channel attached; use pcc-attach-channel A2A skill or POST /api/operators/:slug/channels");
      } else if (enabledChannels.length === 0) {
        missing.push("channel enabled (slot 3) — channels attached but all disabled");
      }
      const capsWithoutAvailability = caps.filter((c) => {
        const a = c.availability;
        return !a || (typeof a === "object" && Object.keys(a as object).length === 0);
      });
      if (capsWithoutAvailability.length > 0 && caps.length > 0) {
        missing.push(`availability (slot 4) — ${capsWithoutAvailability.length}/${caps.length} capabilities lack availability; recommend setting mode=always for 24/7 or windows[] for explicit hours`);
      }

      // Readiness (D4(a)): can a device execute, and has a verified run happened?
      const readiness = await loadReadiness(
        kernels.map((k) => k.id),
        signerByKernel,
        caps.map((c) => c.type),
      );
      if (kernels.length > 0) missing.push(...readinessGaps(readiness));

      // Overall status
      let status: "ready" | "partial" | "unconfigured" = "ready";
      if (kernels.length === 0 && caps.length === 0 && channels.length === 0) {
        status = "unconfigured";
      } else if (missing.length > 0) {
        status = "partial";
      }

      const agentCardUrls = kernels.map(
        (k) => `${GATEWAY_URL}/api/kernels/${k.id}/agent-card.json`,
      );

      const body: OperatorStatusResponse = {
        operatorSlug: slug,
        kernels,
        capabilities: caps,
        channels,
        totals: {
          kernelCount: kernels.length,
          capabilityCount: caps.length,
          channelCount: channels.length,
          humanLaneCount,
          machineLaneCount,
          enabledChannelCount: enabledChannels.length,
        },
        agentCardUrls,
        readiness,
        status,
        missing,
      };

      return reply
        .status(200)
        .header("cache-control", "public, max-age=15")
        .send(body);
    },
  );
}
