/**
 * Operator read models (PX-7, for operator-ux's Work Inbox):
 *
 *   GET /api/operator/work    OperatorWorkDTO: the caller's work across job offers, kernel
 *                             jobs and approvals, every field server-assigned
 *   GET /api/operator/income  OperatorIncomeDTO: what the escrow records show for the
 *                             caller's kernel jobs; totals are sums of rows only
 *
 * Both are scoped to the caller's kernels: kernels whose recorded operatorAddress is the
 * caller's PROVEN wallet (SIWE: WP-A's req.provenWallet), compared as addresses. An API
 * key's operatorId or an email is never used, since anyone can claim one at provisioning
 * (#353 review r3, P1-5). Anonymous callers get 401, and a credential without a proven
 * wallet gets 403 identity_unverified. A proven wallet with no kernels gets an empty, fully
 * described read, not an error. `cache-control: no-store`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import { getJobOffersStore } from "../services/job-offers-store.js";
import { jobReadCallerOf } from "../readmodels/job-execution.js";
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

type Load = { ok: true; sources: OperatorWorkSources } | { ok: false; status: 401 | 403 | 503; body: Record<string, unknown> };

function load(req: FastifyRequest): Load {
  const caller = jobReadCallerOf(req as unknown as { headers: Record<string, unknown> });
  if (!caller.authenticated) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthenticated", message: "Sign in or send an API key to read your work." },
    };
  }
  if (!caller.provenWallet) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "identity_unverified",
        message:
          "Your work and income are shown only to a proven identity: sign in with a wallet (SIWE), or use an API key " +
          "minted from a wallet session. An email or a self-declared operator id is not proof.",
      },
    };
  }
  let store: ReturnType<typeof getStore>;
  let kernels;
  try {
    store = getStore();
    kernels = findOperatorKernels(caller.provenWallet, store.db);
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
