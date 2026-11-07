/** GET /api/operators/me/binding — current owned capacity and its kit bindings. */

import type { FastifyInstance } from "fastify";
import { KitBindings } from "../services/kit-bindings.js";
import { getKitRegistry, KitIntegrityError, KitRegistryError, type KitRegistry } from "../services/kit-registry.js";
import { operatorIdentity } from "../services/operator-identity.js";

export async function operatorBindingRoutes(app: FastifyInstance, opts: { registry?: KitRegistry } = {}): Promise<void> {
  app.get("/api/operators/me/binding", async (req, reply) => {
    const identity = operatorIdentity(req);
    if (!identity) return reply.status(401).send({ error: "authentication_required" });
    try {
      return await new KitBindings(opts.registry ?? getKitRegistry()).operatorBinding(identity);
    } catch (err) {
      if (err instanceof KitRegistryError) {
        if (err.code === "binding_projection_invalid") {
          req.log.error({ code: err.code }, "operator binding projection failed validation");
          return reply.status(500).send({ error: err.code });
        }
        return reply.status(err.status).send({ error: err.code, message: err.message, ...err.details });
      }
      if (err instanceof KitIntegrityError) {
        req.log.error({ code: err.code }, "operator binding registry integrity failure");
        return reply.status(500).send({ error: err.code, message: "the stored binding failed verification and is not served" });
      }
      throw err;
    }
  });
}
