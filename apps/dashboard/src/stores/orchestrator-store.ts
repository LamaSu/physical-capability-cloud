import { create } from "zustand";
import type { TransferGraph, Sample, InstrumentWorkflow, ResourceClaim } from "@pcc/spec";

interface OrchestratorState {
  graphs: TransferGraph[];
  samples: Sample[];
  workflows: InstrumentWorkflow[];
  claims: ResourceClaim[];
  selectedGraphId: string | null;
  selectedSampleId: string | null;
  selectedWorkflowId: string | null;

  setGraphs: (graphs: TransferGraph[]) => void;
  setSamples: (samples: Sample[]) => void;
  setWorkflows: (workflows: InstrumentWorkflow[]) => void;
  setClaims: (claims: ResourceClaim[]) => void;
  selectGraph: (id: string | null) => void;
  selectSample: (id: string | null) => void;
  selectWorkflow: (id: string | null) => void;
}

export const useOrchestratorStore = create<OrchestratorState>((set) => ({
  graphs: [],
  samples: [],
  workflows: [],
  claims: [],
  selectedGraphId: null,
  selectedSampleId: null,
  selectedWorkflowId: null,

  setGraphs: (graphs) => set({ graphs }),
  setSamples: (samples) => set({ samples }),
  setWorkflows: (workflows) => set({ workflows }),
  setClaims: (claims) => set({ claims }),
  selectGraph: (id) => set({ selectedGraphId: id }),
  selectSample: (id) => set({ selectedSampleId: id }),
  selectWorkflow: (id) => set({ selectedWorkflowId: id }),
}));
