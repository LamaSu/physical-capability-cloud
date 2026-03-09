/**
 * Contract Builder E2E Demo
 *
 * Demonstrates the declarative contract builder system:
 *
 *   1. User asks "what options for FDM printing?"
 *   2. Broker returns full parameter schema (9 params, 4 groups)
 *   3. User selects: PLA, 40% infill, 0.15mm layers, tree supports, black, sanding
 *   4. Each selection dynamically updates pricing + constrains other options
 *   5. User builds contract → validated, priced, CWM step ready
 *   6. Compared with a CNC contract to show reconfigurability
 *   7. Shows machine profile constraints (Prusa MK4)
 *
 * Run: npx tsx scripts/contract-builder-demo.ts
 */

import { MessageBus } from "@pcc/a2a";
import { UserAgent } from "@pcc/agent-user";
import { BrokerAgent } from "@pcc/agent-broker";
import { KernelAgent } from "@pcc/agent-kernel";
import type { Capability } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { prusaMk4Profile, haasVf2Profile } from "@pcc/contract-builder";

const DIVIDER = "═".repeat(72);
const SECTION = "─".repeat(72);

function log(agent: string, msg: string) {
  const color: Record<string, string> = {
    USER: "\x1b[36m",    // cyan
    BROKER: "\x1b[33m",  // yellow
    KERNEL: "\x1b[32m",  // green
    SYSTEM: "\x1b[35m",  // magenta
    BUILDER: "\x1b[34m", // blue
    PRICE: "\x1b[91m",   // bright red
  };
  const c = color[agent] ?? "\x1b[0m";
  const reset = "\x1b[0m";
  console.log(`${c}[${agent.padEnd(8)}]${reset} ${msg}`);
}

function heading(title: string) {
  console.log(`\n${SECTION}`);
  console.log(`  ${title}`);
  console.log(SECTION);
}

function subheading(title: string) {
  console.log(`\n  \x1b[1m${title}\x1b[0m`);
}

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(DIVIDER);
  console.log("  CONTRACT BUILDER — E2E DEMO");
  console.log("  Schema-driven manufacturing configuration with dynamic pricing");
  console.log(DIVIDER);

  // ── Setup ──────────────────────────────────────────────────────

  heading("1. Setting up agents");

  const bus = new MessageBus();

  const broker = new BrokerAgent(bus);
  broker.start();
  log("BROKER", "Broker agent started");

  // Create a kernel with FDM + CNC capabilities
  const fdmCapability: Capability = {
    id: ids.capability(),
    kernelId: "kernel_maker_space_1",
    type: "fdm",
    name: "Prusa MK4 FDM Printer",
    materials: ["pla", "petg", "abs", "tpu"],
    assuranceTiers: [0, 1, 2],
    pricing: { currency: "USDC", baseCost: "12.00", perMinute: "0.10", minimum: "10.00" },
    availability: { timezone: "America/New_York", windows: {} },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 0,
  };

  const cncCapability: Capability = {
    id: ids.capability(),
    kernelId: "kernel_maker_space_1",
    type: "cnc-3axis",
    name: "Haas VF-2 CNC Mill",
    materials: ["aluminum-6061", "aluminum-7075", "steel-1018", "brass", "delrin"],
    assuranceTiers: [0, 1, 2, 3],
    pricing: { currency: "USDC", baseCost: "85.00", perMinute: "1.50", minimum: "50.00" },
    availability: { timezone: "America/New_York", windows: {} },
    location: { lat: 40.7128, lng: -74.006 },
    queueDepth: 0,
  };

  // Set kernel IDs on profiles
  const fdmProfile = { ...prusaMk4Profile, kernelId: "kernel_maker_space_1" };
  const cncProfile = { ...haasVf2Profile, kernelId: "kernel_maker_space_1" };

  const kernel = new KernelAgent(bus, {
    kernelId: "kernel_maker_space_1",
    name: "NYC Maker Space",
    location: { lat: 40.7128, lng: -74.006 },
    capabilities: [fdmCapability, cncCapability],
    mockPrintDuration: 1000,
    machineProfiles: [fdmProfile, cncProfile],
  });
  kernel.start();
  log("KERNEL", "Kernel agent started (NYC Maker Space: FDM + CNC)");

  // Register with broker
  broker.registerKernelCapabilities(kernel.id, {
    kernelId: "kernel_maker_space_1",
    capabilities: [fdmCapability, cncCapability],
    reputation: 95,
  });
  broker.registerMachineProfile(fdmProfile);
  broker.registerMachineProfile(cncProfile);
  log("BROKER", "Registered kernel capabilities + machine profiles");

  const user = new UserAgent(bus);
  user.start();
  log("USER", "User agent started");

  // Collect notifications
  const notifications: any[] = [];
  user.onNotification((n) => notifications.push(n));

  // ── Demo 1: Explore FDM Build Options ──────────────────────────

  heading("2. User explores FDM build options");
  log("USER", 'Asking: "What options are available for FDM printing?"');

  await user.exploreBuildOptions({ capabilityType: "fdm" });
  await wait(100);

  const optionsNotif = notifications.find((n) => n.type === "build_options");
  if (optionsNotif) {
    log("BROKER", `Responded with build options`);
    log("SYSTEM", optionsNotif.summary);

    const data = optionsNotif.data as any;
    subheading("Available Parameter Groups:");
    for (const group of data.groups) {
      console.log(`\n    \x1b[1m${group.name}\x1b[0m`);
      for (const param of group.params) {
        const reqTag = param.required ? " \x1b[31m(required)\x1b[0m" : "";
        const typeTag = `\x1b[90m[${param.type}]\x1b[0m`;
        console.log(`      ${param.label} ${typeTag}${reqTag}`);
        if (param.description) {
          console.log(`        \x1b[90m${param.description}\x1b[0m`);
        }
        if (param.options) {
          for (const opt of param.options.slice(0, 4)) {
            const price = opt.pricingImpact ? ` \x1b[91m(${opt.pricingImpact.label})\x1b[0m` : "";
            console.log(`          • ${opt.label}${price}`);
          }
          if (param.options.length > 4) {
            console.log(`          \x1b[90m... and ${param.options.length - 4} more\x1b[0m`);
          }
        }
        if (param.min !== undefined) {
          const priceNote = param.pricingImpact ? ` \x1b[91m(${param.pricingImpact.label})\x1b[0m` : "";
          console.log(`          Range: ${param.min}–${param.max} ${param.unit ?? ""}${priceNote}`);
        }
      }
    }
  }

  // ── Demo 2: Build FDM contract with selections ──────────────────

  heading("3. User configures and builds an FDM contract");

  const fdmSelections = {
    material: "pla",
    color: "black",
    infill: 40,
    layerHeight: "0.15",
    supports: true,
    supportType: "tree",
    wallCount: 4,
    postProcessing: ["sanding"],
    quantity: 2,
  };

  log("USER", "Selecting options:");
  log("USER", `  Material: PLA, Color: Black`);
  log("USER", `  Infill: 40%, Layer Height: 0.15mm (Fine)`);
  log("USER", `  Supports: Yes (Tree), Wall Count: 4`);
  log("USER", `  Post-Processing: Sanding`);
  log("USER", `  Quantity: 2`);

  notifications.length = 0;
  await user.buildContract({
    capabilityType: "fdm",
    selections: fdmSelections,
    assuranceTier: 1,
  });
  await wait(100);

  const fdmContractNotif = notifications.find((n) => n.type === "contract_built");
  if (fdmContractNotif) {
    const contract = fdmContractNotif.data as any;
    log("BROKER", "Contract built successfully!");
    log("SYSTEM", fdmContractNotif.summary);

    subheading("Price Breakdown:");
    console.log(`    Base Price:                    $15.00`);
    for (const item of contract.priceBreakdown) {
      const sign = parseFloat(item.amount) >= 0 ? "+" : "";
      console.log(`    ${item.paramLabel} (${item.selectedValue}):`.padEnd(40) + `${sign}$${item.amount}  \x1b[90m${item.impactLabel ?? ""}\x1b[0m`);
    }
    console.log(`    ${"─".repeat(44)}`);
    console.log(`    \x1b[1mTotal (${fdmSelections.quantity} units):`.padEnd(49) + `$${contract.totalPrice}\x1b[0m`);
    console.log(`    Valid: ${contract.isValid ? "\x1b[32m✓ Yes\x1b[0m" : "\x1b[31m✗ No\x1b[0m"}`);

    subheading("Generated CWM Step:");
    console.log(`    Capability: ${contract.cwmStep.capability}`);
    console.log(`    Assurance Tier: ${contract.cwmStep.assuranceTier}`);
    console.log(`    Params: ${JSON.stringify(contract.cwmStep.params, null, 2).split("\n").join("\n    ")}`);
  }

  // ── Demo 3: Show constraint resolution ──────────────────────────

  heading("4. Constraint resolution demo");

  log("BUILDER", "Showing how constraints work dynamically:");

  // Show that PLA excludes vapor smoothing
  notifications.length = 0;
  await user.exploreBuildOptions({
    capabilityType: "fdm",
    currentSelections: { material: "pla" },
  });
  await wait(100);

  const constrainedNotif = notifications.find((n) => n.type === "build_options");
  if (constrainedNotif) {
    const data = constrainedNotif.data as any;
    const postProc = data.groups.flatMap((g: any) => g.params).find((p: any) => p.key === "postProcessing");
    const availableOpts = postProc?.options?.map((o: any) => o.value) ?? [];
    log("BUILDER", `Material=PLA → Post-processing options: ${availableOpts.join(", ")}`);
    log("BUILDER", `  (vapor-smoothing excluded because PLA can't be vapor smoothed)`);
  }

  // Show high infill constraint
  notifications.length = 0;
  await user.exploreBuildOptions({
    capabilityType: "fdm",
    currentSelections: { infill: 90 },
  });
  await wait(100);

  const highInfillNotif = notifications.find((n) => n.type === "build_options");
  if (highInfillNotif) {
    const data = highInfillNotif.data as any;
    const layerHeight = data.groups.flatMap((g: any) => g.params).find((p: any) => p.key === "layerHeight");
    const availableHeights = layerHeight?.options?.map((o: any) => o.value) ?? [];
    log("BUILDER", `Infill=90% → Layer heights restricted to: ${availableHeights.join(", ")}`);
    log("BUILDER", `  (ultra-fine/fine layers too slow at high infill)`);
  }

  // ── Demo 4: Machine profile constraints ─────────────────────────

  heading("5. Machine profile: Prusa MK4 restrictions");

  notifications.length = 0;
  await user.exploreBuildOptions({
    capabilityType: "fdm",
    profileId: "profile_prusa_mk4",
  });
  await wait(100);

  const profileNotif = notifications.find((n) => n.type === "build_options");
  if (profileNotif) {
    const data = profileNotif.data as any;
    log("BUILDER", `Machine: ${data.machineInfo?.machineName ?? "generic"}`);
    const materialParam = data.groups.flatMap((g: any) => g.params).find((p: any) => p.key === "material");
    const materials = materialParam?.options?.map((o: any) => o.label) ?? [];
    log("BUILDER", `Available materials: ${materials.join(", ")}`);
    log("BUILDER", `  (Nylon, PC, ASA, CF-Nylon excluded — no hardened nozzle / enclosure)`);
    log("BUILDER", `Base price: $${data.basePrice} (vs $15 generic)`);
  }

  // ── Demo 5: CNC contract for comparison ─────────────────────────

  heading("6. Cross-process: CNC 3-Axis contract");

  log("USER", "Now configuring a CNC part for comparison...");

  const cncSelections = {
    material: "aluminum-6061",
    tolerance: "precision",
    surfaceFinish: "bead-blast",
    deburring: true,
    threadInserts: true,
    coolant: "flood",
    quantity: 5,
  };

  log("USER", `  Material: Aluminum 6061-T6`);
  log("USER", `  Tolerance: Precision (±0.05mm)`);
  log("USER", `  Surface: Bead Blasted`);
  log("USER", `  Deburring: Yes, Threading: Yes`);
  log("USER", `  Quantity: 5`);

  notifications.length = 0;
  await user.buildContract({
    capabilityType: "cnc-3axis",
    selections: cncSelections,
    assuranceTier: 2,
  });
  await wait(100);

  const cncContractNotif = notifications.find((n) => n.type === "contract_built");
  if (cncContractNotif) {
    const contract = cncContractNotif.data as any;
    log("BROKER", "CNC Contract built!");
    log("SYSTEM", cncContractNotif.summary);

    subheading("CNC Price Breakdown:");
    console.log(`    Base Price:                    $75.00`);
    for (const item of contract.priceBreakdown) {
      const sign = parseFloat(item.amount) >= 0 ? "+" : "";
      console.log(`    ${item.paramLabel} (${item.selectedValue}):`.padEnd(40) + `${sign}$${item.amount}  \x1b[90m${item.impactLabel ?? ""}\x1b[0m`);
    }
    console.log(`    ${"─".repeat(44)}`);
    console.log(`    \x1b[1mTotal (${cncSelections.quantity} units):`.padEnd(49) + `$${contract.totalPrice}\x1b[0m`);
    console.log(`    Assurance Tier: ${contract.cwmStep.assuranceTier}`);
  }

  // ── Demo 6: Validation error demo ──────────────────────────────

  heading("7. Validation error demo");

  log("USER", "Attempting to build a contract with errors...");

  notifications.length = 0;
  await user.buildContract({
    capabilityType: "fdm",
    selections: {
      // Missing required: material, infill, layerHeight, quantity
      color: "black",
      wallCount: 3,
    },
    assuranceTier: 1,
  });
  await wait(100);

  const errorNotif = notifications.find((n) => n.type === "contract_built");
  if (errorNotif) {
    const contract = errorNotif.data as any;
    log("SYSTEM", `Valid: ${contract.isValid ? "Yes" : "No"}`);
    log("SYSTEM", `Errors:`);
    for (const err of contract.validationErrors) {
      console.log(`    \x1b[31m✗\x1b[0m ${err.paramKey}: ${err.message}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────

  heading("8. Summary");

  console.log(`
    The contract builder enables:

    \x1b[1m1. Dynamic Parameter Discovery\x1b[0m
       → Users see every knob they can turn, with descriptions

    \x1b[1m2. Per-Option Pricing\x1b[0m
       → Each selection shows its pricing impact before committing

    \x1b[1m3. Cross-Parameter Constraints\x1b[0m
       → Material choice restricts post-processing, infill restricts layers

    \x1b[1m4. Machine-Specific Profiles\x1b[0m
       → Each kernel's machines constrain what the template allows

    \x1b[1m5. Process Agnostic\x1b[0m
       → Same system works for FDM, SLA, CNC, Laser — just add a template

    \x1b[1m6. CWM Step Generation\x1b[0m
       → Validated contracts produce ready-to-submit workflow steps
  `);

  // Cleanup
  user.stop();
  broker.stop();
  kernel.stop();

  console.log(DIVIDER);
  console.log("  Demo complete!");
  console.log(DIVIDER);
}

main().catch(console.error);
