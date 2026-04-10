import { eq, like, and } from "drizzle-orm";
import {
  protocolTemplates,
  protocolSteps,
  protocolTransfers,
  protocolForks,
  protocolRuns,
  protocolRunSteps,
  protocolRunTransfers,
  automationStatuses,
  transferAgents,
  protocolEvents,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IProtocolTemplateRepository } from "../interfaces/IProtocolTemplateRepository.js";
import type { IProtocolRunRepository } from "../interfaces/IProtocolRunRepository.js";
import type { IAutomationStatusRepository } from "../interfaces/IAutomationStatusRepository.js";

export class ProtocolTemplateRepository implements IProtocolTemplateRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(protocolTemplates).all();
  }

  findById(id: string) {
    return this.db.select().from(protocolTemplates).where(eq(protocolTemplates.id, id)).get();
  }

  findByStatus(status: string) {
    return this.db.select().from(protocolTemplates).where(eq(protocolTemplates.status, status)).all();
  }

  search(query: string) {
    return this.db.select().from(protocolTemplates).where(like(protocolTemplates.name, `%${query}%`)).all();
  }

  insert(template: typeof protocolTemplates.$inferInsert) {
    return this.db.insert(protocolTemplates).values(template).returning().get();
  }

  update(id: string, data: Partial<typeof protocolTemplates.$inferInsert>) {
    return this.db.update(protocolTemplates).set(data).where(eq(protocolTemplates.id, id)).returning().get();
  }

  publish(id: string) {
    return this.db
      .update(protocolTemplates)
      .set({ status: "published", updatedAt: new Date().toISOString() })
      .where(eq(protocolTemplates.id, id))
      .returning()
      .get();
  }

  // ── Steps ───────────────────────────────────────────────────────

  findStepsByTemplate(templateId: string) {
    return this.db.select().from(protocolSteps).where(eq(protocolSteps.templateId, templateId)).all();
  }

  insertStep(step: typeof protocolSteps.$inferInsert) {
    return this.db.insert(protocolSteps).values(step).returning().get();
  }

  insertSteps(steps: (typeof protocolSteps.$inferInsert)[]) {
    if (steps.length === 0) return [];
    return this.db.insert(protocolSteps).values(steps).returning().all();
  }

  // ── Transfers ───────────────────────────────────────────────────

  findTransfersByTemplate(templateId: string) {
    return this.db.select().from(protocolTransfers).where(eq(protocolTransfers.templateId, templateId)).all();
  }

  insertTransfer(transfer: typeof protocolTransfers.$inferInsert) {
    return this.db.insert(protocolTransfers).values(transfer).returning().get();
  }

  insertTransfers(transfers: (typeof protocolTransfers.$inferInsert)[]) {
    if (transfers.length === 0) return [];
    return this.db.insert(protocolTransfers).values(transfers).returning().all();
  }

  // ── Forks ───────────────────────────────────────────────────────

  findForksByTemplate(templateId: string) {
    return this.db.select().from(protocolForks).where(eq(protocolForks.sourceTemplateId, templateId)).all();
  }

  insertFork(fork: typeof protocolForks.$inferInsert) {
    // Increment fork count on source template
    const template = this.findById(fork.sourceTemplateId);
    if (template) {
      this.update(fork.sourceTemplateId, { forkCount: template.forkCount + 1 });
    }
    return this.db.insert(protocolForks).values(fork).returning().get();
  }
}

export class ProtocolRunRepository implements IProtocolRunRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(protocolRuns).all();
  }

  findById(id: string) {
    return this.db.select().from(protocolRuns).where(eq(protocolRuns.id, id)).get();
  }

  findByTemplate(templateId: string) {
    return this.db.select().from(protocolRuns).where(eq(protocolRuns.templateId, templateId)).all();
  }

  findByKernel(kernelId: string) {
    return this.db.select().from(protocolRuns).where(eq(protocolRuns.kernelId, kernelId)).all();
  }

  findByStatus(status: string) {
    return this.db.select().from(protocolRuns).where(eq(protocolRuns.status, status)).all();
  }

  insert(run: typeof protocolRuns.$inferInsert) {
    return this.db.insert(protocolRuns).values(run).returning().get();
  }

  updateStatus(id: string, status: string) {
    const data: Partial<typeof protocolRuns.$inferInsert> = { status };
    if (status === "running") data.startedAt = new Date().toISOString();
    if (status === "completed") data.completedAt = new Date().toISOString();
    return this.db.update(protocolRuns).set(data).where(eq(protocolRuns.id, id)).returning().get();
  }

  // ── Run Steps ───────────────────────────────────────────────────

  findRunSteps(runId: string) {
    return this.db.select().from(protocolRunSteps).where(eq(protocolRunSteps.runId, runId)).all();
  }

  insertRunStep(step: typeof protocolRunSteps.$inferInsert) {
    return this.db.insert(protocolRunSteps).values(step).returning().get();
  }

  insertRunSteps(steps: (typeof protocolRunSteps.$inferInsert)[]) {
    if (steps.length === 0) return [];
    return this.db.insert(protocolRunSteps).values(steps).returning().all();
  }

  // ── Run Transfers ──────────────────────────────────────────────

  findRunTransfers(runId: string) {
    return this.db.select().from(protocolRunTransfers).where(eq(protocolRunTransfers.runId, runId)).all();
  }

  insertRunTransfer(transfer: typeof protocolRunTransfers.$inferInsert) {
    return this.db.insert(protocolRunTransfers).values(transfer).returning().get();
  }

  insertRunTransfers(transfers: (typeof protocolRunTransfers.$inferInsert)[]) {
    if (transfers.length === 0) return [];
    return this.db.insert(protocolRunTransfers).values(transfers).returning().all();
  }

  // ── Events ──────────────────────────────────────────────────────

  findEventsByRun(runId: string) {
    return this.db.select().from(protocolEvents).where(eq(protocolEvents.runId, runId)).all();
  }

  insertEvent(event: typeof protocolEvents.$inferInsert) {
    return this.db.insert(protocolEvents).values(event).returning().get();
  }
}

export class AutomationStatusRepository implements IAutomationStatusRepository {
  constructor(private db: StoreDB) {}

  findAll() {
    return this.db.select().from(automationStatuses).all();
  }

  findByKernel(kernelId: string) {
    return this.db.select().from(automationStatuses).where(eq(automationStatuses.kernelId, kernelId)).all();
  }

  findByTransferPair(fromNodeId: string, toNodeId: string) {
    return this.db
      .select()
      .from(automationStatuses)
      .where(and(eq(automationStatuses.fromNodeId, fromNodeId), eq(automationStatuses.toNodeId, toNodeId)))
      .get();
  }

  insert(status: typeof automationStatuses.$inferInsert) {
    return this.db.insert(automationStatuses).values(status).returning().get();
  }

  update(id: string, data: Partial<typeof automationStatuses.$inferInsert>) {
    return this.db.update(automationStatuses).set(data).where(eq(automationStatuses.id, id)).returning().get();
  }

  recordEpisode(id: string) {
    const current = this.db.select().from(automationStatuses).where(eq(automationStatuses.id, id)).get();
    if (!current) return undefined;
    return this.db
      .update(automationStatuses)
      .set({
        episodeCount: current.episodeCount + 1,
        lastEpisodeAt: new Date().toISOString(),
      })
      .where(eq(automationStatuses.id, id))
      .returning()
      .get();
  }

  // ── Transfer Agents ─────────────────────────────────────────────

  findAllAgents() {
    return this.db.select().from(transferAgents).all();
  }

  findAgentById(id: string) {
    return this.db.select().from(transferAgents).where(eq(transferAgents.id, id)).get();
  }

  insertAgent(agent: typeof transferAgents.$inferInsert) {
    return this.db.insert(transferAgents).values(agent).returning().get();
  }
}
