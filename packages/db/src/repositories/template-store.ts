import { eq, like, and } from "drizzle-orm";
import {
  capabilityTemplateStore,
  machineProfileStore,
  verificationTemplates,
  queryTemplates,
  templateRatings,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { ITemplateStoreRepository } from "../interfaces/ITemplateStoreRepository.js";

export class TemplateStoreRepository implements ITemplateStoreRepository {
  constructor(private db: StoreDB) {}

  // ── Capability Templates ────────────────────────────────────────

  findAllCapabilityTemplates() {
    return this.db.select().from(capabilityTemplateStore).all();
  }

  findCapabilityTemplateById(id: string) {
    return this.db.select().from(capabilityTemplateStore).where(eq(capabilityTemplateStore.id, id)).get();
  }

  findCapabilityTemplatesByType(capabilityType: string) {
    return this.db.select().from(capabilityTemplateStore).where(eq(capabilityTemplateStore.capabilityType, capabilityType)).all();
  }

  findCapabilityTemplatesByStatus(status: string) {
    return this.db.select().from(capabilityTemplateStore).where(eq(capabilityTemplateStore.status, status)).all();
  }

  searchCapabilityTemplates(query: string) {
    return this.db.select().from(capabilityTemplateStore).where(like(capabilityTemplateStore.name, `%${query}%`)).all();
  }

  insertCapabilityTemplate(template: typeof capabilityTemplateStore.$inferInsert) {
    return this.db.insert(capabilityTemplateStore).values(template).returning().get();
  }

  updateCapabilityTemplate(id: string, data: Partial<typeof capabilityTemplateStore.$inferInsert>) {
    return this.db.update(capabilityTemplateStore).set(data).where(eq(capabilityTemplateStore.id, id)).returning().get();
  }

  // ── Machine Profiles ────────────────────────────────────────────

  findAllMachineProfiles() {
    return this.db.select().from(machineProfileStore).all();
  }

  findMachineProfileById(id: string) {
    return this.db.select().from(machineProfileStore).where(eq(machineProfileStore.id, id)).get();
  }

  findMachineProfilesByType(capabilityType: string) {
    return this.db.select().from(machineProfileStore).where(eq(machineProfileStore.capabilityType, capabilityType)).all();
  }

  insertMachineProfile(profile: typeof machineProfileStore.$inferInsert) {
    return this.db.insert(machineProfileStore).values(profile).returning().get();
  }

  updateMachineProfile(id: string, data: Partial<typeof machineProfileStore.$inferInsert>) {
    return this.db.update(machineProfileStore).set(data).where(eq(machineProfileStore.id, id)).returning().get();
  }

  // ── Verification Templates ──────────────────────────────────────

  findAllVerificationTemplates() {
    return this.db.select().from(verificationTemplates).all();
  }

  findVerificationTemplateById(id: string) {
    return this.db.select().from(verificationTemplates).where(eq(verificationTemplates.id, id)).get();
  }

  findVerificationTemplatesByType(capabilityType: string) {
    return this.db.select().from(verificationTemplates).where(eq(verificationTemplates.capabilityType, capabilityType)).all();
  }

  insertVerificationTemplate(template: typeof verificationTemplates.$inferInsert) {
    return this.db.insert(verificationTemplates).values(template).returning().get();
  }

  updateVerificationTemplate(id: string, data: Partial<typeof verificationTemplates.$inferInsert>) {
    return this.db.update(verificationTemplates).set(data).where(eq(verificationTemplates.id, id)).returning().get();
  }

  // ── Query Templates ─────────────────────────────────────────────

  findAllQueryTemplates() {
    return this.db.select().from(queryTemplates).all();
  }

  findQueryTemplateById(id: string) {
    return this.db.select().from(queryTemplates).where(eq(queryTemplates.id, id)).get();
  }

  findQueryTemplatesByIntent(intent: string) {
    return this.db.select().from(queryTemplates).where(eq(queryTemplates.intent, intent)).all();
  }

  searchQueryTemplates(query: string) {
    return this.db.select().from(queryTemplates).where(like(queryTemplates.name, `%${query}%`)).all();
  }

  insertQueryTemplate(template: typeof queryTemplates.$inferInsert) {
    return this.db.insert(queryTemplates).values(template).returning().get();
  }

  updateQueryTemplate(id: string, data: Partial<typeof queryTemplates.$inferInsert>) {
    return this.db.update(queryTemplates).set(data).where(eq(queryTemplates.id, id)).returning().get();
  }

  // ── Template Ratings ────────────────────────────────────────────

  findRatingsByTemplate(templateId: string, templateType: string) {
    return this.db
      .select()
      .from(templateRatings)
      .where(and(eq(templateRatings.templateId, templateId), eq(templateRatings.templateType, templateType)))
      .all();
  }

  insertRating(rating: typeof templateRatings.$inferInsert) {
    return this.db.insert(templateRatings).values(rating).returning().get();
  }
}
