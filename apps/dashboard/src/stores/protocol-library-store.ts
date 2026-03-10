import { create } from "zustand";
import type { ProtocolTemplate, ProtocolRun, AutomationStatus, TransferAgent } from "@pcc/spec";

interface ProtocolLibraryState {
  templates: ProtocolTemplate[];
  runs: ProtocolRun[];
  automationStatuses: AutomationStatus[];
  transferAgents: TransferAgent[];
  selectedTemplateId: string | null;
  selectedRunId: string | null;
  searchQuery: string;
  filterTags: string[];

  setTemplates: (t: ProtocolTemplate[]) => void;
  setRuns: (r: ProtocolRun[]) => void;
  setAutomationStatuses: (s: AutomationStatus[]) => void;
  setTransferAgents: (a: TransferAgent[]) => void;
  selectTemplate: (id: string | null) => void;
  selectRun: (id: string | null) => void;
  setSearchQuery: (q: string) => void;
  setFilterTags: (tags: string[]) => void;
}

export const useProtocolLibraryStore = create<ProtocolLibraryState>((set) => ({
  templates: [],
  runs: [],
  automationStatuses: [],
  transferAgents: [],
  selectedTemplateId: null,
  selectedRunId: null,
  searchQuery: "",
  filterTags: [],

  setTemplates: (templates) => set({ templates }),
  setRuns: (runs) => set({ runs }),
  setAutomationStatuses: (automationStatuses) => set({ automationStatuses }),
  setTransferAgents: (transferAgents) => set({ transferAgents }),
  selectTemplate: (id) => set({ selectedTemplateId: id }),
  selectRun: (id) => set({ selectedRunId: id }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setFilterTags: (filterTags) => set({ filterTags }),
}));
