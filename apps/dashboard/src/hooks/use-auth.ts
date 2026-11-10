/**
 * React hook for SIWE authentication.
 *
 * Uses the auth store (Zustand) for state management and calls
 * the gateway auth endpoints directly. Builds the EIP-4361 message
 * manually — no `siwe` package dependency.
 */

import { useState, useCallback, useEffect } from "react";
import { useAccount, useConnectionEffect, useSignMessage } from "wagmi";
import { useAuthStore } from "../stores/auth-store.js";
import { gatewayUrl } from "../lib/gateway-base.js";

/**
 * Build an EIP-4361 SIWE message string.
 * See https://eips.ethereum.org/EIPS/eip-4361
 */
function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    "",
    params.statement,
    "",
    `URI: ${params.uri}`,
    `Version: ${params.version}`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join("\n");
}

export function useAuth() {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const {
    sessionToken,
    isVerifying,
    error,
    authNotice,
    setAddress,
    setSession,
    setVerifying,
    setError,
    signOutWallet,
    mintSessionKey,
  } = useAuthStore();

  const [isChecking, setIsChecking] = useState(true);

  useConnectionEffect({
    onDisconnect() {
      if (useAuthStore.getState().sessionKeyId) void signOutWallet({ keepPersisted: true });
      else {
        setAddress(null);
        setSession(null);
      }
    },
  });

  // Sync wallet connection to auth store
  useEffect(() => {
    if (isConnected && address) {
      setAddress(address);
    }
  }, [isConnected, address, setAddress]);

  // Check existing session on mount
  useEffect(() => {
    let active = true;
    const epoch = useAuthStore.getState().keyEpoch;
    setIsChecking(true);
    fetch(gatewayUrl("/api/auth/me"), { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const state = useAuthStore.getState();
        if (active && state.keyEpoch === epoch && !state.sessionToken && data?.address) {
          setAddress(data.address);
          // Restore identity for reads; minting still needs a fresh sign-in bearer.
          setSession("cookie");
          return mintSessionKey();
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setIsChecking(false); });
    return () => { active = false; };
  }, [setAddress, setSession, mintSessionKey]);

  const login = useCallback(async () => {
    if (!address || !chainId) return;
    setAddress(address);
    setVerifying(true);
    setError(null);

    try {
      // 1. Get nonce from gateway
      const nonceRes = await fetch(gatewayUrl("/api/auth/nonce"), {
        credentials: "include",
      });
      if (!nonceRes.ok) throw new Error("Failed to get nonce");
      const { nonce } = await nonceRes.json();

      // 2. Build SIWE message (no siwe package needed)
      const message = buildSiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Physical Capability Cloud",
        uri: window.location.origin,
        version: "1",
        chainId,
        nonce,
        issuedAt: new Date().toISOString(),
      });

      // 3. Sign with wallet
      const signature = await signMessageAsync({ message });

      // 4. Verify with gateway
      const verifyRes = await fetch(gatewayUrl("/api/auth/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message, signature }),
      });

      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error ?? "Verification failed");
      }

      const data = await verifyRes.json();
      // Session cookie is set automatically; also store the bearer token
      setSession(data.token ?? "cookie");
      await mintSessionKey();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  }, [address, chainId, signMessageAsync, setAddress, setVerifying, setError, setSession, mintSessionKey]);

  const logout = useCallback(async () => {
    await signOutWallet();
  }, [signOutWallet]);

  return {
    /** The connected wallet address */
    address,
    /** Whether the wallet is connected */
    isConnected: !!isConnected,
    /** Whether the user has a valid SIWE session */
    isAuthenticated: !!sessionToken,
    /** Whether we're checking for an existing session on mount */
    isChecking,
    /** Whether SIWE sign-in is in progress */
    isVerifying,
    /** Auth error message */
    error,
    authNotice,
    /** Initiate SIWE sign-in flow */
    login,
    /** Sign out and destroy session */
    logout,
  };
}
