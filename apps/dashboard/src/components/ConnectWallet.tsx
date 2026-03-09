import React from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { GlassPanel } from "@pcc/ui";
import { useAuthStore } from "../stores/auth-store.js";

/**
 * Wallet connect button + SIWE auth flow.
 * Shows in TopBar — connects wallet, signs SIWE message, establishes session.
 */
export function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const [showModal, setShowModal] = React.useState(false);

  const {
    sessionToken,
    isVerifying,
    error,
    setAddress,
    setSession,
    setVerifying,
    setError,
    logout: authLogout,
  } = useAuthStore();

  // Sync wagmi connection state to auth store
  React.useEffect(() => {
    if (isConnected && address) {
      setAddress(address);
    } else {
      setAddress(null);
      setSession(null);
    }
  }, [isConnected, address, setAddress, setSession]);

  // SIWE sign-in after wallet connects
  const handleSIWE = React.useCallback(async () => {
    if (!address) return;
    setVerifying(true);
    setError(null);

    try {
      // 1. Get nonce from gateway
      const nonceRes = await fetch("/api/auth/nonce", { method: "POST" });
      const { nonce } = await nonceRes.json();

      // 2. Build SIWE message
      const domain = window.location.host;
      const origin = window.location.origin;
      const issuedAt = new Date().toISOString();
      const message = [
        `${domain} wants you to sign in with your Ethereum account:`,
        address,
        "",
        "Sign in to PCC Ground Control",
        "",
        `URI: ${origin}`,
        `Version: 1`,
        `Chain ID: 84532`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
      ].join("\n");

      // 3. Sign
      const signature = await signMessageAsync({ message });

      // 4. Verify with gateway
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature, address }),
      });

      if (!verifyRes.ok) {
        throw new Error("Verification failed");
      }

      const { token } = await verifyRes.json();
      setSession(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  }, [address, signMessageAsync, setVerifying, setError, setSession]);

  const handleDisconnect = () => {
    // Logout from gateway
    if (sessionToken) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
      }).catch(() => {});
    }
    disconnect();
    authLogout();
    setShowModal(false);
  };

  // Connected + authenticated
  if (isConnected && address && sessionToken) {
    return (
      <div className="relative">
        <button
          onClick={() => setShowModal(!showModal)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs hover:bg-green-500/15 transition-colors"
        >
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          {address.slice(0, 6)}...{address.slice(-4)}
        </button>
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
  if (isConnected && address && !sessionToken) {
    return (
      <button
        onClick={handleSIWE}
        disabled={isVerifying}
        className="px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs hover:bg-yellow-500/15 transition-colors disabled:opacity-50"
      >
        {isVerifying ? "Signing..." : "Sign In"}
        {error && <span className="ml-2 text-red-400/60 text-[10px]">({error})</span>}
      </button>
    );
  }

  // Not connected — show connect button + modal
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
                  {connector.name === "MetaMask" ? "🦊" :
                   connector.name === "Coinbase Wallet" ? "🔵" :
                   connector.name === "WalletConnect" ? "🔗" : "💼"}
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
