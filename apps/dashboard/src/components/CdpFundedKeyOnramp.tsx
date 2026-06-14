import React from "react";
import { getAuthHeaders } from "../stores/auth-store.js";

/**
 * CdpFundedKeyOnramp — card → funded smart wallet → scoped, revocable agent key.
 *
 * Drives the lane #017 routes:
 *   POST   /api/fiat-ramp/cdp/provision         (create smart wallet + onramp URL)
 *   POST   /api/fiat-ramp/cdp/spend-permission  (issue scoped, revocable key)
 *   DELETE /api/fiat-ramp/cdp/spend-permission/:id
 *
 * The only human step is paying once at the onramp URL. The agent receives a
 * scoped spend-permission, never a raw private key. Works against the mock routes
 * until CDP creds are wired (then the same flow is real).
 */

interface Provisioned {
  walletAddress: string;
  network: string;
  onrampUrl: string;
  sessionId: string;
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
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

const BTN = "px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40";
const INPUT =
  "w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/90 outline-none focus:border-teal-400/40";

export function CdpFundedKeyOnramp() {
  const [wallet, setWallet] = React.useState<Provisioned | null>(null);
  const [provisioning, setProvisioning] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const [spender, setSpender] = React.useState("");
  const [allowance, setAllowance] = React.useState("50");
  const [periodHrs, setPeriodHrs] = React.useState("24");
  const [issuing, setIssuing] = React.useState(false);
  const [perm, setPerm] = React.useState<Permission | null>(null);

  async function provision() {
    setProvisioning(true);
    setErr(null);
    try {
      setWallet(await api("/api/fiat-ramp/cdp/provision", "POST", { presetAmountUSD: 25 }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setProvisioning(false);
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
    if (!perm) return;
    try {
      await api(`/api/fiat-ramp/cdp/spend-permission/${perm.permissionId}`, "DELETE");
      setPerm({ ...perm, revoked: true });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl">
      <div className="p-5 space-y-5">
        <div>
          <h3 className="text-base font-semibold text-white/90">Funded agent key</h3>
          <p className="text-[13px] text-white/40 mt-1">
            Attach a card once → a smart wallet is created and funded with USDC on Base (gasless).
            Your agent gets a <span className="text-teal-400/80">scoped, revocable</span> spending
            key — never a raw private key.
          </p>
        </div>

        {/* Step 1 — provision */}
        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-white/30">
            Step 1 · Create funded wallet
          </div>
          {!wallet ? (
            <button
              onClick={provision}
              disabled={provisioning}
              className={`${BTN} bg-teal-400/20 text-teal-400 border border-teal-400/30 hover:bg-teal-400/30`}
            >
              {provisioning ? "Creating…" : "Create funded wallet"}
            </button>
          ) : (
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 space-y-2">
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
              <div className="text-[11px] text-white/40">
                {wallet.network} · smart account · gasless USDC
              </div>
              <a
                href={wallet.onrampUrl}
                target="_blank"
                rel="noreferrer"
                className={`${BTN} inline-block bg-lime-400/15 text-lime-300 border border-lime-400/30 hover:bg-lime-400/25`}
              >
                Fund with card →
              </a>
            </div>
          )}
        </div>

        {/* Step 2 — scoped key */}
        {wallet && (
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wide text-white/30">
              Step 2 · Issue a scoped agent key
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
                  <span
                    className={`text-[10px] rounded px-1.5 py-0.5 border ${
                      perm.revoked
                        ? "text-white/40 border-white/20"
                        : "text-emerald-400/80 border-emerald-400/30"
                    }`}
                  >
                    {perm.revoked ? "REVOKED" : "ACTIVE"}
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
                    className={`${BTN} bg-white/[0.04] text-white/50 border border-white/10 hover:text-rose-300 hover:border-rose-400/30`}
                  >
                    Revoke
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
