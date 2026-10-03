import { create } from "zustand";
import { accountScoped } from "../lib/account-scope.js";
import type { EarningsPeriod } from "@pcc/ui";

type OperatorTab = "overview" | "approvals" | "earnings" | "certifications" | "maintenance";

interface OperatorState {
  selectedMachineId: string | null;
  earningsPeriod: EarningsPeriod;
  activeTab: OperatorTab;

  setSelectedMachine: (id: string | null) => void;
  setEarningsPeriod: (p: EarningsPeriod) => void;
  setActiveTab: (t: OperatorTab) => void;
}

export const useOperatorStore = create<OperatorState>((set) => ({
  selectedMachineId: null,
  earningsPeriod: "30d",
  activeTab: "overview",

  setSelectedMachine: (id) => set({ selectedMachineId: id }),
  setEarningsPeriod: (p) => set({ earningsPeriod: p }),
  setActiveTab: (t) => set({ activeTab: t }),
}));

// The signed-in account's state: reset on every account change (lib/account-scope.ts).
accountScoped(useOperatorStore);
