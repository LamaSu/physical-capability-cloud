/**
 * @pcc/adapter-zeon — Zeon Systems adapter for PCC.
 *
 * Zeon has bench execution and no settlement layer. PCC has settlement and no
 * bench. This package wires them together without lying about which side did
 * what: the digital steps (expression gate, plate analysis, round-2 design) are
 * real kernel capabilities, and starting the robot is surfaced as a human step
 * because Zeon's cloud exposes no execution route.
 */

export {
  ZeonSyncClient,
  ZeonSyncError,
  ZEON_ROUTES,
} from "./sync-client.js";
export type {
  ZeonSyncConfig,
  ZeonProject,
  ZeonMeshItem,
  ZeonIdentity,
} from "./sync-client.js";

export { ZeonAdapter, TEM1_REQUIRED_LABWARE } from "./adapter.js";
export type {
  ZeonAdapterConfig,
  HumanStep,
  PreparedRun,
  LabwareAvailability,
} from "./adapter.js";

export {
  buildZeonTem1Manifest,
  TEM1_WORKFLOW_STEPS,
  ZEON_TEM1_KERNEL_ID,
  ZEON_TEM1_CAPABILITY,
} from "./manifest.js";
export type { ZeonManifestInput } from "./manifest.js";
