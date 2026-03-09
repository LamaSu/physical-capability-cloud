import type { FastifyInstance } from "fastify";
import { getAllTemplates, getRegisteredTypes } from "@pcc/contract-builder";

export async function capabilityRoutes(app: FastifyInstance) {
  // List all registered capability types
  app.get("/api/capabilities/types", async () => {
    return { types: getRegisteredTypes() };
  });

  // List all capability templates with their details
  app.get("/api/capabilities/templates", async () => {
    const templates = getAllTemplates();
    return {
      templates: templates.map((t) => ({
        capabilityType: t.capabilityType,
        name: t.name,
        version: t.version,
        description: t.description,
        paramCount: t.params.length,
        groups: [...new Set(t.params.map((p) => p.group))],
        basePrice: t.basePricingHints?.basePrice,
        currency: t.basePricingHints?.currency,
      })),
    };
  });
}
