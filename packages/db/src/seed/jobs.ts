import type { StoreDB } from "../connection.js";
import { jobs } from "../schema/index.js";

/**
 * Seeds jobs from gateway mock data.
 */
export function seedJobs(db: StoreDB): void {
  db.insert(jobs)
    .values([
      {
        id: "job-001",
        stepId: "step-1",
        cwmId: "cwm-001",
        capabilityId: "cap-nyc-fdm",
        kernelId: "kernel-nyc",
        status: "executing",
        assignedDevices: ["dev-fdm-prusa-mk4", "dev-cam-nyc-1"],
        startedAt: "2026-03-10T08:00:00Z",
        progress: 67,
      },
      {
        id: "job-002",
        stepId: "step-2",
        cwmId: "cwm-002",
        capabilityId: "cap-sf-cnc",
        kernelId: "kernel-sf",
        status: "executing",
        assignedDevices: ["dev-cnc-haas-vf2"],
        startedAt: "2026-03-10T07:30:00Z",
        progress: 23,
      },
      {
        id: "job-003",
        stepId: "step-3",
        cwmId: "cwm-003",
        capabilityId: "cap-nyc-laser",
        kernelId: "kernel-nyc",
        status: "queued",
        assignedDevices: [],
        progress: 0,
      },
      {
        id: "job-004",
        stepId: "step-4",
        cwmId: "cwm-001",
        capabilityId: "cap-nyc-fdm",
        kernelId: "kernel-nyc",
        status: "completed",
        assignedDevices: ["dev-fdm-prusa-mk4"],
        startedAt: "2026-03-09T14:00:00Z",
        completedAt: "2026-03-09T18:30:00Z",
        progress: 100,
      },
      {
        id: "job-bio-42",
        stepId: "step-bio-1",
        cwmId: "cwm-bio-001",
        capabilityId: "cap-bio-hplc",
        kernelId: "kernel-biolab-01",
        status: "executing",
        assignedDevices: ["dev-liquid-handler", "dev-centrifuge", "dev-hplc"],
        startedAt: "2026-03-10T08:00:00Z",
        progress: 50,
      },
    ])
    .run();
}
