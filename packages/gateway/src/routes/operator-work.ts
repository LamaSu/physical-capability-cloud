/**
 * Operator read models (PX-7, for operator-ux's Work Inbox):
 *
 *   GET /api/operator/work    OperatorWorkDTO: the caller's work across job offers, kernel
 *                             jobs and approvals, every field server-assigned
 *   GET /api/operator/income  OperatorIncomeDTO: what the escrow records show for the
 *                             caller's kernel jobs; totals are sums of rows only
 *
 * Both are scoped to the caller's kernels (operatorAddress is the caller, compared
 * case-insensitively). Anonymous callers get 401. A caller with no kernels gets an empty,
 * fully described read, not an error. `cache-control: no-store`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import { getJobOffersStore } from "../services/job-offers-store.js";
import {
  buildOperatorIncomeDTO,
  buildOperatorWorkDTO,
  findOperatorKernels,
  loadOperatorWorkSources,
  type OffersReader,
  type OperatorWorkSources,
} from "../readmodels/operator-work.js";

export const OPERATOR_WORK_DEFAULT_LIMIT = 200;
export const OPERATOR_WORK_MAX_LIMIT = 500;

function offersReader(): OffersReader | null {
  try {
    return getJobOffersStore();
  } catch {
    return null;
  }
}

type Load = { ok: true; sources: OperatorWorkSources } | { ok: false; status: 401 | 503; body: Record<string, unknown> };

function load(req: FastifyRequest): Load {
  const principal = ((req as any).operatorId ?? (req as any).userId ?? null) as string | null;
  if (!principal || String(principal).trim() === "") {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthenticated", message: "Sign in or send an API key to read your work." },
    };
  }
  let store: ReturnType<typeof getStore>;
  let kernels;
  try {
    store = getStore();
    kernels = findOperatorKernels(principal, store.db);
  } catch (error) {
    req.log.error({ err: error }, "operator read model: kernel read failed");
    return {
      ok: false,
      status: 503,
      body: { error: "read_model_unavailable", message: "Your kernels could not be read, so nothing is shown. Try again shortly." },
    };
  }
  const sources = loadOperatorWorkSources(kernels, store.repos as any, store.db, offersReader(), {
    tenant: tenantOpts(req as any),
    onReadError: (source, error) => req.log.warn({ source, err: error }, "operator read model: source read failed"),
  });
  return { ok: true, sources };
}

export async function operatorWorkRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>("/api/operator/work", async (req, reply) => {
    const asOf = new Date().toISOString();
    let limit = OPERATOR_WORK_DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      const n = Number(req.query.limit);
      if (!Number.isInteger(n) || n < 1 || n > OPERATOR_WORK_MAX_LIMIT) {
        return reply.code(400).send({
          error: "invalid_limit",
          message: `limit must be an integer from 1 to ${OPERATOR_WORK_MAX_LIMIT}.`,
        });
      }
      limit = n;
    }
    const loaded = load(req);
    if (!loaded.ok) return reply.code(loaded.status).send(loaded.body);
    reply.header("cache-control", "no-store");
    return buildOperatorWorkDTO(loaded.sources, asOf, { limit, nowMs: Date.parse(asOf) });
  });

  app.get("/api/operator/income", async (req, reply) => {
    const asOf = new Date().toISOString();
    const loaded = load(req);
    if (!loaded.ok) return reply.code(loaded.status).send(loaded.body);
    reply.header("cache-control", "no-store");
    return buildOperatorIncomeDTO(loaded.sources, asOf);
  });
}
