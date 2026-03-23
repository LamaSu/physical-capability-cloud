import React, { useRef, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, useInView, useMotionValue, useTransform, animate } from "framer-motion";
import { ParticleBackground } from "@pcc/ui";

// ---------------------------------------------------------------------------
// Animated counter — counts from 0 to target
// ---------------------------------------------------------------------------
function AnimatedNumber({ target, prefix = "", suffix = "", duration = 2, decimals = 0 }: { target: number; prefix?: string; suffix?: string; duration?: number; decimals?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const count = useMotionValue(0);
  const rounded = useTransform(count, (v) => `${prefix}${decimals > 0 ? v.toFixed(decimals) : Math.round(v)}${suffix}`);

  useEffect(() => {
    if (isInView) {
      animate(count, target, { duration, ease: "easeOut" });
    }
  }, [isInView, target, count, duration]);

  return <motion.span ref={ref}>{rounded}</motion.span>;
}

// ---------------------------------------------------------------------------
// Staggered reveal wrapper
// ---------------------------------------------------------------------------
const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12 } },
};

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const } },
};

const fadeIn = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.8 } },
};

// ---------------------------------------------------------------------------
// Money flow bars — visual comparison
// ---------------------------------------------------------------------------
function MoneyBar({ label, amount, total, color, delay, decimals = 0 }: { label: string; amount: number; total: number; color: string; delay: number; decimals?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-50px" });
  const pct = (amount / total) * 100;

  return (
    <div ref={ref} className="space-y-2">
      <div className="flex justify-between items-baseline">
        <span className="text-sm text-white/50 tracking-wide">{label}</span>
        <span className="text-lg font-mono font-semibold" style={{ color }}>
          <AnimatedNumber target={amount} prefix="$" duration={1.5} />
        </span>
      </div>
      <div className="h-3 rounded-full bg-white/[0.04] overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={isInView ? { width: `${pct}%` } : { width: 0 }}
          transition={{ duration: 1.2, delay, ease: [0.22, 1, 0.36, 1] as const }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// How It Works step card
// ---------------------------------------------------------------------------
function StepCard({ number, title, description, accent }: { number: string; title: string; description: string; accent: string }) {
  return (
    <motion.div
      variants={fadeUp}
      className="relative p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06] backdrop-blur-sm group hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-500"
    >
      <div
        className="absolute -top-4 -left-2 text-6xl font-black tracking-tighter opacity-10"
        style={{ color: accent }}
      >
        {number}
      </div>
      <div className="relative z-10 space-y-3">
        <h3 className="text-lg font-semibold text-white/90">{title}</h3>
        <p className="text-sm leading-relaxed text-white/45">{description}</p>
      </div>
      <div
        className="absolute bottom-0 left-6 right-6 h-px opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }}
      />
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Persona card
// ---------------------------------------------------------------------------
function PersonaCard({ emoji, title, description, accent }: { emoji: string; title: string; description: string; accent: string }) {
  return (
    <motion.div
      variants={fadeUp}
      className="relative p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06] backdrop-blur-sm hover:bg-white/[0.04] transition-all duration-500 group"
      whileHover={{ y: -4, transition: { duration: 0.3 } }}
    >
      <div className="text-4xl mb-4">{emoji}</div>
      <h3 className="text-base font-semibold text-white/90 mb-2">{title}</h3>
      <p className="text-sm leading-relaxed text-white/40">{description}</p>
      <div
        className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{ boxShadow: `0 0 40px ${accent}15, inset 0 0 40px ${accent}05` }}
      />
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Comparison table row
// ---------------------------------------------------------------------------
function ComparisonRow({ label, old: oldVal, pcc, index }: { label: string; old: string; pcc: string; index: number }) {
  return (
    <motion.div
      variants={fadeUp}
      className="grid grid-cols-3 gap-4 py-3 border-b border-white/[0.04] last:border-0"
    >
      <div className="text-sm text-white/50">{label}</div>
      <div className="text-sm text-white/25 line-through decoration-white/10">{oldVal}</div>
      <div className="text-sm font-medium" style={{ color: "#7CB342" }}>{pcc}</div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Copy Agent File CTA button
// ---------------------------------------------------------------------------
function CopyAgentFileButton() {
  const [copied, setCopied] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const handleCopy = async () => {
    setLoading(true);
    try {
      const res = await fetch("/agent-package.json");
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback: try with a textarea
      try {
        const res = await fetch("/agent-package.json");
        const text = await res.text();
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch {
        // Last resort: open in new tab
        window.open("/agent-package.json", "_blank");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 w-full max-w-md">
      <button
        onClick={handleCopy}
        disabled={loading}
        className="w-full relative px-8 py-4 rounded-2xl font-bold text-base text-white bg-gradient-to-r from-emerald-500 to-emerald-400 hover:from-emerald-400 hover:to-emerald-300 transition-all duration-300 shadow-lg shadow-emerald-500/30 hover:shadow-emerald-500/50 hover:-translate-y-0.5 ring-2 ring-emerald-400/30 hover:ring-emerald-400/60 disabled:opacity-60"
      >
        {loading ? "Loading..." : copied ? "Copied to clipboard!" : "Copy Agent File"}
      </button>
      <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] w-full">
        <span className="text-xs font-mono text-white/30 truncate flex-1">agent-package.json — 73 tools, ready to paste</span>
        <button
          onClick={handleCopy}
          className="text-xs text-emerald-400/60 hover:text-emerald-400 transition-colors shrink-0"
        >
          {copied ? "done" : "copy"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Feedback Form
// ---------------------------------------------------------------------------
function FeedbackSection() {
  const [type, setType] = React.useState<"bug" | "suggestion" | "comment">("comment");
  const [message, setMessage] = React.useState("");
  const [submitted, setSubmitted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setSubmitting(true);
    try {
      const base = (window as any).__PCC_API_BASE__ || "";
      await fetch(`${base}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, message, page: "landing" }),
      });
    } catch {
      // Silently succeed — feedback is best-effort
    }
    setSubmitted(true);
    setSubmitting(false);
    setTimeout(() => {
      setSubmitted(false);
      setMessage("");
    }, 4000);
  };

  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-50px" }}
      variants={stagger}
      className="max-w-xl mx-auto"
    >
      <motion.div variants={fadeUp} className="text-center mb-8">
        <span className="text-xs tracking-[0.3em] uppercase text-amber-400/60 font-mono">Talk to us</span>
        <h2 className="text-2xl font-bold text-white/90 mt-3">Found a bug? Have an idea?</h2>
      </motion.div>

      {submitted ? (
        <motion.div variants={fadeUp} className="text-center p-6 rounded-2xl bg-green-500/[0.05] border border-green-500/20">
          <p className="text-green-400 font-medium">Thanks! We got it.</p>
        </motion.div>
      ) : (
        <motion.form variants={fadeUp} onSubmit={handleSubmit} className="space-y-4">
          <div className="flex gap-2">
            {(["bug", "suggestion", "comment"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={`px-4 py-2 rounded-lg text-xs font-medium transition-all duration-200 ${
                  type === t
                    ? "bg-white/10 text-white/90 border border-white/20"
                    : "bg-white/[0.03] text-white/40 border border-white/[0.06] hover:bg-white/[0.06]"
                }`}
              >
                {t === "bug" ? "Bug Report" : t === "suggestion" ? "Suggestion" : "Comment"}
              </button>
            ))}
          </div>
          <textarea
            placeholder={type === "bug" ? "What went wrong? Steps to reproduce..." : type === "suggestion" ? "What would make PCC better?" : "Tell us what you think..."}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            required
            rows={4}
            className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white/90 text-sm placeholder:text-white/25 focus:outline-none focus:border-amber-400/30 transition-colors resize-none"
          />
          <div className="flex items-center justify-between">
            <a
              href="https://github.com/wingdingspenpal/poop/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-white/20 hover:text-white/40 transition-colors underline underline-offset-2"
            >
              Or open a GitHub issue
            </a>
            <button
              type="submit"
              disabled={submitting || !message.trim()}
              className="px-6 py-2.5 rounded-xl font-semibold text-sm text-forest-900 bg-gradient-to-r from-amber-400 to-orange-400 hover:from-amber-300 hover:to-orange-300 transition-all duration-300 shadow-lg shadow-amber-500/20 disabled:opacity-40"
            >
              {submitting ? "Sending..." : "Send Feedback"}
            </button>
          </div>
        </motion.form>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main Landing Page
// ---------------------------------------------------------------------------
export function LandingPage() {
  const navigate = useNavigate();
  const [mouseY, setMouseY] = useState(0);
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistName, setWaitlistName] = useState("");
  const [waitlistRole, setWaitlistRole] = useState("");
  const [waitlistSubmitted, setWaitlistSubmitted] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => setMouseY(e.clientY / window.innerHeight);
    window.addEventListener("mousemove", handler);
    return () => window.removeEventListener("mousemove", handler);
  }, []);

  return (
    <div className="relative min-h-screen bg-forest-900 overflow-x-hidden">
      <ParticleBackground />

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* HERO                                                           */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 min-h-screen flex flex-col items-center justify-center px-6 text-center">
        {/* Radial glow behind hero text */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(ellipse 60% 40% at 50% ${45 + mouseY * 10}%, rgba(124, 179, 66, 0.08) 0%, transparent 70%)`,
          }}
        />

        <motion.div
          initial="hidden"
          animate="show"
          variants={stagger}
          className="relative z-10 max-w-4xl mx-auto space-y-8"
        >
          {/* Eyebrow */}
          <motion.div variants={fadeUp} className="flex items-center justify-center gap-2">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-green-400/40" />
            <span className="text-xs tracking-[0.3em] uppercase text-green-400/60 font-mono">PCC</span>
            <div className="h-px w-8 bg-gradient-to-l from-transparent to-green-400/40" />
          </motion.div>

          {/* Main headline */}
          <motion.h1
            variants={fadeUp}
            className="text-5xl sm:text-6xl md:text-7xl font-black tracking-tight leading-[0.95]"
          >
            <span className="text-white/95">You do the work.</span>
            <br />
            <span className="bg-gradient-to-r from-gold-400 via-gold-300 to-gold-400 bg-clip-text text-transparent">
              You keep the money.
            </span>
          </motion.h1>

          {/* Subhead */}
          <motion.p
            variants={fadeUp}
            className="text-lg sm:text-xl text-white/40 max-w-2xl mx-auto leading-relaxed"
          >
            You weld, drive, cook, build, create, fix, inspect, or deliver.
            Your AI agent finds the work, negotiates the price, and handles the paperwork.
            You get paid the moment the job's done.{" "}
            <span className="text-white/60 font-medium">No platform cut. No invoicing. No waiting.</span>
          </motion.p>

          {/* Primary CTAs — agent file + whitepaper */}
          <motion.div variants={fadeUp} className="flex flex-col items-center gap-6 pt-4">
            <div className="flex flex-col sm:flex-row items-center gap-4 w-full max-w-lg">
              <CopyAgentFileButton />
            </div>
            <a
              href="/whitepaper.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm text-white/70 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:text-white/90 transition-all duration-300 hover:-translate-y-0.5"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-white/50">
                <path d="M4 2h5.5L13 5.5V14H4V2Z" stroke="currentColor" strokeWidth="1.2" />
                <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6 8h4M6 10.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              Read the White Paper
            </a>
            <a
              href="#feedback"
              className="text-xs text-white/30 hover:text-white/50 transition-colors underline underline-offset-4 decoration-white/10"
            >
              Report a bug or give feedback
            </a>
          </motion.div>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
          animate={{ y: [0, 8, 0] }}
          transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
        >
          <div className="w-5 h-8 rounded-full border border-white/10 flex items-start justify-center p-1.5">
            <div className="w-1 h-1.5 rounded-full bg-white/30" />
          </div>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* THE PROBLEM                                                    */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-32 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-100px" }}
          variants={stagger}
          className="max-w-4xl mx-auto"
        >
          <motion.div variants={fadeUp} className="space-y-4 mb-16">
            <span className="text-xs tracking-[0.3em] uppercase text-gold-400/60 font-mono">Where does the money go?</span>
            <h2 className="text-3xl sm:text-4xl font-bold text-white/90 leading-tight">
              You do $100 worth of work.<br />
              <span className="text-white/30">You take home $45.</span>
            </h2>
            <p className="text-base text-white/35 max-w-xl leading-relaxed">
              Platform fees. Staffing agencies. Project managers. Dispatchers. Insurance brokers.
              Invoice departments. Account managers. None of them touch the work. All of them
              take a cut. According to the Economic Policy Institute, gig workers retain roughly
              37 cents of every dollar earned after platform fees, expenses, and taxes.
            </p>
            <p className="text-xs text-white/20 font-mono">
              Source: Mishel, L. (2018). "Uber and the Labor Market." Economic Policy Institute.
            </p>
          </motion.div>

          {/* The math — visual bars */}
          <motion.div variants={fadeUp} className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Traditional */}
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-4">
              <div className="text-xs tracking-[0.2em] uppercase text-white/25 font-mono mb-2">Traditional</div>
              <MoneyBar label="Operator gets" amount={45} total={100} color="#616161" delay={0} />
              <MoneyBar label="Platform fees" amount={25} total={100} color="#EF5350" delay={0.1} />
              <MoneyBar label="Admin overhead" amount={15} total={100} color="#EF5350" delay={0.2} />
              <MoneyBar label="Payment processing" amount={5} total={100} color="#EF5350" delay={0.3} />
              <MoneyBar label="Trust & insurance" amount={10} total={100} color="#EF5350" delay={0.4} />
              <div className="pt-2 border-t border-white/[0.06] text-right">
                <span className="text-xs text-white/25">of every </span>
                <span className="text-sm font-mono text-white/40">$100</span>
              </div>
            </div>

            {/* With PCC */}
            <div className="p-6 rounded-2xl bg-white/[0.02] border border-green-500/10 relative overflow-hidden flex flex-col justify-center min-h-[280px]">
              <div className="absolute inset-0 bg-gradient-to-br from-green-500/[0.03] to-transparent pointer-events-none" />
              <div className="relative z-10 space-y-5 text-center px-4">
                <div className="text-xs tracking-[0.2em] uppercase text-green-400/60 font-mono">With PCC</div>
                <p className="text-xl sm:text-2xl font-bold text-white/90 leading-snug">
                  You generate $100 of value.<br />
                  <span className="bg-gradient-to-r from-green-400 to-teal-400 bg-clip-text text-transparent">You keep the money they would have taken.</span>
                </p>
                <p className="text-sm text-white/30 leading-relaxed">
                  Your agent replaces the platform. Proof of work replaces the middlemen.
                  Escrow replaces the invoice department.
                </p>
              </div>
            </div>
          </motion.div>

          {/* Punchline */}
          <motion.p variants={fadeUp} className="text-center text-white/25 text-sm mt-8 max-w-lg mx-auto">
            AI agents handle coordination. Cryptographic proof handles trust.
            Escrow handles payment. The things that used to cost $55 now run as infrastructure.
          </motion.p>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* HOW IT WORKS                                                   */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-32 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-100px" }}
          variants={stagger}
          className="max-w-5xl mx-auto"
        >
          <motion.div variants={fadeUp} className="mb-16">
            <span className="text-xs tracking-[0.3em] uppercase text-teal-400/60 font-mono">How It Works</span>
            <h2 className="text-3xl sm:text-4xl font-bold text-white/90 mt-4">You focus on the work. Everything else is handled.</h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <StepCard
              number="01"
              title="Tell us what you do"
              description="You're a welder. A driver. An artist. A lab tech. A chef. Whatever it is — describe it, set your rate, and choose how you prove your work (photos, GPS, sensors, or just timestamps). That's it."
              accent="#7CB342"
            />
            <StepCard
              number="02"
              title="Let your agent run your business"
              description="Your AI agent is your manager, your scheduler, and your sales team. It finds work that fits, negotiates fair rates, and only accepts jobs you'd actually want. It works 24/7 and it doesn't take a cut."
              accent="#FFB300"
            />
            <StepCard
              number="03"
              title="Finish the job. Money moves."
              description="Your phone, your dashcam, your sensors — they're already collecting proof. When the work matches what was promised, payment releases from escrow. No invoice. No 'check is in the mail.' It just hits your wallet."
              accent="#00BFA5"
            />
          </div>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* CONNECTS WITH                                                  */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-20 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-50px" }}
          variants={stagger}
          className="max-w-5xl mx-auto"
        >
          <motion.div variants={fadeUp} className="text-center mb-12">
            <span className="text-xs tracking-[0.3em] uppercase text-white/25 font-mono">Connects with your tools</span>
          </motion.div>

          <motion.div
            variants={fadeUp}
            className="flex flex-wrap items-center justify-center gap-6 sm:gap-10"
          >
            {/* OpenClaw */}
            <div className="group flex items-center gap-3 px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.12] transition-all duration-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-green-400/70 group-hover:text-green-400 transition-colors">
                <path d="M7 8C7 8 5 10 5 12C5 14 7 16 7 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M17 8C17 8 19 10 19 12C19 14 17 16 17 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M12 4V8M12 8L9 11M12 8L15 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="12" cy="14" r="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M12 16V20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="text-sm font-medium text-white/50 group-hover:text-white/80 transition-colors">OpenClaw</span>
            </div>

            {/* Claude Code */}
            <div className="group flex items-center gap-3 px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-orange-400/20 transition-all duration-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-orange-400/70 group-hover:text-orange-400 transition-colors">
                <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M7 9L10 12L7 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M13 15H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="text-sm font-medium text-white/50 group-hover:text-white/80 transition-colors">Claude Code</span>
            </div>

            {/* Cursor */}
            <div className="group flex items-center gap-3 px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-blue-400/20 transition-all duration-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-blue-400/70 group-hover:text-blue-400 transition-colors">
                <path d="M5 3L19 12L12 13.5L9 21L5 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M12 13.5L17 19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="text-sm font-medium text-white/50 group-hover:text-white/80 transition-colors">Cursor</span>
            </div>

            {/* NanoClaw */}
            <div className="group flex items-center gap-3 px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-purple-400/20 transition-all duration-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-purple-400/70 group-hover:text-purple-400 transition-colors">
                <path d="M8 9C8 9 6.5 10.5 6.5 12C6.5 13.5 8 15 8 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M16 9C16 9 17.5 10.5 17.5 12C17.5 13.5 16 15 16 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M12 6V10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M12 14V18" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span className="text-sm font-medium text-white/50 group-hover:text-white/80 transition-colors">NanoClaw</span>
            </div>

            {/* MCP */}
            <div className="group flex items-center gap-3 px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-teal-400/20 transition-all duration-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-teal-400/70 group-hover:text-teal-400 transition-colors">
                <circle cx="12" cy="6" r="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="6" cy="18" r="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="18" cy="18" r="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M12 8V12M12 12L7 16M12 12L17 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="text-sm font-medium text-white/50 group-hover:text-white/80 transition-colors">MCP</span>
            </div>

            {/* Any Agent */}
            <div className="group flex items-center gap-3 px-5 py-3 rounded-xl bg-white/[0.02] border border-dashed border-white/[0.08] hover:bg-white/[0.04] hover:border-white/[0.15] transition-all duration-400">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-white/30 group-hover:text-white/60 transition-colors">
                <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
                <path d="M12 9V15M9 12H15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="text-sm font-medium text-white/30 group-hover:text-white/60 transition-colors">Your agent</span>
            </div>
          </motion.div>

          <motion.p variants={fadeUp} className="text-center text-white/20 text-xs mt-8 max-w-lg mx-auto">
            PCC speaks A2A and MCP. Any agent that can send an intent can discover capabilities, negotiate contracts, and settle payments.
          </motion.p>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* WHO THIS IS FOR                                                */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-32 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-100px" }}
          variants={stagger}
          className="max-w-5xl mx-auto"
        >
          <motion.div variants={fadeUp} className="mb-16">
            <span className="text-xs tracking-[0.3em] uppercase text-cyan-400/60 font-mono">This is for</span>
            <h2 className="text-3xl sm:text-4xl font-bold text-white/90 mt-4">People who make things happen.</h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <PersonaCard
              emoji={"\u{1F44B}"}
              title="You have skills"
              description="You weld, paint, cook, deliver, inspect, or create. You're tired of platforms taking 30% for matching you with someone three miles away. Put your skills on PCC and let your agent build your client list."
              accent="#7CB342"
            />
            <PersonaCard
              emoji={"\u{2699}\uFE0F"}
              title="You have equipment"
              description="Your CNC machine sits idle 60% of the time. Your 3D printer could run overnight. Your lab instruments are booked 3 hours a day. Put them on PCC and they earn while you sleep."
              accent="#FFB300"
            />
            <PersonaCard
              emoji={"\u{1F50D}"}
              title="You need something done"
              description="Stop hiring companies. Hire the person or machine that actually does the work. See proof it was done right. Pay on completion, not on faith. Your agent handles sourcing — you just say what you need."
              accent="#00BFA5"
            />
          </div>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* THE COMPARISON                                                 */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-32 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-100px" }}
          variants={stagger}
          className="max-w-3xl mx-auto"
        >
          <motion.div variants={fadeUp} className="mb-12">
            <span className="text-xs tracking-[0.3em] uppercase text-gold-400/60 font-mono">What changes</span>
            <h2 className="text-3xl sm:text-4xl font-bold text-white/90 mt-4">Everything that isn't the actual work.</h2>
          </motion.div>

          <motion.div
            variants={fadeIn}
            className="p-8 rounded-2xl bg-white/[0.02] border border-white/[0.06]"
          >
            {/* Header */}
            <div className="grid grid-cols-3 gap-4 pb-4 mb-2 border-b border-white/[0.08]">
              <div className="text-xs tracking-[0.15em] uppercase text-white/30 font-mono" />
              <div className="text-xs tracking-[0.15em] uppercase text-white/20 font-mono">Old Way</div>
              <div className="text-xs tracking-[0.15em] uppercase text-green-400/60 font-mono">PCC</div>
            </div>
            <ComparisonRow label="Platform cut" old="25–30%" pcc="No platform" index={0} />
            <ComparisonRow label="Getting paid" old="Net-30, maybe" pcc="Instant, on proof" index={1} />
            <ComparisonRow label="Trust" old="Star ratings from strangers" pcc="Actual proof of work" index={2} />
            <ComparisonRow label="Admin" old="Dispatchers, managers, AP" pcc="Your AI agent, for free" index={3} />
            <ComparisonRow label="When things go wrong" old="Call center, good luck" pcc="Evidence speaks for itself" index={4} />
            <ComparisonRow label="Finding work" old="Applications, job boards" pcc="Agents match automatically" index={5} />
          </motion.div>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* FOOTER CTA                                                     */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-32 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-100px" }}
          variants={stagger}
          className="max-w-3xl mx-auto text-center space-y-8"
        >
          <motion.p variants={fadeUp} className="text-sm text-white/30 leading-relaxed max-w-xl mx-auto">
            Every skill you have, every machine you own, every thing you can physically do
            in the real world — it has value. Right now, most of that value leaks out to
            people standing between you and the person who needs what you do.
            We're closing that gap.
          </motion.p>

          <motion.h2
            variants={fadeUp}
            className="text-4xl sm:text-5xl font-black"
          >
            <span className="bg-gradient-to-r from-green-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
              Your work. Your money. Your terms.
            </span>
          </motion.h2>

          <motion.div variants={fadeUp} className="flex items-center justify-center gap-4 pt-4">
            <button
              onClick={() => navigate("/setup")}
              className="px-8 py-3 rounded-xl font-semibold text-sm text-forest-900 bg-gradient-to-r from-green-400 to-teal-400 hover:from-green-300 hover:to-teal-300 transition-all duration-300 shadow-lg shadow-green-500/20 hover:shadow-green-500/30 hover:-translate-y-0.5"
            >
              Get Your Agent
            </button>
            <button
              onClick={() => navigate("/dashboard")}
              className="px-8 py-3 rounded-xl font-semibold text-sm text-white/70 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] hover:text-white/90 transition-all duration-300 hover:-translate-y-0.5"
            >
              See the Dashboard
            </button>
          </motion.div>
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* WAITLIST                                                       */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-32 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-100px" }}
          variants={stagger}
          className="max-w-xl mx-auto"
        >
          <motion.div variants={fadeUp} className="text-center mb-12">
            <span className="text-xs tracking-[0.3em] uppercase text-green-400/60 font-mono">Early Access</span>
            <h2 className="text-3xl font-bold text-white/90 mt-4">Get on the list.</h2>
            <p className="text-sm text-white/30 mt-3">
              We're onboarding the first operators and buyers. Tell us what you do and we'll get you set up.
            </p>
          </motion.div>

          {waitlistSubmitted ? (
            <motion.div variants={fadeUp} className="text-center p-8 rounded-2xl bg-green-500/[0.05] border border-green-500/20">
              <p className="text-green-400 font-medium">You're on the list. We'll be in touch.</p>
            </motion.div>
          ) : (
            <motion.form
              variants={fadeUp}
              onSubmit={(e) => { e.preventDefault(); setWaitlistSubmitted(true); }}
              className="space-y-4"
            >
              <input
                type="text"
                placeholder="Your name"
                value={waitlistName}
                onChange={(e) => setWaitlistName(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white/90 text-sm placeholder:text-white/25 focus:outline-none focus:border-green-400/30 transition-colors"
              />
              <input
                type="email"
                placeholder="Email"
                value={waitlistEmail}
                onChange={(e) => setWaitlistEmail(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white/90 text-sm placeholder:text-white/25 focus:outline-none focus:border-green-400/30 transition-colors"
              />
              <input
                type="text"
                placeholder="What do you do? (e.g. &quot;I run a CNC shop&quot;, &quot;I need parts made&quot;, &quot;I have lab instruments&quot;)"
                value={waitlistRole}
                onChange={(e) => setWaitlistRole(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white/90 text-sm placeholder:text-white/25 focus:outline-none focus:border-green-400/30 transition-colors"
              />
              <button
                type="submit"
                className="w-full px-8 py-3 rounded-xl font-semibold text-sm text-forest-900 bg-gradient-to-r from-green-400 to-teal-400 hover:from-green-300 hover:to-teal-300 transition-all duration-300 shadow-lg shadow-green-500/20"
              >
                Join the Waitlist
              </button>
            </motion.form>
          )}
        </motion.div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* FEEDBACK                                                       */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section id="feedback" className="relative z-10 py-24 px-6">
        <FeedbackSection />
      </section>

      {/* ═══════════════════════════════════════════════════════════════ */}
      {/* FOOTER                                                         */}
      {/* ═══════════════════════════════════════════════════════════════ */}
      <section className="relative z-10 py-16 px-6">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true }}
          variants={stagger}
          className="max-w-3xl mx-auto text-center space-y-6"
        >
          <motion.div variants={fadeUp} className="flex items-center justify-center gap-6 text-xs text-white/20">
            <a
              href="https://github.com/wingdingspenpal/poop/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white/40 transition-colors underline underline-offset-2"
            >
              Report a bug
            </a>
            <span className="text-white/10">&middot;</span>
            <a
              href="https://github.com/wingdingspenpal/poop/discussions"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white/40 transition-colors underline underline-offset-2"
            >
              Give feedback
            </a>
            <span className="text-white/10">&middot;</span>
            <a
              href="/whitepaper.md"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white/40 transition-colors underline underline-offset-2"
            >
              White paper
            </a>
            <span className="text-white/10">&middot;</span>
            <a
              href="/agent-package.json"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white/40 transition-colors underline underline-offset-2"
            >
              Agent file
            </a>
          </motion.div>

          <motion.div variants={fadeIn}>
            <div className="h-px w-32 mx-auto bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <p className="text-xs text-white/15 mt-4 font-mono tracking-wider">
              open source &middot; open protocol &middot; open economy
            </p>
          </motion.div>
        </motion.div>
      </section>
    </div>
  );
}
