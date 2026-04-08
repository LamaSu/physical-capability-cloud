import type {
  protocolTemplates,
  protocolSteps,
  protocolTransfers,
  protocolForks,
} from "../schema/index.js";

export type TemplateRow = typeof protocolTemplates.$inferSelect;
export type TemplateInsert = typeof protocolTemplates.$inferInsert;
export type StepRow = typeof protocolSteps.$inferSelect;
export type StepInsert = typeof protocolSteps.$inferInsert;
export type TransferRow = typeof protocolTransfers.$inferSelect;
export type TransferInsert = typeof protocolTransfers.$inferInsert;
export type ForkRow = typeof protocolForks.$inferSelect;
export type ForkInsert = typeof protocolForks.$inferInsert;

export interface IProtocolTemplateRepository {
  findAll(): TemplateRow[];
  findById(id: string): TemplateRow | undefined;
  findByStatus(status: string): TemplateRow[];
  search(query: string): TemplateRow[];
  insert(template: TemplateInsert): TemplateRow | undefined;
  update(id: string, data: Partial<TemplateInsert>): TemplateRow | undefined;
  publish(id: string): TemplateRow | undefined;
  // Steps sub-domain
  findStepsByTemplate(templateId: string): StepRow[];
  insertStep(step: StepInsert): StepRow | undefined;
  insertSteps(steps: StepInsert[]): StepRow[];
  // Transfers sub-domain
  findTransfersByTemplate(templateId: string): TransferRow[];
  insertTransfer(transfer: TransferInsert): TransferRow | undefined;
  insertTransfers(transfers: TransferInsert[]): TransferRow[];
  // Forks sub-domain
  findForksByTemplate(templateId: string): ForkRow[];
  insertFork(fork: ForkInsert): ForkRow | undefined;
}
