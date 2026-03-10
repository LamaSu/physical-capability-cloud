/**
 * ProtocolEngine — resolves abstract protocol templates into concrete
 * instrument bindings within a kernel.
 *
 * A ProtocolTemplate specifies capability types, not specific instruments.
 * The engine maps each step to the best matching TransferNode, resolves
 * parameter bindings, and produces a ProtocolRun ready for execution.
 */

import type {
  ProtocolTemplate,
  ProtocolStep,
  ProtocolRun,
  ProtocolRunStep,
  ProtocolRunTransfer,
  TransferNode,
  AutomationLevel,
} from "@pcc/spec";
import { ids } from "@pcc/spec";

import { TransferGraphBuilder } from "./transfer-graph.js";
import { ResourcePool } from "./resource-pool.js";
import { AutomationTracker } from "./automation-tracker.js";

export class ProtocolEngine {
  constructor(
    private graphBuilder: TransferGraphBuilder,
    private pool: ResourcePool,
    private automationTracker: AutomationTracker,
  ) {}

  // ── Binding ──────────────────────────────────────────────────────

  /**
   * Bind a protocol template to real instruments in a kernel.
   * Each abstract ProtocolStep is assigned to the best matching TransferNode.
   */
  bindProtocol(
    template: ProtocolTemplate,
    kernelId: string,
    parameterValues: Record<string, string | number | boolean>,
    initiatedBy: string,
  ): ProtocolRun {
    // Build a mapping: protocolStepId → nodeId
    const stepNodeMap = new Map<string, string>();
    let prevNodeId: string | undefined;

    const runSteps: ProtocolRunStep[] = [];

    for (const step of template.steps) {
      const candidates = this.findCandidateNodes(step.capabilityType, prevNodeId);
      if (candidates.length === 0) {
        throw new Error(
          `No instrument found for capability "${step.capabilityType}" required by step "${step.label}"`,
        );
      }

      const selectedNode = candidates[0]; // Best candidate (nearest if preferNearNode was set)
      stepNodeMap.set(step.id, selectedNode.id);

      const resolvedParams = this.resolveParams(step, parameterValues);

      const runStep: ProtocolRunStep = {
        id: ids.protocolRunStep(),
        protocolStepId: step.id,
        nodeId: selectedNode.id,
        deviceId: selectedNode.deviceId,
        action: step.action,
        resolvedParams,
        status: "pending",
      };

      runSteps.push(runStep);
      prevNodeId = selectedNode.id;
    }

    // Build run transfers from template transfers
    const runTransfers: ProtocolRunTransfer[] = [];

    for (const transfer of template.transfers) {
      const fromNodeId = stepNodeMap.get(transfer.fromStepId);
      const toNodeId = stepNodeMap.get(transfer.toStepId);

      if (!fromNodeId || !toNodeId) {
        throw new Error(
          `Transfer references unbound step: from=${transfer.fromStepId} to=${transfer.toStepId}`,
        );
      }

      // Determine automation level from tracker or transfer preference
      let automationLevel: AutomationLevel = transfer.preferredAutomationLevel ?? "manual";
      const automationStatus = this.automationTracker.getStatus(fromNodeId, toNodeId);
      if (automationStatus) {
        automationLevel = automationStatus.currentLevel;
      }

      // Determine mechanism based on automation level
      let mechanism: string = "robot_arm";
      if (automationLevel === "manual") {
        mechanism = "manual";
      } else if (automationLevel === "teleoperated" || automationLevel === "pilot_operated") {
        mechanism = "robot_teleoperated";
      } else if (automationLevel === "vla_assisted" || automationLevel === "fully_autonomous") {
        mechanism = "robot_autonomous";
      }

      const runTransfer: ProtocolRunTransfer = {
        id: ids.protocolRunTransfer(),
        protocolTransferId: transfer.id,
        fromNodeId,
        toNodeId,
        transferAgentId: automationStatus?.transferAgentId,
        automationLevel,
        mechanism,
        episodeRecorded: false,
        status: "pending",
      };

      runTransfers.push(runTransfer);
    }

    const run: ProtocolRun = {
      id: ids.protocolRun(),
      templateId: template.id,
      templateVersion: template.version,
      kernelId,
      parameterValues,
      steps: runSteps,
      transfers: runTransfers,
      status: "ready",
      currentStepIndex: 0,
      initiatedBy,
      sampleIds: [],
      createdAt: new Date().toISOString(),
    };

    return run;
  }

  // ── Node discovery ───────────────────────────────────────────────

  /**
   * Find instrument nodes matching a capability type.
   * If preferNearNode is provided, results are sorted by proximity
   * (shortest transfer path from that node).
   */
  findCandidateNodes(
    capabilityType: string,
    preferNearNode?: string,
  ): TransferNode[] {
    const allNodes = this.graphBuilder.getNodes();
    const matches = allNodes.filter((node) =>
      node.capabilities.includes(capabilityType),
    );

    if (!preferNearNode || matches.length <= 1) {
      return matches;
    }

    // Sort by distance from preferNearNode
    const withDistance = matches.map((node) => {
      const path = this.graphBuilder.findPath(preferNearNode, node.id);
      const distance = path ? path.totalTimeMs : Infinity;
      return { node, distance };
    });

    withDistance.sort((a, b) => a.distance - b.distance);
    return withDistance.map((wd) => wd.node);
  }

  // ── Parameter resolution ─────────────────────────────────────────

  /**
   * Resolve parameter bindings: substitute protocol-level parameter values
   * into step-level parameters.
   */
  resolveParams(
    step: ProtocolStep,
    parameterValues: Record<string, string | number | boolean>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = { ...step.params };

    if (step.parameterBindings) {
      for (const binding of step.parameterBindings) {
        if (binding.protocolParamKey in parameterValues) {
          resolved[binding.stepParamKey] = parameterValues[binding.protocolParamKey];
        }
      }
    }

    return resolved;
  }

  // ── Validation ───────────────────────────────────────────────────

  /**
   * Validate that a protocol can execute in this kernel.
   * Checks that all required capabilities exist and transfer paths are reachable.
   */
  validateBinding(
    template: ProtocolTemplate,
  ): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check all required capabilities have at least one matching node
    for (const cap of template.requiredCapabilities) {
      const candidates = this.findCandidateNodes(cap);
      if (candidates.length === 0) {
        errors.push(`No instrument found for required capability "${cap}"`);
      } else if (candidates.length === 1) {
        warnings.push(`Only one instrument available for capability "${cap}" — no redundancy`);
      }
    }

    // Check that each step's capability is available
    const stepNodeMap = new Map<string, string>();
    for (const step of template.steps) {
      const candidates = this.findCandidateNodes(step.capabilityType);
      if (candidates.length === 0) {
        errors.push(
          `Step "${step.label}" requires capability "${step.capabilityType}" — not available`,
        );
      } else {
        stepNodeMap.set(step.id, candidates[0].id);
      }
    }

    // Check that all transfers have reachable paths
    for (const transfer of template.transfers) {
      const fromNodeId = stepNodeMap.get(transfer.fromStepId);
      const toNodeId = stepNodeMap.get(transfer.toStepId);

      if (fromNodeId && toNodeId && fromNodeId !== toNodeId) {
        const path = this.graphBuilder.findPath(fromNodeId, toNodeId);
        if (!path) {
          errors.push(
            `No transfer path between step "${transfer.fromStepId}" (node ${fromNodeId}) and step "${transfer.toStepId}" (node ${toNodeId})`,
          );
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}
