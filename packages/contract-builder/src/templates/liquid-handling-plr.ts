/**
 * Liquid Handling (PyLabRobot) capability template.
 *
 * Universal liquid-handling contract surface that routes through the
 * `@pcc/adapter-pylabrobot` package. Operators publish one or more
 * `MachineProfile`s (Opentrons OT-2, Flex, Hamilton STAR, Vantage, Tecan
 * EVO) which constrain the param surface via build/options responses.
 *
 * Coverage:
 *   - Phase 1: Opentrons OT-2 (this template's reference profile)
 *   - Phase 2: Opentrons Flex, Hamilton STAR / STARlet / Vantage, Tecan EVO
 *
 * Distinct from `liquid-handling-prep` (Hamilton Microlab Prep via the
 * vendor's REST API) — see PLR research §5 for the coexistence rationale.
 *
 * 18 parameters in 8 groups:
 *   Backend:   plrBackend, deckLayoutId
 *   Protocol:  protocolSource, protocolPayload, protocolType
 *   Labware:   plateFormat, plateClass, tipType
 *   Pipetting: pipetteChannel, transferVolume_uL, mixCycles, aspirationRate
 *   Reagents:  liquidClass, sampleCount, replicates
 *   Modules:   modules
 *   Evidence:  evidenceTier
 *   Order:     quantity
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const liquidHandlingPlrTemplate: CapabilityTemplate = {
  capabilityType: "liquid-handling-plr",
  version: "1.0",
  name: "Liquid Handling (PyLabRobot)",
  description:
    "Universal liquid-handling routed through PyLabRobot — Opentrons OT-2/Flex, Hamilton STAR/Vantage, Tecan EVO. Operator's MachineProfile constrains the param surface.",
  params: [
    // ── Backend Group ──
    {
      type: "enum",
      key: "plrBackend",
      label: "PLR Backend",
      description: "PyLabRobot backend to use. The operator's MachineProfile restricts this enum to backends they support.",
      required: true,
      order: 1,
      group: "Backend",
      options: [
        { value: "ot2", label: "Opentrons OT-2" },
        { value: "flex", label: "Opentrons Flex" },
        { value: "star", label: "Hamilton STAR / STARlet", pricingImpact: { mode: "percent", value: "10", label: "+10% Hamilton" } },
        { value: "vantage", label: "Hamilton Vantage", pricingImpact: { mode: "percent", value: "15", label: "+15% Vantage (next-gen)" } },
        { value: "evo", label: "Tecan Freedom EVO", pricingImpact: { mode: "percent", value: "8", label: "+8% Tecan" } },
        { value: "chatterbox", label: "ChatterBox (mock, dry-run only)" },
      ],
    },
    {
      type: "string",
      key: "deckLayoutId",
      label: "Deck Layout ID",
      description:
        "Operator-published deck layout JSON identifier. The operator lists their available decks via /api/decks; pick one whose labware matches your protocol.",
      required: true,
      order: 2,
      group: "Backend",
    },

    // ── Protocol Group ──
    {
      type: "enum",
      key: "protocolSource",
      label: "Protocol Source",
      description: "How the protocol is supplied to the operator",
      required: true,
      order: 3,
      group: "Protocol",
      options: [
        { value: "plr-script", label: "PyLabRobot Python script (URL or signed payload)" },
        { value: "opentrons-protocol", label: "Opentrons Python protocol", pricingImpact: { mode: "percent", value: "10", label: "+10% Opentrons protocol review" } },
        { value: "worklist-csv", label: "Worklist CSV (Hamilton/Tecan style)" },
        { value: "synthace-export", label: "Synthace / Antha export" },
        { value: "stock-protocol", label: "Operator's stock protocol library" },
        { value: "inline-ops", label: "Inline JSON ops array" },
      ],
    },
    {
      type: "string",
      key: "protocolPayload",
      label: "Protocol Payload",
      description:
        "URL to the protocol asset or operator stock-protocol-ID. URLs must be HTTPS; Tier 2+ contracts may require a signed payload hash.",
      required: true,
      order: 4,
      group: "Protocol",
    },
    {
      type: "enum",
      key: "protocolType",
      label: "Protocol Type",
      description: "Tag for matching to operator specialties + pricing tiers",
      required: false,
      order: 5,
      group: "Protocol",
      defaultValue: "transfer",
      options: [
        { value: "transfer", label: "Simple Transfer" },
        { value: "serial-dilution", label: "Serial Dilution", pricingImpact: { mode: "percent", value: "15", label: "+15% serial dilution" } },
        { value: "plate-reformat", label: "Plate Reformatting" },
        { value: "distribute", label: "Distribute" },
        { value: "consolidate", label: "Consolidate" },
        { value: "normalization", label: "Normalization", pricingImpact: { mode: "percent", value: "20", label: "+20% normalization" } },
        { value: "mixing", label: "Mixing" },
        { value: "cherry-pick", label: "Cherry-pick (hit picking)", pricingImpact: { mode: "percent", value: "10", label: "+10% cherry-pick" } },
        { value: "pcr-prep", label: "PCR prep / mastermix" },
        { value: "dna-assembly", label: "DNA assembly (Golden Gate, Gibson)" },
        { value: "cell-passage", label: "Cell passage / split", pricingImpact: { mode: "percent", value: "10", label: "+10% cell handling" } },
        { value: "custom", label: "Custom", pricingImpact: { mode: "percent", value: "10", label: "+10% custom" } },
      ],
    },

    // ── Labware Group ──
    {
      type: "enum",
      key: "plateFormat",
      label: "Plate Format",
      description: "SBS plate format",
      required: true,
      order: 6,
      group: "Labware",
      options: [
        { value: "6", label: "6-well" },
        { value: "12", label: "12-well" },
        { value: "24", label: "24-well" },
        { value: "48", label: "48-well" },
        { value: "96", label: "96-well" },
        { value: "384", label: "384-well", pricingImpact: { mode: "percent", value: "10", label: "+10% 384-well precision" } },
        { value: "1536", label: "1536-well", pricingImpact: { mode: "percent", value: "25", label: "+25% 1536-well precision" } },
      ],
    },
    {
      type: "enum",
      key: "plateClass",
      label: "Plate Class",
      description: "Well geometry / volume class (must match operator labware)",
      required: true,
      order: 7,
      group: "Labware",
      options: [
        { value: "flat-bottom", label: "Flat-bottom microplate" },
        { value: "round-bottom", label: "Round-bottom (U)" },
        { value: "v-bottom", label: "V-bottom" },
        { value: "dwp-1mL", label: "Deep-well 1mL" },
        { value: "dwp-2mL", label: "Deep-well 2mL" },
        { value: "pcr-strip", label: "PCR strip" },
        { value: "tube-rack-1.5mL", label: "1.5mL tube rack" },
        { value: "tube-rack-2.0mL", label: "2.0mL tube rack" },
        { value: "reservoir-12-channel", label: "12-channel reservoir" },
        { value: "reservoir-single", label: "Single-channel reservoir" },
      ],
    },
    {
      type: "enum",
      key: "tipType",
      label: "Tip Type",
      description: "Pipette tip type (filter vs. non-filter, volume range)",
      required: true,
      order: 8,
      group: "Labware",
      options: [
        { value: "10uL-filter", label: "10uL filter tip" },
        { value: "20uL-filter", label: "20uL filter tip" },
        { value: "50uL-filter", label: "50uL filter tip" },
        { value: "200uL-filter", label: "200uL filter tip" },
        { value: "300uL-filter", label: "300uL filter tip" },
        { value: "1000uL-filter", label: "1000uL filter tip" },
        { value: "10uL", label: "10uL standard tip" },
        { value: "20uL", label: "20uL standard tip" },
        { value: "50uL", label: "50uL standard tip" },
        { value: "200uL", label: "200uL standard tip" },
        { value: "300uL", label: "300uL standard tip" },
        { value: "1000uL", label: "1000uL standard tip" },
      ],
    },

    // ── Pipetting Group ──
    {
      type: "enum",
      key: "pipetteChannel",
      label: "Pipette Channels",
      description: "Number of independent pipetting channels (constrained by MachineProfile)",
      required: true,
      order: 9,
      group: "Pipetting",
      options: [
        { value: "single", label: "Single-channel" },
        { value: "8-channel", label: "8-channel", pricingImpact: { mode: "percent", value: "-15", label: "-15% 8-channel (faster)" } },
        { value: "96-channel", label: "96-channel head", pricingImpact: { mode: "percent", value: "-25", label: "-25% 96-channel (Flex / CO-RE 96 only)" } },
        { value: "384-channel", label: "384-channel head", pricingImpact: { mode: "percent", value: "-30", label: "-30% 384-channel (specialty)" } },
      ],
    },
    {
      type: "number",
      key: "transferVolume_uL",
      label: "Transfer Volume (uL)",
      description:
        "Volume per pipetting step. Constrained by tipType + pipetteChannel + MachineProfile (e.g. OT-2 p1000 max 1000 uL).",
      required: true,
      order: 10,
      group: "Pipetting",
      min: 0.5,
      max: 5000,
      step: 0.5,
      unit: "uL",
      defaultValue: 100,
    },
    {
      type: "number",
      key: "mixCycles",
      label: "Mix Cycles",
      description: "Aspirate/dispense cycles for mixing (0 = no mixing)",
      required: false,
      order: 11,
      group: "Pipetting",
      min: 0,
      max: 30,
      step: 1,
      defaultValue: 0,
    },
    {
      type: "enum",
      key: "aspirationRate",
      label: "Aspiration Rate",
      description: "Speed of aspirate/dispense (affects viscous + delicate liquids)",
      required: false,
      order: 12,
      group: "Pipetting",
      defaultValue: "default",
      options: [
        { value: "slow", label: "Slow" },
        { value: "default", label: "Default" },
        { value: "fast", label: "Fast" },
        { value: "custom", label: "Custom", pricingImpact: { mode: "percent", value: "5", label: "+5% custom rate" } },
      ],
    },

    // ── Reagents Group ──
    {
      type: "enum",
      key: "liquidClass",
      label: "Liquid Class",
      description: "PLR liquid class — drives per-liquid pipetting calibration tables",
      required: true,
      order: 13,
      group: "Reagents",
      options: [
        { value: "water", label: "Water" },
        { value: "aqueous-buffer", label: "Aqueous buffer (PBS, TBS, Tris)" },
        { value: "serum", label: "Serum / plasma", pricingImpact: { mode: "percent", value: "10", label: "+10% biological (contamination protocol)" } },
        { value: "dmso", label: "DMSO", pricingImpact: { mode: "percent", value: "15", label: "+15% DMSO (filter tips required)" } },
        { value: "ethanol", label: "Ethanol", pricingImpact: { mode: "percent", value: "15", label: "+15% ethanol (volatile)" } },
        { value: "glycerol-50%", label: "Glycerol 50%", pricingImpact: { mode: "percent", value: "20", label: "+20% viscous (slow aspiration)" } },
        { value: "viscous-custom", label: "Viscous (custom)", pricingImpact: { mode: "percent", value: "20", label: "+20% viscous" } },
        { value: "volatile", label: "Volatile (acetone, MeOH, MeCN)", pricingImpact: { mode: "percent", value: "25", label: "+25% volatile (special handling)" } },
        { value: "cell-suspension", label: "Cell suspension", pricingImpact: { mode: "percent", value: "15", label: "+15% cells (gentle pipetting)" } },
      ],
    },
    {
      type: "number",
      key: "sampleCount",
      label: "Sample Count",
      description: "Distinct samples to process",
      required: true,
      order: 14,
      group: "Reagents",
      min: 1,
      max: 1536,
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
      order: 15,
      group: "Reagents",
      min: 1,
      max: 12,
      step: 1,
      defaultValue: 1,
      pricingImpact: { mode: "per_unit", value: "0.50", label: "+$0.50 per replicate" },
    },

    // ── Modules Group ──
    {
      type: "string",
      key: "modules",
      label: "Modules",
      description:
        "Hardware modules required (comma-separated): temperature-deck, magnetic-deck, thermocycler-module, heater-shaker-module, hepa-fan",
      required: false,
      order: 16,
      group: "Modules",
      defaultValue: "",
    },

    // ── Evidence Group ──
    {
      type: "enum",
      key: "evidenceTier",
      label: "Evidence Tier",
      description:
        "How much evidence is collected during execution. Tier maps onto the operator's MachineProfile capabilities (e.g. Tier 2 requires `evidenceCapabilities.camera`).",
      required: false,
      order: 17,
      group: "Evidence",
      defaultValue: "1",
      options: [
        { value: "0", label: "Tier 0 — Self-Attested", description: "Device-health snapshot only. Fastest, cheapest." },
        { value: "1", label: "Tier 1 — Verified", description: "PLR log + completion event + bundle hash" },
        { value: "2", label: "Tier 2 — Certified", description: "+ per-step camera + gravimetric + pressure trace", pricingImpact: { mode: "percent", value: "20", label: "+20% Tier 2 evidence" } },
        { value: "3", label: "Tier 3 — Sovereign", description: "+ Lit Protocol encryption + multi-verifier + Storacha pinning + ZK proof", pricingImpact: { mode: "percent", value: "100", label: "+100% Tier 3 evidence" } },
      ],
    },

    // ── Order ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of plates / runs to process",
      required: true,
      order: 18,
      group: "Order",
      min: 1,
      max: 50,
      step: 1,
      defaultValue: 1,
    },
  ],

  // ── Cross-parameter constraints ────────────────────────────────────────
  constraints: [
    // Aqueous-only liquid classes (water, buffer, serum, cells) are
    // compatible with all plate classes. Volatile / DMSO / Ethanol force
    // filter tips (no standard non-filter tips).
    {
      when: { param: "liquidClass", in: ["dmso", "ethanol", "volatile"] },
      then: [
        {
          param: "tipType",
          restrictTo: [
            "10uL-filter",
            "20uL-filter",
            "50uL-filter",
            "200uL-filter",
            "300uL-filter",
            "1000uL-filter",
          ],
        },
      ],
    },
    // 96-channel + 384-channel heads only work with 96/384 plates.
    {
      when: { param: "pipetteChannel", equals: "96-channel" },
      then: [
        { param: "plateFormat", restrictTo: ["96", "384"] },
      ],
    },
    {
      when: { param: "pipetteChannel", equals: "384-channel" },
      then: [
        { param: "plateFormat", restrictTo: ["384", "1536"] },
      ],
    },
    // The chatterbox backend is dry-run only — restrict to dry-friendly
    // protocol types so the user doesn't think they're running real cells.
    {
      when: { param: "plrBackend", equals: "chatterbox" },
      then: [
        {
          param: "protocolType",
          restrictTo: ["transfer", "serial-dilution", "mixing", "distribute", "custom"],
        },
      ],
    },
  ],

  basePricingHints: {
    basePrice: "12.00",
    currency: "USDC",
    perUnitLabel: "per plate/run",
  },
};
