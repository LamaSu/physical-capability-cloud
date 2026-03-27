/**
 * Liquid Handler capability template.
 *
 * 10 parameters in 4 groups:
 *   Protocol: protocolType, plateFormat, replicates
 *   Pipetting: pipetteType, transferVolume, mixCycles
 *   Reagents: reagentType, sampleCount
 *   Post-Processing: evidenceTier, postProcessing
 */

import type { CapabilityTemplate } from "@pcc/spec";

export const liquidHandlerTemplate: CapabilityTemplate = {
  capabilityType: "liquid-handler",
  version: "1.0",
  name: "Automated Liquid Handling",
  description: "Robotic pipetting — transfers, serial dilutions, plate formatting, mixing, and sample preparation",
  params: [
    // ── Protocol Group ──
    {
      type: "enum",
      key: "protocolType",
      label: "Protocol Type",
      description: "Type of liquid handling workflow to execute",
      required: true,
      order: 1,
      group: "Protocol",
      options: [
        { value: "transfer", label: "Simple Transfer", description: "Aspirate from source, dispense to destination" },
        { value: "serial-dilution", label: "Serial Dilution", description: "Sequential dilution across wells", pricingImpact: { mode: "percent", value: "15", label: "+15% for serial dilution (precision critical)" } },
        { value: "plate-reformat", label: "Plate Reformatting", description: "Cherry-pick or reformat between plate layouts" },
        { value: "distribute", label: "Distribute", description: "One source to many destinations" },
        { value: "consolidate", label: "Consolidate", description: "Many sources to one destination" },
        { value: "normalization", label: "Normalization", description: "Adjust concentrations to target", pricingImpact: { mode: "percent", value: "20", label: "+20% for normalization (calculation + precision)" } },
        { value: "mixing", label: "Mixing", description: "Aspirate and dispense in-place for thorough mixing" },
        { value: "custom", label: "Custom Protocol", description: "Upload Opentrons Python protocol directly", pricingImpact: { mode: "percent", value: "10", label: "+10% for custom protocol review" } },
      ],
    },
    {
      type: "enum",
      key: "plateFormat",
      label: "Plate Format",
      description: "Well plate format used in this protocol",
      required: true,
      order: 2,
      group: "Protocol",
      options: [
        { value: "96-well", label: "96-Well Plate", description: "Standard 96-well microplate (8×12)" },
        { value: "384-well", label: "384-Well Plate", description: "High-density 384-well (16×24)", pricingImpact: { mode: "percent", value: "10", label: "+10% for 384-well precision" } },
        { value: "24-well", label: "24-Well Plate", description: "24-well deep-well or culture plate" },
        { value: "6-well", label: "6-Well Plate", description: "6-well plate for cell culture" },
        { value: "tubes", label: "Tube Rack", description: "1.5mL/2.0mL microcentrifuge tubes" },
        { value: "reservoir", label: "Reservoir", description: "Single- or multi-channel reservoir" },
      ],
    },
    {
      type: "number",
      key: "replicates",
      label: "Replicates",
      description: "Number of technical replicates per sample",
      required: false,
      order: 3,
      group: "Protocol",
      min: 1,
      max: 12,
      step: 1,
      defaultValue: 1,
      pricingImpact: { mode: "per_unit", value: "0.50", label: "+$0.50 per replicate" },
    },

    // ── Pipetting Group ──
    {
      type: "enum",
      key: "pipetteType",
      label: "Pipette",
      description: "Which pipette to use (determines volume range and channels)",
      required: true,
      order: 4,
      group: "Pipetting",
      options: [
        { value: "p20-single", label: "P20 Single (1-20µL)", description: "High precision for small volumes" },
        { value: "p300-single", label: "P300 Single (20-300µL)", description: "Standard range for most protocols" },
        { value: "p1000-single", label: "P1000 Single (100-1000µL)", description: "Large volume transfers" },
        { value: "p20-multi", label: "P20 8-Channel (1-20µL)", description: "High-throughput small volumes", pricingImpact: { mode: "percent", value: "-15", label: "-15% for multi-channel (faster)" } },
        { value: "p300-multi", label: "P300 8-Channel (20-300µL)", description: "High-throughput standard range", pricingImpact: { mode: "percent", value: "-15", label: "-15% for multi-channel (faster)" } },
      ],
    },
    {
      type: "number",
      key: "transferVolume",
      label: "Transfer Volume",
      description: "Volume per transfer step in microliters",
      required: true,
      order: 5,
      group: "Pipetting",
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
      description: "Number of aspirate/dispense cycles for mixing steps (0 = no mixing)",
      required: false,
      order: 6,
      group: "Pipetting",
      min: 0,
      max: 20,
      step: 1,
      defaultValue: 3,
    },

    // ── Reagents Group ──
    {
      type: "enum",
      key: "reagentType",
      label: "Sample Type",
      description: "Type of liquid being handled (affects tip usage and contamination protocols)",
      required: true,
      order: 7,
      group: "Reagents",
      options: [
        { value: "aqueous", label: "Aqueous (buffer, water, saline)" },
        { value: "biological", label: "Biological (serum, plasma, cell suspension)", pricingImpact: { mode: "percent", value: "10", label: "+10% for biological (contamination protocol)" } },
        { value: "organic", label: "Organic Solvent (DMSO, ethanol, methanol)", pricingImpact: { mode: "percent", value: "15", label: "+15% for organic (filter tips required)" } },
        { value: "viscous", label: "Viscous (glycerol, PEG)", pricingImpact: { mode: "percent", value: "20", label: "+20% for viscous (slow aspiration)" } },
        { value: "volatile", label: "Volatile (acetone, chloroform)", pricingImpact: { mode: "percent", value: "25", label: "+25% for volatile (special handling)" } },
      ],
    },
    {
      type: "number",
      key: "sampleCount",
      label: "Sample Count",
      description: "Number of distinct samples to process",
      required: true,
      order: 8,
      group: "Reagents",
      min: 1,
      max: 384,
      step: 1,
      defaultValue: 8,
      pricingImpact: { mode: "per_unit", value: "0.25", label: "+$0.25 per sample (tip cost)" },
    },

    // ── Post-Processing Group ──
    {
      type: "enum",
      key: "evidenceTier",
      label: "Evidence Tier",
      description: "Level of evidence collected during execution",
      required: false,
      order: 9,
      group: "Post-Processing",
      defaultValue: "basic",
      options: [
        { value: "none", label: "No Evidence (Tier 0)", description: "Fastest, cheapest — no verification" },
        { value: "basic", label: "Basic Evidence (Tier 1)", description: "Run logs + completion photos" },
        { value: "full", label: "Full Evidence (Tier 2)", description: "Logs + photos + volume verification + sensor data", pricingImpact: { mode: "percent", value: "20", label: "+20% for full evidence" } },
      ],
    },
    {
      type: "enum",
      key: "postProcessing",
      label: "Post-Processing",
      description: "Additional steps after the protocol completes",
      required: false,
      order: 10,
      group: "Post-Processing",
      defaultValue: "none",
      options: [
        { value: "none", label: "None" },
        { value: "seal", label: "Plate Seal", description: "Apply adhesive plate seal", pricingImpact: { mode: "flat", value: "2.00", label: "+$2.00 for plate sealing" } },
        { value: "centrifuge", label: "Centrifuge", description: "Spin down after transfer", pricingImpact: { mode: "flat", value: "5.00", label: "+$5.00 for centrifugation" } },
        { value: "incubate", label: "Incubate", description: "Temperature hold on thermocycler module", pricingImpact: { mode: "flat", value: "3.00", label: "+$3.00 for incubation" } },
      ],
    },

    // ── Order ──
    {
      type: "number",
      key: "quantity",
      label: "Quantity",
      description: "Number of plates/runs to process",
      required: true,
      order: 11,
      group: "Order",
      min: 1,
      max: 50,
      step: 1,
      defaultValue: 1,
    },
  ],
  basePricingHints: {
    basePrice: "10.00",
    currency: "USDC",
    perUnitLabel: "per plate/run",
  },
};
