import type {
  protocolRuns,
  protocolRunSteps,
  protocolRunTransfers,
  protocolEvents,
} from "../schema/index.js";

export type ProtocolRunRow = typeof protocolRuns.$inferSelect;
export type ProtocolRunInsert = typeof protocolRuns.$inferInsert;
export type ProtocolRunStepRow = typeof protocolRunSteps.$inferSelect;
export type ProtocolRunStepInsert = typeof protocolRunSteps.$inferInsert;
export type ProtocolRunTransferRow = typeof protocolRunTransfers.$inferSelect;
export type ProtocolRunTransferInsert = typeof protocolRunTransfers.$inferInsert;
export type ProtocolEventRow = typeof protocolEvents.$inferSelect;
export type ProtocolEventInsert = typeof protocolEvents.$inferInsert;

export interface IProtocolRunRepository {
  findAll(): ProtocolRunRow[];
  findById(id: string): ProtocolRunRow | undefined;
  findByTemplate(templateId: string): ProtocolRunRow[];
  findByKernel(kernelId: string): ProtocolRunRow[];
  findByStatus(status: string): ProtocolRunRow[];
  insert(run: ProtocolRunInsert): ProtocolRunRow | undefined;
  updateStatus(id: string, status: string): ProtocolRunRow | undefined;
  // Run Steps sub-domain
  findRunSteps(runId: string): ProtocolRunStepRow[];
  insertRunStep(step: ProtocolRunStepInsert): ProtocolRunStepRow | undefined;
  insertRunSteps(steps: ProtocolRunStepInsert[]): ProtocolRunStepRow[];
  // Run Transfers sub-domain
  findRunTransfers(runId: string): ProtocolRunTransferRow[];
  insertRunTransfer(transfer: ProtocolRunTransferInsert): ProtocolRunTransferRow | undefined;
  insertRunTransfers(transfers: ProtocolRunTransferInsert[]): ProtocolRunTransferRow[];
  // Events sub-domain
  findEventsByRun(runId: string): ProtocolEventRow[];
  insertEvent(event: ProtocolEventInsert): ProtocolEventRow | undefined;
}
