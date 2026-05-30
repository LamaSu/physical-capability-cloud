/**
 * Machine profile for Opentrons OT-2 driven via the @pcc/adapter-pylabrobot
 * (PLR) backend.
 *
 * Restricts the universal `liquid-handling-plr` template to what an OT-2
 * actually supports:
 *
 * - Deck: 11 standard slots. Up to 2 pipette mounts (single or 8-channel
 *   GEN1/GEN2 pipettes — P10/P20/P50/P300/P1000). No 96-channel head; no
 *   1536-well support.
 * - Modules: temperature-deck, magnetic-deck, thermocycler-module,
 *   heater-shaker-module. No absorbance plate reader.
 * - Materials: standard aqueous + solvent-compatible plate classes. No
 *   acid-resistant decks; no high-pressure capability.
 * - Pipetting tolerance: ~2% CV at 100uL (P300/P1000); ~5% CV at 1uL (P20).
 * - Evidence: no built-in camera; no pressure trace; no gravimetric scale
 *   (operators bolt these on via separate camera-adapter and sensor-adapter
 *   instances — Tier 2 contracts require those to be present).
 *
 * For Flex (OT-3), see `opentrons-flex-via-plr.ts` (Phase 2).
 * Hamilton STAR / Vantage profiles also live under PLR (Phase 2).
 *
 * Calibration metadata: this profile carries `calibrationStub` for the
 * adapter to populate at registration time. The authoritative deck
 * calibration JSON lives on the operator's filesystem (referenced by
 * the adapter's `deckLayoutPath` adapterConfig field).
 */

import type { MachineProfile } from "@pcc/spec";

export const opentronsOt2ViaPlrProfile: MachineProfile = {
  id: "profile_opentrons_ot2_via_plr",
  capabilityType: "liquid-handling-plr",
  machineName: "Opentrons OT-2 (via PyLabRobot)",
  kernelId: "", // set at registration time

  paramOverrides: [
    // Backend: only OT-2 + chatterbox (for dry-run testing) supported by
    // this profile.
    {
      paramKey: "plrBackend",
      restrictTo: ["ot2", "chatterbox"],
      overrideDefault: "ot2",
    },
    // Pipette channels: OT-2 has no 96-channel head, no 384.
    {
      paramKey: "pipetteChannel",
      restrictTo: ["single", "8-channel"],
      overrideDefault: "8-channel",
    },
    // OT-2 doesn't support 1536-well plates.
    {
      paramKey: "plateFormat",
      restrictTo: ["6", "12", "24", "48", "96", "384"],
      overrideDefault: "96",
    },
    // P1000 max is 1000 uL. P20 min is 1 uL. Override range to be honest
    // about what the instrument can do.
    {
      paramKey: "transferVolume_uL",
      overrideMin: 1,
      overrideMax: 1000,
      overrideDefault: 100,
    },
    // Tip selection — OT-2 tips are 10/20/200/300/1000 uL.
    {
      paramKey: "tipType",
      restrictTo: [
        "10uL-filter",
        "20uL-filter",
        "200uL-filter",
        "300uL-filter",
        "1000uL-filter",
        "10uL",
        "20uL",
        "200uL",
        "300uL",
        "1000uL",
      ],
      overrideDefault: "300uL-filter",
    },
    // Materials: solvent-compatible aqueous + alcohols (limited DMSO
    // tolerance — operator may tighten further per their PLA deck wear).
    // Note: cell suspension allowed but operator marks the deck as
    // contaminated post-run.
    {
      paramKey: "liquidClass",
      restrictTo: [
        "water",
        "aqueous-buffer",
        "serum",
        "dmso",
        "ethanol",
        "viscous-custom",
        "cell-suspension",
      ],
      overrideDefault: "water",
    },
    // Sample count: cap by deck capacity. With one 96-well source +
    // one 96-well destination + tips on remaining slots = up to ~768
    // samples in a multi-pass plan. Conservative single-pass cap = 384.
    {
      paramKey: "sampleCount",
      overrideMax: 384,
      overrideDefault: 96,
    },
    // Evidence: Tier 0/1 are always available; Tier 2 requires bolt-on
    // camera + scale (advertise tier 0/1/2 — operator's
    // evidenceCapabilities tells PCC whether Tier 2 is currently
    // satisfied).
    {
      paramKey: "evidenceTier",
      restrictTo: ["0", "1", "2"],
      overrideDefault: "1",
    },
    // OT-2 modules.
    {
      paramKey: "modules",
      overrideDefault: "",
    },
  ],

  // Additional machine-specific params live under the OT-2 profile so the
  // adapter can pass them through to PLR's OpentronsBackend without
  // polluting the universal template.
  additionalParams: [
    {
      type: "enum",
      key: "ot2Pipette",
      label: "OT-2 Pipette",
      description:
        "Which OT-2 pipette to use (GEN1 vs GEN2 generation, plus single vs 8-channel head and volume class). The operator's profile declares which are currently mounted.",
      required: true,
      order: 50,
      group: "OT-2",
      options: [
        { value: "p20-single-gen2", label: "P20 Single-Channel (GEN2) — 1–20 uL" },
        { value: "p20-multi-gen2", label: "P20 8-Channel (GEN2) — 1–20 uL" },
        { value: "p300-single-gen2", label: "P300 Single-Channel (GEN2) — 20–300 uL" },
        { value: "p300-multi-gen2", label: "P300 8-Channel (GEN2) — 20–300 uL" },
        { value: "p1000-single-gen2", label: "P1000 Single-Channel (GEN2) — 100–1000 uL" },
        { value: "p10-single-gen1", label: "P10 Single-Channel (GEN1, legacy) — 1–10 uL" },
        { value: "p50-single-gen1", label: "P50 Single-Channel (GEN1, legacy) — 5–50 uL" },
      ],
      defaultValue: "p300-single-gen2",
    },
    {
      type: "boolean",
      key: "useApiv3",
      label: "Use API v3 (Opentrons HTTP)",
      description:
        "If true, the adapter uses Opentrons HTTP API v3 (default for OT-2 firmware ≥5.0). If false, falls back to v2 for older firmware.",
      required: false,
      order: 51,
      group: "OT-2",
      defaultValue: true,
    },
  ],

  // Pricing override — OT-2 is the lowest-cost PLR-supported instrument
  // (no Hamilton/Tecan firmware tax). Operators can override per-instance.
  pricingOverrides: {
    basePrice: "10.00",
    currency: "USDC",
  },
};
