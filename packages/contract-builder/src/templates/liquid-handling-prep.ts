/**
 * Liquid Handling Prep capability template.
 *
 * Hamilton-ML-Prep-flavoured variant of the generic `liquid-handler`
 * template. Customers building contracts against Hamilton-equipped
 * operators get a typed parameter schema that matches Hamilton's
 * runtime API:
 *   - protocolId — selects from the operator's pre-configured protocol
 *     library on the instrument (POST /api/v1/protocol-run/create)
 *   - worklistType — top-level Hamilton workflow (hit-pick, normalize,
 *     transfer, reformat)
 *   - transferVolume / plate format / sample count / replicates — the
 *     standard liquid-handling knobs
 *   - evidenceTier — Hamilton's run-data PDF + pipetting CSV + camera
 *     snapshot pipeline maps directly onto PCC tiers 0/1/2
 *
 * 9 parameters in 4 groups:
 *   Protocol: protocolId, worklistType, plateFormat
 *   Volumes: transferVolume, mixCycles
 *   Samples: sampleCount, replicates
 *   Evidence: evidenceTier
 *   Order: quantity
 *
 * The Hamilton runtime adapter lives in `@pcc/kernel/adapters/hamilton-adapter.ts`
 * and the operator-helpers package is at https://github.com/LamaSu/hamilton-pcc-bridge.
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const liquidHandlingPrepTemplate: CapabilityTemplate = {
  capabilityType: "liquid-handling-prep",
  version: "1.0",
  name: "Liquid Handling (Hamilton ML Prep)",
  description:
    "Hamilton Microlab Prep automated liquid handling — typed parameters that map directly onto the instrument's REST API (protocol-run, run-data, camera).",
  params: [
    // ── Protocol Group ──
    {
      type: "string",
      key: "protocolId",
      label: "Protocol ID",
      description:
        "ID of the protocol to run on the instrument. Operators publish their protocol library via /api/v1/protocols; pick one of their advertised IDs.",
      required: true,
      order: 1,
      group: "Protocol",
    },
    {
      type: "enum",
      key: "worklistType",
      label: "Worklist Type",
      description: "Top-level Hamilton workflow shape",
      required: true,
      order: 2,
      group: "Protocol",
      options: [
        { value: "transfer", label: "Simple Transfer", description: "Source → destination, fixed volume" },
        { value: "hit-pick", label: "Hit Picking", description: "Cherry-pick wells from a source plate to a target", pricingImpact: { mode: "percent", value: "10", label: "+10% for hit-picking (per-well coords)" } },
        { value: "normalization", label: "Normalization", description: "Adjust concentrations to target via diluent + sample", pricingImpact: { mode: "percent", value: "20", label: "+20% for normalization (calc + precision)" } },
        { value: "plate-reformat", label: "Plate Reformat", description: "Move samples between plate formats (e.g. 96 → 384)" },
        { value: "serial-dilution", label: "Serial Dilution", description: "Sequential dilution across columns/rows", pricingImpact: { mode: "percent", value: "15", label: "+15% for serial dilution" } },
      ],
    },
    {
      type: "enum",
      key: "plateFormat",
      label: "Plate Format",
      description: "Source/destination labware geometry",
      required: true,
      order: 3,
      group: "Protocol",
      options: [
        { value: "96-well", label: "96-Well Plate (8×12)", description: "Standard microplate" },
        { value: "384-well", label: "384-Well Plate (16×24)", description: "High-density", pricingImpact: { mode: "percent", value: "10", label: "+10% for 384-well precision" } },
        { value: "24-well", label: "24-Well (deep)", description: "Deep-well or culture" },
        { value: "tubes", label: "Tube Rack", description: "1.5/2.0 mL tubes" },
        { value: "reservoir", label: "Reservoir", description: "Single- or multi-channel reservoir" },
      ],
    },

    // ── Volumes Group ──
    {
      type: "number",
      key: "transferVolume",
      label: "Transfer Volume",
      description: "Volume per pipetting step (µL). Hamilton ML Prep range is roughly 1–1000 µL.",
      required: true,
      order: 4,
      group: "Volumes",
      min: 1,
      max: 1000,
      step: 0.5,
      unit: "µL",
      defaultValue: 100,
    },
    {
      type: "number",
      key: "mixCycles",
      label: "Mix Cycles",
      description: "Aspirate/dispense cycles for mixing (0 = no mixing)",
      required: false,
      order: 5,
      group: "Volumes",
      min: 0,
      max: 20,
      step: 1,
      defaultValue: 3,
    },

    // ── Samples Group ──
    {
      type: "number",
      key: "sampleCount",
      label: "Sample Count",
      description: "Distinct samples to process",
      required: true,
      order: 6,
      group: "Samples",
      min: 1,
      max: 384,
      step: 1,
      defaultValue: 8,
      pricingImpact: { mode: "per_unit", value: "0.30", label: "+$0.30 per sample (tip + reagent)" },
    },
    {
      type: "number",
      key: "replicates",
      label: "Replicates",
      description: "Technical replicates per sample",
      required: false,
      order: 7,
      group: "Samples",
      min: 1,
      max: 12,
      step: 1,
      defaultValue: 1,
      pricingImpact: { mode: "per_unit", value: "0.50", label: "+$0.50 per replicate" },
    },

    // ── Evidence Group ──
    {
      type: "enum",
      key: "evidenceTier",
      label: "Evidence Tier",
      description:
        "Maps onto Hamilton's run-data outputs. Tier 1 retrieves the PDF + pipetting CSV; Tier 2 adds the camera snapshot for visual verification.",
      required: false,
      order: 8,
      group: "Evidence",
      defaultValue: "1",
      options: [
        { value: "0", label: "Tier 0 — Self-Attested", description: "Device-health snapshot only. Fastest, cheapest." },
        { value: "1", label: "Tier 1 — Verified", description: "Run-data PDF + pipetting CSV (Hamilton's documented exports)" },
        { value: "2", label: "Tier 2 — Certified", description: "Tier 1 + camera snapshot from Hamilton's vision system + sensor logs", pricingImpact: { mode: "percent", value: "20", label: "+20% for Tier 2 evidence" } },
      ],
    },

    // ── Order ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of plates / runs to process",
      required: true,
      order: 9,
      group: "Order",
      min: 1,
      max: 50,
      step: 1,
      defaultValue: 1,
    },
  ],
  basePricingHints: {
    basePrice: "12.00",
    currency: "USDC",
    perUnitLabel: "per plate/run",
  },
};
