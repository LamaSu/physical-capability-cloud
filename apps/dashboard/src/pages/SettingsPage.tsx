import React from "react";
import { useAccount } from "wagmi";
import { AddressDisplay, GlassPanel, LoadingShell } from "@pcc/ui";
import { keyCounts, useAgentMe } from "../api/hooks/use-pcc-data.js";
import { UnavailableState } from "../components/ReadState.js";
import { useUIStore } from "../stores/ui-store.js";

function AccountRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-white/50">{label}</span>
      <span className="text-sm font-mono text-white/70 text-right break-all">{children}</span>
    </div>
  );
}

function AccountPanel() {
  const query = useAgentMe();
  if (query.isLoading) return <LoadingShell rows={3} />;
  if (!query.data) return <UnavailableState what="your account" error={query.error} onRetry={() => void query.refetch()} />;
  const { identity, keys } = query.data;
  const counts = keyCounts(keys);
  const reason = typeof keys?.unavailable === "string" ? keys.unavailable.slice(0, 80) : null;
  return (
    <div className="space-y-3">
      <AccountRow label="Operator">{identity.operator}</AccountRow>
      <AccountRow label="API key">{identity.key_name ?? "unnamed"}{identity.key_id && <> <span className="text-white/30">({identity.key_id.slice(0, 8)})</span></>}</AccountRow>
      <AccountRow label="Access">{identity.scopes.includes("*") ? "All scopes (*)" : identity.scopes.join(", ") || "none"}</AccountRow>
      <AccountRow label="Active keys">{counts ? counts.active : <span className="text-white/40">unavailable{reason ? ` (${reason})` : ""}</span>}</AccountRow>
      {counts && counts.wildcardKeys > 0 && <p className="text-xs text-amber-200/70">{counts.wildcardKeys} of your keys can use every scope (*). Revoke the ones you no longer need.</p>}
      {query.isError && <p className="text-xs text-amber-200/70">Couldn't refresh; showing the last successful read.</p>}
    </div>
  );
}

function WalletPanel() {
  const { address, isConnected, chain, chainId } = useAccount();
  if (!isConnected || !address) return <p className="text-sm text-white/40">No wallet connected. Use <span className="text-white/60">Connect Wallet</span> in the top bar.</p>;
  return (
    <div className="space-y-3">
      <AccountRow label="Address"><AddressDisplay address={address} chars={6} /></AccountRow>
      <AccountRow label="Wallet network">{chain?.name ?? `unsupported chain ${chainId ?? "?"}`}</AccountRow>
    </div>
  );
}

export function SettingsPage() {
  const setPageMeta = useUIStore((state) => state.setPageMeta);
  React.useEffect(() => { setPageMeta("Settings", "Account and wallet"); }, [setPageMeta]);
  return (
    <div className="space-y-6 max-w-2xl">
      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Account</h2>
        <AccountPanel />
      </GlassPanel>
      <GlassPanel padding="lg">
        <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Wallet</h2>
        <WalletPanel />
      </GlassPanel>
    </div>
  );
}
