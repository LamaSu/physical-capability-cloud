import { create } from "zustand";
import type { CapabilityType, ResolvedBuildOptions, BuilderContract, AssuranceTier } from "@pcc/spec";
import { ContractBuilder, getRegisteredTypes } from "@pcc/contract-builder";

interface BuilderState {
  builder: ContractBuilder;
  selectedType: CapabilityType | null;
  profileId: string | undefined;
  selections: Record<string, string | number | boolean | string[]>;
  assuranceTier: AssuranceTier;
  resolvedOptions: ResolvedBuildOptions | null;
  contract: BuilderContract | null;
  availableTypes: CapabilityType[];

  selectType: (type: CapabilityType) => void;
  setProfile: (profileId: string | undefined) => void;
  updateSelection: (key: string, value: string | number | boolean | string[]) => void;
  setAssuranceTier: (tier: AssuranceTier) => void;
  buildContract: () => void;
  reset: () => void;
}

export const useBuilderStore = create<BuilderState>((set, get) => {
  const builder = new ContractBuilder();

  function resolve() {
    const { selectedType, selections, profileId } = get();
    if (!selectedType) return;
    try {
      const resolvedOptions = builder.getBuildOptions(selectedType, selections, profileId);
      set({ resolvedOptions });
    } catch {
      // ignore resolution errors during partial selection
    }
  }

  return {
    builder,
    selectedType: null,
    profileId: undefined,
    selections: {},
    assuranceTier: 1,
    resolvedOptions: null,
    contract: null,
    availableTypes: getRegisteredTypes() as CapabilityType[],

    selectType: (type) => {
      set({ selectedType: type, selections: {}, contract: null, profileId: undefined });
      resolve();
    },

    setProfile: (profileId) => {
      set({ profileId, selections: {}, contract: null });
      resolve();
    },

    updateSelection: (key, value) => {
      const selections = { ...get().selections, [key]: value };
      set({ selections, contract: null });
      // Re-resolve with new selections for constraint updates
      const { selectedType, profileId } = get();
      if (!selectedType) return;
      try {
        const resolvedOptions = builder.getBuildOptions(selectedType, selections, profileId);
        set({ resolvedOptions, selections });
      } catch {
        set({ selections });
      }
    },

    setAssuranceTier: (tier) => set({ assuranceTier: tier }),

    buildContract: () => {
      const { selectedType, selections, assuranceTier, profileId } = get();
      if (!selectedType) return;
      try {
        const contract = builder.buildContract(selectedType, selections, assuranceTier, profileId);
        set({ contract });
      } catch {
        // Validation errors are inside the contract
      }
    },

    reset: () => set({
      selectedType: null,
      profileId: undefined,
      selections: {},
      resolvedOptions: null,
      contract: null,
      assuranceTier: 1,
    }),
  };
});
