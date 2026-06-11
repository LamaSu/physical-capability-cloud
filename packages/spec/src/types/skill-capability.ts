/**
 * Human-node skill capabilities — makes humans first-class capability
 * providers in the PCC value chain, alongside machine capabilities.
 *
 * A `SkillCapability` is the human analog of a machine `CapabilityDTO`: a
 * billable unit of what a person can DO (hvac-repair, plumbing, lab-tech,
 * delivery-courier, translation, data-entry). A `SkillJob` is the escrow-
 * backed unit of work a poster hires that skill for, with a status lifecycle
 * mirroring the machine-job state machine.
 *
 * Proof of completion rides the existing capture flow's shape
 * (`CompletionProof.photoBase64` + `webauthnSignature`); payout rides the
 * existing fiat-ramp endpoints (Wise / Yellowcard). Escrow integration is a
 * follow-on PR — for now jobs carry an optional `escrowId` slot.
 *
 * Companion to the composition engine: a skill is just another node a
 * workflow can compose, completing the "everyone is a frictionless node"
 * piece of the grand vision.
 */

import { z } from "zod";
import type { Id, Timestamp } from "./common.js";

// ── Core entities ─────────────────────────────────────────────────────

export interface SkillCapability {
  id: Id;
  humanDid: Id;
  name: string;
  description: string;
  skillType: string; // e.g. "hvac-repair", "plumbing", "lab-tech", "delivery-courier", "translation", "data-entry"
  certifications: string[]; // ["NATE-certified", "EPA-608", "OSHA-30"]
  hourlyRateUSD: number;
  location: { lat: number; lng: number };
  serviceRadiusKm: number; // default 50 on registration
  weeklyAvailableHours: number;
  reputation: number; // 0-1000, starts at 0
  completedJobs: number; // starts at 0
  active: boolean; // starts true
  registeredAt: Timestamp;
  updatedAt: Timestamp;
}

export type SkillJobStatus =
  | "pending_acceptance"
  | "accepted"
  | "in_progress"
  | "completed"
  | "disputed"
  | "cancelled";

export interface SkillJob {
  jobId: Id;
  skillId: Id;
  posterDid: Id;
  description: string;
  budgetUSD: number;
  expectedDurationHours: number;
  location: { lat: number; lng: number };
  status: SkillJobStatus;
  escrowId?: Id;
  acceptedAt?: Timestamp;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  proofBundleId?: Id;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CompletionProof {
  photoBase64?: string;
  webauthnSignature?: string;
  notes?: string;
}

// ── Request shapes ────────────────────────────────────────────────────

export interface SkillRegistrationRequest {
  humanDid: Id;
  name: string;
  description: string;
  skillType: string;
  certifications?: string[];
  hourlyRateUSD: number;
  location: { lat: number; lng: number };
  serviceRadiusKm?: number;
  weeklyAvailableHours: number;
}

export interface SkillUpdateRequest {
  humanDid: Id; // must match the skill's humanDid (auth gate)
  description?: string;
  hourlyRateUSD?: number;
  serviceRadiusKm?: number;
  weeklyAvailableHours?: number;
  active?: boolean;
}

export interface SkillHireRequest {
  posterDid: Id;
  description: string;
  budgetUSD: number;
  expectedDurationHours: number;
  location: { lat: number; lng: number };
  minReputation?: number;
}

export interface SkillJobAcceptRequest {
  humanDid: Id; // must match the skill's humanDid
}

// ── Zod schemas (runtime validation for route handlers) ───────────────

/** A `{ lat, lng }` geographic point. Shared by registration + hire. */
const LocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

export const SkillRegistrationSchema = z.object({
  humanDid: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  skillType: z.string().min(1),
  certifications: z.array(z.string()).optional(),
  hourlyRateUSD: z.number().positive(),
  location: LocationSchema,
  serviceRadiusKm: z.number().positive().optional(),
  weeklyAvailableHours: z.number().nonnegative(),
});

export const SkillUpdateSchema = z.object({
  humanDid: z.string().min(1),
  description: z.string().min(1).optional(),
  hourlyRateUSD: z.number().positive().optional(),
  serviceRadiusKm: z.number().positive().optional(),
  weeklyAvailableHours: z.number().nonnegative().optional(),
  active: z.boolean().optional(),
});

export const SkillHireSchema = z.object({
  posterDid: z.string().min(1),
  description: z.string().min(1),
  budgetUSD: z.number().positive(),
  expectedDurationHours: z.number().positive(),
  location: LocationSchema,
  minReputation: z.number().min(0).max(1000).optional(),
});

export const SkillJobAcceptSchema = z.object({
  humanDid: z.string().min(1),
});

export const CompletionProofSchema = z.object({
  photoBase64: z.string().optional(),
  webauthnSignature: z.string().optional(),
  notes: z.string().optional(),
});
