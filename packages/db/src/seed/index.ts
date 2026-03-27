import { count } from "drizzle-orm";
import type { StoreDB } from "../connection.js";
import { shopKernels } from "../schema/index.js";
import { seedKernels } from "./kernels.js";
import { seedJobs } from "./jobs.js";
import { seedEscrow } from "./escrow.js";
import { seedOrchestrator } from "./orchestrator.js";
import { seedProtocols } from "./protocols.js";
import { seedLogistics } from "./logistics.js";
import { seedEncryption } from "./encryption.js";
import { seedSensors } from "./sensors.js";
import { seedBatches } from "./batches.js";
import { seedOperatorPolicies } from "./operator-policies.js";

/**
 * Seeds all mock data in dependency order.
 * Idempotent: skips if data already exists (e.g., persisted SQLite volume).
 */
export function seedAll(db: StoreDB): void {
  // Check if seed data already exists to avoid UNIQUE constraint violations
  // when running on a persisted volume (e.g., Railway).
  const [row] = db.select({ n: count() }).from(shopKernels).all();
  if (row && row.n > 0) {
    console.log(`[seed] Database already seeded (${row.n} kernels found), skipping`);
    return;
  }

  // Order matters: kernels first (FK target), then capabilities/devices,
  // then jobs, then everything that references them.
  seedKernels(db);
  seedJobs(db);
  seedEscrow(db);
  seedOrchestrator(db);
  seedProtocols(db);
  seedLogistics(db);
  seedEncryption(db);
  seedSensors(db);
  seedBatches(db);
  seedOperatorPolicies(db);
  console.log("[seed] Mock data seeded successfully");
}

export {
  seedKernels,
  seedJobs,
  seedEscrow,
  seedOrchestrator,
  seedProtocols,
  seedLogistics,
  seedEncryption,
  seedSensors,
  seedBatches,
  seedOperatorPolicies,
};
