import type { FastifyInstance } from "fastify";
import { ContractBuilder, getRegisteredTypes } from "@pcc/contract-builder";
import type { CapabilityType, AssuranceTier } from "@pcc/spec";
import { pipelineTelemetry } from "../telemetry.js";

const builder = new ContractBuilder();

export async function buildRoutes(app: FastifyInstance) {
  // Get build options (synchronous — calls ContractBuilder directly)
  app.post<{
    Body: {
      type: string;
      selections?: Record<string, unknown>;
      profileId?: string;
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
          "drive a multi-step configurator UI.",
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
    async (req) => {
      const { type, selections = {}, profileId } = req.body;
      const options = builder.getBuildOptions(
        type as CapabilityType,
        selections as Record<string, string | number | boolean | string[]>,
        profileId,
      );
      pipelineTelemetry.emit("pipeline-" + Date.now(), "quote_request", "completed", { metadata: { endpoint: "/api/build/options", type } });
      return { options };
    },
  );

  // Calculate price (synchronous)
  app.post<{
    Body: {
      type: string;
      selections: Record<string, unknown>;
      profileId?: string;
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
    async (req) => {
      const { type, selections, profileId } = req.body;
      const result = builder.calculatePrice(
        type as CapabilityType,
        selections as Record<string, string | number | boolean | string[]>,
        profileId,
      );
      pipelineTelemetry.emit("pipeline-" + Date.now(), "quote_request", "completed", { metadata: { endpoint: "/api/build/price", type } });
      return { pricing: result };
    },
  );

  // Build contract (synchronous)
  app.post<{
    Body: {
      type: string;
      selections: Record<string, unknown>;
      assuranceTier: number;
      profileId?: string;
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
    async (req) => {
      const { type, selections, assuranceTier, profileId } = req.body;
      const contract = builder.buildContract(
        type as CapabilityType,
        selections as Record<string, string | number | boolean | string[]>,
        assuranceTier as AssuranceTier,
        profileId,
      );
      pipelineTelemetry.emit("pipeline-" + Date.now(), "contract_build", "completed", { metadata: { endpoint: "/api/build/contract", type, assuranceTier } });
      return { contract };
    },
  );
}
