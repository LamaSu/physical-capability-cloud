/**
 * Protocol Compiler — converts abstract PCC ProtocolSteps into
 * Opentrons Python Protocol API code.
 *
 * Takes a ProtocolTemplate (abstract capability-based steps) and
 * produces a valid Opentrons .py file that can be uploaded and run.
 */

import type { ProtocolStep, ProtocolTemplate, ProtocolParameter } from "@pcc/spec";
import type { DeckLayout, LabwareDef, PipetteMount } from "./types.js";

// ── Compiled Protocol ─────────────────────────────────────────────

export interface CompiledProtocol {
  /** The Python source code */
  source: string;
  /** Protocol metadata */
  metadata: {
    protocolName: string;
    author: string;
    description: string;
    apiLevel: string;
  };
  /** Estimated duration in ms */
  estimatedDurationMs: number;
  /** Labware required (for deck validation) */
  requiredLabware: string[];
  /** Warnings or notes */
  warnings: string[];
}

// ── Compiler ──────────────────────────────────────────────────────

export class ProtocolCompiler {
  private apiLevel: string;

  constructor(apiLevel = "2.18") {
    this.apiLevel = apiLevel;
  }

  /**
   * Compile a PCC ProtocolTemplate into Opentrons Python code.
   *
   * @param template - Abstract protocol template from PCC
   * @param params - Resolved parameter values
   * @param deck - Target deck layout (labware positions)
   */
  compile(
    template: ProtocolTemplate,
    params: Record<string, string | number | boolean>,
    deck: DeckLayout,
  ): CompiledProtocol {
    const warnings: string[] = [];
    const requiredLabware: string[] = [];

    // Merge default values with provided params
    const resolvedParams = { ...template.defaultValues, ...params };

    // Build the Python code
    const lines: string[] = [];

    // Metadata block
    lines.push(`metadata = {`);
    lines.push(`    'protocolName': '${this.escape(template.name)}',`);
    lines.push(`    'author': 'PCC Protocol Compiler',`);
    lines.push(`    'description': '${this.escape(template.description)}',`);
    lines.push(`    'apiLevel': '${this.apiLevel}',`);
    lines.push(`}`);
    lines.push(``);

    // Main run function
    lines.push(`def run(protocol):`);

    // Load labware from deck layout
    const labwareVars: Map<string, string> = new Map();
    let labwareIdx = 0;
    for (const [slot, labware] of Object.entries(deck.slots)) {
      if (!labware) continue;
      const varName = `labware_${labwareIdx++}`;
      labwareVars.set(slot, varName);
      requiredLabware.push(labware.loadName);
      lines.push(`    ${varName} = protocol.load_labware('${labware.loadName}', '${slot}')  # ${labware.displayName}`);
    }

    // Load pipettes (derive from deck or default)
    lines.push(`    left_pipette = protocol.load_instrument('p300_single_gen2', 'left')`);
    lines.push(`    right_pipette = protocol.load_instrument('p20_single_gen2', 'right')`);
    lines.push(``);

    // Compile each step in order (respecting dependsOn DAG)
    const ordered = this.topologicalSort(template.steps);
    let totalDuration = 0;

    for (const step of ordered) {
      lines.push(`    # Step: ${this.escape(step.label)}`);
      const stepLines = this.compileStep(step, resolvedParams, labwareVars, warnings);
      lines.push(...stepLines.map((l) => `    ${l}`));
      lines.push(``);
      totalDuration += step.estimatedDurationMs;
    }

    // Protocol complete
    lines.push(`    protocol.comment('Protocol complete')`);

    return {
      source: lines.join("\n"),
      metadata: {
        protocolName: template.name,
        author: "PCC Protocol Compiler",
        description: template.description,
        apiLevel: this.apiLevel,
      },
      estimatedDurationMs: totalDuration,
      requiredLabware,
      warnings,
    };
  }

  /**
   * Compile a single abstract step into Python lines.
   */
  private compileStep(
    step: ProtocolStep,
    params: Record<string, string | number | boolean>,
    labwareVars: Map<string, string>,
    warnings: string[],
  ): string[] {
    const lines: string[] = [];
    const p = { ...step.params };

    // Resolve parameter bindings
    if (step.parameterBindings) {
      for (const binding of step.parameterBindings) {
        if (params[binding.protocolParamKey] !== undefined) {
          p[binding.stepParamKey] = params[binding.protocolParamKey];
        }
      }
    }

    switch (step.action) {
      case "aspirate": {
        const vol = p.volume ?? 100;
        const well = p.well ?? "A1";
        const slot = String(p.slot ?? "1");
        const labware = labwareVars.get(slot) ?? `protocol.loaded_labwares[${slot}]`;
        const pipette = p.pipette === "right" ? "right_pipette" : "left_pipette";
        lines.push(`${pipette}.aspirate(${vol}, ${labware}['${well}'])`);
        break;
      }

      case "dispense": {
        const vol = p.volume ?? 100;
        const well = p.well ?? "A1";
        const slot = String(p.slot ?? "2");
        const labware = labwareVars.get(slot) ?? `protocol.loaded_labwares[${slot}]`;
        const pipette = p.pipette === "right" ? "right_pipette" : "left_pipette";
        lines.push(`${pipette}.dispense(${vol}, ${labware}['${well}'])`);
        break;
      }

      case "transfer": {
        const vol = p.volume ?? 100;
        const srcWell = p.sourceWell ?? "A1";
        const dstWell = p.destWell ?? "A1";
        const srcSlot = String(p.sourceSlot ?? "1");
        const dstSlot = String(p.destSlot ?? "2");
        const srcLabware = labwareVars.get(srcSlot) ?? `protocol.loaded_labwares[${srcSlot}]`;
        const dstLabware = labwareVars.get(dstSlot) ?? `protocol.loaded_labwares[${dstSlot}]`;
        const pipette = p.pipette === "right" ? "right_pipette" : "left_pipette";
        const newTip = p.newTip ?? "always";
        lines.push(`${pipette}.transfer(${vol}, ${srcLabware}['${srcWell}'], ${dstLabware}['${dstWell}'], new_tip='${newTip}')`);
        break;
      }

      case "mix": {
        const reps = p.repetitions ?? 3;
        const vol = p.volume ?? 100;
        const well = p.well ?? "A1";
        const slot = String(p.slot ?? "1");
        const labware = labwareVars.get(slot) ?? `protocol.loaded_labwares[${slot}]`;
        const pipette = p.pipette === "right" ? "right_pipette" : "left_pipette";
        lines.push(`${pipette}.mix(${reps}, ${vol}, ${labware}['${well}'])`);
        break;
      }

      case "distribute": {
        const vol = p.volume ?? 50;
        const srcWell = p.sourceWell ?? "A1";
        const srcSlot = String(p.sourceSlot ?? "1");
        const dstSlot = String(p.destSlot ?? "2");
        const srcLabware = labwareVars.get(srcSlot) ?? `protocol.loaded_labwares[${srcSlot}]`;
        const dstLabware = labwareVars.get(dstSlot) ?? `protocol.loaded_labwares[${dstSlot}]`;
        const pipette = p.pipette === "right" ? "right_pipette" : "left_pipette";
        const wells = p.destWells ?? ["A1", "A2", "A3"];
        const wellList = Array.isArray(wells) ? wells : [wells];
        const destStr = wellList.map((w: string) => `${dstLabware}['${w}']`).join(", ");
        lines.push(`${pipette}.distribute(${vol}, ${srcLabware}['${srcWell}'], [${destStr}])`);
        break;
      }

      case "consolidate": {
        const vol = p.volume ?? 50;
        const srcSlot = String(p.sourceSlot ?? "1");
        const dstSlot = String(p.destSlot ?? "2");
        const dstWell = p.destWell ?? "A1";
        const srcLabware = labwareVars.get(srcSlot) ?? `protocol.loaded_labwares[${srcSlot}]`;
        const dstLabware = labwareVars.get(dstSlot) ?? `protocol.loaded_labwares[${dstSlot}]`;
        const pipette = p.pipette === "right" ? "right_pipette" : "left_pipette";
        const wells = p.sourceWells ?? ["A1", "A2", "A3"];
        const wellList = Array.isArray(wells) ? wells : [wells];
        const srcStr = wellList.map((w: string) => `${srcLabware}['${w}']`).join(", ");
        lines.push(`${pipette}.consolidate(${vol}, [${srcStr}], ${dstLabware}['${dstWell}'])`);
        break;
      }

      case "thermocycler_set_temperature": {
        const temp = p.temperature ?? 95;
        const holdTime = p.holdTimeSeconds ?? 30;
        lines.push(`tc_mod = protocol.loaded_modules.get('thermocyclerModuleV2')`);
        lines.push(`if tc_mod:`);
        lines.push(`    tc_mod.set_block_temperature(${temp}, hold_time_seconds=${holdTime})`);
        break;
      }

      case "temperature_module_set": {
        const temp = p.temperature ?? 4;
        lines.push(`temp_mod = protocol.loaded_modules.get('temperatureModuleV2')`);
        lines.push(`if temp_mod:`);
        lines.push(`    temp_mod.set_temperature(${temp})`);
        break;
      }

      case "pause": {
        const msg = p.message ?? "Pausing protocol";
        lines.push(`protocol.pause('${this.escape(String(msg))}')`);
        break;
      }

      case "comment": {
        const msg = p.message ?? "";
        lines.push(`protocol.comment('${this.escape(String(msg))}')`);
        break;
      }

      case "delay": {
        const seconds = p.seconds ?? 60;
        lines.push(`protocol.delay(seconds=${seconds})`);
        break;
      }

      default:
        warnings.push(`Unknown action '${step.action}' in step '${step.label}' — skipped`);
        lines.push(`protocol.comment('WARNING: Unknown action ${step.action}')`);
    }

    return lines;
  }

  /** Topological sort of steps by dependsOn edges */
  private topologicalSort(steps: ProtocolStep[]): ProtocolStep[] {
    const visited = new Set<string>();
    const result: ProtocolStep[] = [];
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const visit = (step: ProtocolStep) => {
      if (visited.has(step.id)) return;
      visited.add(step.id);
      for (const depId of step.dependsOn) {
        const dep = stepMap.get(depId);
        if (dep) visit(dep);
      }
      result.push(step);
    };

    for (const step of steps) {
      visit(step);
    }

    return result;
  }

  private escape(s: string): string {
    return s.replace(/'/g, "\\'").replace(/\n/g, "\\n");
  }
}
