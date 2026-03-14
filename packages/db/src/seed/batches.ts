import type { StoreDB } from "../connection.js";
import {
  batchManifests,
  sampleSlots,
  batchEvents,
} from "../schema/index.js";

/**
 * Seeds batch data: manifests, sample slots, and batch events.
 * Uses the biolab HPLC device/capability for an HPLC batch run.
 */
export function seedBatches(db: StoreDB): void {
  // ── Batch Manifests ───────────────────────────────────────────────

  db.insert(batchManifests)
    .values({
      id: "batch_hplc_001",
      kernelId: "kernel-biolab-01",
      deviceId: "dev-hplc",
      capabilityId: "cap-bio-hplc",
      status: "completed",
      sealedAt: "2026-03-10T08:25:00Z",
      startedAt: "2026-03-10T08:30:00Z",
      completedAt: "2026-03-10T09:45:00Z",
      runConfig: {
        column: "C18_reverse_phase",
        mobile_phase_a: "water_0.1pct_tfa",
        mobile_phase_b: "acetonitrile_0.1pct_tfa",
        flow_rate_ml_min: 1.0,
        gradient_duration_min: 30,
        detection_wavelength_nm: 280,
        column_temperature_c: 25,
        injection_volume_ul: 10,
      },
      methodId: "method_rp_hplc_v2",
    })
    .run();

  // ── Sample Slots ──────────────────────────────────────────────────

  db.insert(sampleSlots)
    .values([
      {
        id: "slot_001",
        batchId: "batch_hplc_001",
        position: "A1",
        jobId: "job-bio-42",
        stepId: "step-bio-1",
        userId: "user_dr_chen",
        sampleLabel: "Serum-2026-A",
        sampleType: "unknown",
        status: "completed",
        acquisitionStart: "2026-03-10T08:30:00Z",
        acquisitionEnd: "2026-03-10T08:48:00Z",
        resultHash: "sha256:c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
        resultRef: "ipfs://QmSerum2026A_chromatogram",
      },
      {
        id: "slot_002",
        batchId: "batch_hplc_001",
        position: "A2",
        jobId: "job-bio-42",
        stepId: "step-bio-1",
        userId: "user_dr_chen",
        sampleLabel: "Serum-2026-B",
        sampleType: "unknown",
        status: "completed",
        acquisitionStart: "2026-03-10T08:50:00Z",
        acquisitionEnd: "2026-03-10T09:08:00Z",
        resultHash: "sha256:d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
        resultRef: "ipfs://QmSerum2026B_chromatogram",
      },
      {
        id: "slot_003",
        batchId: "batch_hplc_001",
        position: "A3",
        jobId: "job-bio-42",
        stepId: "step-bio-1",
        userId: "user_lab_tech_j",
        sampleLabel: "Blank-Control",
        sampleType: "blank",
        status: "completed",
        acquisitionStart: "2026-03-10T09:10:00Z",
        acquisitionEnd: "2026-03-10T09:28:00Z",
        resultHash: "sha256:e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6",
        resultRef: "ipfs://QmBlankControl_chromatogram",
      },
      {
        id: "slot_004",
        batchId: "batch_hplc_001",
        position: "A4",
        jobId: "job-bio-42",
        stepId: "step-bio-1",
        userId: "user_lab_tech_j",
        sampleLabel: "BSA-Standard-1mg",
        sampleType: "standard",
        status: "completed",
        acquisitionStart: "2026-03-10T09:30:00Z",
        acquisitionEnd: "2026-03-10T09:45:00Z",
        resultHash: "sha256:f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1",
        resultRef: "ipfs://QmBSAStandard_chromatogram",
      },
    ])
    .run();

  // ── Batch Events ──────────────────────────────────────────────────

  db.insert(batchEvents)
    .values([
      {
        id: "bevt_001",
        batchId: "batch_hplc_001",
        timestamp: "2026-03-10T08:25:00Z",
        type: "batch_sealed",
        payload: { slotCount: 4, methodId: "method_rp_hplc_v2" },
      },
      {
        id: "bevt_002",
        batchId: "batch_hplc_001",
        timestamp: "2026-03-10T08:30:00Z",
        type: "batch_started",
        slotId: "slot_001",
        payload: { message: "HPLC run started with slot A1" },
      },
      {
        id: "bevt_003",
        batchId: "batch_hplc_001",
        timestamp: "2026-03-10T08:48:00Z",
        type: "slot_completed",
        slotId: "slot_001",
        payload: {
          peakCount: 5,
          mainPeakRetentionMin: 12.4,
          baselineStable: true,
        },
      },
      {
        id: "bevt_004",
        batchId: "batch_hplc_001",
        timestamp: "2026-03-10T09:45:00Z",
        type: "batch_completed",
        payload: {
          totalSlotsProcessed: 4,
          passedQC: 4,
          failedQC: 0,
          totalRunTimeMin: 75,
        },
      },
    ])
    .run();
}
