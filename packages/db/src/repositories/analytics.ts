import { eq, like, and } from "drizzle-orm";
import { analyticsEvents, materializedViews, complianceTemplates, complianceProfiles } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { IAnalyticsRepository } from "../interfaces/IAnalyticsRepository.js";

export class AnalyticsRepository implements IAnalyticsRepository {
  constructor(private db: StoreDB) {}

  // ── Analytics Events ────────────────────────────────────────────

  findAllEvents() {
    return this.db.select().from(analyticsEvents).all();
  }

  findEventById(id: string) {
    return this.db.select().from(analyticsEvents).where(eq(analyticsEvents.id, id)).get();
  }

  findEventsByActor(actorId: string) {
    return this.db.select().from(analyticsEvents).where(eq(analyticsEvents.actorId, actorId)).all();
  }

  findEventsByResource(resourceType: string, resourceId: string) {
    return this.db
      .select()
      .from(analyticsEvents)
      .where(and(eq(analyticsEvents.resourceType, resourceType), eq(analyticsEvents.resourceId, resourceId)))
      .all();
  }

  findEventsByType(eventType: string) {
    return this.db.select().from(analyticsEvents).where(eq(analyticsEvents.eventType, eventType)).all();
  }

  insertEvent(event: typeof analyticsEvents.$inferInsert) {
    return this.db.insert(analyticsEvents).values(event).returning().get();
  }

  // ── Materialized Views ──────────────────────────────────────────

  findAllMaterializedViews() {
    return this.db.select().from(materializedViews).all();
  }

  findMaterializedViewById(id: string) {
    return this.db.select().from(materializedViews).where(eq(materializedViews.id, id)).get();
  }

  findMaterializedViewByScope(viewType: string, scopeKey: string) {
    return this.db
      .select()
      .from(materializedViews)
      .where(and(eq(materializedViews.viewType, viewType), eq(materializedViews.scopeKey, scopeKey)))
      .get();
  }

  upsertMaterializedView(view: typeof materializedViews.$inferInsert) {
    return this.db
      .insert(materializedViews)
      .values(view)
      .onConflictDoUpdate({ target: materializedViews.id, set: view })
      .returning()
      .get();
  }

  // ── Compliance Templates ────────────────────────────────────────

  findAllComplianceTemplates() {
    return this.db.select().from(complianceTemplates).all();
  }

  findComplianceTemplateById(id: string) {
    return this.db.select().from(complianceTemplates).where(eq(complianceTemplates.id, id)).get();
  }

  findComplianceTemplatesByStatus(status: string) {
    return this.db.select().from(complianceTemplates).where(eq(complianceTemplates.status, status)).all();
  }

  searchComplianceTemplates(query: string) {
    return this.db.select().from(complianceTemplates).where(like(complianceTemplates.name, `%${query}%`)).all();
  }

  insertComplianceTemplate(template: typeof complianceTemplates.$inferInsert) {
    return this.db.insert(complianceTemplates).values(template).returning().get();
  }

  updateComplianceTemplate(id: string, data: Partial<typeof complianceTemplates.$inferInsert>) {
    return this.db.update(complianceTemplates).set(data).where(eq(complianceTemplates.id, id)).returning().get();
  }

  // ── Compliance Profiles ─────────────────────────────────────────

  findAllComplianceProfiles() {
    return this.db.select().from(complianceProfiles).all();
  }

  findComplianceProfileById(id: string) {
    return this.db.select().from(complianceProfiles).where(eq(complianceProfiles.id, id)).get();
  }

  findComplianceProfilesByKernel(kernelId: string) {
    return this.db.select().from(complianceProfiles).where(eq(complianceProfiles.kernelId, kernelId)).all();
  }

  insertComplianceProfile(profile: typeof complianceProfiles.$inferInsert) {
    return this.db.insert(complianceProfiles).values(profile).returning().get();
  }

  updateComplianceProfile(id: string, data: Partial<typeof complianceProfiles.$inferInsert>) {
    return this.db.update(complianceProfiles).set(data).where(eq(complianceProfiles.id, id)).returning().get();
  }
}
