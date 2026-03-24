/**
 * Opentrons-specific types for the PCC kernel.
 *
 * Covers: robot identity, deck layout, pipettes, modules, labware,
 * protocol runs, and liquid-handler capability parameters.
 */

// ── Robot Identity ────────────────────────────────────────────────

export interface OpentronRobotInfo {
  name: string;
  model: "OT-2" | "OT-3" | "Flex";
  serialNumber: string;
  firmwareVersion: string;
  apiVersion: string;
  /** REST API base URL (e.g. http://192.168.1.5:31950) */
  apiUrl: string;
}

// ── Deck & Labware ────────────────────────────────────────────────

/** OT-2 has slots 1-11 + fixed trash. Flex has A1-D3 grid. */
export type DeckSlot = string;

export interface LabwareDef {
  /** Opentrons labware load name (e.g. "corning_96_wellplate_360ul_flat") */
  loadName: string;
  displayName: string;
  namespace: string;
  version: number;
  /** Slot it's loaded on */
  slot: DeckSlot;
}

export interface DeckLayout {
  slots: Record<DeckSlot, LabwareDef | null>;
  modules: OpentronModule[];
}

// ── Pipettes ──────────────────────────────────────────────────────

export type PipetteMount = "left" | "right";

export interface PipetteInfo {
  mount: PipetteMount;
  name: string;
  /** e.g. "p300_single_gen2", "flex_8channel_1000" */
  pipetteId: string;
  minVolume: number;
  maxVolume: number;
  channels: 1 | 8 | 96;
}

// ── Modules ───────────────────────────────────────────────────────

export type ModuleType =
  | "thermocyclerModuleV2"
  | "temperatureModuleV2"
  | "magneticModuleV2"
  | "heaterShakerModuleV1"
  | "absorbanceReaderV1";

export interface OpentronModule {
  moduleType: ModuleType;
  serial: string;
  slot: DeckSlot;
  status: Record<string, unknown>;
}

// ── Protocol ──────────────────────────────────────────────────────

export interface OTProtocol {
  id: string;
  name: string;
  /** Python protocol source code */
  source: string;
  metadata: {
    protocolName: string;
    author: string;
    description: string;
    apiLevel: string;
  };
}

export interface OTRun {
  id: string;
  protocolId: string;
  status: "idle" | "running" | "paused" | "stopped" | "failed" | "succeeded";
  /** 0-100 progress based on commands completed */
  progress: number;
  errors: Array<{ detail: string; createdAt: string }>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** Opentrons command log */
  commands: OTCommand[];
}

export interface OTCommand {
  id: string;
  commandType: string;
  status: "queued" | "running" | "succeeded" | "failed";
  params: Record<string, unknown>;
  result?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: { detail: string };
}

// ── Liquid Handling Capabilities ──────────────────────────────────

export interface LiquidHandlerCapability {
  pipettes: PipetteInfo[];
  modules: OpentronModule[];
  deckSlots: number;
  maxTipRacks: number;
  supportedLabware: string[];
  supportedActions: LiquidAction[];
}

export type LiquidAction =
  | "aspirate"
  | "dispense"
  | "mix"
  | "transfer"
  | "distribute"
  | "consolidate"
  | "blow_out"
  | "touch_tip"
  | "air_gap"
  | "drop_tip"
  | "pick_up_tip";

// ── Adapter Config ────────────────────────────────────────────────

export interface OpentronAdapterConfig {
  /** Robot REST API URL (e.g. http://192.168.1.5:31950) */
  url: string;
  /** Opentrons API version header (e.g. "2.18") */
  apiVersion?: string;
  /** Poll interval for run status in ms (default 1000) */
  pollIntervalMs?: number;
  /** Mock mode — simulates OT responses without real hardware */
  mockMode?: boolean;
  /** Max concurrent jobs — always 1 for liquid handlers */
  maxConcurrent?: number;
  /** Max queue depth — reject if queue exceeds this */
  maxQueueDepth?: number;
}
