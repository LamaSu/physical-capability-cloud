import { create } from "zustand";

export interface StepDraft {
  id: string;
  capabilityType: string;
  label: string;
  action: string;
  params: Record<string, unknown>;
  estimatedDurationMs: number;
  requiredLabware: string;
  producesEvidence: boolean;
  dependsOn: string[];
  position: { x: number; y: number };
  notes: string;
}

export interface TransferDraft {
  id: string;
  fromStepId: string;
  toStepId: string;
  labwareType: string;
  preferredAutomationLevel: string;
  notes: string;
}

export interface ParamDraft {
  key: string;
  label: string;
  type: string;
  required: boolean;
  group: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

interface ProtocolBuilderState {
  // Template metadata
  name: string;
  description: string;
  version: string;
  tags: string[];

  // Steps (nodes in DAG)
  steps: StepDraft[];
  selectedStepId: string | null;

  // Transfers (edges)
  transfers: TransferDraft[];
  selectedTransferId: string | null;

  // Parameters
  parameters: ParamDraft[];
  defaultValues: Record<string, string | number | boolean>;

  // Counters
  nextStepId: number;
  nextTransferId: number;
  nextParamId: number;

  // Actions
  setMeta: (meta: Partial<{ name: string; description: string; version: string; tags: string[] }>) => void;
  addStep: (capabilityType: string, label: string, position: { x: number; y: number }) => string;
  removeStep: (id: string) => void;
  updateStep: (id: string, updates: Partial<StepDraft>) => void;
  selectStep: (id: string | null) => void;
  addTransfer: (fromStepId: string, toStepId: string) => string;
  removeTransfer: (id: string) => void;
  updateTransfer: (id: string, updates: Partial<TransferDraft>) => void;
  selectTransfer: (id: string | null) => void;
  addParameter: () => void;
  removeParameter: (key: string) => void;
  updateParameter: (key: string, updates: Partial<ParamDraft>) => void;
  reset: () => void;
}

export const useProtocolBuilderStore = create<ProtocolBuilderState>((set, get) => ({
  name: "New Protocol",
  description: "",
  version: "0.1.0",
  tags: [],

  steps: [],
  selectedStepId: null,

  transfers: [],
  selectedTransferId: null,

  parameters: [],
  defaultValues: {},

  nextStepId: 1,
  nextTransferId: 1,
  nextParamId: 1,

  setMeta: (meta) => set(meta),

  addStep: (capabilityType, label, position) => {
    const id = `pstep-${get().nextStepId}`;
    set((s) => ({
      steps: [
        ...s.steps,
        {
          id,
          capabilityType,
          label,
          action: "",
          params: {},
          estimatedDurationMs: 60_000,
          requiredLabware: "plate_96",
          producesEvidence: false,
          dependsOn: [],
          position,
          notes: "",
        },
      ],
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
      transfers: s.transfers.filter((t) => t.fromStepId !== id && t.toStepId !== id),
      selectedStepId: s.selectedStepId === id ? null : s.selectedStepId,
    })),

  updateStep: (id, updates) =>
    set((s) => ({
      steps: s.steps.map((step) => (step.id === id ? { ...step, ...updates } : step)),
    })),

  selectStep: (id) => set({ selectedStepId: id, selectedTransferId: null }),

  addTransfer: (fromStepId, toStepId) => {
    const id = `ptransfer-${get().nextTransferId}`;
    set((s) => ({
      transfers: [
        ...s.transfers,
        {
          id,
          fromStepId,
          toStepId,
          labwareType: "plate_96",
          preferredAutomationLevel: "manual",
          notes: "",
        },
      ],
      nextTransferId: s.nextTransferId + 1,
      // Also add dependency
      steps: s.steps.map((step) =>
        step.id === toStepId && !step.dependsOn.includes(fromStepId)
          ? { ...step, dependsOn: [...step.dependsOn, fromStepId] }
          : step,
      ),
    }));
    return id;
  },

  removeTransfer: (id) =>
    set((s) => {
      const transfer = s.transfers.find((t) => t.id === id);
      return {
        transfers: s.transfers.filter((t) => t.id !== id),
        selectedTransferId: s.selectedTransferId === id ? null : s.selectedTransferId,
        // Remove dependency
        steps: transfer
          ? s.steps.map((step) =>
              step.id === transfer.toStepId
                ? { ...step, dependsOn: step.dependsOn.filter((d) => d !== transfer.fromStepId) }
                : step,
            )
          : s.steps,
      };
    }),

  updateTransfer: (id, updates) =>
    set((s) => ({
      transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

  selectTransfer: (id) => set({ selectedTransferId: id, selectedStepId: null }),

  addParameter: () => {
    const key = `param_${get().nextParamId}`;
    set((s) => ({
      parameters: [
        ...s.parameters,
        {
          key,
          label: `Parameter ${s.nextParamId}`,
          type: "string",
          required: false,
          group: "General",
          defaultValue: "",
          options: [],
        },
      ],
      nextParamId: s.nextParamId + 1,
    }));
  },

  removeParameter: (key) =>
    set((s) => ({
      parameters: s.parameters.filter((p) => p.key !== key),
      defaultValues: Object.fromEntries(
        Object.entries(s.defaultValues).filter(([k]) => k !== key),
      ),
    })),

  updateParameter: (key, updates) =>
    set((s) => ({
      parameters: s.parameters.map((p) => (p.key === key ? { ...p, ...updates } : p)),
    })),

  reset: () =>
    set({
      name: "New Protocol",
      description: "",
      version: "0.1.0",
      tags: [],
      steps: [],
      selectedStepId: null,
      transfers: [],
      selectedTransferId: null,
      parameters: [],
      defaultValues: {},
      nextStepId: 1,
      nextTransferId: 1,
      nextParamId: 1,
    }),
}));
