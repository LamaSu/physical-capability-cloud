import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/** Equipment class for market categorization */
export const equipmentClasses = sqliteTable("equipment_classes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(), // EquipmentCategory
  subcategory: text("subcategory"),
  description: text("description").notNull(),
  commonMaterials: text("common_materials", { mode: "json" }).notNull().$type<string[]>(),
  typicalTolerances: text("typical_tolerances", { mode: "json" }).notNull().$type<string[]>(),
  typicalPriceRange: text("typical_price_range", { mode: "json" }).notNull().$type<{
    min: string;
    max: string;
    currency: string;
  }>(),
  spaceRequirementsRange: text("space_requirements_range", { mode: "json" }).notNull().$type<{
    minFootprint: { width: number; depth: number; unit: string };
    maxFootprint: { width: number; depth: number; unit: string };
  }>(),
});

/** Hosting space listing */
export const hostingSpaces = sqliteTable("hosting_spaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  operatorAddress: text("operator_address").notNull(),
  location: text("location", { mode: "json" }).notNull().$type<{ lat: number; lng: number }>(),
  address: text("address").notNull(),
  dimensions: text("dimensions", { mode: "json" }).notNull().$type<{
    width: number;
    depth: number;
    height: number;
    unit: string;
  }>(),
  power: text("power", { mode: "json" }).notNull().$type<{
    voltage: number;
    amperage: number;
    phase: number;
    circuitCount: number;
  }>(),
  amenities: text("amenities", { mode: "json" }).notNull().$type<string[]>(),
  environmentalSystems: text("environmental_systems", { mode: "json" }).notNull().$type<string[]>(),
  safetyFeatures: text("safety_features", { mode: "json" }).notNull().$type<string[]>(),
  access: text("access", { mode: "json" }).notNull().$type<{
    schedule: string;
    loadingDock: boolean;
    forklift: boolean;
  }>(),
  monthlyPrice: text("monthly_price").notNull(),
  currency: text("currency").notNull(),
  availableSlots: integer("available_slots").notNull(),
  totalSlots: integer("total_slots").notNull(),
  rating: real("rating").notNull().default(0),
  currentMachines: text("current_machines", { mode: "json" }).$type<string[]>(),
});

/** Maintenance event for a machine */
export const maintenanceEvents = sqliteTable("maintenance_events", {
  id: text("id").primaryKey(),
  machineId: text("machine_id").notNull(),
  type: text("type").notNull(), // "scheduled" | "unscheduled" | "inspection"
  description: text("description").notNull(),
  scheduledAt: text("scheduled_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(), // "upcoming" | "in-progress" | "completed"
});
