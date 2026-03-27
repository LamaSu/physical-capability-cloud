import React, { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useInView } from "framer-motion";

// ---------------------------------------------------------------------------
// API base — used to fetch the context pack
// ---------------------------------------------------------------------------

const API_BASE =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD
    ? "https://pcc-gateway-production.up.railway.app"
    : "http://localhost:3200");

// ---------------------------------------------------------------------------
// Copy Button — the primary CTA
// ---------------------------------------------------------------------------

function CopyPackButton() {
  const [state, setState] = useState<"idle" | "loading" | "copied" | "error">("idle");

  const handleCopy = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`${API_BASE}/agent-context-pack`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setState("copied");
      setTimeout(() => setState("idle"), 3000);
    } catch {
      // Fallback: copy the URL instead
      try {
        await navigator.clipboard.writeText(`${API_BASE}/agent-context-pack`);
        setState("copied");
        setTimeout(() => setState("idle"), 3000);
      } catch {
        setState("error");
        setTimeout(() => setState("idle"), 2000);
      }
    }
  }, []);

  const label = {
    idle: "Copy Agent Pack",
    loading: "Fetching...",
    copied: "Copied! Paste into your AI.",
    error: "Failed -- try again",
  }[state];

  return (
    <button
      onClick={handleCopy}
      disabled={state === "loading"}
      className="group relative px-10 py-5 text-lg font-semibold tracking-wide rounded-2xl transition-all duration-300 cursor-pointer disabled:cursor-wait"
      style={{
        background:
          state === "copied"
            ? "linear-gradient(135deg, #059669, #10b981)"
            : "linear-gradient(135deg, #6366f1, #8b5cf6, #a855f7)",
        color: "#fff",
        fontFamily: "'Space Grotesk', system-ui, sans-serif",
        border: "none",
        boxShadow:
          state === "copied"
            ? "0 0 40px rgba(16,185,129,0.4), 0 0 80px rgba(16,185,129,0.15)"
            : "0 0 40px rgba(139,92,246,0.3), 0 0 80px rgba(139,92,246,0.1)",
      }}
    >
      {/* Glow ring */}
      <div
        className="absolute -inset-[2px] rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background:
            state === "copied"
              ? "linear-gradient(135deg, #059669, #10b981, #34d399)"
              : "linear-gradient(135deg, #6366f1, #a855f7, #ec4899, #6366f1)",
          filter: "blur(8px)",
          zIndex: -1,
        }}
      />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Scroll-triggered reveal
// ---------------------------------------------------------------------------

function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 30 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Step card data
// ---------------------------------------------------------------------------

const STEPS = [
  {
    number: "01",
    title: "Copy the pack",
    body: "One click. The entire PCC API, data types, and workflow templates -- copied to your clipboard as a single context document.",
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    ),
  },
  {
    number: "02",
    title: "Paste into your AI",
    body: "Claude, ChatGPT, Gemini, a local model -- any AI that accepts text. Paste the pack and it becomes a PCC interface agent.",
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93" />
        <path d="M8.75 9.93A4.002 4.002 0 0 1 12 2" />
        <path d="M12 18v4" />
        <path d="M8 22h8" />
        <circle cx="12" cy="13" r="3" />
      </svg>
    ),
  },
  {
    number: "03",
    title: "Your agent builds your interface",
    body: "It discovers capabilities, builds contracts, tracks jobs, verifies evidence. The AI generates whatever UI your environment supports.",
    icon: (
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 4V2" />
        <path d="M15 16v-2" />
        <path d="M8 9h2" />
        <path d="M20 9h2" />
        <path d="M17.8 11.8 19 13" />
        <path d="M15 9h.01" />
        <path d="M17.8 6.2 19 5" />
        <path d="m3 21 9-9" />
        <path d="M12.2 6.2 11 5" />
      </svg>
    ),
  },
];

// ---------------------------------------------------------------------------
// Capability grid data
// ---------------------------------------------------------------------------

const CAPABILITIES = [
  { title: "Discover & quote", desc: "Browse capabilities across the entire network. Get real-time pricing." },
  { title: "Build contracts", desc: "Configure, price, and execute capability contracts with escrow protection." },
  { title: "Track jobs", desc: "Real-time job monitoring with SSE streams and evidence collection." },
  { title: "Verify with ZK proofs", desc: "Zero-knowledge proofs, photo verification, and on-chain anchoring." },
  { title: "Onboard equipment", desc: "Register your machines in minutes. Auto-detect, auto-configure." },
  { title: "Earn as an operator", desc: "DePIN rewards, soulbound certificates, and a sovereign wealth fund." },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function LandingPage() {
  const navigate = useNavigate();
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      setMousePos({
        x: (e.clientX / window.innerWidth) * 100,
        y: (e.clientY / window.innerHeight) * 100,
      });
    };
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  return (
    <div className="relative min-h-screen overflow-x-hidden" style={{ background: "#050510" }}>
      {/* Ambient background gradients */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `
            radial-gradient(ellipse 60% 40% at ${35 + (mousePos.x - 50) * 0.05}% ${25 + (mousePos.y - 50) * 0.04}%, rgba(99,102,241,0.08) 0%, transparent 70%),
            radial-gradient(ellipse 40% 50% at ${65 + (mousePos.x - 50) * 0.04}% ${75 + (mousePos.y - 50) * 0.03}%, rgba(168,85,247,0.06) 0%, transparent 70%),
            radial-gradient(ellipse 50% 30% at ${50 + (mousePos.x - 50) * 0.02}% ${50 + (mousePos.y - 50) * 0.02}%, rgba(236,72,153,0.04) 0%, transparent 60%),
            #050510
          `,
          transition: "background 0.4s ease",
        }}
      />

      {/* Grid texture */}
      <div
        className="fixed inset-0 pointer-events-none z-0 opacity-[0.025]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
        }}
      />

      {/* ================================================================= */}
      {/* HERO                                                               */}
      {/* ================================================================= */}
      <section className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6">
        <div className="max-w-3xl w-full mx-auto text-center space-y-10">
          {/* Tag */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.1 }}
          >
            <span
              className="inline-block px-4 py-1.5 rounded-full text-[11px] tracking-[0.25em] uppercase font-medium border"
              style={{
                color: "#a78bfa",
                borderColor: "rgba(167,139,250,0.2)",
                background: "rgba(167,139,250,0.05)",
              }}
            >
              Physical Capability Cloud
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.25 }}
            className="text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.1] tracking-tight"
            style={{ color: "#f0f0f8", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
          >
            Your Agent Is{" "}
            <span
              style={{
                background: "linear-gradient(135deg, #818cf8, #c084fc, #f472b6)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Your Interface
            </span>
          </motion.h1>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.45 }}
            className="text-lg sm:text-xl max-w-2xl mx-auto leading-relaxed"
            style={{ color: "#94a3b8", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
          >
            PCC is agent-first infrastructure. Copy the context pack, paste it into your AI,
            and your agent becomes your manufacturing control plane.
          </motion.p>

          {/* CTA Button */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.65 }}
          >
            <CopyPackButton />
          </motion.div>

          {/* Alt actions */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.85 }}
            className="flex items-center justify-center gap-6 text-sm"
          >
            <a
              href={`${API_BASE}/agent-context-pack`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-200"
              style={{ color: "#64748b" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#a78bfa")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
            >
              View raw pack
            </a>
            <span style={{ color: "#334155" }}>|</span>
            <a
              href={`${API_BASE}/agent-context-pack.json`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-200"
              style={{ color: "#64748b" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#a78bfa")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
            >
              JSON format
            </a>
            <span style={{ color: "#334155" }}>|</span>
            <a
              href={`${API_BASE}/agent-package.json`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-200"
              style={{ color: "#64748b" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#a78bfa")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#64748b")}
            >
              MCP tools (49)
            </a>
          </motion.div>
        </div>

        {/* Scroll hint */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.25 }}
          transition={{ delay: 1.5 }}
        >
          <motion.div
            animate={{ y: [0, 6, 0] }}
            transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
          >
            <svg width="20" height="28" viewBox="0 0 20 28" fill="none">
              <rect x="1" y="1" width="18" height="26" rx="9" stroke="#64748b" strokeWidth="1" />
              <circle cx="10" cy="8" r="2" fill="#64748b" />
            </svg>
          </motion.div>
        </motion.div>
      </section>

      {/* ================================================================= */}
      {/* HOW IT WORKS                                                       */}
      {/* ================================================================= */}
      <section className="relative z-10 py-32 px-6">
        <div className="max-w-5xl mx-auto">
          <Reveal>
            <h2
              className="text-center text-3xl sm:text-4xl font-bold tracking-tight mb-4"
              style={{ color: "#f0f0f8", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
            >
              Three steps.{" "}
              <span style={{ color: "#64748b" }}>Zero setup.</span>
            </h2>
            <p
              className="text-center text-base mb-16 max-w-xl mx-auto"
              style={{ color: "#64748b" }}
            >
              No SDK. No API key. No dashboard login. Just context.
            </p>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {STEPS.map((step, i) => (
              <Reveal key={step.number} delay={i * 0.1}>
                <div
                  className="relative p-8 rounded-2xl border h-full transition-colors duration-300 hover:border-[rgba(139,92,246,0.2)]"
                  style={{
                    background: "rgba(15,15,30,0.6)",
                    borderColor: "rgba(255,255,255,0.06)",
                    backdropFilter: "blur(12px)",
                  }}
                >
                  {/* Number watermark */}
                  <div
                    className="absolute top-4 right-6 text-6xl font-black"
                    style={{
                      color: "rgba(139,92,246,0.06)",
                      fontFamily: "'Space Grotesk', system-ui, sans-serif",
                    }}
                  >
                    {step.number}
                  </div>

                  {/* Icon */}
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center mb-6"
                    style={{
                      background: "rgba(139,92,246,0.1)",
                      color: "#a78bfa",
                    }}
                  >
                    {step.icon}
                  </div>

                  <h3
                    className="text-lg font-semibold mb-3"
                    style={{ color: "#e2e8f0", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
                  >
                    {step.title}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: "#94a3b8" }}>
                    {step.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================= */}
      {/* WHAT YOUR AGENT CAN DO                                             */}
      {/* ================================================================= */}
      <section className="relative z-10 py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <Reveal>
            <h2
              className="text-center text-3xl sm:text-4xl font-bold tracking-tight mb-4"
              style={{ color: "#f0f0f8", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
            >
              What your agent can do
            </h2>
            <p
              className="text-center text-base mb-16 max-w-xl mx-auto"
              style={{ color: "#64748b" }}
            >
              130+ API endpoints. 49 MCP tools. 5 SSE streams. One context pack.
            </p>
          </Reveal>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {CAPABILITIES.map((cap, i) => (
              <Reveal key={cap.title} delay={i * 0.06}>
                <div
                  className="p-6 rounded-xl border transition-all duration-300 hover:border-[rgba(139,92,246,0.15)] hover:bg-[rgba(139,92,246,0.03)]"
                  style={{
                    borderColor: "rgba(255,255,255,0.05)",
                    background: "transparent",
                  }}
                >
                  <h3
                    className="text-base font-semibold mb-2"
                    style={{ color: "#c4b5fd", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
                  >
                    {cap.title}
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: "#94a3b8" }}>
                    {cap.desc}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================= */}
      {/* FOR DEVELOPERS                                                     */}
      {/* ================================================================= */}
      <section className="relative z-10 py-24 px-6">
        <div className="max-w-3xl mx-auto">
          <Reveal>
            <div
              className="p-8 rounded-2xl border text-center"
              style={{
                background: "rgba(15,15,30,0.4)",
                borderColor: "rgba(255,255,255,0.06)",
              }}
            >
              <h2
                className="text-2xl font-bold mb-6"
                style={{ color: "#e2e8f0", fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
              >
                For Developers
              </h2>
              <div className="flex flex-wrap items-center justify-center gap-4 mb-6">
                <a
                  href={`${API_BASE}/agent-package.json`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg text-sm font-medium border transition-all duration-200"
                  style={{
                    color: "#a78bfa",
                    borderColor: "rgba(167,139,250,0.25)",
                    background: "rgba(167,139,250,0.05)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.12)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.05)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.25)";
                  }}
                >
                  agent-package.json (MCP)
                </a>
                <a
                  href={`${API_BASE}/.well-known/agent-registration.json`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg text-sm font-medium border transition-all duration-200"
                  style={{
                    color: "#a78bfa",
                    borderColor: "rgba(167,139,250,0.25)",
                    background: "rgba(167,139,250,0.05)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.12)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.05)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.25)";
                  }}
                >
                  ERC-8004 Registration
                </a>
                <a
                  href="https://github.com/wingdingspenpal/poop"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg text-sm font-medium border transition-all duration-200"
                  style={{
                    color: "#a78bfa",
                    borderColor: "rgba(167,139,250,0.25)",
                    background: "rgba(167,139,250,0.05)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.12)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.05)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.25)";
                  }}
                >
                  GitHub
                </a>
                <a
                  href={`${API_BASE}/docs`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded-lg text-sm font-medium border transition-all duration-200"
                  style={{
                    color: "#a78bfa",
                    borderColor: "rgba(167,139,250,0.25)",
                    background: "rgba(167,139,250,0.05)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.12)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.4)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(167,139,250,0.05)";
                    e.currentTarget.style.borderColor = "rgba(167,139,250,0.25)";
                  }}
                >
                  API Docs
                </a>
              </div>
              <p className="text-xs" style={{ color: "#64748b" }}>
                On-chain escrow on Base Sepolia. Evidence on IPFS via Storacha. ZK proofs via Poseidon/Merkle. A2A agent protocol.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================================================================= */}
      {/* FOOTER                                                             */}
      {/* ================================================================= */}
      <section className="relative z-10 py-16 px-6">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          <div
            className="h-px w-32 mx-auto"
            style={{ background: "linear-gradient(90deg, transparent, rgba(139,92,246,0.2), transparent)" }}
          />
          <p className="text-sm" style={{ color: "#64748b" }}>
            Or try the{" "}
            <button
              onClick={() => navigate("/app")}
              className="underline underline-offset-2 transition-colors duration-200 bg-transparent border-none cursor-pointer"
              style={{ color: "#94a3b8" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#c4b5fd")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#94a3b8")}
            >
              limited web dashboard
            </button>
          </p>
          <p className="text-xs" style={{ color: "#334155" }}>
            capability.network
          </p>
        </div>
      </section>
    </div>
  );
}
