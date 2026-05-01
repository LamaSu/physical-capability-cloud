import type { jobs } from "../schema/index.js";

export type JobRow = typeof jobs.$inferSelect;
export type JobInsert = typeof jobs.$inferInsert;

/** Wave 4.1.x — tenant scoping opts. Undefined `tenantId` means "no filter"
 *  (matches today's behavior). Routes pass tenantOpts(req) only when the
 *  TENANT_ENFORCE flag is on AND the caller has a tenantId. */
export interface JobsTenantOpts {
  tenantId?: string;
}

export interface IJobRepository {
  findAll(opts?: JobsTenantOpts): JobRow[];
  findById(id: string): JobRow | undefined;
  findByKernel(kernelId: string, opts?: JobsTenantOpts): JobRow[];
  findByStatus(status: string, opts?: JobsTenantOpts): JobRow[];
  findByKernelAndStatus(kernelId: string, status: string, opts?: JobsTenantOpts): JobRow[];
  insert(job: JobInsert): JobRow | undefined;
  update(id: string, data: Partial<JobInsert>): JobRow | undefined;
  updateStatus(id: string, status: string, progress?: number): JobRow | undefined;
}
