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
 * The endpoint is PUBLIC — operator slug is non-secret, and status doesn't
 * expose any credential. (Channel credentialRef values are vault references,
 * not secrets — safe to surface.)
 */

import type { FastifyInstance } from "fastify";
import { getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { getChannelsByOperator } from "./operator-channels.js";

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
  status: "ready" | "partial" | "unconfigured";
  missing: string[];
}

export async function operatorStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { slug: string } }>(
    "/api/operators/:slug/status",
    async (req, reply) => {
      const slug = req.params.slug;
      const { shopKernels, capabilities } = schema;

      let kernels: OperatorStatusKernel[] = [];
      let caps: OperatorStatusCapability[] = [];

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
