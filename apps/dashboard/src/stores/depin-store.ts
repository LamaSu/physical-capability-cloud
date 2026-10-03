import { create } from "zustand";
import { accountScoped } from "../lib/account-scope.js";
import type {
  CapabilityCertificate,
  RewardEpoch,
  DePINRewardClaim,
  TreasuryBalance,
} from "@pcc/spec";

interface DePINState {
  certificates: CapabilityCertificate[];
  epochs: RewardEpoch[];
  claims: DePINRewardClaim[];
  treasury: TreasuryBalance | null;
  selectedEpochId: string | null;

  setCertificates: (certs: CapabilityCertificate[]) => void;
  setEpochs: (epochs: RewardEpoch[]) => void;
  setClaims: (claims: DePINRewardClaim[]) => void;
  setTreasury: (treasury: TreasuryBalance) => void;
  selectEpoch: (id: string | null) => void;
}

export const useDePINStore = create<DePINState>((set) => ({
  certificates: [],
  epochs: [],
  claims: [],
  treasury: null,
  selectedEpochId: null,

  setCertificates: (certificates) => set({ certificates }),
  setEpochs: (epochs) => set({ epochs }),
  setClaims: (claims) => set({ claims }),
  setTreasury: (treasury) => set({ treasury }),
  selectEpoch: (id) => set({ selectedEpochId: id }),
}));

// The signed-in account's state: reset on every account change (lib/account-scope.ts).
accountScoped(useDePINStore);
