import { eq, inArray } from "drizzle-orm";
import { escrows, escrowMilestones, disputes } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IEscrowRepository } from "../interfaces/IEscrowRepository.js";
import { inChunks } from "./batch.js";

export class EscrowRepository implements IEscrowRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(escrows).all();
  }

  findById(id: string) {
    return this.db.select().from(escrows).where(eq(escrows.id, id)).get();
  }

  findByCwm(cwmId: string) {
    return this.db.select().from(escrows).where(eq(escrows.cwmId, cwmId)).get();
  }

  findByStatus(status: string) {
    return this.db.select().from(escrows).where(eq(escrows.status, status)).all();
  }

  insert(escrow: typeof escrows.$inferInsert) {
    return this.db.insert(escrows).values(escrow).returning().get();
  }

  updateStatus(id: string, status: string) {
    return this.db.update(escrows).set({ status }).where(eq(escrows.id, id)).returning().get();
  }

  // ── Milestones ──────────────────────────────────────────────────

  findMilestonesByEscrow(escrowId: string) {
    return this.db.select().from(escrowMilestones).where(eq(escrowMilestones.escrowId, escrowId)).all();
  }

  findMilestonesByEscrowIds(escrowIds: string[]) {
    return inChunks(escrowIds, (chunk) =>
      this.db.select().from(escrowMilestones).where(inArray(escrowMilestones.escrowId, chunk)).all(),
    );
  }

  insertMilestone(milestone: typeof escrowMilestones.$inferInsert) {
    return this.db.insert(escrowMilestones).values(milestone).returning().get();
  }

  updateMilestoneStatus(id: string, status: string) {
    return this.db.update(escrowMilestones).set({ status }).where(eq(escrowMilestones.id, id)).returning().get();
  }

  // ── Disputes ────────────────────────────────────────────────────

  findDisputesByEscrow(escrowId: string) {
    return this.db.select().from(disputes).where(eq(disputes.escrowId, escrowId)).all();
  }

  insertDispute(dispute: typeof disputes.$inferInsert) {
    return this.db.insert(disputes).values(dispute).returning().get();
  }

  updateDisputeStatus(id: string, status: string) {
    return this.db.update(disputes).set({ status }).where(eq(disputes.id, id)).returning().get();
  }
}
