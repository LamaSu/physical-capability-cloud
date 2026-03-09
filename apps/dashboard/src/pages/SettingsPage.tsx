import React from "react";
import { GlassPanel, AddressDisplay } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

export function SettingsPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Settings", "Wallet, network, and preferences"); }, [setPageMeta]);

  return (
    <div className="space-y-6 max-w-2xl">
      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Wallet</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/50">Address</span>
            <AddressDisplay address="0x1234567890abcdef1234567890abcdef12345678" chars={6} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/50">Network</span>
            <span className="text-sm font-mono text-green-400/70">Base Sepolia</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/50">Balance</span>
            <span className="text-sm font-mono text-white/70">1,000.00 USDC</span>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Preferences</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/50">Default Assurance Tier</span>
            <span className="text-sm font-mono text-white/70">Tier 1</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-white/50">Auto-fund Escrow</span>
            <span className="text-sm font-mono text-green-400/70">Enabled</span>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
