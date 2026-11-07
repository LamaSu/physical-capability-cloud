import React from "react";
import {
  GlassPanel,
  GlowBadge,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { authorizedFetch } from "../lib/authorized-fetch.js";
import { scopeErrorMessage } from "../lib/scope-notice.js";
import { CdpFundedKeyOnramp } from "../components/CdpFundedKeyOnramp.js";

// ── Types ────────────────────────────────────────────────────────

type Tab = "fund" | "withdraw" | "activity" | "fundedkey";






const COUNTRIES = [
  { code: "NG", label: "Nigeria", currency: "NGN", channels: ["Bank Transfer", "Mobile Money"] },
  { code: "KE", label: "Kenya", currency: "KES", channels: ["Bank Transfer", "M-PESA"] },
  { code: "ZA", label: "South Africa", currency: "ZAR", channels: ["Bank Transfer", "EFT"] },
  { code: "GH", label: "Ghana", currency: "GHS", channels: ["Bank Transfer", "Mobile Money"] },
  { code: "BR", label: "Brazil", currency: "BRL", channels: ["Bank Transfer", "PIX"] },
  { code: "MX", label: "Mexico", currency: "MXN", channels: ["Bank Transfer", "SPEI"] },
  { code: "IN", label: "India", currency: "INR", channels: ["Bank Transfer", "UPI"] },
  { code: "PH", label: "Philippines", currency: "PHP", channels: ["Bank Transfer", "GCash"] },
];


// ── Helpers ───────────────────────────────────────────────────────


function formatNumber(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ── Inline SVG Icons ─────────────────────────────────────────────

function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="9" width="12" height="9" rx="1" />
      <path d="M7 9V6a3 3 0 016 0v3" />
    </svg>
  );
}



function GlobeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c-2 2-3 4.5-3 7s1 5 3 7M10 3c2 2 3 4.5 3 7s-1 5-3 7" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="16" height="12" rx="2" />
      <path d="M2 9h16M6 13h2M10 13h4" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17h14M5 17V5a1 1 0 011-1h8a1 1 0 011 1v12M8 9h1M11 9h1M8 13h1M11 13h1" />
    </svg>
  );
}


// ── Sub-sections ──────────────────────────────────────────────────

function TrustBadges({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {items.map((item) => (
        <div key={item} className="flex items-center gap-1.5 text-[11px] text-white/40 bg-white/[0.03] border border-white/[0.06] rounded-full px-2.5 py-1">
          <span className="text-emerald-500/70"><LockIcon size={11} /></span>
          {item}
        </div>
      ))}
    </div>
  );
}

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "fund", label: "Fund Wallet" },
    { id: "withdraw", label: "Withdraw" },
    { id: "activity", label: "Activity" },
    { id: "fundedkey", label: "Funded Key" },
  ];
  return (
    <div className="flex items-center gap-1 bg-white/[0.03] border border-white/[0.06] rounded-xl p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={
            active === t.id
              ? "px-3 py-1 rounded-md bg-teal-400/20 text-teal-400 border border-teal-400/30 text-sm font-medium transition-all"
              : "px-3 py-1 rounded-md text-white/30 hover:text-white/50 text-sm transition-colors"
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Tab: Fund Wallet ─────────────────────────────────────────────

function FundWalletTab() {
  const [notice, setNotice] = React.useState<string | null>(null);
  const [stripeAmount, setStripeAmount] = React.useState("");
  const [stripeSubmitting, setStripeSubmitting] = React.useState(false);

  const [ycAmount, setYcAmount] = React.useState("");
  const [ycCountryIdx, setYcCountryIdx] = React.useState(0);
  const [ycChannel, setYcChannel] = React.useState(0);
  const [ycSubmitting, setYcSubmitting] = React.useState(false);

  const selectedCountry = COUNTRIES[ycCountryIdx];

  const handleStripe = async () => {
    setStripeSubmitting(true);
    setNotice(null);
    await authorizedFetch("/api/fiat-ramp/stripe/onramp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: stripeAmount }),
    }).then(async (res) => setNotice(await scopeErrorMessage(res, "/api/fiat-ramp/stripe/onramp", "POST"))).catch(() => {});
    setTimeout(() => setStripeSubmitting(false), 1500);
  };

  const handleYellowcard = async () => {
    setYcSubmitting(true);
    setNotice(null);
    await authorizedFetch("/api/fiat-ramp/yellowcard/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountUsd: ycAmount,
        country: selectedCountry.code,
        channel: selectedCountry.channels[ycChannel],
      }),
    }).then(async (res) => setNotice(await scopeErrorMessage(res, "/api/fiat-ramp/yellowcard/deposit", "POST"))).catch(() => {});
    setTimeout(() => setYcSubmitting(false), 1500);
  };

  return (
    <div className="grid grid-cols-2 gap-4">
      {notice && <p role="status" className="col-span-2 text-xs text-amber-400/80">{notice}</p>}
      {/* Stripe Card */}
      <GlassPanel padding="lg">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-[#635bff]/20 border border-[#635bff]/30 flex items-center justify-center text-[#7c75ff]">
                <CardIcon />
              </div>
              <div>
                <p className="text-sm font-medium text-white/80">Credit Card / ACH</p>
                <p className="text-[11px] text-white/30">Powered by Stripe</p>
              </div>
            </div>
            <GlowBadge color="teal">US + EU</GlowBadge>
          </div>

          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Amount (USD)</p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
              <input
                type="number"
                min="10"
                placeholder="100.00"
                value={stripeAmount}
                onChange={(e) => setStripeAmount(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-7 pr-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors"
              />
            </div>
          </div>

          <button
            onClick={handleStripe}
            disabled={stripeSubmitting || !stripeAmount}
            className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              stripeSubmitting || !stripeAmount
                ? "bg-white/5 text-white/30 cursor-not-allowed"
                : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30"
            }`}
          >
            {stripeSubmitting ? "Opening Stripe…" : "Fund via Stripe"}
          </button>

          <TrustBadges items={["Stripe handles KYC", "Fraud protection included"]} />

          <div className="flex items-start gap-2 text-[11px] text-white/40 bg-white/[0.02] border border-white/[0.04] rounded-lg p-2.5">
            <span className="text-emerald-500/70 mt-0.5 shrink-0"><LockIcon size={12} /></span>
            <span>Stripe assumes fraud liability. Your card details never touch PCC servers.</span>
          </div>
        </div>
      </GlassPanel>

      {/* Yellowcard Card */}
      <GlassPanel padding="lg">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-yellow-500/15 border border-yellow-500/25 flex items-center justify-center text-yellow-400">
                <GlobeIcon />
              </div>
              <div>
                <p className="text-sm font-medium text-white/80">Bank Transfer / Mobile Money</p>
                <p className="text-[11px] text-white/30">Powered by Yellowcard</p>
              </div>
            </div>
            <GlowBadge color="gold">34 countries</GlowBadge>
          </div>

          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Country</p>
            <select
              value={ycCountryIdx}
              onChange={(e) => { setYcCountryIdx(Number(e.target.value)); setYcChannel(0); }}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 focus:border-green-500/30 focus:outline-none transition-colors"
            >
              {COUNTRIES.map((c, i) => (
                <option key={c.code} value={i} className="bg-[#0a0a0a]">{c.label} ({c.currency})</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wider text-white/40">Amount (USD)</p>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
              <input
                type="number"
                min="5"
                placeholder="50.00"
                value={ycAmount}
                onChange={(e) => setYcAmount(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-7 pr-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors"
              />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Payment Channel</p>
            <div className="flex gap-2">
              {selectedCountry.channels.map((ch, i) => (
                <button
                  key={ch}
                  onClick={() => setYcChannel(i)}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs transition-all ${
                    ycChannel === i
                      ? "bg-teal-400/20 text-teal-400 border border-teal-400/30"
                      : "bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70"
                  }`}
                >
                  {ch}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleYellowcard}
            disabled={ycSubmitting || !ycAmount}
            className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              ycSubmitting || !ycAmount
                ? "bg-white/5 text-white/30 cursor-not-allowed"
                : "bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 hover:bg-yellow-500/25"
            }`}
          >
            {ycSubmitting ? "Connecting…" : "Deposit via Yellowcard"}
          </button>

          <TrustBadges items={["Licensed in 34 countries", "Instant mobile money"]} />
        </div>
      </GlassPanel>

      {/* Chain Trust Notice */}
      <div className="col-span-2">
        <GlassPanel padding="md">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-white/40">
                <span className="text-emerald-500/70"><LockIcon size={12} /></span>
                No private keys shared
              </div>
            </div>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}

// ── Tab: Withdraw ────────────────────────────────────────────────

function WithdrawTab() {
  const [notice, setNotice] = React.useState<string | null>(null);
  const [amount, setAmount] = React.useState("");
  const [countryIdx, setCountryIdx] = React.useState(0);
  const [payoutMethod, setPayoutMethod] = React.useState(0);
  const [accountName, setAccountName] = React.useState("");
  const [accountNumber, setAccountNumber] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const selectedCountry = COUNTRIES[countryIdx];
  const isMobileMoney = selectedCountry.channels[payoutMethod]?.toLowerCase().includes("money")
    || selectedCountry.channels[payoutMethod]?.toLowerCase().includes("pesa")
    || selectedCountry.channels[payoutMethod]?.toLowerCase().includes("gcash");

  const numAmount = parseFloat(amount) || 0;

  const handleSubmit = async () => {
    setSubmitting(true);
    setNotice(null);
    await authorizedFetch("/api/fiat-ramp/yellowcard/withdrawal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountUsd: amount,
        country: selectedCountry.code,
        channel: selectedCountry.channels[payoutMethod],
        accountName,
        accountNumber: isMobileMoney ? phone : accountNumber,
      }),
    }).then(async (res) => setNotice(await scopeErrorMessage(res, "/api/fiat-ramp/yellowcard/withdrawal", "POST"))).catch(() => {});
    setTimeout(() => setSubmitting(false), 1500);
  };

  return (
    <div className="grid grid-cols-3 gap-4">
      {notice && <p role="status" className="col-span-3 text-xs text-amber-400/80">{notice}</p>}
      {/* Form */}
      <div className="col-span-2 space-y-4">
        {/* Amount */}
        <GlassPanel padding="lg">
          <div className="space-y-4">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Withdrawal Amount</p>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
              <input
                type="number"
                min="10"
                placeholder="100.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-7 pr-16 py-2.5 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-white/30">USDC</span>
            </div>
          </div>
        </GlassPanel>

        {/* Destination */}
        <GlassPanel padding="lg">
          <div className="space-y-4">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Destination</p>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <p className="text-[10px] text-white/30">Country</p>
                <select
                  value={countryIdx}
                  onChange={(e) => { setCountryIdx(Number(e.target.value)); setPayoutMethod(0); }}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 focus:border-green-500/30 focus:outline-none transition-colors"
                >
                  {COUNTRIES.map((c, i) => (
                    <option key={c.code} value={i} className="bg-[#0a0a0a]">{c.label}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <p className="text-[10px] text-white/30">Payout Method</p>
                <select
                  value={payoutMethod}
                  onChange={(e) => setPayoutMethod(Number(e.target.value))}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 focus:border-green-500/30 focus:outline-none transition-colors"
                >
                  {selectedCountry.channels.map((ch, i) => (
                    <option key={ch} value={i} className="bg-[#0a0a0a]">{ch}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-[10px] text-white/30">Account Holder Name</p>
              <input
                type="text"
                placeholder="Full legal name"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors"
              />
            </div>

            {isMobileMoney ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <p className="text-[10px] text-white/30">Mobile Phone Number</p>
                  <input
                    type="tel"
                    placeholder="+234 800 000 0000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors"
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-[10px] text-white/30">Network</p>
                  <select className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 focus:border-green-500/30 focus:outline-none transition-colors">
                    <option className="bg-[#0a0a0a]">M-PESA</option>
                    <option className="bg-[#0a0a0a]">MTN Mobile Money</option>
                    <option className="bg-[#0a0a0a]">Airtel Money</option>
                  </select>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="text-[10px] text-white/30">Account Number / IBAN</p>
                <input
                  type="text"
                  placeholder="Account number or IBAN"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors"
                />
              </div>
            )}
          </div>
        </GlassPanel>

        {/* Enterprise (Wise) */}
        <GlassPanel padding="md">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#9fe870]/10 border border-[#9fe870]/20 flex items-center justify-center text-[#9fe870] shrink-0 mt-0.5">
              <BuildingIcon />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-sm font-medium text-white/70">Enterprise Payout</p>
                <GlowBadge color="green">Wise</GlowBadge>
              </div>
              <p className="text-xs text-white/40 leading-relaxed">
                Send to institutional bank accounts in 40+ currencies via Wise.
                Ideal for enterprises that prefer traditional banking rails.
              </p>
              <button className="mt-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 text-xs transition-colors">
                Configure Wise Payout
              </button>
            </div>
          </div>
        </GlassPanel>
      </div>

      {/* Summary Panel */}
      <div className="space-y-3">
        <p className="text-[10px] uppercase tracking-wider text-white/40">Withdrawal Summary</p>
        <GlassPanel padding="lg">
          <div className="space-y-3">
            <div className="space-y-2">
              {[
                { label: "Amount", value: numAmount > 0 ? `$${formatNumber(numAmount)}` : "—" },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between text-xs">
                  <span className="text-white/40">{label}</span>
                  <span className="text-white/60 font-mono">{value}</span>
                </div>
              ))}
            </div>

            <div className="space-y-1.5 pt-1 border-t border-white/[0.04]">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-white/30">Est. delivery</span>
                <span className="text-white/50">
                  {isMobileMoney ? "Instant – 2h" : "1–3 business days"}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-white/30">Provider</span>
                <span className="text-white/50">Yellowcard</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-white/30">Destination</span>
                <span className="text-white/50">{selectedCountry.label}</span>
              </div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={submitting || !amount || !accountName || (!isMobileMoney ? !accountNumber : !phone)}
              className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                submitting || !amount || !accountName
                  ? "bg-white/5 text-white/30 cursor-not-allowed"
                  : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30"
              }`}
            >
              {submitting ? "Submitting…" : "Submit Withdrawal"}
            </button>
          </div>
        </GlassPanel>

        <GlassPanel padding="md">
          <div className="flex items-start gap-2 text-[11px] text-white/40">
            <span className="text-emerald-500/70 mt-0.5 shrink-0"><LockIcon size={12} /></span>
            <span>Withdrawals are sourced directly from your USDC wallet. KYC may be required for large amounts.</span>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}


// ── Tab: Activity ─────────────────────────────────────────────────

function ActivityTab() {
  return <p>Your funding activity isn't shown here yet.</p>;
}

// ── Main Page ─────────────────────────────────────────────────────

export function WalletPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => {
    setPageMeta("Wallet & Funding", "Fund your agent wallet or withdraw earnings");
  }, [setPageMeta]);

  const [activeTab, setActiveTab] = React.useState<Tab>("fund");



  return (
    <div className="space-y-6 p-6">

      {/* Tab Bar */}
      <TabBar active={activeTab} onChange={setActiveTab} />

      {/* Tab Content */}
      {activeTab === "fund" && <FundWalletTab />}
      {activeTab === "withdraw" && <WithdrawTab />}
      {activeTab === "activity" && <ActivityTab />}
      {activeTab === "fundedkey" && <CdpFundedKeyOnramp />}
    </div>
  );
}
