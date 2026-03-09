import { create } from "zustand";
import type { CapabilityType, AssuranceTier } from "@pcc/spec";

export interface WorkflowStep {
  id: string;
  capability: CapabilityType;
  label: string;
  params: Record<string, unknown>;
  assuranceTier: AssuranceTier;
  dependsOn: string[];
}

interface WorkflowState {
  steps: WorkflowStep[];
  selectedStepId: string | null;
  workflowName: string;
  nextStepId: number;

  addStep: (capability: CapabilityType, label: string) => string;
  removeStep: (id: string) => void;
  updateStep: (id: string, updates: Partial<WorkflowStep>) => void;
  addDependency: (fromId: string, toId: string) => void;
  removeDependency: (fromId: string, toId: string) => void;
  selectStep: (id: string | null) => void;
  setWorkflowName: (name: string) => void;
  reset: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  steps: [],
  selectedStepId: null,
  workflowName: "New Workflow",
  nextStepId: 1,

  addStep: (capability, label) => {
    const id = `step-${get().nextStepId}`;
    set((s) => ({
      steps: [...s.steps, { id, capability, label, params: {}, assuranceTier: 1, dependsOn: [] }],
      nextStepId: s.nextStepId + 1,
      selectedStepId: id,
    }));
    return id;
  },

  removeStep: (id) =>
    set((s) => ({
      steps: s.steps
        .filter((step) => step.id !== id)
        .map((step) => ({ ...step, dependsOn: step.dependsOn.filter((d) => d !== id) })),
      selectedStepId: s.selectedStepId === id ? null : s.selectedStepId,
    })),

  updateStep: (id, updates) =>
    set((s) => ({
      steps: s.steps.map((step) => (step.id === id ? { ...step, ...updates } : step)),
    })),

  addDependency: (fromId, toId) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === toId && !step.dependsOn.includes(fromId)
          ? { ...step, dependsOn: [...step.dependsOn, fromId] }
          : step,
      ),
    })),

  removeDependency: (fromId, toId) =>
    set((s) => ({
      steps: s.steps.map((step) =>
        step.id === toId ? { ...step, dependsOn: step.dependsOn.filter((d) => d !== fromId) } : step,
      ),
    })),

  selectStep: (id) => set({ selectedStepId: id }),
  setWorkflowName: (name) => set({ workflowName: name }),
  reset: () => set({ steps: [], selectedStepId: null, workflowName: "New Workflow", nextStepId: 1 }),
}));
