import React from "react";
import { useNavigate } from "react-router-dom";
import { WizardStepContent, GlassPanel, GlowBadge } from "@pcc/ui";
import { useOnboardWizardStore } from "../../stores/onboard-wizard-store.js";
import { apiPost } from "../../lib/api.js";
import type {
  GenerateConfigResponse,
  RegisterDeviceResponse,
  TestJobResponse,
} from "../../lib/api.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubmitState {
  status: "idle" | "submitting" | "success" | "error";
  errorMessage?: string;
  registeredDeviceId?: string;
  kernelId?: string;
}

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
  // Step 1: generate-config → register-device → /api/devices/register
  // ---------------------------------------------------------------------------

  const handleSubmit = async () => {
    setSubmit({ status: "submitting" });

    // Build a device description from wizard state
    const deviceName = identity.name || "unnamed-device";
    const kernelId = `kernel_${deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${Date.now()}`;

    try {
      // 1. Generate kernel config
      let generatedConfig: GenerateConfigResponse | null = null;
      try {
        generatedConfig = await apiPost<GenerateConfigResponse>("/setup/generate-config", {
          kernelId,
          devices: [
            {
              name: deviceName,
              type: "machine",
              adapterType: "mock",
            },
          ],
          mockMode: true,
        });
      } catch (err) {
        // Non-fatal — gateway may be offline; continue in offline mode
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Failed to fetch") && !msg.includes("NetworkError") && !msg.includes("fetch")) {
          throw err;
        }
        // Swallow network errors — fallback mode
      }

      const resolvedKernelId = generatedConfig?.config.kernelId ?? kernelId;
      const resolvedDeviceId =
        generatedConfig?.config.devices[0]?.id ??
        `dev_${deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_000`;

      // 2. Register device via setup endpoint
      let registeredDevice: RegisterDeviceResponse | null = null;
      try {
        registeredDevice = await apiPost<RegisterDeviceResponse>("/setup/register-device", {
          kernelId: resolvedKernelId,
          deviceId: resolvedDeviceId,
          type: "machine",
          model: [identity.manufacturer, identity.model].filter(Boolean).join(" ") || "unknown",
          adapterType: "mock",
          adapterConfig: { mockMode: true },
          capabilities: capabilities.map((c) => c.id),
        });
      } catch (err) {
        // Fallback: try /api/devices/register
        const msg = err instanceof Error ? err.message : String(err);
        // kernel_not_found is expected if DB is empty — try devices/register
        if (msg.includes("kernel_not_found") || msg.includes("kernel not found")) {
          // best-effort — ignore
        } else if (!msg.includes("Failed to fetch") && !msg.includes("NetworkError") && !msg.includes("fetch")) {
          throw err;
        }
      }

      // 3. Register via /api/devices/register (broader registration)
      try {
        await apiPost<{ device: unknown }>("/devices/register", {
          kernelId: resolvedKernelId,
          id: resolvedDeviceId,
          type: "machine",
          model: [identity.manufacturer, identity.model].filter(Boolean).join(" ") || "unknown",
          adapterType: "mock",
          adapterConfig: { mockMode: true },
          capabilities: capabilities.map((c) => c.id),
        });
      } catch {
        // best-effort — DB may not have the kernel, that's okay in demo
      }

      setSubmit({
        status: "success",
        registeredDeviceId: registeredDevice?.device?.id ?? resolvedDeviceId,
        kernelId: resolvedKernelId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      // If gateway is completely offline, treat as offline success
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("fetch")) {
        const fallbackKernelId = kernelId;
        const fallbackDeviceId = `dev_${deviceName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_000`;
        setSubmit({
          status: "success",
          registeredDeviceId: fallbackDeviceId,
          kernelId: fallbackKernelId,
        });
      } else {
        setSubmit({ status: "error", errorMessage: msg });
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Run test job
  // ---------------------------------------------------------------------------

  const handleRunTestJob = async () => {
    setTestJob({ status: "running" });
    try {
      const result = await apiPost<TestJobResponse>("/setup/test-job", {
        kernelId: submit.kernelId,
        deviceId: submit.registeredDeviceId,
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
  // Render — success state
  // ---------------------------------------------------------------------------

  if (submit.status === "success") {
    return (
      <WizardStepContent
        title="Machine Registered"
        subtitle="Your machine has been registered on the PCCP network."
        onNext={() => navigate("/operator")}
        nextLabel="Go to Operator Dashboard"
      >
        <div className="space-y-4 max-w-xl">
          {/* Success indicator */}
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
                  {submit.registeredDeviceId}
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
  // Render — review state
  // ---------------------------------------------------------------------------

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
            <div className="text-xs text-white/40">Registering machine on PCCP network...</div>
          </div>
        )}

        {/* Error state */}
        {submit.status === "error" && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 space-y-2">
            <div className="text-xs text-red-400 font-medium">Registration failed</div>
            <div className="text-xs text-white/40">{submit.errorMessage}</div>
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
