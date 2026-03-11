import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Machine registration submitted during onboarding */
export const machineRegistrations = sqliteTable("machine_registrations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(), // CapabilityType
  manufacturer: text("manufacturer").notNull(),
  model: text("model").notNull(),
  serialNumber: text("serial_number"),
  description: text("description"),
  photos: text("photos", { mode: "json" }).notNull().$type<string[]>(),
  capabilities: text("capabilities", { mode: "json" }).notNull().$type<Array<{
    id: string;
    type: string;
    name: string;
    description: string;
    materials: string[];
    tolerances?: Record<string, string>;
    envelope?: { x: number; y: number; z: number; unit: string };
    params: Record<string, unknown>[];
    source: string;
  }>>(),
  spaceRequirements: text("space_requirements", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  pricing: text("pricing", { mode: "json" }).notNull().$type<{
    baseCost: string;
    perMinute?: string;
    perGram?: string;
    perCm3?: string;
    minimum: string;
    currency: string;
  }>(),
  operator: text("operator", { mode: "json" }).notNull().$type<{
    walletAddress: string;
    displayName: string;
    certifications: Array<{
      id: string;
      name: string;
      issuer: string;
      issuedAt: string;
      expiresAt: string;
      documentHash?: string;
      status: string;
    }>;
    trainingAcknowledgments: Record<string, boolean>;
    insurance?: { provider: string; policyNumber: string; coverageAmount: string };
  }>(),
  status: text("status").notNull(), // "draft" | "submitted" | "reviewing" | "approved" | "active" | "suspended"
  createdAt: text("created_at").notNull(),
  submittedAt: text("submitted_at"),
  approvedAt: text("approved_at"),
});

/** Uploaded documentation for AI analysis */
export const onboardingDocuments = sqliteTable("onboarding_documents", {
  id: text("id").primaryKey(),
  machineRegistrationId: text("machine_registration_id").notNull().references(() => machineRegistrations.id),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: text("size_bytes").notNull(), // stored as text to avoid integer overflow for large files
  hash: text("hash").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
  analysisStatus: text("analysis_status").notNull(), // "pending" | "analyzing" | "complete" | "failed"
  analysisResult: text("analysis_result", { mode: "json" }).$type<{
    suggestedCapabilities: Array<{
      id: string;
      type: string;
      name: string;
      description: string;
      materials: string[];
      tolerances?: Record<string, string>;
      envelope?: { x: number; y: number; z: number; unit: string };
      suggestedParams: Record<string, unknown>[];
      confidence: number;
      sourceReason: string;
    }>;
    extractedSpecs: Record<string, string>;
    extractedMaterials: string[];
    extractedTolerances: Array<Record<string, string>>;
    confidence: number;
    sourceDocumentId: string;
  }>(),
});
