import { create } from "zustand";

interface SubnetMetrics {
  totalVerifications: number;
  averageScore: number;
  activeMinerCount: number;
  lastEpochRewards: number;
}

interface SubnetMiner {
  uid: number;
  hotkey: string;
  stake: number;
  trust: number;
  incentive: number;
}

interface SubnetState {
  available: boolean;
  metrics: SubnetMetrics;
  miners: SubnetMiner[];
  setStatus: (available: boolean, metrics: SubnetMetrics) => void;
  setMiners: (miners: SubnetMiner[]) => void;
}

export const useSubnetStore = create<SubnetState>((set) => ({
  available: false,
  metrics: {
    totalVerifications: 0,
    averageScore: 0,
    activeMinerCount: 0,
    lastEpochRewards: 0,
  },
  miners: [],

  setStatus: (available, metrics) => set({ available, metrics }),
  setMiners: (miners) => set({ miners }),
}));
