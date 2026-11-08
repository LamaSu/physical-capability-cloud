/** GET /api/operators/me/binding — current owned capacity and its kit bindings. */

import type { FastifyInstance } from "fastify";
import { KitBindings } from "../services/kit-bindings.js";
import { getKitRegistry, KitIntegrityError, KitRegistryError, type KitRegistry } from "../services/kit-registry.js";
import { AUTHENTICATION_REQUIRED, authorityOf, isAnonymous } from "../auth/kernel-authority.js";

export async function operatorBindingRoutes(app: FastifyInstance, opts: { registry?: KitRegistry } = {}): Promise<void> {
  app.get("/api/operators/me/binding", async (req, reply) => {
    const authority = authorityOf(req);
    if (isAnonymous(authority)) return reply.status(401).send(AUTHENTICATION_REQUIRED);
    if (!authority.provenWallet) return reply.status(403).send({
      error: "forbidden", reason: "operator_proof_required",
      message: "Your bindings need a wallet sign-in proof that you control a kernel's operator wallet.",
    });
    try {
      return await new KitBindings(opts.registry ?? getKitRegistry()).operatorBinding(authority.provenWallet);
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
