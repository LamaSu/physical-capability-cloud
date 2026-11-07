import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useUIStore } from "../stores/ui-store.js";
import { authorizedFetch } from "../lib/authorized-fetch.js";
import { cn } from "@pcc/ui";

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

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
      const res = await authorizedFetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  const navigate = useNavigate();

  useEffect(() => {
    setPageMeta("PCC Network", "The Capability Network");
  }, [setPageMeta]);

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

          {/* CTA buttons */}
          <div className="flex flex-wrap justify-center gap-4 pt-4">
            <button
              onClick={() => navigate("/discover")}
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
              href="https://capability.network"
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
