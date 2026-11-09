import type { FastifyInstance } from "fastify";
import { recheckKitDescriptor } from "@pcc/spec/recheck";

/** Public static discovery document; clients re-check using their embedded kit. */
export async function settlementRecheckKitRoutes(app: FastifyInstance) {
  app.get("/.well-known/pcc-settlement-recheck.json", {
    schema: {
      tags: ["well-known"],
      summary: "Settlement client re-check kit (public)",
      operationId: "getSettlementRecheckKit",
    },
  }, async (_req, reply) => reply
    .header("content-type", "application/json")
    .header("access-control-allow-origin", "*")
    .header("cache-control", "public, max-age=300")
    .send(recheckKitDescriptor()));
}
