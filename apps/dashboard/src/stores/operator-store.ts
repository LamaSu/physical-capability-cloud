import { create } from "zustand";
import type { EarningsPeriod } from "@pcc/ui";

interface OperatorState {
  selectedMachineId: string | null;
  earningsPeriod: EarningsPeriod;
  activeTab: "overview" | "earnings" | "certifications" | "maintenance";

  setSelectedMachine: (id: string | null) => void;
  setEarningsPeriod: (p: EarningsPeriod) => void;
  setActiveTab: (t: "overview" | "earnings" | "certifications" | "maintenance") => void;
}

export const useOperatorStore = create<OperatorState>((set) => ({
  selectedMachineId: null,
  earningsPeriod: "30d",
  activeTab: "overview",

  setSelectedMachine: (id) => set({ selectedMachineId: id }),
  setEarningsPeriod: (p) => set({ earningsPeriod: p }),
  setActiveTab: (t) => set({ activeTab: t }),
}));
