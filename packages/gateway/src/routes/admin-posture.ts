import type { FastifyInstance } from "fastify";
import { countAdminKeyFields, hasSingleValidAdminKey } from "../middleware/relay-admin-gate.js";
import { getCallerScopes } from "../middleware/scope-checker.js";
import { auditService } from "../services/audit-service.js";
import { buildPostureReport } from "../services/posture.js";

export async function adminPostureRoutes(app: FastifyInstance) {
  app.get("/api/admin/posture", { exposeHeadRoute: false }, async (req, reply) => {
    const n = countAdminKeyFields(req);
    let credential: string | undefined;
    let actor: string | undefined;
    if (n > 1) credential = "duplicate_admin_key";
    else if (n === 1) {
      const value = req.headers["x-admin-key"];
      if (hasSingleValidAdminKey(req) && value !== "*") actor = "admin-key";
      else credential = value === "*" ? "wildcard_admin_secret" : "admin_key_mismatch";
    } else if (!req.apiKeyId) credential = "no_api_key";
    else {
      const scopes = getCallerScopes(req);
      if (scopes.includes("*")) credential = "wildcard_scope";
      else if (!scopes.includes("admin")) credential = "no_admin_scope";
      else actor = req.apiKeyId;
    }
    if (credential) {
      auditService.log({ eventType: "admin.posture.refused", actor: req.apiKeyId ?? undefined, action: "read", resourceType: "posture", metadata: { credential } });
      return reply.code(403).send({ error: "forbidden" });
    }
    const report = buildPostureReport();
    const { verdict, flags, errors } = report;
    auditService.log({ eventType: "admin.posture.read", actor, action: "read", resourceType: "posture", metadata: { verdict, flags, errors } });
    return reply.header("cache-control", "no-store").send(report);
  });
}
