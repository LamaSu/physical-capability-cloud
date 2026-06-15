import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ContractBuilder,
  PricingCalculator,
  ContractValidator,
} from "@pcc/contract-builder";
import type { CapabilityType, AssuranceTier, BuilderContract } from "@pcc/spec";
import { pipelineTelemetry } from "../telemetry.js";
import { getCapabilityDescriptor } from "../services/ad-hoc-pricing.js";

const builder = new ContractBuilder();
const pricing = new PricingCalculator();
const validator = new ContractValidator();

/**
 * Common 4xx envelope for missing-template + missing-capability cases.
 * Routes used to throw on this path → Fastify default error handler →
 * 500 to the buyer. Now we surface a clear 404 with the reason.
 */
function sendMissing(reply: FastifyReply, reason: string): void {
  reply.status(404).send({
    error: "capability_not_buildable",
    message: reason,
  });
}

export async function buildRoutes(app: FastifyInstance) {
  // Get build options (synchronous — calls ContractBuilder directly for
  // built-in templates, or derives from a registered capability row for
  // ad-hoc capability types)
  app.post<{
    Body: {
      type: string;
      selections?: Record<string, unknown>;
      profileId?: string;
      /** Optional. Required for ad-hoc capability types so we can derive
       *  pricing from the specific capability instance. For built-in
       *  templates it's a no-op. */
      capabilityId?: string;
    };
  }>(
    "/api/build/options",
    {
      schema: {
        tags: ["contract-builder"],
        summary: "Get parameter options for a capability type",
        description:
          "Returns the parameter groups and allowed values for the given " +
          "capability, optionally filtered by partial selections. Used to " +
          "drive a multi-step configurator UI. Falls back to a generic " +
          "quantity-and-notes form for ad-hoc capability types whose " +
          "pricing comes from the capability row's pricingModel.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: { type: "string", description: "Capability type." },
            selections: {
              type: "object",
              additionalProperties: true,
              description: "Partial selections to narrow available options.",
            },
            profileId: { type: "string" },
            capabilityId: {
              type: "string",
              description:
                "Optional capability instance ID. Required for ad-hoc " +
                "capability types so pricing comes from the right row.",
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              options: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { type, selections = {}, profileId, capabilityId } = req.body;
      const desc = getCapabilityDescriptor(type, capabilityId);

      if (desc.kind === "missing") {
        return sendMissing(reply, desc.reason);
      }

      let options;
      if (desc.kind === "template") {
        options = builder.getBuildOptions(
          type as CapabilityType,
          selections as Record<string, string | number | boolean | string[]>,
          profileId,
        );
      } else {
        // Ad-hoc: return the pre-built ResolvedBuildOptions view model.
        options = desc.descriptor.resolved;
      }

      pipelineTelemetry.emit(
        "pipeline-" + Date.now(),
        "quote_request",
        "completed",
        {
          metadata: {
            endpoint: "/api/build/options",
            type,
            kind: desc.kind,
          },
        },
      );
      return { options };
    },
  );

  // Calculate price (synchronous). Ad-hoc capabilities price as
  // baseCost * (quantity ?? 1) with no template adjustments — the
  // operator's pricing model on the capability row is the single
  // source of truth for ad-hoc types.
  app.post<{
    Body: {
      type: string;
      selections: Record<string, unknown>;
      profileId?: string;
      capabilityId?: string;
    };
  }>(
    "/api/build/price",
    {
      schema: {
        tags: ["contract-builder"],
        summary: "Calculate price for a configured capability",
        description:
          "Returns the itemized price (base + adjustments + currency) " +
          "for the given selections without committing to a contract.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["type", "selections"],
          properties: {
            type: { type: "string", description: "Capability type." },
            selections: {
              type: "object",
              additionalProperties: true,
              description: "Complete parameter selections.",
            },
            profileId: { type: "string" },
            capabilityId: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              pricing: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { type, selections, profileId, capabilityId } = req.body;
      const desc = getCapabilityDescriptor(type, capabilityId);

      if (desc.kind === "missing") {
        return sendMissing(reply, desc.reason);
      }

      let result;
      if (desc.kind === "template") {
        result = builder.calculatePrice(
          type as CapabilityType,
          selections as Record<string, string | number | boolean | string[]>,
          profileId,
        );
      } else {
        // Ad-hoc: linear base * quantity.
        const quantity = Number((selections as Record<string, unknown>).quantity ?? 1) || 1;
        const basePriceNum = parseFloat(desc.descriptor.basePrice);
        const totalPrice = basePriceNum * quantity;
        result = {
          basePrice: basePriceNum,
          totalPrice,
          breakdown: [
            {
              paramKey: "quantity",
              paramLabel: "Quantity",
              selectedValue: String(quantity),
              impact: { mode: "per_unit", value: desc.descriptor.basePrice },
              amount: (basePriceNum * (quantity - 1)).toFixed(2),
            },
          ],
          currency: desc.descriptor.currency,
        };
      }

      pipelineTelemetry.emit(
        "pipeline-" + Date.now(),
        "quote_request",
        "completed",
        {
          metadata: {
            endpoint: "/api/build/price",
            type,
            kind: desc.kind,
          },
        },
      );
      return { pricing: result };
    },
  );

  // Build contract (synchronous). Ad-hoc capabilities skip parameter
  // validation (there's no rich template to validate against) and emit
  // a minimal CWM step derived from the capability row.
  app.post<{
    Body: {
      type: string;
      selections: Record<string, unknown>;
      assuranceTier: number;
      profileId?: string;
      capabilityId?: string;
    };
  }>(
    "/api/build/contract",
    {
      schema: {
        tags: ["contract-builder"],
        summary: "Build a complete capability contract",
        description:
          "Synchronously builds a contract for the given capability type with " +
          "the provided parameter selections and assurance tier (0-3). Returns " +
          "an unsigned contract ready for escrow funding via /api/escrow/fund.",
        body: {
          type: "object",
          additionalProperties: false,
          required: ["type", "selections", "assuranceTier"],
          properties: {
            type: {
              type: "string",
              description: "Capability type (e.g. '3d-printing', 'cnc', 'hplc').",
            },
            selections: {
              type: "object",
              additionalProperties: true,
              description: "Parameter selections (material, infill, layerHeight...).",
            },
            assuranceTier: {
              type: "integer",
              enum: [0, 1, 2, 3],
              description: "0=self-attested, 1=verified, 2=certified, 3=sovereign.",
            },
            profileId: {
              type: "string",
              description: "Optional pricing profile override.",
            },
            capabilityId: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              contract: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { type, selections, assuranceTier, profileId, capabilityId } = req.body;
      const desc = getCapabilityDescriptor(type, capabilityId);

      if (desc.kind === "missing") {
        return sendMissing(reply, desc.reason);
      }

      let contract: BuilderContract;
      if (desc.kind === "template") {
        contract = builder.buildContract(
          type as CapabilityType,
          selections as Record<string, string | number | boolean | string[]>,
          assuranceTier as AssuranceTier,
          profileId,
        );
      } else {
        // Ad-hoc: synthesize a minimal BuilderContract from the
        // ResolvedBuildOptions view model.
        const pricingResult = pricing.calculate(
          desc.descriptor.resolved,
          selections,
        );
        // Validate against the synthesized view model so the quantity
        // required-check fires the same way it does for templates.
        const validationResult = validator.validate(
          desc.descriptor.resolved,
          selections,
          assuranceTier,
        );
        contract = {
          selections: selections as Record<string, string | number | boolean | string[]>,
          totalPrice: pricingResult.totalPrice.toFixed(2),
          priceBreakdown: pricingResult.breakdown,
          cwmStep: validationResult.cwmStep,
          validationErrors: validationResult.errors,
          isValid: validationResult.errors.length === 0,
          templateName: desc.descriptor.resolved.templateName,
          machineInfo: desc.descriptor.resolved.machineInfo,
        };
      }

      pipelineTelemetry.emit(
        "pipeline-" + Date.now(),
        "contract_build",
        "completed",
        {
          metadata: {
            endpoint: "/api/build/contract",
            type,
            assuranceTier,
            kind: desc.kind,
          },
        },
      );
      return { contract };
    },
  );
}
