import React from "react";
import { useNavigate } from "react-router-dom";
import { WizardStepContent, GlassPanel, GlowBadge } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { apiPost } from "../../lib/api.js";
import type { TestJobResponse } from "../../lib/api.js";
import { describeRegistrationFailure, registerMachine } from "./register-machine.js";
import type { RegistrationOutcome } from "./register-machine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubmitState =
  | { status: "idle" | "submitting" }
  | RegistrationOutcome;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Step7_Review() {
  const {
    identity,
    documents,
    capabilities,
    spaceRequirements,
    pricing,
    operatorName,
    certifications,
    prevStep,
  } = useOnboardWizardStore();

  const navigate = useNavigate();
  const [submit, setSubmit] = React.useState<SubmitState>({ status: "idle" });
  const [testJob, setTestJob] = React.useState<{
    status: "idle" | "running" | "done" | "error";
    result?: TestJobResponse;
    errorMessage?: string;
  }>({ status: "idle" });

  // ---------------------------------------------------------------------------
  // Register machine
  // ---------------------------------------------------------------------------

  const handleSubmit = async () => {
    if (submit.status === "submitting") return;

    setSubmit({ status: "submitting" });
    setTestJob({ status: "idle" });

    const outcome = await registerMachine(
      {
        name: identity.name || "",
        manufacturer: identity.manufacturer,
        model: identity.model,
        capabilityIds: capabilities.map((c) => c.id),
      },
      { post: apiPost },
    );

    setSubmit(outcome);
  };

  // ---------------------------------------------------------------------------
  // Run test job
  // ---------------------------------------------------------------------------

  const handleRunTestJob = async () => {
    if (submit.status !== "confirmed") return;

    setTestJob({ status: "running" });
    try {
      const result = await apiPost<TestJobResponse>("/setup/test-job", {
        kernelId: submit.kernelId,
        deviceId: submit.deviceId,
        assuranceTier: 0,
      });
      setTestJob({ status: "done", result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setTestJob({ status: "error", errorMessage: msg });
    }
  };

  // ---------------------------------------------------------------------------
  // Retry
  // ---------------------------------------------------------------------------

  const handleRetry = () => {
    setSubmit({ status: "idle" });
    setTestJob({ status: "idle" });
  };

  // ---------------------------------------------------------------------------
  // Render — confirmed state
  // ---------------------------------------------------------------------------

  if (submit.status === "confirmed") {
    return (
      <WizardStepContent
        title="Machine Registered"
        subtitle="Your machine has been registered on the PCC network."
        onNext={() => navigate("/operator")}
        nextLabel="Go to Operator Dashboard"
      >
        <div className="space-y-4 max-w-xl">
          {/* Confirmation indicator */}
          <div className="flex justify-center py-2">
            <div className="w-16 h-16 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center">
              <span className="text-2xl text-green-400">&#10003;</span>
            </div>
          </div>

          <GlassPanel padding="md" glow="green" className="space-y-2">
            <div className="text-xs font-medium text-white/50">Registration Details</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] text-white/30 uppercase tracking-wider">Device ID</div>
                <div className="text-xs text-white/70 font-mono truncate">
                  {submit.deviceId}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-white/30 uppercase tracking-wider">Kernel</div>
                <div className="text-xs text-white/70 font-mono truncate">{submit.kernelId}</div>
              </div>
            </div>
          </GlassPanel>

          {/* Test Job section */}
          {testJob.status === "idle" && (
            <GlassPanel padding="md" className="space-y-3">
              <div className="text-xs font-medium text-white/50">Verify the pipeline</div>
              <p className="text-xs text-white/30">
                Run a test job to confirm the device adapter and evidence pipeline work end-to-end.
              </p>
              <button
                onClick={handleRunTestJob}
                className="w-full py-2 rounded-lg bg-green-500/15 border border-green-500/25 text-green-400 text-sm font-medium hover:bg-green-500/20 transition-colors"
              >
                Run Test Job
              </button>
            </GlassPanel>
          )}

          {testJob.status === "running" && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
              <div className="w-3 h-3 border border-green-500/50 border-t-green-500 rounded-full animate-spin" />
              <span className="text-xs text-white/40">Running test job...</span>
            </div>
          )}

          {testJob.status === "done" && testJob.result && (
            <GlassPanel padding="md" glow="green" className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-green-400 text-sm">&#10003;</span>
                <span className="text-xs font-medium text-white/70">Test job completed</span>
                <GlowBadge color="green">{testJob.result.status}</GlowBadge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-white/40">
                <span>Job: <span className="font-mono text-white/30 text-[10px]">{testJob.result.jobId.slice(0, 20)}...</span></span>
                <span>Duration: {testJob.result.duration}ms</span>
              </div>
            </GlassPanel>
          )}

          {testJob.status === "error" && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <div className="text-xs text-red-400 font-medium mb-1">Test job failed</div>
              <div className="text-xs text-white/40">{testJob.errorMessage}</div>
            </div>
          )}
        </div>
      </WizardStepContent>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — unconfirmed state
  // ---------------------------------------------------------------------------

  // Nothing here may say "saved": the wizard store is in-memory only, so a
  // reload loses the operator's details.
  if (submit.status === "unconfirmed") {
    return (
      <WizardStepContent
        title="Couldn't reach the network to confirm"
        subtitle="Your details are only kept in this browser tab — reloading or closing it will lose them."
        onBack={prevStep}
        onNext={handleSubmit}
        nextLabel="Try Again"
      >
        <div className="space-y-4 max-w-xl">
          <div
            role="alert"
            className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/25 space-y-2"
          >
            <div className="text-sm font-medium text-amber-400">
              Registration not confirmed
            </div>
            <p className="text-xs text-white/50">{submit.reason}</p>
          </div>

          <GlassPanel padding="md" className="space-y-2 border-amber-500/20">
            <div className="text-xs font-medium text-amber-400">
              Proposed IDs — not confirmed
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] text-white/40 uppercase tracking-wider">
                  Proposed Device ID (not confirmed)
                </div>
                <div className="text-xs text-white/70 font-mono truncate">
                  {submit.deviceId}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-white/40 uppercase tracking-wider">
                  Proposed Kernel ID (not confirmed)
                </div>
                <div className="text-xs text-white/70 font-mono truncate">
                  {submit.kernelId}
                </div>
              </div>
            </div>
          </GlassPanel>
        </div>
      </WizardStepContent>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — review state
  // ---------------------------------------------------------------------------

  const failureExplanation =
    submit.status === "failed" ? describeRegistrationFailure(submit.errorMessage) : null;

  return (
    <WizardStepContent
      title="Review & Submit"
      subtitle="Review your machine registration before submitting."
      onBack={submit.status === "submitting" ? undefined : prevStep}
      onNext={submit.status === "submitting" ? undefined : handleSubmit}
      nextLabel={submit.status === "submitting" ? "Registering..." : "Submit Registration"}
      nextDisabled={submit.status === "submitting"}
    >
      <div className="space-y-4 max-w-xl">
        {/* Identity */}
        <GlassPanel padding="md" className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-white/50">Machine Identity</span>
            <GlowBadge color="green">{identity.category || "—"}</GlowBadge>
          </div>
          <div className="text-sm text-white/70">{identity.name || "—"}</div>
          <div className="text-xs text-white/30">
            {identity.manufacturer} {identity.model}
          </div>
        </GlassPanel>

        {/* Documents */}
        <GlassPanel padding="md" className="space-y-1">
          <span className="text-xs font-medium text-white/50">Documents</span>
          <div className="text-sm text-white/50">{documents.length} file(s) uploaded</div>
        </GlassPanel>

        {/* Capabilities */}
        <GlassPanel padding="md" className="space-y-2">
          <span className="text-xs font-medium text-white/50">Capabilities ({capabilities.length})</span>
          {capabilities.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <GlowBadge color="green">{c.type}</GlowBadge>
              <span className="text-xs text-white/50">{c.name}</span>
            </div>
          ))}
        </GlassPanel>

        {/* Space */}
        {spaceRequirements && (
          <GlassPanel padding="md" className="space-y-1">
            <span className="text-xs font-medium text-white/50">Physical Space</span>
            <div className="text-xs text-white/40">
              {spaceRequirements.footprint.width} x {spaceRequirements.footprint.depth} x {spaceRequirements.footprint.height} {spaceRequirements.footprint.unit}
              {" | "}{spaceRequirements.power.voltage}V {spaceRequirements.power.phase}ph
              {" | "}{spaceRequirements.weight.value} {spaceRequirements.weight.unit}
            </div>
          </GlassPanel>
        )}

        {/* Pricing */}
        {pricing && (
          <GlassPanel padding="md" className="space-y-1">
            <span className="text-xs font-medium text-white/50">Pricing</span>
            <div className="text-xs text-white/40">
              Base: ${pricing.baseCost} | Min: ${pricing.minimum} | {pricing.currency}
              {pricing.perMinute && ` | $${pricing.perMinute}/min`}
              {pricing.perGram && ` | $${pricing.perGram}/g`}
            </div>
          </GlassPanel>
        )}

        {/* Operator */}
        <GlassPanel padding="md" className="space-y-1">
          <span className="text-xs font-medium text-white/50">Operator</span>
          <div className="text-sm text-white/50">{operatorName || "—"}</div>
          <div className="text-xs text-white/30">{certifications.length} certification(s)</div>
        </GlassPanel>

        {/* Loading indicator */}
        {submit.status === "submitting" && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-3 h-3 border border-green-500/50 border-t-green-500 rounded-full animate-spin" />
            <div className="text-xs text-white/40">Registering machine on PCC network...</div>
          </div>
        )}

        {/* Error state */}
        {submit.status === "failed" && (
          <div role="alert" className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 space-y-2">
            <div className="text-xs text-red-400 font-medium">Registration failed</div>
            <div className="text-xs text-white/40">{submit.errorMessage}</div>
            {failureExplanation && (
              <p className="text-xs text-white/60">{failureExplanation}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleSubmit}
                className="text-xs px-3 py-1.5 rounded-lg bg-green-500/15 border border-green-500/25 text-green-400 hover:bg-green-500/20 transition-colors"
              >
                Retry
              </button>
              <button
                onClick={handleRetry}
                className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/40 hover:text-white/60 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        )}
      </div>
    </WizardStepContent>
  );
}
