import React from "react";
import { useConnect, useDisconnect } from "wagmi";
import { GlassPanel } from "@pcc/ui";
import { useAuth } from "../hooks/use-auth.js";
import { useAuthStore } from "../stores/auth-store.js";

/** One wallet re-sign action, also used after a gateway quickstart refusal. */
export function SignInAgainButton({ login, isVerifying }: { login: () => Promise<void>; isVerifying: boolean }) {
  return (
    <button
      type="button"
      onClick={() => void login()}
      disabled={isVerifying}
      className="px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs hover:bg-yellow-500/15 transition-colors disabled:opacity-50"
    >
      Sign in again
    </button>
  );
}

/**
 * Wallet connect button + SIWE auth flow.
 * Shows in TopBar -- connects wallet, signs SIWE message, establishes session.
 */
export function ConnectWallet({ showNotice = true }: { showNotice?: boolean } = {}) {
  const { address, isConnected, isAuthenticated, isVerifying, error, authNotice, login, logout } = useAuth();
  const sessionToken = useAuthStore((s) => s.sessionToken);
  const hasKey = useAuthStore((s) => s.isAuthenticated);
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const [showModal, setShowModal] = React.useState(false);

  const handleDisconnect = async () => {
    await logout();
    disconnect();
    setShowModal(false);
  };

  // Connected + authenticated
  if (isConnected && address && isAuthenticated) {
    return (
      <div className="relative">
        <button
          onClick={() => setShowModal(!showModal)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs hover:bg-green-500/15 transition-colors"
        >
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          {address.slice(0, 6)}...{address.slice(-4)}
        </button>
        {sessionToken === "cookie" && !hasKey && <SignInAgainButton login={login} isVerifying={isVerifying} />}
        {showNotice && authNotice && <p role="status" className="max-w-xs text-xs text-white/60">{authNotice}</p>}
        {showModal && (
          <div className="absolute right-0 top-full mt-2 z-50">
            <GlassPanel padding="md" className="min-w-[200px] space-y-3">
              <div className="text-[10px] text-white/20">Connected Wallet</div>
              <div className="text-xs text-white/50 font-mono break-all">{address}</div>
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-[10px] text-green-400/60">Authenticated</span>
              </div>
              <button
                onClick={handleDisconnect}
                className="w-full px-3 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-red-400/60 text-[10px] hover:bg-red-500/15 transition-colors"
              >
                Disconnect
              </button>
            </GlassPanel>
          </div>
        )}
      </div>
    );
  }

  // Connected but not yet authenticated
  if (isConnected && address && !isAuthenticated) {
    return (
      <div>
        <button
          onClick={login}
          disabled={isVerifying}
          className="px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs hover:bg-yellow-500/15 transition-colors disabled:opacity-50"
        >
          {isVerifying ? "Signing..." : "Sign In"}
          {error && <span className="ml-2 text-red-400/60 text-[10px]">({error})</span>}
        </button>
        {showNotice && authNotice && <p role="status" className="max-w-xs text-xs text-white/60">{authNotice}</p>}
      </div>
    );
  }

  // Not connected -- show connect button + modal
  return (
    <div className="relative">
      <button
        onClick={() => setShowModal(!showModal)}
        className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/50 text-xs hover:text-white/70 hover:border-green-500/20 transition-colors"
      >
        Connect Wallet
      </button>
      {showModal && (
        <div className="absolute right-0 top-full mt-2 z-50">
          <GlassPanel padding="md" className="min-w-[240px] space-y-2">
            <div className="text-xs text-white/30 mb-2">Choose Wallet</div>
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => {
                  connect({ connector });
                  setShowModal(false);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-green-500/15 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-white/[0.04] flex items-center justify-center text-white/30 text-sm">
                  {connector.name === "MetaMask" ? "M" :
                   connector.name === "Coinbase Wallet" ? "C" :
                   connector.name === "WalletConnect" ? "W" : "?"}
                </div>
                <div>
                  <div className="text-xs text-white/60">{connector.name}</div>
                  <div className="text-[10px] text-white/15">
                    {connector.name === "Injected" ? "Browser wallet" : connector.type}
                  </div>
                </div>
              </button>
            ))}
          </GlassPanel>
        </div>
      )}
    </div>
  );
}
