import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useInView } from "framer-motion";

// ---------------------------------------------------------------------------
// Typewriter — the agent speaks
// ---------------------------------------------------------------------------

function Typewriter({ text, speed = 30, onDone }: { text: string; speed?: number; onDone?: () => void }) {
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
// Holographic Card — mouse-tracked shine + glare
// ---------------------------------------------------------------------------

function HoloCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMove = useCallback((e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    el.style.setProperty("--px", `${x}%`);
    el.style.setProperty("--py", `${y}%`);
    el.style.setProperty("--rx", `${(y - 50) / -12}deg`);
    el.style.setProperty("--ry", `${(x - 50) / 12}deg`);
  }, []);

  const handleLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--px", "50%");
    el.style.setProperty("--py", "50%");
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  }, []);

  return (
    <div
      ref={ref}
      onPointerMove={handleMove}
      onPointerLeave={handleLeave}
      className={`holo-card group relative ${className}`}
      style={{
        "--px": "50%",
        "--py": "50%",
        "--rx": "0deg",
        "--ry": "0deg",
        transform: "perspective(800px) rotateX(var(--rx)) rotateY(var(--ry))",
        transition: "transform 0.15s ease",
      } as React.CSSProperties}
    >
      {/* Holographic shine layer */}
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 z-10"
        style={{
          mixBlendMode: "color-dodge",
          background: `
            repeating-linear-gradient(
              110deg,
              hsl(257 57% 60% / 0.4) 0%,
              hsl(200 57% 60% / 0.4) 20%,
              hsl(120 57% 60% / 0.4) 40%,
              hsl(40 57% 60% / 0.4) 60%,
              hsl(320 57% 60% / 0.4) 80%,
              hsl(257 57% 60% / 0.4) 100%
            )
          `,
          backgroundSize: "300% 300%",
          backgroundPosition: "var(--px) var(--py)",
          filter: "brightness(0.7) contrast(1.2)",
        }}
      />
      {/* Glare spot */}
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-60 transition-opacity duration-500 z-10"
        style={{
          mixBlendMode: "overlay",
          background: `radial-gradient(circle at var(--px) var(--py), rgba(255,255,255,0.25) 0%, transparent 60%)`,
        }}
      />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scroll-triggered section wrapper
// ---------------------------------------------------------------------------

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Step data
// ---------------------------------------------------------------------------

const STEPS = [
  {
    glyph: "\u{2625}", // ankh
    title: "Describe your work",
    body: "CNC, welding, printing, inspection — say what you do in plain language. Your agent translates it into capability the network understands.",
    accent: "#D8A01B",
  },
  {
    glyph: "\u{1F441}", // eye
    title: "Your agent handles everything",
    body: "It finds jobs, negotiates rates, collects proof, and submits evidence. You focus on the work. It runs your business.",
    accent: "#E89AC7",
  },
  {
    glyph: "\u{1FA79}", // scarab-like (drop of blood emoji as proxy)
    title: "Get paid instantly",
    body: "Escrow releases the moment proof matches the contract. No invoicing, no 30-day terms. Money moves when work is done.",
    accent: "#00D4D4",
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function LandingPage() {
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });

  // Track mouse for holographic background
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
    navigate(`/go${input.trim() ? `?q=${encodeURIComponent(input.trim())}` : ""}`);
  };

  return (
    <div
      className="relative min-h-screen overflow-x-hidden"
      style={{ background: "#030308" }}
    >
      {/* ─── Holographic background ──────────────────────────── */}
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

      {/* Holo shimmer overlay — subtle animated sweep */}
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

      {/* ═══════════════════════════════════════════════════════ */}
      {/* HERO                                                    */}
      {/* ═══════════════════════════════════════════════════════ */}
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
              capability.network
            </h1>
          </motion.div>

          {/* Agent speaking */}
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
                text="I find work for people who make things. Tell me what you do, and I'll handle the rest."
                speed={28}
                onDone={() => setShowInput(true)}
              />
            </p>
          </motion.div>

          {/* Input — the CTA */}
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
              {/* Subtle glow under input */}
              <div
                className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-2/3 h-6 blur-xl opacity-30"
                style={{ background: "linear-gradient(90deg, #D8A01B, #B57BDB, #00D4D4)" }}
              />
            </form>
          </motion.div>

          {/* Secondary links */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={showInput ? { opacity: 1 } : {}}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="flex items-center justify-center gap-6"
          >
            <a
              href="/whitepaper.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#D8A01B")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              Read the whitepaper
            </a>
            <span style={{ color: "#7B7B9A", opacity: 0.3 }}>|</span>
            <button
              onClick={() => navigate("/feedback")}
              className="text-xs tracking-wide transition-colors duration-300"
              style={{ color: "#7B7B9A", background: "none", border: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "#E89AC7")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "#7B7B9A")}
            >
              Report a bug
            </button>
          </motion.div>
        </div>

        {/* Scroll hint */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
          initial={{ opacity: 0 }}
          animate={showInput ? { opacity: 0.3 } : {}}
          transition={{ delay: 1.5 }}
        >
          <motion.div
            animate={{ y: [0, 6, 0] }}
            transition={{ repeat: Infinity, duration: 2.5, ease: "easeInOut" }}
          >
            <svg width="20" height="28" viewBox="0 0 20 28" fill="none">
              <rect x="1" y="1" width="18" height="26" rx="9" stroke="#7B7B9A" strokeWidth="1" />
              <circle cx="10" cy="8" r="2" fill="#7B7B9A" />
            </svg>
          </motion.div>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* HOW IT WORKS                                            */}
      {/* ═══════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-32 px-6">
        <div className="max-w-5xl mx-auto">
          <Reveal>
            <h2
              className="text-center text-2xl sm:text-3xl font-semibold tracking-tight mb-20"
              style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Three steps.{" "}
              <span style={{ color: "#7B7B9A" }}>No middlemen.</span>
            </h2>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
            {STEPS.map((step, i) => (
              <Reveal key={i} delay={i * 0.12}>
                <HoloCard className="h-full">
                  <div
                    className="relative z-20 p-8 rounded-2xl h-full border"
                    style={{
                      background: "#0A0A1A",
                      borderColor: "rgba(255,255,255,0.06)",
                    }}
                  >
                    {/* Glyph */}
                    <div
                      className="text-4xl mb-6 w-14 h-14 flex items-center justify-center rounded-xl"
                      style={{
                        background: `${step.accent}10`,
                        boxShadow: `0 0 30px ${step.accent}08`,
                      }}
                    >
                      {step.glyph}
                    </div>

                    {/* Number */}
                    <div
                      className="absolute top-6 right-8 text-7xl font-black opacity-[0.04]"
                      style={{ color: step.accent, fontFamily: "'Space Grotesk', sans-serif" }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </div>

                    <h3
                      className="text-lg font-semibold mb-3"
                      style={{ color: "#E8E8F0", fontFamily: "'Space Grotesk', sans-serif" }}
                    >
                      {step.title}
                    </h3>
                    <p className="text-sm leading-relaxed" style={{ color: "#7B7B9A" }}>
                      {step.body}
                    </p>

                    {/* Bottom accent line */}
                    <div
                      className="absolute bottom-0 left-8 right-8 h-px opacity-0 group-hover:opacity-100 transition-opacity duration-700"
                      style={{ background: `linear-gradient(90deg, transparent, ${step.accent}, transparent)` }}
                    />
                  </div>
                </HoloCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* TRUST SIGNALS                                           */}
      {/* ═══════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-24 px-6">
        <Reveal>
          <div className="max-w-3xl mx-auto text-center space-y-8">
            <p
              className="text-base sm:text-lg font-medium tracking-wide"
              style={{ color: "#7B7B9A", fontFamily: "'Space Grotesk', sans-serif" }}
            >
              On-chain escrow. Cryptographic proof. Zero platform fees.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
              {["Built on Base", "Evidence on Storacha", "A2A Protocol"].map((label) => (
                <span
                  key={label}
                  className="text-xs tracking-widest uppercase"
                  style={{ color: "#7B7B9A", opacity: 0.4 }}
                >
                  {label}
                </span>
              ))}
            </div>

            <div
              className="h-px w-24 mx-auto"
              style={{ background: "linear-gradient(90deg, transparent, #D8A01B33, transparent)" }}
            />

            <p className="text-xs" style={{ color: "#7B7B9A", opacity: 0.25 }}>
              &copy; {new Date().getFullYear()} capability.network
            </p>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
