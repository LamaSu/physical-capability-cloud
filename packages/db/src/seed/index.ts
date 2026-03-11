import type { StoreDB } from "../connection.js";
import { seedKernels } from "./kernels.js";
import { seedJobs } from "./jobs.js";
import { seedEscrow } from "./escrow.js";
import { seedOrchestrator } from "./orchestrator.js";
import { seedProtocols } from "./protocols.js";
import { seedLogistics } from "./logistics.js";

/**
 * Seeds all mock data in dependency order.
 */
export function seedAll(db: StoreDB): void {
  // Order matters: kernels first (FK target), then capabilities/devices,
  // then jobs, then everything that references them.
  seedKernels(db);
  seedJobs(db);
  seedEscrow(db);
  seedOrchestrator(db);
  seedProtocols(db);
  seedLogistics(db);
}

export { seedKernels, seedJobs, seedEscrow, seedOrchestrator, seedProtocols, seedLogistics };
