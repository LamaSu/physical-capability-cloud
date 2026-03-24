import React from "react";
import {
  GlassPanel,
  DataCell,
  GlowBadge,
  AddressDisplay,
  AmountDisplay,
  StatusChip,
  EmptyState,
} from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

// ── Types ────────────────────────────────────────────────────────

type Tab = "fund" | "withdraw" | "credits" | "activity";
type Provider = "stripe" | "yellowcard" | "wise" | "all";

interface FiatRampSession {
  id: string;
  provider: Provider;
  direction: "deposit" | "withdrawal";
  amountUsd: string;
  amountLocal?: string;
  localCurrency?: string;
  status: "pending" | "completed" | "failed";
  createdAt: number;
}

interface CreditUsageEntry {
  id: string;
  description: string;
  credits: number;
  createdAt: number;
}

// ── Mock Data ────────────────────────────────────────────────────

const MOCK_SESSIONS: FiatRampSession[] = [
  {
    id: "fr_001",
    provider: "stripe",
    direction: "deposit",
    amountUsd: "500.00",
    status: "completed",
    createdAt: Date.now() - 3_600_000,
  },
  {
    id: "fr_002",
    provider: "yellowcard",
    direction: "deposit",
    amountUsd: "200.00",
    amountLocal: "323,460",
    localCurrency: "NGN",
    status: "completed",
    createdAt: Date.now() - 7_200_000,
  },
  {
    id: "fr_003",
    provider: "yellowcard",
    direction: "withdrawal",
    amountUsd: "150.00",
    amountLocal: "242,595",
    localCurrency: "NGN",
    status: "pending",
    createdAt: Date.now() - 1_800_000,
  },
  {
    id: "fr_004",
    provider: "stripe",
    direction: "deposit",
    amountUsd: "1000.00",
    status: "completed",
    createdAt: Date.now() - 86_400_000,
  },
  {
    id: "fr_005",
    provider: "wise",
    direction: "withdrawal",
    amountUsd: "300.00",
    status: "completed",
    createdAt: Date.now() - 172_800_000,
  },
  {
    id: "fr_006",
    provider: "yellowcard",
    direction: "deposit",
    amountUsd: "75.00",
    amountLocal: "121,297",
    localCurrency: "NGN",
    status: "failed",
    createdAt: Date.now() - 259_200_000,
  },
];

const MOCK_CREDIT_USAGE: CreditUsageEntry[] = [
  { id: "cu_001", description: "Agent job submission — kernel-03", credits: -250, createdAt: Date.now() - 1_200_000 },
  { id: "cu_002", description: "API credits purchased", credits: 10_000, createdAt: Date.now() - 3_600_000 },
  { id: "cu_003", description: "Evidence verification — bundle_xyz", credits: -100, createdAt: Date.now() - 7_200_000 },
  { id: "cu_004", description: "Protocol run — FDM v1.2", credits: -500, createdAt: Date.now() - 14_400_000 },
  { id: "cu_005", description: "API credits purchased", credits: 5_000, createdAt: Date.now() - 86_400_000 },
];

const COUNTRIES = [
  { code: "NG", label: "Nigeria", currency: "NGN", rate: 1617.3, channels: ["Bank Transfer", "Mobile Money"] },
  { code: "KE", label: "Kenya", currency: "KES", rate: 129.5, channels: ["Bank Transfer", "M-PESA"] },
  { code: "ZA", label: "South Africa", currency: "ZAR", rate: 18.6, channels: ["Bank Transfer", "EFT"] },
  { code: "GH", label: "Ghana", currency: "GHS", rate: 15.7, channels: ["Bank Transfer", "Mobile Money"] },
  { code: "BR", label: "Brazil", currency: "BRL", rate: 5.02, channels: ["Bank Transfer", "PIX"] },
  { code: "MX", label: "Mexico", currency: "MXN", rate: 17.1, channels: ["Bank Transfer", "SPEI"] },
  { code: "IN", label: "India", currency: "INR", rate: 83.4, channels: ["Bank Transfer", "UPI"] },
  { code: "PH", label: "Philippines", currency: "PHP", rate: 55.9, channels: ["Bank Transfer", "GCash"] },
];

const SETTLEMENT_CONTRACT = "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985";

// ── Helpers ───────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

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

function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 16V4M4 10l6-6 6 6" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 4v12M16 10l-6 6-6-6" />
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

function ChainIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 7l-6 6M8 7H5a3 3 0 000 6h3M12 7h3a3 3 0 010 6h-3" />
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
    { id: "credits", label: "API Credits" },
    { id: "activity", label: "Activity" },
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
  const [stripeAmount, setStripeAmount] = React.useState("");
  const [stripeSubmitting, setStripeSubmitting] = React.useState(false);

  const [ycAmount, setYcAmount] = React.useState("");
  const [ycCountryIdx, setYcCountryIdx] = React.useState(0);
  const [ycChannel, setYcChannel] = React.useState(0);
  const [ycSubmitting, setYcSubmitting] = React.useState(false);

  const selectedCountry = COUNTRIES[ycCountryIdx];
  const ycLocalAmount = parseFloat(ycAmount) > 0
    ? formatNumber(parseFloat(ycAmount) * selectedCountry.rate, 2)
    : "—";

  const handleStripe = async () => {
    setStripeSubmitting(true);
    await fetch("/api/fiat-ramp/stripe/onramp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: stripeAmount }),
    }).catch(() => {});
    setTimeout(() => setStripeSubmitting(false), 1500);
  };

  const handleYellowcard = async () => {
    setYcSubmitting(true);
    await fetch("/api/fiat-ramp/yellowcard/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountUsd: ycAmount,
        country: selectedCountry.code,
        channel: selectedCountry.channels[ycChannel],
      }),
    }).catch(() => {});
    setTimeout(() => setYcSubmitting(false), 1500);
  };

  return (
    <div className="grid grid-cols-2 gap-4">
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

          <TrustBadges items={["Stripe handles KYC", "Fraud protection included", "USDC on Base"]} />

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
              <span className="text-[10px] text-white/30 font-mono">
                1 USD = {formatNumber(selectedCountry.rate, 2)} {selectedCountry.currency}
              </span>
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
            {parseFloat(ycAmount) > 0 && (
              <p className="text-[11px] text-white/40 font-mono">
                You pay: <span className="text-yellow-400/80">{ycLocalAmount} {selectedCountry.currency}</span>
              </p>
            )}
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
                <span className="text-emerald-500/70"><ChainIcon /></span>
                All funds held in USDC on Base
              </div>
              <GlowBadge color="cyan">Base L2</GlowBadge>
              <div className="text-xs text-white/30">|</div>
              <div className="flex items-center gap-1.5 text-xs text-white/40">
                <span className="text-emerald-500/70"><LockIcon size={12} /></span>
                No private keys shared
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-white/30">
              Settlement contract:
              <AddressDisplay address={SETTLEMENT_CONTRACT} chars={6} />
            </div>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}

// ── Tab: Withdraw ────────────────────────────────────────────────

function WithdrawTab() {
  const [amount, setAmount] = React.useState("");
  const [countryIdx, setCountryIdx] = React.useState(0);
  const [payoutMethod, setPayoutMethod] = React.useState(0);
  const [accountName, setAccountName] = React.useState("");
  const [accountNumber, setAccountNumber] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const selectedCountry = COUNTRIES[countryIdx];
  const localAmount = parseFloat(amount) > 0
    ? formatNumber(parseFloat(amount) * selectedCountry.rate, 2)
    : "—";
  const isMobileMoney = selectedCountry.channels[payoutMethod]?.toLowerCase().includes("money")
    || selectedCountry.channels[payoutMethod]?.toLowerCase().includes("pesa")
    || selectedCountry.channels[payoutMethod]?.toLowerCase().includes("gcash");

  const FEE_PERCENT = 0.015;
  const numAmount = parseFloat(amount) || 0;
  const feeAmount = numAmount * FEE_PERCENT;
  const netAmount = numAmount - feeAmount;

  const handleSubmit = async () => {
    setSubmitting(true);
    await fetch("/api/fiat-ramp/yellowcard/withdrawal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountUsd: amount,
        country: selectedCountry.code,
        channel: selectedCountry.channels[payoutMethod],
        accountName,
        accountNumber: isMobileMoney ? phone : accountNumber,
      }),
    }).catch(() => {});
    setTimeout(() => setSubmitting(false), 1500);
  };

  return (
    <div className="grid grid-cols-3 gap-4">
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
            {parseFloat(amount) > 0 && (
              <p className="text-[11px] text-white/40 font-mono">
                Converts to approx. <span className="text-yellow-400/80">{localAmount} {selectedCountry.currency}</span> at {formatNumber(selectedCountry.rate, 2)}
              </p>
            )}
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
        <GlassPanel padding="lg" glow={numAmount > 0 ? "green" : "none"}>
          <div className="space-y-3">
            <div className="space-y-2">
              {[
                { label: "Amount", value: numAmount > 0 ? `$${formatNumber(numAmount)}` : "—" },
                { label: "Network fee (1.5%)", value: numAmount > 0 ? `-$${formatNumber(feeAmount)}` : "—" },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center justify-between text-xs">
                  <span className="text-white/40">{label}</span>
                  <span className="text-white/60 font-mono">{value}</span>
                </div>
              ))}
              <div className="border-t border-white/[0.06] pt-2 flex items-center justify-between">
                <span className="text-xs text-white/50">You receive</span>
                <span className="text-sm font-mono text-emerald-400">
                  {numAmount > 0 ? `$${formatNumber(netAmount)}` : "—"}
                </span>
              </div>
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
            <span>Withdrawals are sourced directly from your USDC wallet on Base. KYC may be required for large amounts.</span>
          </div>
        </GlassPanel>
      </div>
    </div>
  );
}

// ── Tab: API Credits ─────────────────────────────────────────────

function CreditsTab({ creditBalance }: { creditBalance: number }) {
  const [buyAmount, setBuyAmount] = React.useState("");
  const [buying, setBuying] = React.useState(false);

  const creditsToReceive = parseFloat(buyAmount) > 0
    ? Math.floor(parseFloat(buyAmount) * 100)
    : 0;

  const handleBuy = async () => {
    setBuying(true);
    await fetch("/api/credits/purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: buyAmount }),
    }).catch(() => {});
    setTimeout(() => setBuying(false), 1500);
  };

  return (
    <div className="grid grid-cols-3 gap-4">
      {/* Balance + Purchase */}
      <div className="col-span-2 space-y-4">
        <GlassPanel padding="lg" glow="green">
          <div className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Current Credit Balance</p>
            <div className="text-4xl font-mono font-bold text-emerald-400">
              {creditBalance.toLocaleString()}
            </div>
            <p className="text-xs text-white/30">API credits</p>
          </div>
        </GlassPanel>

        <GlassPanel padding="lg">
          <div className="space-y-4">
            <p className="text-[10px] uppercase tracking-wider text-white/40">Purchase Credits</p>

            <div className="space-y-2">
              <p className="text-xs text-white/30">Amount in USD</p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
                <input
                  type="number"
                  min="1"
                  placeholder="10.00"
                  value={buyAmount}
                  onChange={(e) => setBuyAmount(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg pl-7 pr-3 py-2.5 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors"
                />
              </div>
              {creditsToReceive > 0 && (
                <p className="text-xs text-white/40 font-mono">
                  You will receive: <span className="text-emerald-400">{creditsToReceive.toLocaleString()} credits</span>
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs text-white/30 bg-white/[0.02] rounded-lg p-3 border border-white/[0.04]">
              <span className="text-teal-400/70 font-mono text-sm font-semibold">1 USD = 100 credits</span>
              <span className="text-white/20 mx-1">·</span>
              Credits deducted per API call, job submission, and evidence verification
            </div>

            <button
              onClick={handleBuy}
              disabled={buying || !buyAmount}
              className={`w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                buying || !buyAmount
                  ? "bg-white/5 text-white/30 cursor-not-allowed"
                  : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30"
              }`}
            >
              {buying ? "Processing…" : "Buy Credits"}
            </button>
          </div>
        </GlassPanel>
      </div>

      {/* Usage List */}
      <div className="space-y-3">
        <p className="text-[10px] uppercase tracking-wider text-white/40">Recent Usage</p>
        <div className="space-y-2">
          {MOCK_CREDIT_USAGE.map((entry) => (
            <GlassPanel key={entry.id} padding="sm">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-white/60 truncate">{entry.description}</p>
                  <p className="text-[10px] text-white/30 mt-0.5">{formatTime(entry.createdAt)}</p>
                </div>
                <span className={`text-sm font-mono font-semibold shrink-0 ${
                  entry.credits > 0 ? "text-emerald-400" : "text-red-400/80"
                }`}>
                  {entry.credits > 0 ? "+" : ""}{entry.credits.toLocaleString()}
                </span>
              </div>
            </GlassPanel>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Tab: Activity ─────────────────────────────────────────────────

function ActivityTab({ sessions }: { sessions: FiatRampSession[] }) {
  const [filterProvider, setFilterProvider] = React.useState<Provider>("all");

  const filtered = filterProvider === "all"
    ? sessions
    : sessions.filter((s) => s.provider === filterProvider);

  const providerFilters: { id: Provider; label: string }[] = [
    { id: "all", label: "All" },
    { id: "stripe", label: "Stripe" },
    { id: "yellowcard", label: "Yellowcard" },
    { id: "wise", label: "Wise" },
  ];

  function providerBadgeColor(p: Provider): "teal" | "gold" | "green" | "gray" {
    if (p === "stripe") return "teal";
    if (p === "yellowcard") return "gold";
    if (p === "wise") return "green";
    return "gray";
  }

  function sessionStatus(s: FiatRampSession["status"]): "completed" | "executing" | "failed" {
    if (s === "completed") return "completed";
    if (s === "pending") return "executing";
    return "failed";
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        {providerFilters.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilterProvider(f.id)}
            className={
              filterProvider === f.id
                ? "px-3 py-1 rounded-md bg-teal-400/20 text-teal-400 border border-teal-400/30 text-sm transition-all"
                : "px-3 py-1 rounded-md text-white/30 hover:text-white/50 text-sm transition-colors"
            }
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-white/30">{filtered.length} transactions</span>
      </div>

      {/* Session list */}
      {filtered.length === 0 ? (
        <GlassPanel padding="lg">
          <EmptyState
            title="No transactions"
            description="Fund your wallet or make a withdrawal to see activity here."
          />
        </GlassPanel>
      ) : (
        <div className="space-y-2">
          {filtered.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] cursor-pointer transition-colors"
            >
              {/* Direction arrow */}
              <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                session.direction === "deposit"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-orange-500/15 text-orange-400"
              }`}>
                {session.direction === "deposit" ? <ArrowDownIcon /> : <ArrowUpIcon />}
              </div>

              {/* Provider badge */}
              <GlowBadge color={providerBadgeColor(session.provider)}>
                {session.provider}
              </GlowBadge>

              {/* Direction label */}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white/70 capitalize">
                  {session.direction}
                  {session.localCurrency && (
                    <span className="text-white/30 text-xs ml-1.5 font-mono">
                      {session.amountLocal} {session.localCurrency}
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-white/30 font-mono">{session.id}</p>
              </div>

              {/* Amount */}
              <AmountDisplay amount={session.amountUsd} size="sm" />

              {/* Status */}
              <StatusChip status={sessionStatus(session.status)} />

              {/* Time */}
              <span className="text-[11px] text-white/30 shrink-0">{formatTime(session.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export function WalletPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  React.useEffect(() => {
    setPageMeta("Wallet & Funding", "Fund your agent wallet or withdraw earnings");
  }, [setPageMeta]);

  const [activeTab, setActiveTab] = React.useState<Tab>("fund");

  // Mock wallet data — try API first, fall back to mock
  const [walletBalance, setWalletBalance] = React.useState("1,234.56");
  const [pendingDeposits, setPendingDeposits] = React.useState(2);
  const [totalFunded, setTotalFunded] = React.useState("6,420.00");
  const [creditBalance, setCreditBalance] = React.useState(14_150);
  const [sessions, setSessions] = React.useState<FiatRampSession[]>(MOCK_SESSIONS);

  React.useEffect(() => {
    fetch("/api/wallet/balance")
      .then((r) => r.json())
      .then((d) => {
        if (d.balance) setWalletBalance(d.balance);
        if (d.pendingDeposits !== undefined) setPendingDeposits(d.pendingDeposits);
        if (d.totalFunded) setTotalFunded(d.totalFunded);
        if (d.creditBalance !== undefined) setCreditBalance(d.creditBalance);
      })
      .catch(() => {}); // keep mock

    fetch("/api/fiat-ramp/sessions")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.sessions) && d.sessions.length > 0) setSessions(d.sessions);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-6 p-6">
      {/* KPI Row */}
      <div className="grid grid-cols-4 gap-4">
        <GlassPanel padding="md" glow="green">
          <DataCell
            label="Wallet Balance"
            value={<AmountDisplay amount={walletBalance} size="md" glow />}
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Pending Deposits"
            value={pendingDeposits}
            sub="awaiting confirmation"
            mono
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="Total Funded"
            value={<AmountDisplay amount={totalFunded} size="md" />}
            sub="all-time"
          />
        </GlassPanel>
        <GlassPanel padding="md">
          <DataCell
            label="API Credits"
            value={creditBalance.toLocaleString()}
            sub="remaining"
            mono
          />
        </GlassPanel>
      </div>

      {/* Tab Bar */}
      <TabBar active={activeTab} onChange={setActiveTab} />

      {/* Tab Content */}
      {activeTab === "fund" && <FundWalletTab />}
      {activeTab === "withdraw" && <WithdrawTab />}
      {activeTab === "credits" && <CreditsTab creditBalance={creditBalance} />}
      {activeTab === "activity" && <ActivityTab sessions={sessions} />}
    </div>
  );
}
