import React from "react";
import { authorizedFetch } from "../lib/authorized-fetch.js";

/**
 * CdpFundedKeyOnramp — zero-friction PCC onboarding.
 *
 *   Step 1 (free):     create a gasless smart wallet — NO card. Usable on PCC
 *                      immediately (gasless USDC on Base via paymaster: receive
 *                      payments, hold an identity, operate).
 *   Step 2 (optional): add funds with a card — only when you want to SPEND.
 *   Step 3 (optional): issue a SCOPED, REVOCABLE agent key (never a raw key).
 *
 * Lane #017 routes (mock until CDP creds land):
 *   POST   /api/fiat-ramp/cdp/wallet            (free wallet, no card)
 *   POST   /api/fiat-ramp/coinbase/onramp       (fund an existing wallet — real URL)
 *   POST   /api/fiat-ramp/cdp/spend-permission  (scoped agent key)
 *   DELETE /api/fiat-ramp/cdp/spend-permission/:id
 *
 * Without CDP credentials the gateway returns `mock: true` and a random
 * address that no key controls (packages/payments/src/cdp/wallet-client.ts).
 * Such a wallet is labelled, is never called usable, and is never offered
 * card funding: the Coinbase checkout is real, so money sent to that address
 * could not be recovered. Its spend permissions are simulated too.
 *
 * Every answer is checked in full before it is shown as money state (astra
 * 408a). An answer missing a field, or one that doesn't match what was asked,
 * is a failed request: a wallet must say whether it is simulated, a checkout
 * must be Coinbase's own and pay exactly this wallet on Base, and a spend
 * permission must echo the request it confirms.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The networks the CDP wallet client creates wallets on (packages/payments/src/cdp). */
const NETWORKS = new Set(["base", "base-sepolia"]);
/** USDC's smallest unit: the permission's on-chain allowance is the USDC amount times this. */
const USDC_UNITS = 1_000_000;
const CHECKOUT_ORIGIN = "https://pay.coinbase.com";

interface Wallet {
  walletAddress: string;
  network: string;
  smartAccount: true;
  /** Explicit in every answer: true when no key controls the address. */
  mock: boolean;
}
interface Permission {
  permissionId: string;
  spender: string;
  allowanceUSDC: number;
  periodSec: number;
  expiresAt: string;
  revoked: boolean;
}
interface PermissionRequest {
  walletAddress: string;
  spender: string;
  allowanceUSDC: number;
  periodSec: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const sameAddress = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** POST /api/fiat-ramp/cdp/wallet's answer, or null when it isn't one in full. */
function parseWallet(v: unknown): Wallet | null {
  if (!isRecord(v)) return null;
  const { walletAddress, network, smartAccount, mock } = v;
  if (typeof walletAddress !== "string" || !ADDRESS.test(walletAddress)) return null;
  if (typeof network !== "string" || !NETWORKS.has(network)) return null;
  if (smartAccount !== true || typeof mock !== "boolean") return null;
  return { walletAddress, network, smartAccount, mock };
}

/**
 * POST /api/fiat-ramp/coinbase/onramp's answer for `wallet`: Coinbase's live
 * checkout paying exactly this wallet on Base, the gateway's note when it says
 * the checkout is a mock, or null when the answer is neither.
 */
function parseCheckout(v: unknown, wallet: Wallet): { url: string } | { note: string } | null {
  if (!isRecord(v) || v.provider !== "coinbase" || typeof v.mock !== "boolean") return null;
  if (v.mock) return { note: typeof v.note === "string" && v.note ? v.note : "This gateway has no Coinbase app configured." };
  if (v.network !== "base" || v.asset !== "USDC" || !sameAddress(v.walletAddress, wallet.walletAddress)) return null;
  if (typeof v.onrampUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(v.onrampUrl);
  } catch {
    return null;
  }
  if (url.origin !== CHECKOUT_ORIGIN || !url.pathname.startsWith("/buy")) return null;
  // Where the money goes: {"<address>": ["base"]}, this wallet and nothing else.
  let addresses: unknown;
  try {
    addresses = JSON.parse(url.searchParams.get("addresses") ?? "");
  } catch {
    return null;
  }
  if (!isRecord(addresses)) return null;
  const destinations = Object.entries(addresses);
  if (destinations.length !== 1) return null;
  const [address, networks] = destinations[0]!;
  if (!sameAddress(address, wallet.walletAddress)) return null;
  if (!Array.isArray(networks) || networks.length !== 1 || networks[0] !== "base") return null;
  return { url: url.href };
}

/** POST /api/fiat-ramp/cdp/spend-permission's answer, or null unless it is a complete, unrevoked permission confirming `request`. */
function parsePermission(v: unknown, request: PermissionRequest): Permission | null {
  if (!isRecord(v)) return null;
  const { permissionId, account, spender, token, allowance, allowanceUSDC, periodSec, start, expiresAt, revoked } = v;
  if (typeof permissionId !== "string" || permissionId.length === 0) return null;
  if (!sameAddress(account, request.walletAddress) || !sameAddress(spender, request.spender)) return null;
  if (token !== "USDC" || allowanceUSDC !== request.allowanceUSDC || periodSec !== request.periodSec) return null;
  if (allowance !== String(Math.round(request.allowanceUSDC * USDC_UNITS))) return null;
  if (typeof start !== "string" || typeof expiresAt !== "string") return null;
  const from = Date.parse(start);
  const until = Date.parse(expiresAt);
  if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) return null;
  if (revoked !== false) return null;
  return { permissionId, spender: spender as string, allowanceUSDC, periodSec, expiresAt, revoked };
}

/** What a permission is now: revoked only on the gateway's confirmation, expired past its expiry. */
function permissionStatus(perm: Permission, now = Date.now()): "REVOKED" | "EXPIRED" | "ACTIVE" {
  if (perm.revoked) return "REVOKED";
  return Date.parse(perm.expiresAt) <= now ? "EXPIRED" : "ACTIVE";
}

async function api(path: string, method: string, body?: unknown): Promise<any> {
  const res = await authorizedFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Show the gateway's own reason (e.g. a missing scope) when it sends one.
    let reason = "";
    try {
      const json = (await res.json()) as { error?: string; message?: string };
      reason = json.message ?? json.error ?? "";
    } catch {
      // No JSON body: the status line is all there is.
    }
    throw new Error(`${method} ${path} → ${res.status}${reason ? `: ${reason}` : ""}`);
  }
  return res.json();
}

const BTN = "px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40";
const INPUT =
  "w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-teal-400/40";

export function CdpFundedKeyOnramp() {
  const [wallet, setWallet] = React.useState<Wallet | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [onrampUrl, setOnrampUrl] = React.useState<string | null>(null);
  // Set when the gateway answered the onramp request with mock: true.
  const [onrampNote, setOnrampNote] = React.useState<string | null>(null);
  const [funding, setFunding] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const [spender, setSpender] = React.useState("");
  const [allowance, setAllowance] = React.useState("50");
  const [periodHrs, setPeriodHrs] = React.useState("24");
  const [issuing, setIssuing] = React.useState(false);
  const [perm, setPerm] = React.useState<Permission | null>(null);
  const [revoking, setRevoking] = React.useState(false);

  // The gateway said this wallet is simulated: nothing controls its address.
  const simulated = wallet?.mock === true;
  // Coinbase's card checkout pays out USDC on Base mainnet. Only a real wallet
  // on "base" can receive it. A base-sepolia (testnet) wallet would be paid
  // real money on a network PCC doesn't read for it.
  const cardFundable = !!wallet && wallet.mock === false && wallet.network === "base";

  async function createWallet() {
    setCreating(true);
    setErr(null);
    try {
      const w = parseWallet(await api("/api/fiat-ramp/cdp/wallet", "POST"));
      if (w) setWallet(w);
      else setErr("The gateway's wallet answer was incomplete (it must give the address and network, and say whether the wallet is simulated), so no wallet is shown.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function fund() {
    if (!wallet || !cardFundable) return;
    setFunding(true);
    setErr(null);
    try {
      const checkout = parseCheckout(
        await api("/api/fiat-ramp/coinbase/onramp", "POST", {
          walletAddress: wallet.walletAddress,
          network: wallet.network,
        }),
        wallet,
      );
      if (!checkout) setErr("The gateway's checkout wasn't Coinbase's card checkout for this wallet on Base, so it isn't offered.");
      // A mock: no Coinbase app is configured on this gateway, so its URL is not a checkout to offer.
      else if ("note" in checkout) setOnrampNote(checkout.note);
      else setOnrampUrl(checkout.url);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setFunding(false);
    }
  }

  async function issue() {
    if (!wallet) return;
    const request: PermissionRequest = {
      walletAddress: wallet.walletAddress,
      spender: spender.trim(),
      allowanceUSDC: Number(allowance),
      periodSec: Math.round(Number(periodHrs) * 3600),
    };
    if (!ADDRESS.test(request.spender)) {
      setErr("Enter the agent's address: 0x and 40 hex digits.");
      return;
    }
    if (!(request.allowanceUSDC > 0) || !Number.isFinite(request.allowanceUSDC) || !(request.periodSec > 0)) {
      setErr("Enter a positive USDC allowance and period.");
      return;
    }
    setIssuing(true);
    setErr(null);
    try {
      const p = parsePermission(await api("/api/fiat-ramp/cdp/spend-permission", "POST", request), request);
      if (p) setPerm(p);
      else setErr("The gateway's answer didn't confirm this permission in full, so it isn't shown as issued. Check the gateway before relying on it.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setIssuing(false);
    }
  }

  async function revoke() {
    if (!perm || revoking) return;
    setRevoking(true);
    setErr(null);
    try {
      const r = (await api(`/api/fiat-ramp/cdp/spend-permission/${perm.permissionId}`, "DELETE")) as { revoked?: unknown; permissionId?: unknown } | null;
      // Only the gateway's explicit confirmation, for this permission, marks the key revoked.
      if (r?.revoked === true && r.permissionId === perm.permissionId) setPerm({ ...perm, revoked: true });
      else setErr("The gateway didn't confirm the revocation, so the key may still be active.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl">
      <div className="p-5 space-y-5">
        <div>
          <h3 className="text-base font-semibold text-white/90">Start on PCC — no card needed</h3>
          <p className="text-[13px] text-white/40 mt-1">
            Create a wallet for free and use PCC immediately — gasless on Base (receive payments,
            hold an identity, operate). Add a card <span className="text-white/60">only</span> when
            you want to spend, and scope a <span className="text-teal-400/80">revocable</span> key
            for your agent.
          </p>
        </div>

        {/* Step 1 — free wallet */}
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-white/30">
            Step 1 · Create your wallet (free)
          </div>
          {!wallet ? (
            <button
              onClick={createWallet}
              disabled={creating}
              className={`${BTN} bg-teal-400/20 text-teal-400 border border-teal-400/30 hover:bg-teal-400/30`}
            >
              {creating ? "Creating…" : "Create wallet — no card"}
            </button>
          ) : (
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-white/70 break-all">
                  {wallet.walletAddress}
                </span>
                {wallet.mock && (
                  <span className="text-[10px] text-amber-400/70 border border-amber-400/30 rounded px-1.5 py-0.5">
                    MOCK
                  </span>
                )}
              </div>
              {simulated ? (
                <div className="text-[11px] text-amber-400/80">
                  Simulated wallet: this gateway has no CDP credentials, so no key controls this
                  address. Don't send funds to it.
                </div>
              ) : (
                <div className="text-[11px] text-emerald-400/70">
                  ✓ Usable on PCC now · {wallet.network} · gasless
                </div>
              )}
            </div>
          )}
        </div>

        {/* Step 2 — optional fund */}
        {wallet && (
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-white/30">
              Step 2 · Add funds (optional — only to spend)
            </div>
            {simulated ? (
              <p className="text-[12px] text-white/40">
                Card funding is off for a simulated wallet: money sent to its address could not be
                recovered.
              </p>
            ) : !cardFundable ? (
              <p className="text-[12px] text-white/40">
                Card funding is off for a {wallet.network} wallet: the card checkout pays out USDC on
                Base mainnet, not on this wallet's network.
              </p>
            ) : onrampNote ? (
              <p className="text-[12px] text-amber-400/80">No card checkout on this gateway: {onrampNote}</p>
            ) : !onrampUrl ? (
              <button
                onClick={fund}
                disabled={funding}
                className={`${BTN} bg-white/[0.04] text-white/60 border border-white/10 hover:text-lime-300 hover:border-lime-400/30`}
              >
                {funding ? "Preparing…" : "Add funds with a card →"}
              </button>
            ) : (
              <a
                href={onrampUrl}
                target="_blank"
                rel="noreferrer"
                className={`${BTN} inline-block bg-lime-400/15 text-lime-300 border border-lime-400/30 hover:bg-lime-400/25`}
              >
                Open card checkout →
              </a>
            )}
          </div>
        )}

        {/* Step 3 — optional scoped key */}
        {wallet && (
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-white/30">
              Step 3 · Issue a scoped agent key (optional)
            </div>
            {!perm ? (
              <div className="space-y-2">
                <input
                  className={INPUT}
                  placeholder="Agent address (0x…)"
                  value={spender}
                  onChange={(e) => setSpender(e.target.value)}
                />
                <div className="flex gap-2">
                  <input
                    className={INPUT}
                    type="number"
                    placeholder="USDC allowance"
                    value={allowance}
                    onChange={(e) => setAllowance(e.target.value)}
                  />
                  <input
                    className={INPUT}
                    type="number"
                    placeholder="Period (hours)"
                    value={periodHrs}
                    onChange={(e) => setPeriodHrs(e.target.value)}
                  />
                </div>
                <button
                  onClick={issue}
                  disabled={issuing || !spender.trim()}
                  className={`${BTN} bg-teal-400/20 text-teal-400 border border-teal-400/30 hover:bg-teal-400/30`}
                >
                  {issuing ? "Issuing…" : "Issue scoped key"}
                </button>
              </div>
            ) : (
              <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[12px] text-white/70">{perm.permissionId}</span>
                  <span className="flex items-center gap-1.5">
                    {simulated && (
                      <span className="text-[10px] text-amber-400/70 border border-amber-400/30 rounded px-1.5 py-0.5">
                        MOCK
                      </span>
                    )}
                    <span
                      className={`text-[10px] rounded px-1.5 py-0.5 border ${
                        permissionStatus(perm) === "ACTIVE"
                          ? "text-emerald-400/80 border-emerald-400/30"
                          : "text-white/40 border-white/20"
                      }`}
                    >
                      {permissionStatus(perm)}
                    </span>
                  </span>
                </div>
                <div className="text-[11px] text-white/40">
                  ${perm.allowanceUSDC} USDC / {Math.round(perm.periodSec / 3600)}h · spender{" "}
                  {perm.spender.slice(0, 10)}… · expires{" "}
                  {new Date(perm.expiresAt).toLocaleDateString()}
                </div>
                {!perm.revoked && (
                  <button
                    onClick={revoke}
                    disabled={revoking}
                    className={`${BTN} bg-white/[0.04] text-white/50 border border-white/10 hover:text-rose-300 hover:border-rose-400/30`}
                  >
                    {revoking ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {err && <div className="text-[12px] text-rose-400/80">{err}</div>}
      </div>
    </div>
  );
}
