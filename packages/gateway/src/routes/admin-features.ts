import type { FastifyInstance } from "fastify";
import { isAdminCaller } from "../auth/admin-caller.js";
import { countAdminKeyFields } from "../middleware/relay-admin-gate.js";
import { FEATURE_SWITCHES, listFeatureSwitches, setFeatureSwitch, type FeatureName } from "../services/feature-switches.js";

export async function adminFeatureRoutes(app: FastifyInstance) {
  // The root gateway decorates JSON 5xx responses with report_hint. Preserve
  // this API's exact unavailable body after that shared response hook runs.
  app.addHook("onSend", async (_req, reply, payload) => {
    if (reply.statusCode === 503 && typeof payload === "string"
      && JSON.parse(payload).error === "feature_switches_unavailable") {
      return JSON.stringify({ error: "feature_switches_unavailable" });
    }
    return payload;
  });
  app.get("/api/admin/features", { exposeHeadRoute: false }, async (req, reply) => {
    if (!isAdminCaller(req)) return reply.code(403).send({ error: "forbidden" });
    try {
      return reply.header("cache-control", "no-store").send({ features: listFeatureSwitches() });
    } catch {
      return reply.code(503).send({ error: "feature_switches_unavailable" });
    }
  });

  app.put<{ Params: { name: string } }>("/api/admin/features/:name", async (req, reply) => {
    if (!isAdminCaller(req)) return reply.code(403).send({ error: "forbidden" });
    const name = req.params.name;
    if (!FEATURE_SWITCHES.includes(name as FeatureName)) return reply.code(404).send({ error: "not_found" });
    const body = req.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !("enabled" in body) || typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "invalid_body" });
    }
    const actor = countAdminKeyFields(req) === 1 ? "admin-key" : req.apiKeyId!;
    try {
      return reply.send(setFeatureSwitch(name as FeatureName, body.enabled, actor));
    } catch {
      return reply.code(503).send({ error: "feature_switches_unavailable" });
    }
  });
}
