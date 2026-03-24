import { create } from "zustand";

/** Oracle-based metrics (replaces SubnetMetrics) */
interface OracleMetrics {
  totalVerifications: number;
  averageScore: number;
  activeOracles: number;
  primaryOracle: string;
  fallbackOracles: string[];
  recentResults: Array<{
    oracle: string;
    passed: boolean;
    score: number;
    timestamp: string;
  }>;
  // legacy compat fields
  activeMinerCount?: number;
  lastEpochRewards?: number;
}

interface OracleEntry {
  name: string;
  available: boolean;
  totalVerifications: number;
  averageScore: number;
  isPrimary: boolean;
}

interface SubnetState {
  available: boolean;
  metrics: OracleMetrics;
  /** Oracle leaderboard (replaces miners) */
  oracles: OracleEntry[];
  /** @deprecated Use oracles instead */
  miners: OracleEntry[];
  setStatus: (available: boolean, metrics: OracleMetrics) => void;
  setOracles: (oracles: OracleEntry[]) => void;
  /** @deprecated Use setOracles */
  setMiners: (miners: OracleEntry[]) => void;
}

export const useSubnetStore = create<SubnetState>((set) => ({
  available: false,
  metrics: {
    totalVerifications: 0,
    averageScore: 0,
    activeOracles: 0,
    primaryOracle: "uma",
    fallbackOracles: ["chainlink", "eigenlayer"],
    recentResults: [],
    activeMinerCount: 0,
    lastEpochRewards: 0,
  },
  oracles: [],
  miners: [],

  setStatus: (available, metrics) => set({ available, metrics }),
  setOracles: (oracles) => set({ oracles, miners: oracles }),
  setMiners: (miners) => set({ miners, oracles: miners }),
}));

/** @deprecated Use useSubnetStore */
export const useOracleStore = useSubnetStore;
