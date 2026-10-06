import type { FastifyReply, FastifyRequest } from "fastify";
import { hasValidAdminKey } from "../readmodels/job-execution.js";

export const RELAY_DISABLED_REFUSAL = {
  error: "forbidden",
  reason: "relay_disabled",
  message: "The device relay is closed on this deployment.",
} as const;

export function isRelayGateOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PCC_RELAY_GATE === "open";
}

function isRelayPath(path: string | undefined): boolean {
  return path === "/api/relay" || path?.startsWith("/api/relay/") === true
    || path === "/api/ot2" || path?.startsWith("/api/ot2/") === true;
}

export function isRelayRequest(req: { url: string; routeOptions?: { url?: string } }): boolean {
  if (isRelayPath(req.routeOptions?.url)) return true;
  return isRelayPath(req.url.split("?")[0].replace(/\/+/g, "/"));
}

export async function rejectRelayWithoutAdminKey(req: FastifyRequest, reply: FastifyReply) {
  if (isRelayGateOpen()) return;
  if (!isRelayRequest(req)) return;
  if (hasValidAdminKey(req.headers["x-admin-key"])) return;
  return reply.code(403).send(RELAY_DISABLED_REFUSAL);
}
