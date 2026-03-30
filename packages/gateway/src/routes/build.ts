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
  }>("/api/build/options", async (req) => {
    const { type, selections = {}, profileId } = req.body;
    const options = builder.getBuildOptions(
      type as CapabilityType,
      selections as Record<string, string | number | boolean | string[]>,
      profileId,
    );
    pipelineTelemetry.emit("pipeline-" + Date.now(), "quote_request", "completed", { metadata: { endpoint: "/api/build/options", type } });
    return { options };
  });

  // Calculate price (synchronous)
  app.post<{
    Body: {
      type: string;
      selections: Record<string, unknown>;
      profileId?: string;
    };
  }>("/api/build/price", async (req) => {
    const { type, selections, profileId } = req.body;
    const result = builder.calculatePrice(
      type as CapabilityType,
      selections as Record<string, string | number | boolean | string[]>,
      profileId,
    );
    pipelineTelemetry.emit("pipeline-" + Date.now(), "quote_request", "completed", { metadata: { endpoint: "/api/build/price", type } });
    return { pricing: result };
  });

  // Build contract (synchronous)
  app.post<{
    Body: {
      type: string;
      selections: Record<string, unknown>;
      assuranceTier: number;
      profileId?: string;
    };
  }>("/api/build/contract", async (req) => {
    const { type, selections, assuranceTier, profileId } = req.body;
    const contract = builder.buildContract(
      type as CapabilityType,
      selections as Record<string, string | number | boolean | string[]>,
      assuranceTier as AssuranceTier,
      profileId,
    );
    pipelineTelemetry.emit("pipeline-" + Date.now(), "contract_build", "completed", { metadata: { endpoint: "/api/build/contract", type, assuranceTier } });
    return { contract };
  });
}
