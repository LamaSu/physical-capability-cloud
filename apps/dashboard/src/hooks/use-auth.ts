/**
 * React hook for SIWE authentication.
 *
 * Uses the auth store (Zustand) for state management and calls
 * the gateway auth endpoints directly. Builds the EIP-4361 message
 * manually — no `siwe` package dependency.
 */

import { useState, useCallback, useEffect } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { useAuthStore } from "../stores/auth-store.js";

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
    setAddress,
    setSession,
    setVerifying,
    setError,
    logout: authLogout,
  } = useAuthStore();

  const [isChecking, setIsChecking] = useState(true);

  // Sync wallet connection to auth store
  useEffect(() => {
    if (isConnected && address) {
      setAddress(address);
    } else {
      setAddress(null);
      setSession(null);
    }
  }, [isConnected, address, setAddress, setSession]);

  // Check existing session on mount
  useEffect(() => {
    setIsChecking(true);
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.address) {
          setAddress(data.address);
          setSession("cookie");
        }
      })
      .catch(() => {})
      .finally(() => setIsChecking(false));
  }, [setAddress, setSession]);

  const login = useCallback(async () => {
    if (!address || !chainId) return;
    setVerifying(true);
    setError(null);

    try {
      // 1. Get nonce from gateway
      const nonceRes = await fetch("/api/auth/nonce", {
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
      const verifyRes = await fetch("/api/auth/verify", {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  }, [address, chainId, signMessageAsync, setVerifying, setError, setSession]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Ignore network errors on logout
    }
    authLogout();
  }, [authLogout]);

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
    /** Initiate SIWE sign-in flow */
    login,
    /** Sign out and destroy session */
    logout,
  };
}
