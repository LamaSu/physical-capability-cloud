import type { escrows, escrowMilestones, disputes } from "../schema/index.js";

export type EscrowRow = typeof escrows.$inferSelect;
export type EscrowInsert = typeof escrows.$inferInsert;
export type MilestoneRow = typeof escrowMilestones.$inferSelect;
export type MilestoneInsert = typeof escrowMilestones.$inferInsert;
export type DisputeRow = typeof disputes.$inferSelect;
export type DisputeInsert = typeof disputes.$inferInsert;

export interface IEscrowRepository {
  findAll(): EscrowRow[];
  findById(id: string): EscrowRow | undefined;
  findByCwm(cwmId: string): EscrowRow | undefined;
  findByContractAddress(contractAddress: string): EscrowRow | undefined;
  findByStatus(status: string): EscrowRow[];
  insert(escrow: EscrowInsert): EscrowRow | undefined;
  updateStatus(id: string, status: string): EscrowRow | undefined;
  // Milestones sub-domain
  findMilestonesByEscrow(escrowId: string): MilestoneRow[];
  insertMilestone(milestone: MilestoneInsert): MilestoneRow | undefined;
  updateMilestoneStatus(id: string, status: string): MilestoneRow | undefined;
  // Disputes sub-domain
  findDisputesByEscrow(escrowId: string): DisputeRow[];
  insertDispute(dispute: DisputeInsert): DisputeRow | undefined;
  updateDisputeStatus(id: string, status: string): DisputeRow | undefined;
}
