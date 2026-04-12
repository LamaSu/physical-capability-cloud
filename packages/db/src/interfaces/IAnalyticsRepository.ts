import type {
  analyticsEvents,
  materializedViews,
  complianceTemplates,
  complianceProfiles,
} from "../schema/index.js";

export type AnalyticsEventRow = typeof analyticsEvents.$inferSelect;
export type AnalyticsEventInsert = typeof analyticsEvents.$inferInsert;
export type MaterializedViewRow = typeof materializedViews.$inferSelect;
export type MaterializedViewInsert = typeof materializedViews.$inferInsert;
export type ComplianceTemplateRow = typeof complianceTemplates.$inferSelect;
export type ComplianceTemplateInsert = typeof complianceTemplates.$inferInsert;
export type ComplianceProfileRow = typeof complianceProfiles.$inferSelect;
export type ComplianceProfileInsert = typeof complianceProfiles.$inferInsert;

export interface IAnalyticsRepository {
  // Analytics events
  findAllEvents(): AnalyticsEventRow[];
  findEventById(id: string): AnalyticsEventRow | undefined;
  findEventsByActor(actorId: string): AnalyticsEventRow[];
  findEventsByResource(resourceType: string, resourceId: string): AnalyticsEventRow[];
  findEventsByType(eventType: string): AnalyticsEventRow[];
  insertEvent(event: AnalyticsEventInsert): AnalyticsEventRow | undefined;
  // Materialized views
  findAllMaterializedViews(): MaterializedViewRow[];
  findMaterializedViewById(id: string): MaterializedViewRow | undefined;
  findMaterializedViewByScope(viewType: string, scopeKey: string): MaterializedViewRow | undefined;
  upsertMaterializedView(view: MaterializedViewInsert): MaterializedViewRow | undefined;
  // Compliance templates
  findAllComplianceTemplates(): ComplianceTemplateRow[];
  findComplianceTemplateById(id: string): ComplianceTemplateRow | undefined;
  findComplianceTemplatesByStatus(status: string): ComplianceTemplateRow[];
  searchComplianceTemplates(query: string): ComplianceTemplateRow[];
  insertComplianceTemplate(template: ComplianceTemplateInsert): ComplianceTemplateRow | undefined;
  updateComplianceTemplate(id: string, data: Partial<ComplianceTemplateInsert>): ComplianceTemplateRow | undefined;
  // Compliance profiles
  findAllComplianceProfiles(): ComplianceProfileRow[];
  findComplianceProfileById(id: string): ComplianceProfileRow | undefined;
  findComplianceProfilesByKernel(kernelId: string): ComplianceProfileRow[];
  insertComplianceProfile(profile: ComplianceProfileInsert): ComplianceProfileRow | undefined;
  updateComplianceProfile(id: string, data: Partial<ComplianceProfileInsert>): ComplianceProfileRow | undefined;
}
