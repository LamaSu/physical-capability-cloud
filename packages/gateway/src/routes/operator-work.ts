/**
 * Operator read models (PX-7, for operator-ux's Work Inbox):
 *
 *   GET /api/operator/work    OperatorWorkDTO: the caller's work across job offers, kernel
 *                             jobs and approvals, every field server-assigned
 *   GET /api/operator/income  OperatorIncomeDTO: what the escrow records show for the
 *                             caller's kernel jobs; totals sum every row across all pages
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
  OPERATOR_PAGE_DEFAULT_LIMIT,
  OPERATOR_PAGE_MAX_LIMIT,
  type OffersReader,
  type OperatorPage,
  type OperatorWorkSources,
} from "../readmodels/operator-work.js";
import { lit } from "../observability/closed-schema.js";

export const OPERATOR_WORK_DEFAULT_LIMIT = OPERATOR_PAGE_DEFAULT_LIMIT;
export const OPERATOR_WORK_MAX_LIMIT = OPERATOR_PAGE_MAX_LIMIT;

/** `?limit=` (1 to the maximum) and `?offset=` (0 or more), the same for the work list and the income rows. */
function pageFrom(q: { limit?: unknown; offset?: unknown }):
  | { ok: true; page: OperatorPage }
  | { ok: false; body: { error: string; message: string } } {
  const page: OperatorPage = { limit: OPERATOR_PAGE_DEFAULT_LIMIT, offset: 0 };
  // A repeated parameter arrives as a list: anything but one string is invalid, never a crash.
  if (q.limit !== undefined) {
    const n = typeof q.limit === "string" ? Number(q.limit) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > OPERATOR_PAGE_MAX_LIMIT) {
      return { ok: false, body: { error: "invalid_limit", message: `limit must be an integer from 1 to ${OPERATOR_PAGE_MAX_LIMIT}.` } };
    }
    page.limit = n;
  }
  if (q.offset !== undefined) {
    const n = typeof q.offset === "string" && q.offset.trim() !== "" ? Number(q.offset) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < 0) {
      return { ok: false, body: { error: "invalid_offset", message: "offset must be an integer of 0 or more." } };
    }
    page.offset = n;
  }
  return { ok: true, page };
}

/**
 * `?snapshot=`: the snapshot of the list a client is paging through (review r2 of #389, MEDIUM).
 * Absent, the page is served as read. Present, it must be one string, and it must equal the
 * current list's snapshot, or the route answers 409 list_changed.
 */
function snapshotFrom(q: { snapshot?: unknown }):
  | { ok: true; snapshot: string | null }
  | { ok: false; body: { error: string; message: string } } {
  if (q.snapshot === undefined) return { ok: true, snapshot: null };
  if (typeof q.snapshot !== "string" || q.snapshot.trim() === "") {
    return { ok: false, body: { error: "invalid_snapshot", message: "snapshot must be the snapshot of an earlier page." } };
  }
  return { ok: true, snapshot: q.snapshot };
}

const LIST_CHANGED = "The list changed since that snapshot, so this page could repeat or skip rows. Start again at offset 0.";

function offersReader(): OffersReader | null {
  try {
    return getJobOffersStore();
  } catch {
    return null;
  }
}

type Load = { ok: true; sources: OperatorWorkSources } | { ok: false; status: 401 | 403 | 503; body: Record<string, unknown> };

/** 401 or 403, decided before anything is validated or read (the job read family's rule). */
function identityRefusal(req: FastifyRequest): Extract<Load, { ok: false }> | null {
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
  return null;
}

function load(req: FastifyRequest): Load {
  const refused = identityRefusal(req);
  if (refused) return refused;
  // identityRefusal returned null, so the caller has a proven wallet.
  const wallet = jobReadCallerOf(req as unknown as { headers: Record<string, unknown> }).provenWallet!;
  let store: ReturnType<typeof getStore>;
  let kernels;
  try {
    store = getStore();
    kernels = findOperatorKernels(wallet, store.db);
  } catch (error) {
    req.log.error({ err: error }, lit("operator read model: kernel read failed"));
    return {
      ok: false,
      status: 503,
      body: { error: "read_model_unavailable", message: "Your kernels could not be read, so nothing is shown. Try again shortly." },
    };
  }
  const sources = loadOperatorWorkSources(kernels, store.repos as any, store.db, offersReader(), {
    tenant: tenantOpts(req as any),
    onReadError: (source, error) => req.log.warn({ source, err: error }, lit("operator read model: source read failed")),
  });
  return { ok: true, sources };
}

export async function operatorWorkRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string | string[]; offset?: string | string[]; snapshot?: string | string[] } }>("/api/operator/work", async (req, reply) => {
    const asOf = new Date().toISOString();
    const refused = identityRefusal(req);
    if (refused) return reply.code(refused.status).send(refused.body);
    const p = pageFrom(req.query);
    if (!p.ok) return reply.code(400).send(p.body);
    const snap = snapshotFrom(req.query);
    if (!snap.ok) return reply.code(400).send(snap.body);
    const loaded = load(req);
    if (!loaded.ok) return reply.code(loaded.status).send(loaded.body);
    reply.header("cache-control", "no-store");
    const dto = buildOperatorWorkDTO(loaded.sources, asOf, { ...p.page, nowMs: Date.parse(asOf) });
    if (snap.snapshot !== null && snap.snapshot !== dto.snapshot) {
      return reply.code(409).send({ error: "list_changed", message: LIST_CHANGED, snapshot: dto.snapshot });
    }
    return dto;
  });

  app.get<{ Querystring: { limit?: string | string[]; offset?: string | string[]; snapshot?: string | string[] } }>("/api/operator/income", async (req, reply) => {
    const asOf = new Date().toISOString();
    const refused = identityRefusal(req);
    if (refused) return reply.code(refused.status).send(refused.body);
    const p = pageFrom(req.query);
    if (!p.ok) return reply.code(400).send(p.body);
    const snap = snapshotFrom(req.query);
    if (!snap.ok) return reply.code(400).send(snap.body);
    const loaded = load(req);
    if (!loaded.ok) return reply.code(loaded.status).send(loaded.body);
    reply.header("cache-control", "no-store");
    const dto = buildOperatorIncomeDTO(loaded.sources, asOf, p.page);
    if (snap.snapshot !== null && snap.snapshot !== dto.snapshot) {
      return reply.code(409).send({ error: "list_changed", message: LIST_CHANGED, snapshot: dto.snapshot });
    }
    return dto;
  });
}
