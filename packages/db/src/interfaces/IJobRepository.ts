import type { jobs } from "../schema/index.js";

export type JobRow = typeof jobs.$inferSelect;
export type JobInsert = typeof jobs.$inferInsert;

export interface IJobRepository {
  findAll(): JobRow[];
  findById(id: string): JobRow | undefined;
  findByKernel(kernelId: string): JobRow[];
  findByStatus(status: string): JobRow[];
  findByKernelAndStatus(kernelId: string, status: string): JobRow[];
  insert(job: JobInsert): JobRow | undefined;
  update(id: string, data: Partial<JobInsert>): JobRow | undefined;
  updateStatus(id: string, status: string, progress?: number): JobRow | undefined;
}
