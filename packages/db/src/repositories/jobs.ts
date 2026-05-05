import { eq, and } from "drizzle-orm";
import { jobs } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IJobRepository, JobsTenantOpts } from "../interfaces/IJobRepository.js";

export class JobRepository implements IJobRepository {
  constructor(private db: StoreDB) {}

  findAll(opts?: JobsTenantOpts) {
    if (opts?.tenantId) {
      return this.db.select().from(jobs).where(eq(jobs.tenantId, opts.tenantId)).all();
    }
    return this.db.select().from(jobs).all();
  }

  findById(id: string) {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  findByKernel(kernelId: string, opts?: JobsTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kernelId, kernelId), eq(jobs.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(jobs).where(eq(jobs.kernelId, kernelId)).all();
  }

  findByStatus(status: string, opts?: JobsTenantOpts) {
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, status), eq(jobs.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(jobs).where(eq(jobs.status, status)).all();
  }

  findByKernelAndStatus(kernelId: string, status: string, opts?: JobsTenantOpts) {
    const base = and(eq(jobs.kernelId, kernelId), eq(jobs.status, status));
    if (opts?.tenantId) {
      return this.db
        .select()
        .from(jobs)
        .where(and(base, eq(jobs.tenantId, opts.tenantId)))
        .all();
    }
    return this.db.select().from(jobs).where(base).all();
  }

  insert(job: typeof jobs.$inferInsert) {
    return this.db.insert(jobs).values(job).returning().get();
  }

  update(id: string, data: Partial<typeof jobs.$inferInsert>) {
    return this.db.update(jobs).set(data).where(eq(jobs.id, id)).returning().get();
  }

  updateStatus(id: string, status: string, progress?: number) {
    const data: Partial<typeof jobs.$inferInsert> = { status };
    if (progress !== undefined) data.progress = progress;
    if (status === "completed") data.completedAt = new Date().toISOString();
    return this.db.update(jobs).set(data).where(eq(jobs.id, id)).returning().get();
  }
}
