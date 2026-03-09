import { create } from "zustand";
import type { EquipmentCategory } from "@pcc/spec";

interface MarketplaceState {
  selectedCategory: EquipmentCategory | "all";
  selectedClassId: string | null;
  roiInputs: {
    equipmentCost: number;
    monthlyCost: number;
    avgJobValue: number;
    estimatedUtilization: number;
  };
  demandFilter: "all" | "high" | "medium" | "low";
  sortBy: "demand" | "price" | "machines";

  setCategory: (c: EquipmentCategory | "all") => void;
  setSelectedClass: (id: string | null) => void;
  updateROIInput: (key: string, value: number) => void;
  setDemandFilter: (f: "all" | "high" | "medium" | "low") => void;
  setSortBy: (s: "demand" | "price" | "machines") => void;
}

export const useMarketplaceStore = create<MarketplaceState>((set) => ({
  selectedCategory: "all",
  selectedClassId: null,
  roiInputs: {
    equipmentCost: 5000,
    monthlyCost: 200,
    avgJobValue: 30,
    estimatedUtilization: 65,
  },
  demandFilter: "all",
  sortBy: "demand",

  setCategory: (c) => set({ selectedCategory: c }),
  setSelectedClass: (id) => set({ selectedClassId: id }),
  updateROIInput: (key, value) => set((s) => ({ roiInputs: { ...s.roiInputs, [key]: value } })),
  setDemandFilter: (f) => set({ demandFilter: f }),
  setSortBy: (s) => set({ sortBy: s }),
}));
