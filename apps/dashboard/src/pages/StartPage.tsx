import React, { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { getAuthHeaders } from "../stores/auth-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormState {
  category: string;
  description: string;
  machineName: string;
  connectionType: string;
  connectionUrl: string;
  rate: string;
  rateUnit: string;
}

const INITIAL: FormState = {
  category: "",
  description: "",
  machineName: "",
  connectionType: "",
  connectionUrl: "",
  rate: "",
  rateUnit: "hour",
};

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: "3d-printing", label: "3D Printing", icon: "🖨", desc: "FDM, SLA, SLS" },
  { id: "cnc", label: "CNC", icon: "⚙", desc: "Milling, turning, routing" },
  { id: "laser", label: "Laser", icon: "🔆", desc: "Cutting & engraving" },
  { id: "welding", label: "Welding", icon: "🔥", desc: "MIG, TIG, spot" },
  { id: "inspection", label: "Inspection", icon: "🔬", desc: "QA & measurement" },
  { id: "electronics", label: "Electronics", icon: "🔌", desc: "PCB, assembly, test" },
  { id: "woodwork", label: "Woodwork", icon: "🪵", desc: "CNC router, lathe" },
  { id: "textile", label: "Textile", icon: "🧵", desc: "Sewing, embroidery" },
  { id: "other", label: "Other", icon: "🛠", desc: "Anything physical" },
];

const CONNECTIONS = [
  { id: "octoprint", label: "OctoPrint", desc: "Most 3D printers", placeholder: "http://192.168.1.50" },
  { id: "network", label: "Network IP", desc: "Direct connection", placeholder: "192.168.1.100" },
  { id: "api", label: "API Endpoint", desc: "REST / HTTP", placeholder: "https://my-machine.local/api" },
  { id: "manual", label: "Manual", desc: "I'll update status myself", placeholder: "" },
];

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1.5 rounded-full transition-all duration-500 ${
            i === current
              ? "w-8 bg-emerald-400"
              : i < current
                ? "w-1.5 bg-emerald-400/40"
                : "w-1.5 bg-white/10"
          }`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared animation
// ---------------------------------------------------------------------------

const stepVariants = {
  enter: { opacity: 0, x: 60 },
  center: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -60 },
};

// ---------------------------------------------------------------------------
// Step 1: What can you do?
// ---------------------------------------------------------------------------

function StepCapability({
  form,
  setForm,
  onNext,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onNext: () => void;
}) {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          What can you do?
        </h1>
        <p className="mt-2 text-white/40 text-base">
          Pick a category, or just describe it.
        </p>
      </div>

      {/* Category grid */}
      <div className="grid grid-cols-3 gap-3">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => setForm((f) => ({ ...f, category: cat.id }))}
            className={`group relative flex flex-col items-center gap-2 rounded-xl p-4 text-center transition-all duration-200
              ${
                form.category === cat.id
                  ? "bg-emerald-500/15 ring-1 ring-emerald-400/40"
                  : "bg-white/[0.03] hover:bg-white/[0.06] ring-1 ring-white/[0.06]"
              }`}
          >
            <span className="text-2xl">{cat.icon}</span>
            <span className="text-sm font-medium text-white/80">{cat.label}</span>
            <span className="text-[11px] text-white/30">{cat.desc}</span>
          </button>
        ))}
      </div>

      {/* Description */}
      <div className="space-y-2">
        <label className="text-sm text-white/50">
          Describe what your machine does
        </label>
        <textarea
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          placeholder="e.g. Prusa MK4 — prints PLA, PETG, ASA up to 250x210x220mm"
          rows={3}
          className="w-full rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] px-4 py-3 text-white/80 text-sm placeholder:text-white/20 focus:ring-emerald-400/30 focus:outline-none resize-none transition-all"
        />
      </div>

      <button
        onClick={onNext}
        disabled={!form.category}
        className="w-full rounded-xl bg-emerald-500 py-3.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400 disabled:opacity-30 disabled:hover:bg-emerald-500 disabled:cursor-not-allowed"
      >
        Continue
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Connect your machine
// ---------------------------------------------------------------------------

function StepConnect({
  form,
  setForm,
  onNext,
  onBack,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onNext: () => void;
  onBack: () => void;
}) {
  const selectedConn = CONNECTIONS.find((c) => c.id === form.connectionType);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Connect your machine
        </h1>
        <p className="mt-2 text-white/40 text-base">
          How should we reach it on the network?
        </p>
      </div>

      <div className="space-y-3">
        {CONNECTIONS.map((conn) => (
          <button
            key={conn.id}
            onClick={() => setForm((f) => ({ ...f, connectionType: conn.id, connectionUrl: "" }))}
            className={`w-full flex items-center gap-4 rounded-xl p-4 text-left transition-all duration-200
              ${
                form.connectionType === conn.id
                  ? "bg-emerald-500/15 ring-1 ring-emerald-400/40"
                  : "bg-white/[0.03] hover:bg-white/[0.06] ring-1 ring-white/[0.06]"
              }`}
          >
            <div className="flex-1">
              <div className="text-sm font-medium text-white/80">{conn.label}</div>
              <div className="text-xs text-white/30 mt-0.5">{conn.desc}</div>
            </div>
            <div
              className={`w-4 h-4 rounded-full border-2 transition-all ${
                form.connectionType === conn.id
                  ? "border-emerald-400 bg-emerald-400"
                  : "border-white/20"
              }`}
            />
          </button>
        ))}
      </div>

      {/* URL input (unless manual) */}
      {selectedConn && selectedConn.id !== "manual" && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="space-y-2"
        >
          <label className="text-sm text-white/50">Address</label>
          <input
            value={form.connectionUrl}
            onChange={(e) => setForm((f) => ({ ...f, connectionUrl: e.target.value }))}
            placeholder={selectedConn.placeholder}
            className="w-full rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] px-4 py-3 text-white/80 text-sm font-mono placeholder:text-white/20 focus:ring-emerald-400/30 focus:outline-none transition-all"
          />
        </motion.div>
      )}

      {/* Machine name */}
      <div className="space-y-2">
        <label className="text-sm text-white/50">
          Give it a name <span className="text-white/20">(optional)</span>
        </label>
        <input
          value={form.machineName}
          onChange={(e) => setForm((f) => ({ ...f, machineName: e.target.value }))}
          placeholder="e.g. Shop Printer, Garage CNC"
          className="w-full rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] px-4 py-3 text-white/80 text-sm placeholder:text-white/20 focus:ring-emerald-400/30 focus:outline-none transition-all"
        />
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] py-3.5 text-sm text-white/50 hover:bg-white/[0.08] transition-all"
        >
          Back
        </button>
        <button
          onClick={onNext}
          disabled={!form.connectionType || (form.connectionType !== "manual" && !form.connectionUrl)}
          className="flex-[2] rounded-xl bg-emerald-500 py-3.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Set your rate
// ---------------------------------------------------------------------------

function StepRate({
  form,
  setForm,
  onNext,
  onBack,
  submitting,
}: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  onNext: () => void;
  onBack: () => void;
  submitting: boolean;
}) {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Set your rate
        </h1>
        <p className="mt-2 text-white/40 text-base">
          How much do you charge? You can change this later.
        </p>
      </div>

      <div className="flex gap-3 items-end">
        <div className="flex-1 space-y-2">
          <label className="text-sm text-white/50">Amount (USD)</label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30 text-sm">$</span>
            <input
              type="number"
              value={form.rate}
              onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
              placeholder="25"
              min="0"
              step="0.01"
              className="w-full rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] pl-8 pr-4 py-3 text-white/80 text-lg font-mono placeholder:text-white/20 focus:ring-emerald-400/30 focus:outline-none transition-all"
            />
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-sm text-white/50">Per</label>
          <select
            value={form.rateUnit}
            onChange={(e) => setForm((f) => ({ ...f, rateUnit: e.target.value }))}
            className="rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] px-4 py-3 text-white/80 text-sm focus:ring-emerald-400/30 focus:outline-none transition-all appearance-none cursor-pointer"
          >
            <option value="hour">Hour</option>
            <option value="job">Job</option>
            <option value="gram">Gram</option>
            <option value="unit">Unit</option>
          </select>
        </div>
      </div>

      <div className="rounded-xl bg-white/[0.02] ring-1 ring-white/[0.05] p-4">
        <p className="text-xs text-white/30 leading-relaxed">
          Your rate is visible to anyone searching for your capability.
          You'll get notified when someone wants to place an order, and you
          can accept or decline. You keep 100% — no platform fees.
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="flex-1 rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] py-3.5 text-sm text-white/50 hover:bg-white/[0.08] transition-all"
        >
          Back
        </button>
        <button
          onClick={onNext}
          disabled={submitting}
          className="flex-[2] rounded-xl bg-emerald-500 py-3.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400 disabled:opacity-50"
        >
          {submitting ? "Setting up…" : "Go live"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4: You're live
// ---------------------------------------------------------------------------

function StepDone({ form }: { form: FormState }) {
  const navigate = useNavigate();
  const cat = CATEGORIES.find((c) => c.id === form.category);

  return (
    <div className="space-y-8 text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 15, delay: 0.1 }}
        className="mx-auto w-20 h-20 rounded-2xl bg-emerald-500/20 ring-1 ring-emerald-400/30 flex items-center justify-center text-4xl"
      >
        ✓
      </motion.div>

      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          You're live
        </h1>
        <p className="mt-2 text-white/40 text-base">
          {cat?.icon} {form.machineName || cat?.label || "Your machine"} is on the network.
        </p>
      </div>

      <div className="rounded-xl bg-white/[0.03] ring-1 ring-white/[0.06] p-5 text-left space-y-3">
        <Row label="Capability" value={cat?.label || form.category} />
        <Row label="Connection" value={form.connectionType === "manual" ? "Manual updates" : form.connectionUrl} />
        <Row label="Rate" value={`$${form.rate || "0"} / ${form.rateUnit}`} />
      </div>

      <div className="space-y-3">
        <button
          onClick={() => navigate("/operator")}
          className="w-full rounded-xl bg-emerald-500 py-3.5 text-sm font-semibold text-black transition-all hover:bg-emerald-400"
        >
          Go to dashboard
        </button>
        <button
          onClick={() => navigate("/start")}
          className="w-full rounded-xl bg-white/[0.04] ring-1 ring-white/[0.08] py-3.5 text-sm text-white/50 hover:bg-white/[0.08] transition-all"
        >
          Add another machine
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-xs text-white/30">{label}</span>
      <span className="text-sm text-white/70">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function StartPage() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [direction, setDirection] = useState(1);

  const goNext = useCallback(() => {
    setDirection(1);
    setStep((s) => s + 1);
  }, []);

  const goBack = useCallback(() => {
    setDirection(-1);
    setStep((s) => s - 1);
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    try {
      // Map to API types
      const adapterType =
        form.connectionType === "octoprint"
          ? "octoprint"
          : form.connectionType === "manual"
            ? "mock"
            : "generic-http";

      const deviceId = `dev_${form.category}_${Date.now().toString(36)}`;
      const kernelId = "kernel_dev_001";

      await fetch("/api/setup/register-device", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          kernelId,
          deviceId,
          type: "machine",
          model: form.description || form.machineName || form.category,
          adapterType,
          adapterConfig: form.connectionUrl
            ? { url: form.connectionUrl }
            : undefined,
          capabilities: [form.category],
        }),
      });

      setDirection(1);
      setStep(3);
    } catch (err) {
      console.error("Registration failed:", err);
    } finally {
      setSubmitting(false);
    }
  }, [form]);

  const steps = [
    <StepCapability key="cap" form={form} setForm={setForm} onNext={goNext} />,
    <StepConnect key="conn" form={form} setForm={setForm} onNext={goNext} onBack={goBack} />,
    <StepRate key="rate" form={form} setForm={setForm} onNext={handleSubmit} onBack={goBack} submitting={submitting} />,
    <StepDone key="done" form={form} />,
  ];

  return (
    <div className="min-h-screen bg-[#060F09] flex items-center justify-center px-4">
      {/* Subtle radial glow */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-emerald-500/[0.04] blur-[120px]" />
      </div>

      <div className="relative w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <StepDots current={step} total={4} />
          {step < 3 && (
            <span className="text-xs text-white/20 font-mono">
              {step + 1}/4
            </span>
          )}
        </div>

        {/* Step content */}
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={step}
            custom={direction}
            variants={stepVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
          >
            {steps[step]}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
