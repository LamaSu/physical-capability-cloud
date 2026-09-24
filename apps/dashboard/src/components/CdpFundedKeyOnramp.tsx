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
 */

interface Wallet {
  walletAddress: string;
  network: string;
  smartAccount: boolean;
  mock?: boolean;
}
interface Permission {
  permissionId: string;
  spender: string;
  allowanceUSDC: number;
  periodSec: number;
  expiresAt: string;
  revoked: boolean;
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
  const cardFundable = !!wallet && !simulated && wallet.network === "base";

  async function createWallet() {
    setCreating(true);
    setErr(null);
    try {
      setWallet(await api("/api/fiat-ramp/cdp/wallet", "POST"));
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
      const r = (await api("/api/fiat-ramp/coinbase/onramp", "POST", {
        walletAddress: wallet.walletAddress,
        network: wallet.network,
      })) as { onrampUrl?: unknown; mock?: unknown; note?: unknown };
      if (r.mock === true) {
        // No Coinbase app is configured on this gateway, so its URL is not a checkout to offer.
        setOnrampNote(typeof r.note === "string" && r.note ? r.note : "This gateway has no Coinbase app configured.");
      } else if (typeof r.onrampUrl === "string" && r.onrampUrl.startsWith("https://")) {
        setOnrampUrl(r.onrampUrl);
      } else {
        setErr("The gateway returned no checkout link.");
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setFunding(false);
    }
  }

  async function issue() {
    if (!wallet) return;
    setIssuing(true);
    setErr(null);
    try {
      setPerm(
        await api("/api/fiat-ramp/cdp/spend-permission", "POST", {
          walletAddress: wallet.walletAddress,
          spender: spender.trim(),
          allowanceUSDC: Number(allowance),
          periodSec: Math.round(Number(periodHrs) * 3600),
        }),
      );
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
      const r = (await api(`/api/fiat-ramp/cdp/spend-permission/${perm.permissionId}`, "DELETE")) as { revoked?: unknown } | null;
      // Only the gateway's explicit confirmation marks the key revoked.
      if (r?.revoked === true) setPerm({ ...perm, revoked: true });
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
                        perm.revoked
                          ? "text-white/40 border-white/20"
                          : "text-emerald-400/80 border-emerald-400/30"
                      }`}
                    >
                      {perm.revoked ? "REVOKED" : "ACTIVE"}
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
