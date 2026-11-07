import type { FastifyInstance } from "fastify";

export function demoRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PCC_DEMO_ROUTES === "1" && (env.NODE_ENV === "test" || env.NODE_ENV === "development");
}

export interface NotAvailableBody {
  error: "not_available";
  message: string;
  see: string[];
}

export function notAvailable(what: string, why: string, see: string[]): NotAvailableBody {
  return { error: "not_available", message: what + " " + why, see };
}

/**
 * Board N34, #2498: keep fixture routes registered while refusing their data by
 * default. One plugin-scoped onRequest hook checks the flag per request, before
 * parsing a body or calling a handler. GET's HEAD twin follows the GET template.
 * No route is added, removed, renamed or prefixed. Only test and development
 * honor the flag: PCC_DEMO_ROUTES=1 counts only when NODE_ENV is exactly "test"
 * or "development" (isCarrierProductionEnv's rule). Production, an unset or
 * empty NODE_ENV and any other value ignore it.
 */
export function gateDemoRoutes(
  app: FastifyInstance,
  body: NotAvailableBody,
  scope?: { except: readonly string[] } | { only: readonly string[] },
): void {
  app.addHook("onRequest", async (req, reply) => {
    if (demoRoutesEnabled()) return;
    const method = req.method === "HEAD" ? "GET" : req.method;
    const key = `${method} ${req.routeOptions.url}`;
    if (scope && "except" in scope && scope.except.includes(key)) return;
    if (scope && "only" in scope && !scope.only.includes(key)) return;
    return reply.code(501).send(body);
  });
}
