/**
 * GET /api/product/home — ProductHomeDTO (PX-7) for the shell's StatusBar and Command
 * Center: kernels online/stale, capabilities listed and on online kernels, jobs by execution
 * phase, the configured settlement network, and funds recorded as held in escrow milestones. Aggregates only; behind the API gate like
 * GET /api/jobs. `cache-control: no-store`.
 *
 * Under TENANT_ENFORCE, job counts are the caller's tenant's (unavailable for a caller with
 * no tenant, never every tenant's). Escrow records carry no tenant, so the held total is
 * `unavailable` there rather than a cross-tenant sum.
 */
import type { FastifyInstance } from "fastify";
import { schema } from "@pcc/store";
import { getStore } from "../db.js";
import { tenantOpts } from "../config/tenant-enforce.js";
import { getActiveNetwork } from "../chain-client.js";
import { buildProductHomeDTO, type ProductHomeSources } from "../readmodels/product-home.js";
import type { SourceRead } from "../readmodels/job-execution.js";

export async function productHomeRoutes(app: FastifyInstance) {
  app.get("/api/product/home", async (req, reply) => {
    const asOf = new Date().toISOString();
    const attempt = <T>(source: string, fn: () => T): SourceRead<T> => {
      try {
        return { ok: true, value: fn() };
      } catch (error) {
        req.log.warn({ source, err: error }, "product home read model: source read failed");
        return { ok: false };
      }
    };
    const tenant = tenantOpts(req as any);
    let store: ReturnType<typeof getStore> | null = null;
    try {
      store = getStore();
    } catch (error) {
      req.log.error({ err: error }, "product home read model: store unavailable");
    }
    const db = store?.db;
    const fail = (): never => {
      throw new Error("store unavailable");
    };

    const sources: ProductHomeSources = {
      kernels: attempt("kernels", () => ({
        kernels: (db ?? fail()).select().from(schema.shopKernels).all(),
        capabilities: (db ?? fail()).select({ kernelId: schema.capabilities.kernelId, type: schema.capabilities.type }).from(schema.capabilities).all(),
      })),
      jobs:
        tenant && !tenant.tenantId
          ? { ok: false, withheld: "TENANT_ENFORCE is on and this caller has no tenant, so there are no tenant-scoped job counts." }
          : attempt("jobs", () =>
              (store ?? fail()).repos.jobs.findAll(tenant?.tenantId ? { tenantId: tenant.tenantId } : undefined) as Array<{ status: string }>,
            ),
      escrow: tenant
        ? { ok: false, withheld: "Escrow records carry no tenant, so a tenant-scoped held total cannot be computed." }
        : attempt("escrow", () => ({
            escrows: (db ?? fail())
              .select({ id: schema.escrows.id, contractAddress: schema.escrows.contractAddress, currency: schema.escrows.currency })
              .from(schema.escrows)
              .all(),
            milestones: (db ?? fail())
              .select({ escrowId: schema.escrowMilestones.escrowId, amount: schema.escrowMilestones.amount, status: schema.escrowMilestones.status })
              .from(schema.escrowMilestones)
              .all(),
          })),
      network: getActiveNetwork(),
    };

    reply.header("cache-control", "no-store");
    return buildProductHomeDTO(sources, asOf);
  });
}
