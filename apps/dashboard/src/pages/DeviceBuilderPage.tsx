import React from "react";
import { useNavigate } from "react-router-dom";
import {
  WizardShell,
  WizardStepRail,
  WizardStepContent,
  OnboardingAIBubble,
  GlassPanel,
  GlowBadge,
} from "@pcc/ui";
import type { WizardStep } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import {
  useDeviceBuilderStore,
  type ParamDraft,
  type ConstraintDraft,
} from "../stores/device-builder-store.js";

// ── Constants ────────────────────────────────────────────────────────

const baseInput =
  "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

const addBtnClass =
  "text-xs text-green-400/60 hover:text-green-400/90 border border-green-500/20 rounded-lg px-3 py-1.5 transition-colors";

const deleteBtnClass =
  "text-xs text-red-400/40 hover:text-red-400/70 transition-colors";

const wizardSteps: WizardStep[] = [
  { id: "device", label: "Device Info", description: "Name, type, manufacturer" },
  { id: "params", label: "Parameters", description: "Configurable knobs" },
  { id: "pricing", label: "Pricing", description: "Base price & impacts" },
  { id: "constraints", label: "Constraints", description: "Cross-param rules" },
  { id: "review", label: "Review & Register", description: "Preview & publish" },
];

const aiMessages: Record<number, { content: string; suggestions?: string[] }> = {
  0: {
    content:
      "Let's define your device. This creates a new process type for the contract builder.",
    suggestions: [
      "Use any capability type string -- existing or custom",
      "Manufacturer + model help users find your device",
    ],
  },
  1: {
    content:
      "Parameters are what customers configure when ordering. Think: material, size, quality, quantity.",
    suggestions: [
      "Enum: pick from a list (materials, finishes)",
      "Number: range slider (infill %, quantity)",
      "Boolean: on/off toggle (supports, rush)",
    ],
  },
  2: {
    content:
      "Set your base price and add per-parameter pricing impacts to calculate dynamic quotes.",
    suggestions: [
      "Per-option pricing: set % on each enum option",
      "Boolean pricing: set % when toggle is on",
    ],
  },
  3: {
    content:
      "Constraints prevent invalid combinations. E.g., if material=PLA, exclude vapor-smoothing.",
    suggestions: [
      "Constraints are optional -- skip if not needed",
      "Use 'restrict to' to limit valid options",
      "Use 'exclude' to remove specific options",
    ],
  },
  4: {
    content:
      "Review your template before registering. Once registered, it appears in Build Contract for all users.",
  },
};

// ── Step 1: Device Info ──────────────────────────────────────────────

function StepDeviceInfo() {
  const {
    deviceName, capabilityType, manufacturer, model, description,
    updateDevice, nextStep, isStepValid,
  } = useDeviceBuilderStore();

  return (
    <WizardStepContent
      title="Device Info"
      subtitle="Tell us about your device -- name, type, and manufacturer."
      onNext={nextStep}
      nextDisabled={!isStepValid(0)}
    >
      <div className="space-y-4 max-w-lg">
        <div>
          <label className="text-xs text-white/40 mb-1 block">Machine Name *</label>
          <input
            className={baseInput}
            placeholder="e.g., Desktop Bio-Reactor, Resin Vat 2000"
            value={deviceName}
            onChange={(e) => updateDevice({ deviceName: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Capability Type *</label>
          <input
            className={baseInput}
            placeholder="e.g., fdm, sla, cnc-3axis, laser-cut, bio-reactor, hplc, or any custom type"
            value={capabilityType}
            onChange={(e) => updateDevice({ capabilityType: e.target.value })}
          />
          <p className="text-[10px] text-white/15 mt-1">
            Any string -- use an existing type or define your own
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Manufacturer *</label>
            <input
              className={baseInput}
              placeholder="e.g., Formlabs, Bambu Lab"
              value={manufacturer}
              onChange={(e) => updateDevice({ manufacturer: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Model</label>
            <input
              className={baseInput}
              placeholder="e.g., Form 3+, X1 Carbon"
              value={model}
              onChange={(e) => updateDevice({ model: e.target.value })}
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Description</label>
          <textarea
            className={`${baseInput} min-h-[80px] resize-y`}
            placeholder="Brief description of what this device does..."
            value={description}
            onChange={(e) => updateDevice({ description: e.target.value })}
          />
        </div>
      </div>
    </WizardStepContent>
  );
}

// ── Step 2: Parameter Editor ─────────────────────────────────────────

function ParamCard({ param }: { param: ParamDraft }) {
  const { updateParam, removeParam, addParamOption, updateParamOption, removeParamOption } =
    useDeviceBuilderStore();

  return (
    <GlassPanel padding="md" className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GlowBadge color={param.type === "enum" ? "green" : param.type === "number" ? "gold" : "gray"}>
            {param.type}
          </GlowBadge>
          <span className="text-xs text-white/30 font-mono">{param.key || "new-param"}</span>
        </div>
        <button className={deleteBtnClass} onClick={() => removeParam(param.id)}>
          Delete
        </button>
      </div>

      {/* Core fields */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Type</label>
          <select
            className={baseInput}
            value={param.type}
            onChange={(e) =>
              updateParam(param.id, {
                type: e.target.value as "enum" | "number" | "boolean",
                options: e.target.value === "enum" ? [{ value: "", label: "" }] : [],
              })
            }
          >
            <option value="enum">Enum (list)</option>
            <option value="number">Number (range)</option>
            <option value="boolean">Boolean (toggle)</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Key *</label>
          <input
            className={baseInput}
            placeholder="e.g., material"
            value={param.key}
            onChange={(e) => updateParam(param.id, { key: e.target.value })}
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Label *</label>
          <input
            className={baseInput}
            placeholder="e.g., Material"
            value={param.label}
            onChange={(e) => updateParam(param.id, { label: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Group</label>
          <input
            className={baseInput}
            placeholder="e.g., Print Settings"
            value={param.group}
            onChange={(e) => updateParam(param.id, { group: e.target.value })}
          />
        </div>
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Description</label>
          <input
            className={baseInput}
            placeholder="Help text for this parameter"
            value={param.description}
            onChange={(e) => updateParam(param.id, { description: e.target.value })}
          />
        </div>
      </div>

      {/* Required toggle */}
      <label className="flex items-center gap-2 text-xs text-white/40 cursor-pointer">
        <input
          type="checkbox"
          checked={param.required}
          onChange={(e) => updateParam(param.id, { required: e.target.checked })}
          className="accent-green-500"
        />
        Required
      </label>

      {/* Enum-specific: options */}
      {param.type === "enum" && (
        <div className="space-y-2 pl-2 border-l border-green-500/10">
          <div className="text-[10px] text-white/25 font-mono uppercase tracking-wider">
            Options
          </div>
          {param.options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={`${baseInput} flex-1`}
                placeholder="value"
                value={opt.value}
                onChange={(e) => updateParamOption(param.id, i, { value: e.target.value })}
              />
              <input
                className={`${baseInput} flex-1`}
                placeholder="label"
                value={opt.label}
                onChange={(e) => updateParamOption(param.id, i, { label: e.target.value })}
              />
              <input
                className={`${baseInput} w-20`}
                placeholder="% impact"
                value={opt.pricingPercent ?? ""}
                onChange={(e) =>
                  updateParamOption(param.id, i, { pricingPercent: e.target.value })
                }
              />
              {param.options.length > 1 && (
                <button className={deleteBtnClass} onClick={() => removeParamOption(param.id, i)}>
                  x
                </button>
              )}
            </div>
          ))}
          <button className={addBtnClass} onClick={() => addParamOption(param.id)}>
            + Add option
          </button>
        </div>
      )}

      {/* Number-specific: min/max/step/unit */}
      {param.type === "number" && (
        <div className="grid grid-cols-4 gap-2 pl-2 border-l border-gold-400/10">
          <div>
            <label className="text-[10px] text-white/30 mb-0.5 block">Min</label>
            <input
              className={baseInput}
              type="number"
              value={param.min ?? 0}
              onChange={(e) => updateParam(param.id, { min: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="text-[10px] text-white/30 mb-0.5 block">Max</label>
            <input
              className={baseInput}
              type="number"
              value={param.max ?? 100}
              onChange={(e) => updateParam(param.id, { max: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="text-[10px] text-white/30 mb-0.5 block">Step</label>
            <input
              className={baseInput}
              type="number"
              value={param.step ?? 1}
              onChange={(e) => updateParam(param.id, { step: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="text-[10px] text-white/30 mb-0.5 block">Unit</label>
            <input
              className={baseInput}
              placeholder="e.g., mm, %, kg"
              value={param.unit ?? ""}
              onChange={(e) => updateParam(param.id, { unit: e.target.value })}
            />
          </div>
        </div>
      )}

      {/* Boolean-specific: pricing impact */}
      {param.type === "boolean" && (
        <div className="pl-2 border-l border-white/10">
          <label className="text-[10px] text-white/30 mb-0.5 block">
            Pricing impact when enabled (%)
          </label>
          <input
            className={`${baseInput} w-32`}
            placeholder="e.g., 15"
            value={param.booleanPricingPercent ?? ""}
            onChange={(e) =>
              updateParam(param.id, { booleanPricingPercent: e.target.value })
            }
          />
        </div>
      )}
    </GlassPanel>
  );
}

function StepParameters() {
  const { params, addParam, nextStep, prevStep, isStepValid } =
    useDeviceBuilderStore();

  return (
    <WizardStepContent
      title="Parameters"
      subtitle="Define the configurable knobs customers see when ordering."
      onBack={prevStep}
      onNext={nextStep}
      nextDisabled={!isStepValid(1)}
    >
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/30 font-mono">
            {params.length} parameter{params.length !== 1 ? "s" : ""} defined
          </span>
          <button className={addBtnClass} onClick={addParam}>
            + Add Parameter
          </button>
        </div>

        {params.length === 0 && (
          <GlassPanel padding="lg" className="text-center">
            <p className="text-sm text-white/30">
              No parameters yet. Click "Add Parameter" to start defining what customers can configure.
            </p>
          </GlassPanel>
        )}

        {params.map((p) => (
          <ParamCard key={p.id} param={p} />
        ))}
      </div>
    </WizardStepContent>
  );
}

// ── Step 3: Pricing ──────────────────────────────────────────────────

function StepPricing() {
  const { basePrice, currency, perUnitLabel, setPricing, params, nextStep, prevStep, isStepValid } =
    useDeviceBuilderStore();

  const pricingParamCount = params.filter(
    (p) =>
      (p.type === "enum" && p.options.some((o) => o.pricingPercent && parseFloat(o.pricingPercent) !== 0)) ||
      (p.type === "boolean" && p.booleanPricingPercent && parseFloat(p.booleanPricingPercent) !== 0),
  ).length;

  return (
    <WizardStepContent
      title="Pricing"
      subtitle="Set base pricing. Per-parameter impacts were configured in step 2."
      onBack={prevStep}
      onNext={nextStep}
      nextDisabled={!isStepValid(2)}
    >
      <div className="space-y-6 max-w-lg">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Base Price *</label>
            <input
              className={baseInput}
              type="number"
              step="0.01"
              min="0"
              placeholder="15.00"
              value={basePrice}
              onChange={(e) => setPricing({ basePrice: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Currency</label>
            <select
              className={baseInput}
              value={currency}
              onChange={(e) => setPricing({ currency: e.target.value })}
            >
              <option value="USDC">USDC</option>
              <option value="ETH">ETH</option>
              <option value="DAI">DAI</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Per-Unit Label</label>
            <input
              className={baseInput}
              placeholder="e.g., per part, per hour"
              value={perUnitLabel}
              onChange={(e) => setPricing({ perUnitLabel: e.target.value })}
            />
          </div>
        </div>

        {/* Pricing summary */}
        <GlassPanel padding="md" glow="green">
          <div className="text-[10px] text-white/25 font-mono uppercase tracking-wider mb-3">
            Pricing Summary
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-white/60">
              <span>Base price</span>
              <span className="font-mono text-green-400">
                {parseFloat(basePrice) > 0 ? `${basePrice} ${currency}` : "--"}
              </span>
            </div>
            <div className="flex justify-between text-white/40">
              <span>Unit</span>
              <span className="font-mono">{perUnitLabel || "--"}</span>
            </div>
            <div className="flex justify-between text-white/40">
              <span>Parameters with pricing impact</span>
              <span className="font-mono">{pricingParamCount}</span>
            </div>
            <div className="border-t border-white/[0.06] pt-2 flex justify-between text-white/60">
              <span>Dynamic range</span>
              <span className="font-mono text-white/30">
                {parseFloat(basePrice) > 0
                  ? `${basePrice} ${currency} + options`
                  : "--"}
              </span>
            </div>
          </div>
        </GlassPanel>
      </div>
    </WizardStepContent>
  );
}

// ── Step 4: Constraints ──────────────────────────────────────────────

function ConstraintCard({ constraint }: { constraint: ConstraintDraft }) {
  const { params, updateConstraint, removeConstraint } = useDeviceBuilderStore();

  const enumParams = params.filter((p) => p.type === "enum");

  return (
    <GlassPanel padding="md" className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/30 font-mono">Constraint</span>
        <button className={deleteBtnClass} onClick={() => removeConstraint(constraint.id)}>
          Delete
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">When parameter</label>
          <select
            className={baseInput}
            value={constraint.whenParam}
            onChange={(e) => updateConstraint(constraint.id, { whenParam: e.target.value })}
          >
            <option value="">-- select --</option>
            {params.map((p) => (
              <option key={p.id} value={p.key}>
                {p.label || p.key}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Equals</label>
          <input
            className={baseInput}
            placeholder="value"
            value={constraint.whenEquals}
            onChange={(e) => updateConstraint(constraint.id, { whenEquals: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Then parameter</label>
          <select
            className={baseInput}
            value={constraint.thenParam}
            onChange={(e) => updateConstraint(constraint.id, { thenParam: e.target.value })}
          >
            <option value="">-- select --</option>
            {enumParams.map((p) => (
              <option key={p.id} value={p.key}>
                {p.label || p.key}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Action</label>
          <select
            className={baseInput}
            value={constraint.action}
            onChange={(e) =>
              updateConstraint(constraint.id, {
                action: e.target.value as "restrictTo" | "exclude",
              })
            }
          >
            <option value="restrictTo">Restrict to</option>
            <option value="exclude">Exclude</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-white/30 mb-0.5 block">Values (comma-separated)</label>
          <input
            className={baseInput}
            placeholder="e.g., pla, petg"
            value={constraint.values.join(", ")}
            onChange={(e) =>
              updateConstraint(constraint.id, {
                values: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
      </div>
    </GlassPanel>
  );
}

function StepConstraints() {
  const { constraints, addConstraint, nextStep, prevStep } = useDeviceBuilderStore();

  return (
    <WizardStepContent
      title="Constraints"
      subtitle="Optional: define cross-parameter dependency rules."
      onBack={prevStep}
      onNext={nextStep}
      nextLabel="Review"
    >
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center justify-between">
          <span className="text-xs text-white/30 font-mono">
            {constraints.length} constraint{constraints.length !== 1 ? "s" : ""} defined
          </span>
          <button className={addBtnClass} onClick={addConstraint}>
            + Add Constraint
          </button>
        </div>

        <p className="text-[10px] text-white/20">
          Constraints are optional -- they enforce valid parameter combinations.
          E.g., when material=PLA, exclude vapor-smoothing from post-processing.
        </p>

        {constraints.length === 0 && (
          <GlassPanel padding="lg" className="text-center">
            <p className="text-sm text-white/30">
              No constraints. Your parameters will accept all combinations.
            </p>
          </GlassPanel>
        )}

        {constraints.map((c) => (
          <ConstraintCard key={c.id} constraint={c} />
        ))}
      </div>
    </WizardStepContent>
  );
}

// ── Step 5: Review & Register ────────────────────────────────────────

function StepReview() {
  const navigate = useNavigate();
  const {
    generatedTemplate, generatedProfile, registered,
    generate, register, prevStep, params, constraints,
    deviceName, capabilityType, manufacturer, model,
  } = useDeviceBuilderStore();

  React.useEffect(() => {
    generate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (registered) {
    return (
      <WizardStepContent title="Registered!" subtitle="Your device is live.">
        <div className="flex flex-col items-center justify-center py-16 space-y-6">
          {/* Green checkmark */}
          <div className="w-16 h-16 rounded-full bg-green-500/20 border-2 border-green-500/40 flex items-center justify-center shadow-[0_0_30px_rgba(124,179,66,0.25)]">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
              <path d="M5 12l5 5L19 7" />
            </svg>
          </div>
          <div className="text-center space-y-2">
            <h3 className="text-lg text-white/80 font-medium">Your device is now available in Build Contract</h3>
            <p className="text-sm text-white/40">
              {manufacturer} {model} ({capabilityType}) has been registered with{" "}
              {params.length} parameters and {constraints.length} constraints.
            </p>
          </div>
          <button
            onClick={() => navigate("/build")}
            className="px-6 py-2.5 rounded-lg text-sm font-medium bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-all"
          >
            Go to Build Contract
          </button>
        </div>
      </WizardStepContent>
    );
  }

  const templateJson = generatedTemplate
    ? JSON.stringify(generatedTemplate, null, 2)
    : "Generating...";

  return (
    <WizardStepContent
      title="Review & Register"
      subtitle="Preview the generated template and machine profile before registering."
      onBack={prevStep}
    >
      <div className="space-y-6 max-w-2xl">
        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3">
          <GlassPanel padding="md" glow="green">
            <div className="text-[10px] text-white/25 font-mono uppercase tracking-wider mb-2">
              Template
            </div>
            <div className="text-sm text-white/70 font-medium">
              {generatedTemplate?.name ?? deviceName}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <GlowBadge color="green">{capabilityType}</GlowBadge>
              <span className="text-[10px] text-white/25 font-mono">v1.0</span>
            </div>
            <div className="mt-2 text-[10px] text-white/30">
              {params.length} params, {constraints.length} constraints
            </div>
          </GlassPanel>

          <GlassPanel padding="md">
            <div className="text-[10px] text-white/25 font-mono uppercase tracking-wider mb-2">
              Machine Profile
            </div>
            <div className="text-sm text-white/70 font-medium">
              {generatedProfile?.machineName ?? `${manufacturer} ${model}`}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <GlowBadge color="gray">{generatedProfile?.id ?? "..."}</GlowBadge>
            </div>
            <div className="mt-2 text-[10px] text-white/30">
              Base price: {generatedProfile?.pricingOverrides?.basePrice ?? "--"}{" "}
              {generatedProfile?.pricingOverrides?.currency ?? ""}
            </div>
          </GlassPanel>
        </div>

        {/* JSON preview */}
        <div>
          <div className="text-[10px] text-white/25 font-mono uppercase tracking-wider mb-2">
            Generated Template (JSON)
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/30 p-4 overflow-auto max-h-[400px]">
            <pre className="text-[11px] text-green-400/60 font-mono leading-relaxed whitespace-pre-wrap">
              {templateJson}
            </pre>
          </div>
        </div>

        {/* Register button */}
        <div className="flex justify-end pt-2">
          <button
            onClick={register}
            disabled={!generatedTemplate}
            className="px-6 py-2.5 rounded-lg text-sm font-medium bg-green-500/20 border border-green-500/30 text-green-400 hover:bg-green-500/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Register Device
          </button>
        </div>
      </div>
    </WizardStepContent>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

const stepComponents = [
  StepDeviceInfo,
  StepParameters,
  StepPricing,
  StepConstraints,
  StepReview,
];

export function DeviceBuilderPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { step, setStep } = useDeviceBuilderStore();

  React.useEffect(() => {
    setPageMeta("Contract Builder Builder", `Step ${step + 1} of ${wizardSteps.length}`);
  }, [setPageMeta, step]);

  const StepComponent = stepComponents[step];
  const currentAI = aiMessages[step];

  return (
    <div className="h-[calc(100vh-120px)] -m-6">
      <WizardShell
        stepRail={
          <WizardStepRail steps={wizardSteps} currentStep={step} onStepClick={setStep} />
        }
        content={<StepComponent />}
        aiSidebar={
          <div className="p-4 space-y-4">
            <div className="text-[10px] text-white/20 font-mono uppercase tracking-wider mb-2">
              AI Assistant
            </div>
            {currentAI && (
              <OnboardingAIBubble
                content={currentAI.content}
                suggestions={currentAI.suggestions}
                timestamp="now"
              />
            )}
          </div>
        }
      />
    </div>
  );
}
