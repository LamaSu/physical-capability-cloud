import React from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { baseSepolia, base } from "wagmi/chains";
import { injected, coinbaseWallet, walletConnect } from "@wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// WalletConnect project ID — reads from env or falls back to demo ID
const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "pcc-dev-placeholder";

const config = createConfig({
  chains: [baseSepolia, base],
  connectors: [
    injected(),
    coinbaseWallet({ appName: "PCC Ground Control" }),
    walletConnect({ projectId: WALLETCONNECT_PROJECT_ID }),
  ],
  transports: {
    [baseSepolia.id]: http(),
    [base.id]: http(),
  },
});

// Separate query client for wagmi (doesn't conflict with app's react-query)
const wagmiQueryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

export function WalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={wagmiQueryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export { config as wagmiConfig };
