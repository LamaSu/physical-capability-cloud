import React, { useState, useEffect, useRef } from "react";
import { useUIStore } from "../stores/ui-store.js";
import { getAuthHeaders } from "../stores/auth-store.js";
import { GlowBadge, cn } from "@pcc/ui";

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const BOUNTIES = [
  { id: 1, name: "Electron Beam Welding", reward: 2500, demand: 7, tier: 3, daysLeft: 12, hoursLeft: 4, category: "manufacturing" as const },
  { id: 2, name: "Cryo-EM Imaging", reward: 5000, demand: 12, tier: 3, daysLeft: 8, hoursLeft: 16, category: "lab" as const },
  { id: 3, name: "Precision Laser Sintering", reward: 1500, demand: 4, tier: 2, daysLeft: 20, hoursLeft: 9, category: "manufacturing" as const },
  { id: 4, name: "Autonomous Drone Survey", reward: 800, demand: 9, tier: 1, daysLeft: 15, hoursLeft: 22, category: "transport" as const },
  { id: 5, name: "qPCR Diagnostic Assay", reward: 1200, demand: 6, tier: 2, daysLeft: 25, hoursLeft: 11, category: "lab" as const },
  { id: 6, name: "EV Fast Charge 150kW", reward: 3000, demand: 15, tier: 2, daysLeft: 10, hoursLeft: 7, category: "energy" as const },
];

const CAPABILITIES = [
  { name: "FDM 3D Printing", operators: 24, avgPrice: "$0.50/g", tier: 1, domain: "manufacturing" as const, emoji: "\uD83D\uDDA8\uFE0F" },
  { name: "5-Axis CNC", operators: 8, avgPrice: "$175/hr", tier: 2, domain: "manufacturing" as const, emoji: "\u2699\uFE0F" },
  { name: "HPLC Analysis", operators: 5, avgPrice: "$280/run", tier: 2, domain: "lab" as const, emoji: "\uD83E\uDDEA" },
  { name: "Mass Spectrometry", operators: 3, avgPrice: "$420/sample", tier: 2, domain: "lab" as const, emoji: "\uD83D\uDD2C" },
  { name: "Same-Day Courier", operators: 12, avgPrice: "$75/trip", tier: 1, domain: "transport" as const, emoji: "\uD83D\uDE9A" },
  { name: "Laser Cutting", operators: 15, avgPrice: "$5/min", tier: 1, domain: "manufacturing" as const, emoji: "\u2702\uFE0F" },
  { name: "PCB Assembly", operators: 6, avgPrice: "$8/board", tier: 2, domain: "manufacturing" as const, emoji: "\uD83D\uDD0C" },
  { name: "EV Charging L2", operators: 45, avgPrice: "$0.35/kWh", tier: 1, domain: "energy" as const, emoji: "\u26A1" },
];

const LEADERBOARD = [
  { rank: 1, name: "BioLab SF", did: "did:key:z6Mkp...", capabilities: 5, jobs: 142, earnings: 48500, rep: 970 },
  { rank: 2, name: "PrecisionWorks", did: "did:key:z6Mkq...", capabilities: 3, jobs: 98, earnings: 35200, rep: 945 },
  { rank: 3, name: "BayArea Express", did: "did:key:z6Mkr...", capabilities: 2, jobs: 267, earnings: 22100, rep: 920 },
  { rank: 4, name: "NanoFab Labs", did: "did:key:z6Mks...", capabilities: 4, jobs: 56, earnings: 19800, rep: 890 },
  { rank: 5, name: "FlowChem Inc", did: "did:key:z6Mkt...", capabilities: 2, jobs: 34, earnings: 12400, rep: 865 },
];

const TECH_BADGES: { label: string; color: string }[] = [
  { label: "Metaplex Core", color: "text-purple-400 bg-purple-500/15 border-purple-500/30" },
  { label: "Meteora DLMM", color: "text-cyan-400 bg-cyan-500/15 border-cyan-500/30" },
  { label: "Lit Protocol", color: "text-amber-400 bg-amber-500/15 border-amber-500/30" },
  { label: "Bittensor/POA", color: "text-green-400 bg-green-500/15 border-green-500/30" },
  { label: "Arkhai", color: "text-rose-400 bg-rose-500/15 border-rose-500/30" },
  { label: "IPFS", color: "text-blue-400 bg-blue-500/15 border-blue-500/30" },
  { label: "Base", color: "text-indigo-400 bg-indigo-500/15 border-indigo-500/30" },
  { label: "Solana", color: "text-teal-400 bg-teal-500/15 border-teal-500/30" },
  { label: "x402", color: "text-orange-400 bg-orange-500/15 border-orange-500/30" },
  { label: "W3C DID", color: "text-emerald-400 bg-emerald-500/15 border-emerald-500/30" },
  { label: "ZK/Noir", color: "text-pink-400 bg-pink-500/15 border-pink-500/30" },
];

// ---------------------------------------------------------------------------
// Domain color helpers
// ---------------------------------------------------------------------------

type Domain = "lab" | "manufacturing" | "transport" | "energy";

const DOMAIN_COLORS: Record<Domain, { border: string; text: string; bg: string; glow: string; tag: string }> = {
  lab:           { border: "border-purple-500/40", text: "text-purple-300",  bg: "bg-purple-500/10", glow: "shadow-[0_0_20px_rgba(139,92,246,0.2)]",  tag: "bg-purple-500/20 text-purple-300 border-purple-500/30" },
  manufacturing: { border: "border-orange-500/40", text: "text-orange-300",  bg: "bg-orange-500/10", glow: "shadow-[0_0_20px_rgba(249,115,22,0.2)]",  tag: "bg-orange-500/20 text-orange-300 border-orange-500/30" },
  transport:     { border: "border-blue-500/40",   text: "text-blue-300",    bg: "bg-blue-500/10",   glow: "shadow-[0_0_20px_rgba(59,130,246,0.2)]",   tag: "bg-blue-500/20 text-blue-300 border-blue-500/30" },
  energy:        { border: "border-green-500/40",  text: "text-green-300",   bg: "bg-green-500/10",  glow: "shadow-[0_0_20px_rgba(34,197,94,0.2)]",    tag: "bg-green-500/20 text-green-300 border-green-500/30" },
};

const DOMAIN_LABELS: Record<Domain, string> = {
  lab: "Lab",
  manufacturing: "Mfg",
  transport: "Transport",
  energy: "Energy",
};

// ---------------------------------------------------------------------------
// Animated Counter
// ---------------------------------------------------------------------------

function AnimatedCounter({ target, duration = 2000, prefix = "", suffix = "" }: { target: number; duration?: number; prefix?: string; suffix?: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * target));
      if (progress >= 1) clearInterval(timer);
    }, 30);
    return () => clearInterval(timer);
  }, [target, duration]);
  return <span>{prefix}{count.toLocaleString()}{suffix}</span>;
}

// ---------------------------------------------------------------------------
// Star Rating
// ---------------------------------------------------------------------------

function Stars({ count, max = 5 }: { count: number; max?: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} className={i < count ? "text-yellow-400" : "text-white/20"}>
          &#9733;
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Feedback Modal (kept from original)
// ---------------------------------------------------------------------------

function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [type, setType] = useState<"bug" | "comment" | "difficulty" | "suggestion">("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  if (!open) return null;

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ type, message, page: window.location.pathname }),
      });
      if (res.ok) {
        setStatus("sent");
        setMessage("");
        setTimeout(() => { setStatus("idle"); onClose(); }, 1500);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 rounded-2xl border border-white/[0.08] bg-gray-900/95 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white">Report a Bug or Leave Feedback</h2>
          <p className="text-xs text-white/40">Found something weird? Having trouble? Let us know.</p>
          <div className="flex gap-2">
            {(["bug", "difficulty", "suggestion", "comment"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={cn(
                  "px-3 py-1.5 text-xs rounded-xl border capitalize transition-all",
                  type === t
                    ? "bg-teal-500/20 border-teal-500/40 text-teal-300"
                    : "border-white/[0.08] text-white/40 hover:text-white/60",
                )}
              >
                {t === "bug" ? "Bug Report" : t === "difficulty" ? "Having Trouble" : t === "suggestion" ? "Suggestion" : "Comment"}
              </button>
            ))}
          </div>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Describe the issue or share your thoughts..."
            rows={5}
            maxLength={5000}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white/80 placeholder-white/25 outline-none focus:border-teal-500/40 transition-colors resize-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/20">{message.length}/5000</span>
            <div className="flex gap-3">
              <button onClick={onClose} className="px-4 py-2 text-xs text-white/40 hover:text-white/60 transition-colors">Cancel</button>
              <button
                onClick={handleSubmit}
                disabled={!message.trim() || status === "sending"}
                className={cn(
                  "px-6 py-2 rounded-xl text-sm font-medium transition-all",
                  status === "sent"
                    ? "bg-green-500/20 text-green-400 border border-green-500/30"
                    : status === "error"
                    ? "bg-red-500/20 text-red-400 border border-red-500/30"
                    : "bg-teal-500 hover:bg-teal-400 text-white disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                {status === "sending" ? "Sending..." : status === "sent" ? "Submitted!" : status === "error" ? "Failed -- retry?" : "Submit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function AgentChatPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const bountyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPageMeta("PCC Network", "The Capability Network");
  }, [setPageMeta]);

  const scrollToBounties = () => {
    bountyRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">

      {/* ================================================================= */}
      {/* SECTION 1: HERO — "The Capability Network" */}
      {/* ================================================================= */}
      <section className="relative overflow-hidden py-20 px-6">
        {/* Animated gradient background */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute inset-0 bg-gradient-to-br from-teal-900/40 via-purple-900/30 to-cyan-900/40 animate-gradient-shift" />
          <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full bg-teal-500/10 blur-3xl animate-pulse" />
          <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full bg-purple-500/10 blur-3xl animate-pulse" style={{ animationDelay: "1s" }} />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-cyan-500/5 blur-3xl animate-pulse" style={{ animationDelay: "2s" }} />
        </div>

        <div className="max-w-5xl mx-auto text-center space-y-8">
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight text-white">
            The Capability{" "}
            <span className="bg-gradient-to-r from-teal-400 via-cyan-400 to-purple-400 bg-clip-text text-transparent">
              Network
            </span>
          </h1>
          <p className="text-xl md:text-2xl text-white/50 max-w-2xl mx-auto leading-relaxed">
            AWS for the physical world. Discover, book, and verify real-world manufacturing capabilities on-chain.
          </p>

          {/* Live stats */}
          <div className="flex flex-wrap justify-center gap-8 text-lg md:text-xl font-bold text-white/80">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-teal-400 animate-pulse" />
              <AnimatedCounter target={847} /> <span className="font-normal text-white/40">Capabilities</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-400 animate-pulse" />
              <AnimatedCounter target={163} /> <span className="font-normal text-white/40">Operators</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
              <AnimatedCounter target={12438} /> <span className="font-normal text-white/40">Jobs Completed</span>
            </div>
          </div>

          {/* CTA buttons */}
          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <button
              onClick={scrollToBounties}
              className={cn(
                "px-8 py-4 rounded-2xl text-lg font-bold transition-all duration-300",
                "bg-teal-500 hover:bg-teal-400 text-white",
                "shadow-[0_0_40px_rgba(20,184,166,0.3)] hover:shadow-[0_0_60px_rgba(20,184,166,0.5)]",
                "hover:scale-105 active:scale-95",
              )}
            >
              Explore the Network
            </button>
            <a
              href="/onboard"
              className={cn(
                "px-8 py-4 rounded-2xl text-lg font-bold transition-all duration-300",
                "border-2 border-purple-500/50 text-purple-300",
                "hover:bg-purple-500/10 hover:border-purple-400/70",
                "hover:shadow-[0_0_30px_rgba(139,92,246,0.3)]",
                "hover:scale-105 active:scale-95",
              )}
            >
              Add Your Capability
            </a>
          </div>

          {/* Feedback button */}
          <button
            onClick={() => setFeedbackOpen(true)}
            className="text-sm text-white/30 hover:text-teal-300 transition-colors underline underline-offset-4 decoration-white/10 hover:decoration-teal-400/40"
          >
            Report Bugs / Leave Feedback
          </button>
        </div>
      </section>

      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

      <div className="max-w-7xl mx-auto w-full px-6 space-y-24 pb-16">

        {/* ================================================================= */}
        {/* TECH BADGES */}
        {/* ================================================================= */}
        <section className="space-y-4">
          <p className="text-center text-sm text-white/30 uppercase tracking-widest font-medium">Built with 18 protocol layers</p>
          <div className="flex flex-wrap justify-center gap-3">
            {TECH_BADGES.map((badge, i) => (
              <span
                key={badge.label}
                className={cn(
                  "inline-flex items-center rounded-full border px-4 py-1.5 text-sm font-medium transition-transform hover:scale-105",
                  badge.color,
                )}
                style={{ animation: `float ${3 + (i % 3)}s ease-in-out infinite`, animationDelay: `${i * 0.2}s` }}
              >
                {badge.label}
              </span>
            ))}
          </div>
        </section>

        {/* ================================================================= */}
        {/* DEMO VIDEOS */}
        {/* ================================================================= */}
        <section className="space-y-6">
          <h2 className="text-3xl font-bold text-white text-center">See It In Action</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[
              { src: "https://www.youtube.com/embed/MxWOh0DJhGE", title: "PCCP Demo" },
              { src: "https://www.youtube.com/embed/7Dxt_UkZZto", title: "PCCP Technical Walkthrough" },
            ].map((video) => (
              <div
                key={video.src}
                className="aspect-video rounded-2xl overflow-hidden border border-teal-500/20 shadow-[0_0_30px_rgba(20,184,166,0.1)] hover:shadow-[0_0_40px_rgba(20,184,166,0.2)] transition-shadow"
              >
                <iframe
                  width="100%"
                  height="100%"
                  src={video.src}
                  title={video.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="w-full h-full"
                />
              </div>
            ))}
          </div>
        </section>

        {/* ================================================================= */}
        {/* SECTION 2: "WHAT'S HOT" — BOUNTY BOARD */}
        {/* ================================================================= */}
        <section ref={bountyRef} className="space-y-8">
          <div className="text-center space-y-2">
            <h2 className="text-4xl md:text-5xl font-extrabold text-white">
              What's{" "}
              <span className="bg-gradient-to-r from-yellow-400 to-orange-400 bg-clip-text text-transparent">
                Hot
              </span>
            </h2>
            <p className="text-lg text-white/40">Capabilities in demand right now. Claim a bounty, earn rewards.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {BOUNTIES.map((bounty) => {
              const domainColors = DOMAIN_COLORS[bounty.category];
              return (
                <div
                  key={bounty.id}
                  className={cn(
                    "group relative rounded-2xl border bg-white/[0.03] backdrop-blur-sm p-6 space-y-4 transition-all duration-300",
                    "hover:scale-[1.03] hover:bg-white/[0.06]",
                    domainColors.border,
                    "hover:" + domainColors.glow.replace("shadow-", "shadow-"),
                  )}
                  style={{ boxShadow: "none" }}
                  onMouseEnter={(e) => {
                    const glowMatch = domainColors.glow.match(/rgba\([^)]+\)/);
                    if (glowMatch) e.currentTarget.style.boxShadow = `0 0 30px ${glowMatch[0]}`;
                  }}
                  onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; }}
                >
                  {/* Category tag */}
                  <div className="flex items-center justify-between">
                    <span className={cn("text-[11px] uppercase tracking-wider font-bold px-2.5 py-1 rounded-lg border", domainColors.tag)}>
                      {DOMAIN_LABELS[bounty.category]}
                    </span>
                    <span className="text-xs text-white/30">{bounty.daysLeft}d {bounty.hoursLeft}h left</span>
                  </div>

                  {/* Bounty name */}
                  <h3 className="text-xl font-bold text-white leading-tight">{bounty.name}</h3>

                  {/* Reward badge */}
                  <div className="flex items-center gap-3">
                    <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-yellow-500/15 border border-yellow-500/30 text-yellow-300 font-bold text-lg">
                      ${bounty.reward.toLocaleString()}
                    </span>
                    <span className="text-sm text-white/40">
                      {bounty.demand} {bounty.demand === 1 ? "person wants" : "people want"} this
                    </span>
                  </div>

                  {/* Difficulty */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white/40">Difficulty:</span>
                    <Stars count={bounty.tier} max={3} />
                    <span className="text-xs text-white/30">Tier {bounty.tier}</span>
                  </div>

                  {/* Claim button */}
                  <button
                    className={cn(
                      "w-full py-3 rounded-xl text-base font-bold transition-all duration-200",
                      "bg-green-500 hover:bg-green-400 text-white",
                      "shadow-[0_0_20px_rgba(34,197,94,0.2)] hover:shadow-[0_0_30px_rgba(34,197,94,0.4)]",
                      "hover:scale-[1.02] active:scale-95",
                    )}
                  >
                    CLAIM BOUNTY
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* ================================================================= */}
        {/* SECTION 3: "TOP CAPABILITIES" */}
        {/* ================================================================= */}
        <section className="space-y-8">
          <div className="text-center space-y-2">
            <h2 className="text-4xl md:text-5xl font-extrabold text-white">
              Top{" "}
              <span className="bg-gradient-to-r from-teal-400 to-cyan-400 bg-clip-text text-transparent">
                Capabilities
              </span>
            </h2>
            <p className="text-lg text-white/40">What's already live on the network. Ready to use.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {CAPABILITIES.map((cap) => {
              const domainColors = DOMAIN_COLORS[cap.domain];
              return (
                <div
                  key={cap.name}
                  className={cn(
                    "group rounded-2xl border bg-white/[0.03] backdrop-blur-sm p-5 space-y-3 transition-all duration-300",
                    "hover:scale-[1.03] hover:bg-white/[0.06]",
                    domainColors.border,
                  )}
                  onMouseEnter={(e) => {
                    const glowMatch = domainColors.glow.match(/rgba\([^)]+\)/);
                    if (glowMatch) e.currentTarget.style.boxShadow = `0 0 25px ${glowMatch[0]}`;
                  }}
                  onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; }}
                >
                  {/* Icon + Domain */}
                  <div className="flex items-center justify-between">
                    <span className="text-3xl">{cap.emoji}</span>
                    <span className={cn("text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-lg border", domainColors.tag)}>
                      {DOMAIN_LABELS[cap.domain]}
                    </span>
                  </div>

                  {/* Name */}
                  <h3 className="text-lg font-bold text-white">{cap.name}</h3>

                  {/* Stats */}
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-white/40">Operators</span>
                      <span className="text-white/80 font-medium">{cap.operators}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/40">Avg Price</span>
                      <span className="text-white/80 font-medium">{cap.avgPrice}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-white/40">Tier</span>
                      <GlowBadge color={cap.tier >= 2 ? "gold" : "teal"}>Tier {cap.tier}</GlowBadge>
                    </div>
                  </div>

                  {/* Use button */}
                  <button
                    className={cn(
                      "w-full py-2.5 rounded-xl text-sm font-bold transition-all duration-200",
                      "bg-teal-500/20 border border-teal-500/30 text-teal-300",
                      "hover:bg-teal-500 hover:text-white",
                      "hover:shadow-[0_0_20px_rgba(20,184,166,0.3)]",
                      "hover:scale-[1.02] active:scale-95",
                    )}
                  >
                    USE THIS
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* ================================================================= */}
        {/* SECTION 4: LEADERBOARD */}
        {/* ================================================================= */}
        <section className="space-y-8">
          <div className="text-center space-y-2">
            <h2 className="text-4xl md:text-5xl font-extrabold text-white">
              Leader{" "}
              <span className="bg-gradient-to-r from-yellow-400 via-amber-400 to-orange-400 bg-clip-text text-transparent">
                board
              </span>
            </h2>
            <p className="text-lg text-white/40">Top operators on the network. Will you make the list?</p>
          </div>

          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-sm overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[60px_1fr_100px_100px_120px_120px] gap-4 px-6 py-3 border-b border-white/[0.06] text-xs text-white/40 uppercase tracking-wider font-medium">
              <span>Rank</span>
              <span>Operator</span>
              <span className="text-center">Caps</span>
              <span className="text-center">Jobs</span>
              <span className="text-right">Earned</span>
              <span className="text-right">Rep Score</span>
            </div>

            {/* Rows */}
            {LEADERBOARD.map((op) => {
              const rankBadge =
                op.rank === 1 ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/40" :
                op.rank === 2 ? "bg-gray-400/20 text-gray-300 border-gray-400/40" :
                op.rank === 3 ? "bg-amber-700/20 text-amber-400 border-amber-700/40" :
                "bg-white/5 text-white/50 border-white/10";

              const rankEmoji = op.rank === 1 ? "\uD83E\uDD47" : op.rank === 2 ? "\uD83E\uDD48" : op.rank === 3 ? "\uD83E\uDD49" : "";

              const repPercent = Math.round((op.rep / 1000) * 100);

              return (
                <div
                  key={op.rank}
                  className={cn(
                    "grid grid-cols-[60px_1fr_100px_100px_120px_120px] gap-4 px-6 py-4 items-center border-b border-white/[0.04] transition-colors",
                    "hover:bg-white/[0.03]",
                    op.rank <= 3 && "bg-white/[0.01]",
                  )}
                >
                  {/* Rank */}
                  <span className={cn("inline-flex items-center justify-center w-10 h-10 rounded-xl border text-sm font-bold", rankBadge)}>
                    {rankEmoji || `#${op.rank}`}
                  </span>

                  {/* Operator */}
                  <div>
                    <div className="text-base font-bold text-white">{op.name}</div>
                    <div className="text-xs text-white/30 font-mono">{op.did}</div>
                  </div>

                  {/* Caps */}
                  <div className="text-center text-white/80 font-medium">{op.capabilities}</div>

                  {/* Jobs */}
                  <div className="text-center text-white/80 font-medium">{op.jobs}</div>

                  {/* Earnings */}
                  <div className="text-right text-green-400 font-bold">${op.earnings.toLocaleString()}</div>

                  {/* Rep */}
                  <div className="text-right space-y-1">
                    <span className="text-white/80 font-bold">{op.rep}</span>
                    <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-teal-500 to-cyan-400 transition-all duration-1000"
                        style={{ width: `${repPercent}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {/* CTA row */}
            <div className="px-6 py-5 text-center">
              <a
                href="/onboard"
                className="inline-flex items-center gap-2 text-teal-400 hover:text-teal-300 font-bold text-lg transition-colors"
              >
                You could be here. Level up now.
                <span className="text-xl">&rarr;</span>
              </a>
            </div>
          </div>
        </section>

        {/* ================================================================= */}
        {/* FOOTER */}
        {/* ================================================================= */}
        <footer className="flex flex-col items-center gap-6 pb-12 pt-8 border-t border-white/[0.06]">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <button
              onClick={() => useUIStore.getState().setMode("dashboard")}
              className={cn(
                "px-8 py-3 rounded-2xl text-base font-bold transition-all duration-200",
                "bg-teal-500/10 border-2 border-teal-500/30 text-teal-300",
                "hover:bg-teal-500 hover:text-white",
                "hover:shadow-[0_0_30px_rgba(20,184,166,0.3)]",
                "hover:scale-105 active:scale-95",
              )}
            >
              Explore Dashboard
            </button>
            <a
              href="https://github.com/global-mysterysnailrevolution/physical-capability-cloud"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "px-8 py-3 rounded-2xl text-base font-bold transition-all duration-200",
                "border-2 border-white/10 text-white/50",
                "hover:border-white/30 hover:text-white/80",
                "hover:scale-105 active:scale-95",
              )}
            >
              GitHub
            </a>
            <button
              onClick={() => setFeedbackOpen(true)}
              className="px-6 py-3 rounded-2xl text-sm text-white/30 hover:text-teal-300 border border-white/[0.06] hover:border-teal-500/30 transition-all"
            >
              Report Bugs
            </button>
          </div>
          <p className="text-sm text-white/20">Built with 18 protocol layers</p>
        </footer>
      </div>

      {/* ================================================================= */}
      {/* GLOBAL CSS — keyframes for animations */}
      {/* ================================================================= */}
      <style>{`
        @keyframes gradient-shift {
          0%, 100% { filter: hue-rotate(0deg); }
          50% { filter: hue-rotate(30deg); }
        }
        .animate-gradient-shift {
          animation: gradient-shift 8s ease-in-out infinite;
        }
        @keyframes float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}
