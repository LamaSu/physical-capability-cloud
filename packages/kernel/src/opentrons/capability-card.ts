/**
 * Capability Card — the operator's machine-readable offer to user agents.
 *
 * When an agent discovers this operator, it gets back a CapabilityCard
 * that describes EXACTLY what the operator can do and what parameters
 * the agent must fill in. The card is a schema — the agent fills it in
 * to produce an ExecutionBundle.
 *
 * Flow:
 *   Operator → CapabilityCard → User Agent fills params → ExecutionBundle → Operator validates → Machine runs
 */

import type { PipetteInfo, OpentronModule, LiquidAction, DeckSlot } from "./types.js";

// ── Parameter Schema ──────────────────────────────────────────────
// These describe what the user agent CAN configure for each action.

export type ParamType = "number" | "string" | "enum" | "boolean" | "well" | "wells" | "slot";

export interface ParamSchema {
  key: string;
  label: string;
  type: ParamType;
  required: boolean;
  description: string;
  /** For number: allowed range */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** For enum: allowed values */
  options?: Array<{ value: string; label: string }>;
  /** Default value */
  defaultValue?: unknown;
  /** Validation regex (for string/well types) */
  pattern?: string;
}

// ── Action Schema ─────────────────────────────────────────────────
// Each action the robot can perform, with its full parameter schema.

export interface ActionSchema {
  action: LiquidAction | string;
  label: string;
  description: string;
  /** Parameters the user agent must/can provide */
  params: ParamSchema[];
  /** Which pipette mounts can perform this action */
  compatiblePipettes: string[];
  /** Estimated base duration in ms */
  baseDurationMs: number;
}

// ── Labware Option ────────────────────────────────────────────────

export interface LabwareOption {
  loadName: string;
  displayName: string;
  wellCount: number;
  wellVolumeUl: number;
  category: "wellplate" | "tiprack" | "reservoir" | "tuberack" | "aluminumblock" | "other";
}

// ── Deck Slot State ───────────────────────────────────────────────

export interface DeckSlotState {
  slot: DeckSlot;
  /** What's currently loaded (null = empty) */
  currentLabware: string | null;
  /** Whether this slot can be reconfigured */
  configurable: boolean;
  /** What module occupies this slot (null = none) */
  module: string | null;
}

// ── Capability Card ───────────────────────────────────────────────

export interface CapabilityCard {
  /** Schema version for forward compat */
  schemaVersion: "1.0";

  /** Operator identity */
  operator: {
    kernelId: string;
    name: string;
    location: { lat: number; lng: number };
    reputation: number;
  };

  /** Robot hardware */
  hardware: {
    model: string;
    pipettes: Array<{
      mount: string;
      name: string;
      id: string;
      minVolumeUl: number;
      maxVolumeUl: number;
      channels: number;
    }>;
    modules: Array<{
      type: string;
      slot: string;
    }>;
  };

  /** Available actions with parameter schemas */
  actions: ActionSchema[];

  /** Current deck state + what labware is available */
  deck: {
    slots: DeckSlotState[];
    availableLabware: LabwareOption[];
  };

  /** Pricing formula */
  pricing: {
    baseCost: number;
    perMinuteRate: number;
    minimumCharge: number;
    currency: string;
    /** Human-readable: "baseCost + perMinuteRate × estimatedMinutes, min minimumCharge" */
    formula: string;
  };

  /** Constraints the user agent must respect */
  constraints: {
    maxSteps: number;
    maxProtocolDurationMs: number;
    maxQueueDepth: number;
    currentQueueDepth: number;
    estimatedQueueWaitMs: number;
    assuranceTiers: number[];
    /** Well format regex (e.g. "^[A-H][1-9][0-2]?$") */
    wellPattern: string;
  };

  /** What the user agent sends back (reference to ExecutionBundle schema) */
  responseFormat: "ExecutionBundle/1.0";

  /** ISO timestamp — card is a snapshot, may be stale */
  generatedAt: string;
  /** Card valid for this many ms */
  validForMs: number;
}

// ── Card Builder ──────────────────────────────────────────────────

export function buildCapabilityCard(
  kernelId: string,
  name: string,
  location: { lat: number; lng: number },
  pipettes: PipetteInfo[],
  modules: OpentronModule[],
  deckSlots: DeckSlotState[],
  pricing: { baseCost: string; perMinute: string; minimum: string; currency: string },
  queueDepth: number,
  queueWaitMs: number,
): CapabilityCard {
  const actions = buildActionSchemas(pipettes);

  return {
    schemaVersion: "1.0",
    operator: {
      kernelId,
      name,
      location,
      reputation: 100,
    },
    hardware: {
      model: "OT-2", // TODO: detect from adapter
      pipettes: pipettes.map((p) => ({
        mount: p.mount,
        name: p.name,
        id: p.pipetteId,
        minVolumeUl: p.minVolume,
        maxVolumeUl: p.maxVolume,
        channels: p.channels,
      })),
      modules: modules.map((m) => ({
        type: m.moduleType,
        slot: m.slot,
      })),
    },
    actions,
    deck: {
      slots: deckSlots,
      availableLabware: DEFAULT_LABWARE,
    },
    pricing: {
      baseCost: parseFloat(pricing.baseCost),
      perMinuteRate: parseFloat(pricing.perMinute),
      minimumCharge: parseFloat(pricing.minimum),
      currency: pricing.currency,
      formula: `${pricing.baseCost} + ${pricing.perMinute} × minutes, min ${pricing.minimum} ${pricing.currency}`,
    },
    constraints: {
      maxSteps: 200,
      maxProtocolDurationMs: 4 * 60 * 60_000,
      maxQueueDepth: 10,
      currentQueueDepth: queueDepth,
      estimatedQueueWaitMs: queueWaitMs,
      assuranceTiers: [0, 1, 2],
      wellPattern: "^[A-H](1[0-2]|[1-9])$",
    },
    responseFormat: "ExecutionBundle/1.0",
    generatedAt: new Date().toISOString(),
    validForMs: 10 * 60_000, // 10 minutes
  };
}

// ── Default Labware Library ───────────────────────────────────────

const DEFAULT_LABWARE: LabwareOption[] = [
  { loadName: "opentrons_96_tiprack_300ul", displayName: "300µL Tip Rack", wellCount: 96, wellVolumeUl: 300, category: "tiprack" },
  { loadName: "opentrons_96_tiprack_20ul", displayName: "20µL Tip Rack", wellCount: 96, wellVolumeUl: 20, category: "tiprack" },
  { loadName: "opentrons_96_tiprack_1000ul", displayName: "1000µL Tip Rack", wellCount: 96, wellVolumeUl: 1000, category: "tiprack" },
  { loadName: "corning_96_wellplate_360ul_flat", displayName: "Corning 96-Well Flat Plate", wellCount: 96, wellVolumeUl: 360, category: "wellplate" },
  { loadName: "biorad_96_wellplate_200ul_pcr", displayName: "Bio-Rad 96-Well PCR Plate", wellCount: 96, wellVolumeUl: 200, category: "wellplate" },
  { loadName: "nest_12_reservoir_15ml", displayName: "NEST 12-Channel Reservoir 15mL", wellCount: 12, wellVolumeUl: 15000, category: "reservoir" },
  { loadName: "nest_96_wellplate_2ml_deep", displayName: "NEST 96 Deep Well 2mL", wellCount: 96, wellVolumeUl: 2000, category: "wellplate" },
  { loadName: "opentrons_24_tuberack_eppendorf_1.5ml_safelock_snapcap", displayName: "Eppendorf 1.5mL Tube Rack", wellCount: 24, wellVolumeUl: 1500, category: "tuberack" },
  { loadName: "opentrons_15_tuberack_falcon_15ml_conical", displayName: "Falcon 15mL Tube Rack", wellCount: 15, wellVolumeUl: 15000, category: "tuberack" },
];

// ── Action Schema Builder ─────────────────────────────────────────

function buildActionSchemas(pipettes: PipetteInfo[]): ActionSchema[] {
  const mounts = pipettes.map((p) => p.mount);
  const maxVol = Math.max(...pipettes.map((p) => p.maxVolume), 300);
  const minVol = Math.min(...pipettes.map((p) => p.minVolume), 1);

  const volumeParam: ParamSchema = {
    key: "volume", label: "Volume (µL)", type: "number", required: true,
    description: "Volume to transfer in microliters",
    min: minVol, max: maxVol, step: 0.1, unit: "µL",
  };
  const wellParam: ParamSchema = {
    key: "well", label: "Well", type: "well", required: true,
    description: "Well position (e.g. A1, B3, H12)",
    pattern: "^[A-H](1[0-2]|[1-9])$",
  };
  const slotParam: ParamSchema = {
    key: "slot", label: "Deck Slot", type: "slot", required: true,
    description: "Deck slot number (1-11)",
  };
  const pipetteParam: ParamSchema = {
    key: "pipette", label: "Pipette", type: "enum", required: false,
    description: "Which pipette to use",
    options: mounts.map((m) => ({ value: m, label: m })),
    defaultValue: mounts[0] ?? "left",
  };

  return [
    {
      action: "aspirate",
      label: "Aspirate",
      description: "Draw liquid from a well into the pipette tip",
      params: [volumeParam, wellParam, slotParam, pipetteParam],
      compatiblePipettes: mounts,
      baseDurationMs: 3000,
    },
    {
      action: "dispense",
      label: "Dispense",
      description: "Push liquid from the pipette tip into a well",
      params: [volumeParam, wellParam, slotParam, pipetteParam],
      compatiblePipettes: mounts,
      baseDurationMs: 2500,
    },
    {
      action: "transfer",
      label: "Transfer",
      description: "Move liquid from one well to another (pick tip → aspirate → dispense → drop tip)",
      params: [
        volumeParam,
        { ...wellParam, key: "sourceWell", label: "Source Well" },
        { ...slotParam, key: "sourceSlot", label: "Source Slot" },
        { ...wellParam, key: "destWell", label: "Destination Well" },
        { ...slotParam, key: "destSlot", label: "Destination Slot" },
        pipetteParam,
        {
          key: "newTip", label: "New Tip", type: "enum", required: false,
          description: "When to pick a new tip",
          options: [
            { value: "always", label: "Always (new tip each transfer)" },
            { value: "once", label: "Once (reuse tip)" },
            { value: "never", label: "Never (assume tip loaded)" },
          ],
          defaultValue: "always",
        },
      ],
      compatiblePipettes: mounts,
      baseDurationMs: 8000,
    },
    {
      action: "mix",
      label: "Mix",
      description: "Repeatedly aspirate and dispense in the same well to mix contents",
      params: [
        volumeParam,
        wellParam,
        slotParam,
        pipetteParam,
        {
          key: "repetitions", label: "Repetitions", type: "number", required: false,
          description: "Number of mix cycles", min: 1, max: 50, step: 1, defaultValue: 3,
        },
      ],
      compatiblePipettes: mounts,
      baseDurationMs: 4000,
    },
    {
      action: "distribute",
      label: "Distribute",
      description: "Aspirate once from a source and dispense to multiple destinations",
      params: [
        volumeParam,
        { ...wellParam, key: "sourceWell", label: "Source Well" },
        { ...slotParam, key: "sourceSlot", label: "Source Slot" },
        { ...slotParam, key: "destSlot", label: "Destination Slot" },
        {
          key: "destWells", label: "Destination Wells", type: "wells", required: true,
          description: "Array of destination wells (e.g. [\"A1\",\"A2\",\"A3\"])",
        },
        pipetteParam,
      ],
      compatiblePipettes: mounts,
      baseDurationMs: 6000,
    },
    {
      action: "consolidate",
      label: "Consolidate",
      description: "Aspirate from multiple sources and dispense into one destination",
      params: [
        volumeParam,
        { ...slotParam, key: "sourceSlot", label: "Source Slot" },
        {
          key: "sourceWells", label: "Source Wells", type: "wells", required: true,
          description: "Array of source wells (e.g. [\"A1\",\"A2\",\"A3\"])",
        },
        { ...wellParam, key: "destWell", label: "Destination Well" },
        { ...slotParam, key: "destSlot", label: "Destination Slot" },
        pipetteParam,
      ],
      compatiblePipettes: mounts,
      baseDurationMs: 6000,
    },
    {
      action: "delay",
      label: "Delay",
      description: "Pause execution for a specified time",
      params: [
        {
          key: "seconds", label: "Seconds", type: "number", required: true,
          description: "How long to wait", min: 1, max: 3600, step: 1, unit: "s",
        },
      ],
      compatiblePipettes: mounts,
      baseDurationMs: 0,
    },
    {
      action: "pause",
      label: "Pause",
      description: "Pause for operator intervention (manual step)",
      params: [
        {
          key: "message", label: "Message", type: "string", required: false,
          description: "Message to display to operator",
        },
      ],
      compatiblePipettes: mounts,
      baseDurationMs: 0,
    },
  ];
}
