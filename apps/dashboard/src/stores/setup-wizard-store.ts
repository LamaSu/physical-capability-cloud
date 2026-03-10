import { create } from "zustand";

interface SetupWizardState {
  step: number;

  // Step 1: Welcome
  gatewayStatus: "checking" | "online" | "offline";

  // Step 2: Network
  selectedNetwork: "localhost" | "base-sepolia" | "base";
  rpcUrl: string;

  // Step 3: Wallet
  walletConnected: boolean;

  // Step 4: Identity
  displayName: string;
  organization: string;
  role: "operator" | "customer" | "both";

  // Step 5: Complete
  setupComplete: boolean;

  // Actions
  setStep: (step: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  setGatewayStatus: (status: "checking" | "online" | "offline") => void;
  setNetwork: (network: "localhost" | "base-sepolia" | "base") => void;
  setRpcUrl: (url: string) => void;
  setWalletConnected: (connected: boolean) => void;
  setDisplayName: (name: string) => void;
  setOrganization: (org: string) => void;
  setRole: (role: "operator" | "customer" | "both") => void;
  completeSetup: () => void;
  reset: () => void;
  isStepValid: (step: number) => boolean;
}

const TOTAL_STEPS = 5;

const DEFAULT_RPC: Record<string, string> = {
  localhost: "http://127.0.0.1:8545",
  "base-sepolia": "https://sepolia.base.org",
  base: "https://mainnet.base.org",
};

export const useSetupWizardStore = create<SetupWizardState>((set, get) => ({
  step: 0,

  gatewayStatus: "checking",

  selectedNetwork: "base-sepolia",
  rpcUrl: DEFAULT_RPC["base-sepolia"],

  walletConnected: false,

  displayName: "",
  organization: "",
  role: "customer",

  setupComplete: false,

  setStep: (step) => set({ step: Math.max(0, Math.min(TOTAL_STEPS - 1, step)) }),
  nextStep: () => set((s) => ({ step: Math.min(TOTAL_STEPS - 1, s.step + 1) })),
  prevStep: () => set((s) => ({ step: Math.max(0, s.step - 1) })),

  setGatewayStatus: (status) => set({ gatewayStatus: status }),

  setNetwork: (network) =>
    set({
      selectedNetwork: network,
      rpcUrl: DEFAULT_RPC[network],
    }),
  setRpcUrl: (url) => set({ rpcUrl: url }),

  setWalletConnected: (connected) => set({ walletConnected: connected }),

  setDisplayName: (name) => set({ displayName: name }),
  setOrganization: (org) => set({ organization: org }),
  setRole: (role) => set({ role }),

  completeSetup: () => set({ setupComplete: true }),

  reset: () =>
    set({
      step: 0,
      gatewayStatus: "checking",
      selectedNetwork: "base-sepolia",
      rpcUrl: DEFAULT_RPC["base-sepolia"],
      walletConnected: false,
      displayName: "",
      organization: "",
      role: "customer",
      setupComplete: false,
    }),

  isStepValid: (step) => {
    const s = get();
    switch (step) {
      case 0: return true; // welcome — always valid
      case 1: return s.rpcUrl.length > 0; // network — needs an RPC URL
      case 2: return s.walletConnected; // wallet — must be connected
      case 3: return s.displayName.length > 0; // identity — needs display name
      case 4: return true; // complete — always valid
      default: return false;
    }
  },
}));
