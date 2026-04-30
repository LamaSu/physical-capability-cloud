import { and, desc, eq } from "drizzle-orm";
import {
  contributorProfiles,
  rateSchedules,
  trainingManifests,
  compositionManifests,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  IContributorRepository,
  ContributorProfileRecord,
  RateScheduleRecord,
  TrainingManifestRecord,
  CompositionManifestRecord,
} from "../interfaces/IContributorRepository.js";

/**
 * ContributorRepository — drizzle-backed implementation of
 * IContributorRepository.
 *
 * Conventions:
 *   - All upserts use ON CONFLICT semantics tied to the natural primary key.
 *   - Read methods normalise drizzle's `undefined` (no row found) to `null`
 *     so the contract matches the interface shape callers can program against.
 *   - Canonical-JSON columns are written/read verbatim — the repository does
 *     not parse them. Callers are expected to JSON.parse(record.segmentsJson)
 *     when they need the structured RateSegment[] form. This keeps the data
 *     layer agnostic to upstream schema validation (Zod) and avoids a hard
 *     dependency on @pcc/spec inside @pcc/store.
 */
export class ContributorRepository implements IContributorRepository {
  constructor(private db: StoreDB) {}

  // ── Profiles ───────────────────────────────────────────────────────────────

  upsertProfile(profile: ContributorProfileRecord): void {
    this.db
      .insert(contributorProfiles)
      .values(profile)
      .onConflictDoUpdate({
        target: contributorProfiles.id,
        set: {
          address: profile.address,
          role: profile.role,
          scheduleHash: profile.scheduleHash,
          ipId: profile.ipId,
          contributorNftTokenId: profile.contributorNftTokenId,
          metadataUri: profile.metadataUri,
          registeredAt: profile.registeredAt,
        },
      })
      .run();
  }

  getProfile(id: string): ContributorProfileRecord | null {
    const row = this.db
      .select()
      .from(contributorProfiles)
      .where(eq(contributorProfiles.id, id))
      .get();
    return row ? this.toProfileRecord(row) : null;
  }

  listProfilesByAddress(address: string): ContributorProfileRecord[] {
    return this.db
      .select()
      .from(contributorProfiles)
      .where(eq(contributorProfiles.address, address))
      .orderBy(desc(contributorProfiles.registeredAt))
      .all()
      .map((r) => this.toProfileRecord(r));
  }

  listProfilesByRole(role: string): ContributorProfileRecord[] {
    return this.db
      .select()
      .from(contributorProfiles)
      .where(eq(contributorProfiles.role, role))
      .orderBy(desc(contributorProfiles.registeredAt))
      .all()
      .map((r) => this.toProfileRecord(r));
  }

  // ── Rate schedules ─────────────────────────────────────────────────────────

  publishSchedule(record: RateScheduleRecord): void {
    // Schedules are sealed-immutable: ON CONFLICT DO NOTHING preserves the
    // first publication and silently no-ops on duplicates.
    this.db
      .insert(rateSchedules)
      .values(record)
      .onConflictDoNothing({ target: rateSchedules.scheduleHash })
      .run();
  }

  getSchedule(scheduleHash: string): RateScheduleRecord | null {
    const row = this.db
      .select()
      .from(rateSchedules)
      .where(eq(rateSchedules.scheduleHash, scheduleHash))
      .get();
    return row ? this.toScheduleRecord(row) : null;
  }

  scheduleExists(scheduleHash: string): boolean {
    const row = this.db
      .select({ scheduleHash: rateSchedules.scheduleHash })
      .from(rateSchedules)
      .where(eq(rateSchedules.scheduleHash, scheduleHash))
      .get();
    return Boolean(row);
  }

  listSchedulesByPublisher(address: string): RateScheduleRecord[] {
    return this.db
      .select()
      .from(rateSchedules)
      .where(eq(rateSchedules.publishedBy, address))
      .orderBy(desc(rateSchedules.publishedAt))
      .all()
      .map((r) => this.toScheduleRecord(r));
  }

  // ── Training manifests ────────────────────────────────────────────────────

  setTrainingManifest(record: TrainingManifestRecord): void {
    this.db
      .insert(trainingManifests)
      .values(record)
      .onConflictDoUpdate({
        target: trainingManifests.modelIpId,
        set: {
          baseModelIpId: record.baseModelIpId,
          datasetWeightsJson: record.datasetWeightsJson,
          methodologyHash: record.methodologyHash,
          manifestHash: record.manifestHash,
          createdAt: record.createdAt,
        },
      })
      .run();
  }

  getTrainingManifest(modelIpId: string): TrainingManifestRecord | null {
    const row = this.db
      .select()
      .from(trainingManifests)
      .where(eq(trainingManifests.modelIpId, modelIpId))
      .get();
    return row ? this.toTrainingManifestRecord(row) : null;
  }

  // ── Composition manifests ────────────────────────────────────────────────

  saveCompositionManifest(record: CompositionManifestRecord): string {
    this.db
      .insert(compositionManifests)
      .values(record)
      .onConflictDoUpdate({
        target: compositionManifests.id,
        set: {
          capabilityIpId: record.capabilityIpId,
          escrowAddress: record.escrowAddress,
          milestoneIndex: record.milestoneIndex,
          manifestJson: record.manifestJson,
          manifestHash: record.manifestHash,
          operatorResidualBps: record.operatorResidualBps,
          createdAt: record.createdAt,
        },
      })
      .run();
    return record.id;
  }

  getCompositionManifest(id: string): CompositionManifestRecord | null {
    const row = this.db
      .select()
      .from(compositionManifests)
      .where(eq(compositionManifests.id, id))
      .get();
    return row ? this.toCompositionManifestRecord(row) : null;
  }

  getByEscrowAndMilestone(
    escrowAddress: string,
    milestoneIndex: number,
  ): CompositionManifestRecord | null {
    const row = this.db
      .select()
      .from(compositionManifests)
      .where(
        and(
          eq(compositionManifests.escrowAddress, escrowAddress),
          eq(compositionManifests.milestoneIndex, milestoneIndex),
        ),
      )
      .orderBy(desc(compositionManifests.createdAt))
      .get();
    return row ? this.toCompositionManifestRecord(row) : null;
  }

  // ── Mappers (drizzle row → public record) ───────────────────────────────

  private toProfileRecord(
    row: typeof contributorProfiles.$inferSelect,
  ): ContributorProfileRecord {
    return {
      id: row.id,
      address: row.address,
      role: row.role,
      scheduleHash: row.scheduleHash,
      ipId: row.ipId ?? null,
      contributorNftTokenId: row.contributorNftTokenId ?? null,
      metadataUri: row.metadataUri ?? null,
      registeredAt: row.registeredAt,
    };
  }

  private toScheduleRecord(
    row: typeof rateSchedules.$inferSelect,
  ): RateScheduleRecord {
    return {
      scheduleHash: row.scheduleHash,
      version: row.version,
      segmentsJson: row.segmentsJson,
      notes: row.notes ?? null,
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt,
    };
  }

  private toTrainingManifestRecord(
    row: typeof trainingManifests.$inferSelect,
  ): TrainingManifestRecord {
    return {
      modelIpId: row.modelIpId,
      baseModelIpId: row.baseModelIpId ?? null,
      datasetWeightsJson: row.datasetWeightsJson,
      methodologyHash: row.methodologyHash ?? null,
      manifestHash: row.manifestHash,
      createdAt: row.createdAt,
    };
  }

  private toCompositionManifestRecord(
    row: typeof compositionManifests.$inferSelect,
  ): CompositionManifestRecord {
    return {
      id: row.id,
      capabilityIpId: row.capabilityIpId,
      escrowAddress: row.escrowAddress,
      milestoneIndex: row.milestoneIndex,
      manifestJson: row.manifestJson,
      manifestHash: row.manifestHash,
      operatorResidualBps: row.operatorResidualBps,
      createdAt: row.createdAt,
    };
  }
}
