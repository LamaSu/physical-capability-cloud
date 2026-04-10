import type { automationStatuses, transferAgents } from "../schema/index.js";

export type AutomationStatusRow = typeof automationStatuses.$inferSelect;
export type AutomationStatusInsert = typeof automationStatuses.$inferInsert;
export type TransferAgentRow = typeof transferAgents.$inferSelect;
export type TransferAgentInsert = typeof transferAgents.$inferInsert;

export interface IAutomationStatusRepository {
  findAll(): AutomationStatusRow[];
  findByKernel(kernelId: string): AutomationStatusRow[];
  findByTransferPair(fromNodeId: string, toNodeId: string): AutomationStatusRow | undefined;
  insert(status: AutomationStatusInsert): AutomationStatusRow | undefined;
  update(id: string, data: Partial<AutomationStatusInsert>): AutomationStatusRow | undefined;
  recordEpisode(id: string): AutomationStatusRow | undefined;
  // Transfer Agents sub-domain
  findAllAgents(): TransferAgentRow[];
  findAgentById(id: string): TransferAgentRow | undefined;
  insertAgent(agent: TransferAgentInsert): TransferAgentRow | undefined;
}
