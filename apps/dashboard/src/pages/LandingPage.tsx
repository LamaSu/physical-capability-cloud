import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";

// ---------------------------------------------------------------------------
// API base
// ---------------------------------------------------------------------------

const API_BASE =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD
    ? "https://pcc-gateway-production.up.railway.app"
    : "http://localhost:3200");

// ---------------------------------------------------------------------------
// Typewriter
// ---------------------------------------------------------------------------

function Typewriter({ text, speed = 28, onDone }: { text: string; speed?: number; onDone?: () => void }) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const prefersReduced = useRef(
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    if (prefersReduced.current) {
      setDisplayed(text);
      setDone(true);
      onDoneRef.current?.();
      return;
    }
    let i = 0;
    const iv = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(iv);
        setDone(true);
        onDoneRef.current?.();
      }
    }, speed);
    return () => clearInterval(iv);
  }, [text, speed]);

  return (
    <span>
      {displayed}
      {!done && <span className="inline-block w-[2px] h-[1.1em] bg-[#D8A01B] ml-0.5 align-middle animate-[cursor-blink_0.6s_steps(1)_infinite]" />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Copy Pack Button
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
      className="group relative px-8 py-4 text-base font-semibold tracking-wide rounded-2xl transition-all duration-300 cursor-pointer disabled:cursor-wait"
      style={{
        background:
          state === "copied"
            ? "linear-gradient(135deg, #059669, #10b981)"
            : "linear-gradient(135deg, #D8A01B, #B57BDB)",
        color: "#fff",
        fontFamily: "'Space Grotesk', sans-serif",
        border: "none",
        boxShadow:
          state === "copied"
            ? "0 0 40px rgba(16,185,129,0.4)"
            : "0 0 30px rgba(216,160,27,0.25)",
      }}
    >
      <div
        className="absolute -inset-[2px] rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          background:
            state === "copied"
              ? "linear-gradient(135deg, #059669, #10b981, #34d399)"
              : "linear-gradient(135deg, #D8A01B, #B57BDB, #00D4D4, #D8A01B)",
          filter: "blur(8px)",
          zIndex: -1,
        }}
      />
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function LandingPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [showInput, setShowInput] = useState(false);
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Navigate to the context pack — user's agent takes it from here
    window.open(`${API_BASE}/agent-context-pack`, "_blank");
    // Also navigate to the spatial app with their query
    if (input.trim()) {
      navigate(`/app?q=${encodeURIComponent(input.trim())}`);
    }
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden" style={{ background: "#030308" }}>
      {/* Background */}
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: `
            radial-gradient(ellipse 50% 40% at ${30 + (mousePos.x - 50) * 0.08}% ${20 + (mousePos.y - 50) * 0.06}%, rgba(38,97,156,0.12) 0%, transparent 70%),
            radial-gradient(ellipse 40% 50% at ${70 + (mousePos.x - 50) * 0.06}% ${80 + (mousePos.y - 50) * 0.04}%, rgba(181,123,219,0.10) 0%, transparent 70%),
            radial-gradient(ellipse 30% 30% at ${50 + (mousePos.x - 50) * 0.03}% ${50 + (mousePos.y - 50) * 0.03}%, rgba(216,160,27,0.06) 0%, transparent 60%),
            #030308
          `,
          transition: "background 0.3s ease",
        }}
      />

      {/* Shimmer */}
      <div
        className="fixed inset-0 pointer-events-none z-0 opacity-[0.03]"
        style={{
          background: `linear-gradient(
            ${110 + (mousePos.x - 50) * 0.3}deg,
            transparent 20%,
            #00D4D4 35%,
            #9B6FDB 45%,
            #D4A800 55%,
            #E070A0 65%,
            transparent 80%
          )`,
          backgroundSize: "200% 200%",
          animation: "holo-drift 8s ease-in-out infinite",
        }}
      />

      {/* ═══ HERO ═══ */}
      <section className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6">
        <div className="max-w-2xl w-full mx-auto text-center space-y-10">
          {/* Wordmark */}
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 1, delay: 0.2 }}
          >
            <h1
              className="text-[13px] tracking-[0.35em] uppercase font-medium"
              style={{ color: "#7B7B9A", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              the physical capability cloud for agents
            </h1>
          </motion.div>

          {/* Typewriter */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.8 }}
            className="min-h-[4.5rem]"
          >
            <p
              className="text-2xl sm:text-3xl md:text-4xl font-semibold leading-snug tracking-tight"
              style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              <Typewriter
                text="Every machine, lab, and factory on Earth just became a programmable endpoint. Tell me what needs to exist."
                speed={28}
                onDone={() => setShowInput(true)}
              />
            </p>
          </motion.div>

          {/* Capability ticker */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={showInput ? { opacity: 1 } : {}}
            transition={{ duration: 1.2, delay: 0.1 }}
            className="overflow-hidden"
          >
            <p
              className="text-[11px] sm:text-xs tracking-[0.2em] uppercase"
              style={{ color: "#7B7B9A", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              CNC milling &middot; same-day delivery &middot; HPLC analysis &middot; PCB fabrication &middot; 3D printing &middot; furniture assembly &middot; laser cutting &middot; wet lab assays &middot; drone surveys &middot; chemical synthesis &middot; welding &middot; photo &amp; video &middot; gene sequencing &middot; equipment repair &middot; injection molding &middot; last-mile logistics &middot; quality inspection &middot; notary services &middot; robotic assembly &middot; on-site installation &middot; spectroscopy &middot; soil sampling &middot; vehicle wrapping &middot; calibration
            </p>
          </motion.div>

          {/* Input */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={showInput ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          >
            <form onSubmit={handleSubmit} className="relative">
              <div
                className="rounded-2xl p-[1px]"
                style={{
                  background: "linear-gradient(135deg, #D8A01B44, #26619C44, #B57BDB44, #D8A01B44)",
                }}
              >
                <div className="rounded-2xl overflow-hidden" style={{ background: "#0A0A1A" }}>
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="What do you do?"
                    className="w-full px-6 py-4 sm:py-5 text-base sm:text-lg bg-transparent border-none outline-none placeholder:opacity-30"
                    style={{
                      color: "#E8E8F0",
                      fontFamily: "'Space Grotesk', sans-serif",
                      caretColor: "#D8A01B",
                    }}
                    autoFocus
                  />
                </div>
              </div>
              <div
                className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-2/3 h-6 blur-xl opacity-30"
                style={{ background: "linear-gradient(90deg, #D8A01B, #B57BDB, #00D4D4)" }}
              />
            </form>
          </motion.div>

          {/* Scroll hint */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={showInput ? { opacity: 0.3 } : {}}
            transition={{ delay: 1.5 }}
          >
            <motion.div
              animate={{ y: [0, 6, 0] }}
              transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
              className="flex flex-col items-center gap-2"
            >
              <svg width="20" height="28" viewBox="0 0 20 28" fill="none">
                <rect x="1" y="1" width="18" height="26" rx="9" stroke="#7B7B9A" strokeWidth="1" />
                <circle cx="10" cy="8" r="2" fill="#7B7B9A" />
              </svg>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* ═══ YOUR AGENT IS YOUR INTERFACE ═══ */}
      <section className="relative z-10 py-32 px-6">
        <div className="max-w-2xl mx-auto text-center space-y-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.8 }}
          >
            <h2
              className="text-3xl sm:text-4xl md:text-5xl font-bold leading-[1.1] tracking-tight mb-6"
              style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Your agent is{" "}
              <span
                style={{
                  background: "linear-gradient(135deg, #D8A01B, #B57BDB, #00D4D4)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                your interface
              </span>
            </h2>
            <p
              className="text-lg leading-relaxed mb-10"
              style={{ color: "#7B7B9A", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Copy the context pack. Paste it into your AI. Your agent becomes your manufacturing control plane — it discovers capabilities, builds contracts, tracks jobs, and verifies evidence. No dashboard. No SDK. No login. Just your agent and the network.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.2 }}
          >
            <CopyPackButton />
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="flex items-center justify-center gap-6 text-sm"
          >
            <a
              href={`${API_BASE}/agent-context-pack`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-200"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#D8A01B")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              View raw pack
            </a>
            <span style={{ color: "#7B7B9A", opacity: 0.3 }}>|</span>
            <a
              href={`${API_BASE}/agent-context-pack.json`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-200"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#B57BDB")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              JSON format
            </a>
            <span style={{ color: "#7B7B9A", opacity: 0.3 }}>|</span>
            <a
              href={`${API_BASE}/agent-package.json`}
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-200"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#00D4D4")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              MCP tools (49)
            </a>
            <span style={{ color: "#7B7B9A", opacity: 0.3 }}>|</span>
            <a
              href="https://github.com/wingdingspenpal/poop"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors duration-200"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#E89AC7")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              GitHub
            </a>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <section className="relative z-10 py-16 px-6">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          <div
            className="h-px w-24 mx-auto"
            style={{ background: "linear-gradient(90deg, transparent, #D8A01B33, transparent)" }}
          />
          <p className="text-sm" style={{ color: "#7B7B9A" }}>
            Or try the{" "}
            <button
              onClick={() => navigate("/app")}
              className="underline underline-offset-2 transition-colors duration-200 bg-transparent border-none cursor-pointer"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#D8A01B")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              limited web dashboard
            </button>
          </p>
          <p className="text-xs" style={{ color: "#7B7B9A", opacity: 0.25 }}>
            capability.network
          </p>
        </div>
      </section>
    </div>
  );
}
