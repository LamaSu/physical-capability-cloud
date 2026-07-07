import React from "react";
import { motion, AnimatePresence } from "framer-motion";

interface TourStep {
  id: string;
  title: string;
  content: string;
  target?: string; // CSS selector or route path
}

// A short first-run tour. Deliberately 5 steps (welcome -> discover -> build ->
// trust -> add) — long tours get skipped and teach nothing. Framing matches the
// general product positioning (any capability: machines, human skills, assets),
// not a single vertical; examples stay domain-inclusive.
const tourSteps: TourStep[] = [
  { id: "welcome", title: "Welcome to Physical Capability Cloud", content: "The cloud for real-world capabilities — machines, human skills, and autonomous assets. Discover them, price a job, and settle on verified evidence. Here's the 60-second tour." },
  { id: "discover", title: "Discover & compare", content: "Browse every capability on the network — 3D printing, CNC, HPLC, lab work, courier runs, and more. Each card shows live pricing, queue depth, and the assurance tiers it supports." },
  { id: "build", title: "Build a job", content: "Pick a capability and configure its parameters — the price updates live as you go. Review the contract and commit; your funds go into milestone escrow, not straight to the operator." },
  { id: "evidence", title: "Evidence & settlement", content: "Every job produces cryptographic evidence — sensor logs, images, attestations. Escrow releases only when that evidence meets the assurance tier you paid for. That's the trust layer." },
  { id: "add", title: "Put your own capability on the network", content: "Register a machine, a human skill, or an asset through the guided flow — the AI reads your docs and sets it up. Then earn from every job it completes." },
];

export function OnboardingTour() {
  const [active, setActive] = React.useState(false);
  const [step, setStep] = React.useState(0);

  // Check if user has seen the tour
  React.useEffect(() => {
    const seen = localStorage.getItem("pcc-tour-seen");
    if (!seen) setActive(true);
  }, []);

  const close = () => {
    setActive(false);
    localStorage.setItem("pcc-tour-seen", "true");
  };

  const next = () => {
    if (step < tourSteps.length - 1) setStep(step + 1);
    else close();
  };

  const prev = () => {
    if (step > 0) setStep(step - 1);
  };

  if (!active) return null;

  const currentStep = tourSteps[step];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center"
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />

        {/* Tour card */}
        <motion.div
          key={currentStep.id}
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 0.25 }}
          className="relative z-10 w-[480px] rounded-2xl border border-green-500/20 bg-forest-800/95 backdrop-blur-xl p-6 shadow-[0_0_40px_rgba(124,179,66,0.15)]"
        >
          {/* Step counter */}
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] text-white/30 font-mono uppercase tracking-wider">
              Step {step + 1} of {tourSteps.length}
            </span>
            <button onClick={close} className="text-white/30 hover:text-white/60 text-sm transition-colors">
              Skip tour
            </button>
          </div>

          {/* Progress bar */}
          <div className="flex gap-1 mb-4">
            {tourSteps.map((_, i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-all ${
                  i <= step ? "bg-green-500/50" : "bg-white/[0.06]"
                }`}
              />
            ))}
          </div>

          <h3 className="text-lg font-semibold text-white/90 mb-2">{currentStep.title}</h3>
          <p className="text-sm text-white/50 leading-relaxed">{currentStep.content}</p>

          {/* Navigation */}
          <div className="flex items-center justify-between mt-6">
            <button
              onClick={prev}
              disabled={step === 0}
              className="px-4 py-2 rounded-lg text-sm text-white/30 hover:text-white/60 disabled:opacity-30 transition-colors"
            >
              ← Previous
            </button>
            <button
              onClick={next}
              className="px-6 py-2 rounded-lg bg-green-500/20 border border-green-500/30 text-sm text-green-400 font-medium hover:bg-green-500/30 transition-all"
            >
              {step === tourSteps.length - 1 ? "Get Started" : "Next →"}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/** Button to restart the onboarding tour */
export function TourRestartButton() {
  const restart = () => {
    localStorage.removeItem("pcc-tour-seen");
    window.location.reload();
  };

  return (
    <button
      onClick={restart}
      className="text-xs text-white/20 hover:text-white/40 transition-colors"
      title="Restart onboarding tour"
    >
      ? Tour
    </button>
  );
}
