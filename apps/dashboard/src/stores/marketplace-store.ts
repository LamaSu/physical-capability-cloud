import { create } from "zustand";

/**
 * The ROI calculator's inputs, exactly as the viewer typed them. They start
 * blank: the calculator shows an estimate only from numbers the viewer
 * entered, never from pre-filled figures.
 */
export interface ROIInputs {
  equipmentCost: string;
  monthlyCost: string;
  avgJobValue: string;
  jobsPerMonth: string;
}

interface MarketplaceState {
  roiInputs: ROIInputs;
  updateROIInput: (key: keyof ROIInputs, value: string) => void;
}

const EMPTY_ROI_INPUTS: ROIInputs = {
  equipmentCost: "",
  monthlyCost: "",
  avgJobValue: "",
  jobsPerMonth: "",
};

export const useMarketplaceStore = create<MarketplaceState>((set) => ({
  roiInputs: EMPTY_ROI_INPUTS,
  updateROIInput: (key, value) => set((s) => ({ roiInputs: { ...s.roiInputs, [key]: value } })),
}));
