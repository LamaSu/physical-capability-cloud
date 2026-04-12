import type {
  capabilityTemplateStore,
  machineProfileStore,
  verificationTemplates,
  queryTemplates,
  templateRatings,
} from "../schema/index.js";

export type CapabilityTemplateStoreRow = typeof capabilityTemplateStore.$inferSelect;
export type CapabilityTemplateStoreInsert = typeof capabilityTemplateStore.$inferInsert;
export type MachineProfileStoreRow = typeof machineProfileStore.$inferSelect;
export type MachineProfileStoreInsert = typeof machineProfileStore.$inferInsert;
export type VerificationTemplateRow = typeof verificationTemplates.$inferSelect;
export type VerificationTemplateInsert = typeof verificationTemplates.$inferInsert;
export type QueryTemplateRow = typeof queryTemplates.$inferSelect;
export type QueryTemplateInsert = typeof queryTemplates.$inferInsert;
export type TemplateRatingRow = typeof templateRatings.$inferSelect;
export type TemplateRatingInsert = typeof templateRatings.$inferInsert;

export interface ITemplateStoreRepository {
  // Capability templates
  findAllCapabilityTemplates(): CapabilityTemplateStoreRow[];
  findCapabilityTemplateById(id: string): CapabilityTemplateStoreRow | undefined;
  findCapabilityTemplatesByType(capabilityType: string): CapabilityTemplateStoreRow[];
  findCapabilityTemplatesByStatus(status: string): CapabilityTemplateStoreRow[];
  searchCapabilityTemplates(query: string): CapabilityTemplateStoreRow[];
  insertCapabilityTemplate(template: CapabilityTemplateStoreInsert): CapabilityTemplateStoreRow | undefined;
  updateCapabilityTemplate(id: string, data: Partial<CapabilityTemplateStoreInsert>): CapabilityTemplateStoreRow | undefined;
  // Machine profiles
  findAllMachineProfiles(): MachineProfileStoreRow[];
  findMachineProfileById(id: string): MachineProfileStoreRow | undefined;
  findMachineProfilesByType(capabilityType: string): MachineProfileStoreRow[];
  insertMachineProfile(profile: MachineProfileStoreInsert): MachineProfileStoreRow | undefined;
  updateMachineProfile(id: string, data: Partial<MachineProfileStoreInsert>): MachineProfileStoreRow | undefined;
  // Verification templates
  findAllVerificationTemplates(): VerificationTemplateRow[];
  findVerificationTemplateById(id: string): VerificationTemplateRow | undefined;
  findVerificationTemplatesByType(capabilityType: string): VerificationTemplateRow[];
  insertVerificationTemplate(template: VerificationTemplateInsert): VerificationTemplateRow | undefined;
  updateVerificationTemplate(id: string, data: Partial<VerificationTemplateInsert>): VerificationTemplateRow | undefined;
  // Query templates
  findAllQueryTemplates(): QueryTemplateRow[];
  findQueryTemplateById(id: string): QueryTemplateRow | undefined;
  findQueryTemplatesByIntent(intent: string): QueryTemplateRow[];
  searchQueryTemplates(query: string): QueryTemplateRow[];
  insertQueryTemplate(template: QueryTemplateInsert): QueryTemplateRow | undefined;
  updateQueryTemplate(id: string, data: Partial<QueryTemplateInsert>): QueryTemplateRow | undefined;
  // Template ratings
  findRatingsByTemplate(templateId: string, templateType: string): TemplateRatingRow[];
  insertRating(rating: TemplateRatingInsert): TemplateRatingRow | undefined;
}
