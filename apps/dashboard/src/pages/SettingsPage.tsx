import React from "react";
import { useAccount } from "wagmi";
import { GlassPanel, AddressDisplay, LoadingShell } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useAgentMe } from "../api/hooks/use-pcc-data.js";
import { UnavailableState } from "../components/LiveState.js";

/**
 * Settings shows only what a real source says: the account behind the API
 * key (GET /api/agent/me) and the wallet the browser has connected (wagmi).
 * There is no balance and no saved preferences here because nothing serves
 * them yet; showing defaults would present guesses as account state.
 */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-white/50">{label}</span>
      <span className="text-sm font-mono text-white/70 text-right break-all">{children}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">{children}</h2>;
}

function AccountPanel() {
  const me = useAgentMe();

  if (me.isLoading) return <LoadingShell rows={3} />;
  if (!me.data) {
    return <UnavailableState what="your account" error={me.error} onRetry={() => void me.refetch()} />;
  }

  const { identity, keys } = me.data;
  const fullAccess = identity.scopes.includes("*");

  return (
    <div className="space-y-3">
      <Row label="Operator">{identity.operator}</Row>
      <Row label="API key">
        {identity.key_name ?? "unnamed"} <span className="text-white/30">({identity.key_id.slice(0, 8)})</span>
      </Row>
      <Row label="Access">{fullAccess ? "All scopes (*)" : identity.scopes.join(", ") || "none"}</Row>
      <Row label="Active keys">
        {keys.active ?? <span className="text-white/40">unavailable</span>}
      </Row>
      {keys.wildcard_keys > 0 && (
        <p className="text-xs text-amber-200/70">
          {keys.wildcard_keys} of your keys can use every scope (*). Revoke the ones you no longer need.
        </p>
      )}
      {me.isError && (
        <p className="text-xs text-amber-200/70">Couldn't refresh; showing the last successful read.</p>
      )}
    </div>
  );
}

function WalletPanel() {
  const { address, isConnected, chain, chainId } = useAccount();

  if (!isConnected || !address) {
    return (
      <p className="text-sm text-white/40">
        No wallet connected. Use <span className="text-white/60">Connect Wallet</span> in the top bar.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Row label="Address">
        <AddressDisplay address={address} chars={6} />
      </Row>
      <Row label="Wallet network">{chain?.name ?? `unsupported chain ${chainId ?? "?"}`}</Row>
    </div>
  );
}

export function SettingsPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => { setPageMeta("Settings", "Account and wallet"); }, [setPageMeta]);

  return (
    <div className="space-y-6 max-w-2xl">
      <GlassPanel padding="lg">
        <SectionTitle>Account</SectionTitle>
        <AccountPanel />
      </GlassPanel>

      <GlassPanel padding="lg">
        <SectionTitle>Wallet</SectionTitle>
        <WalletPanel />
      </GlassPanel>
    </div>
  );
}
