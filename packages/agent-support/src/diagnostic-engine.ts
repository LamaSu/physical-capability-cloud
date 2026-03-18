/**
 * DiagnosticEngine — Runs structured diagnostic checks on kernel state.
 *
 * Given telemetry from a kernel, produces actionable findings about
 * what's working, what's broken, and how to fix it.
 */

export interface DiagnosticCheck {
  name: string;
  category: "adapter" | "evidence" | "network" | "settlement" | "capability" | "agent";
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
  fix?: string;
}

export interface DiagnosticResult {
  kernelId: string;
  timestamp: string;
  checks: DiagnosticCheck[];
  passCount: number;
  failCount: number;
  warnCount: number;
  summary: string;
}

export interface KernelState {
  kernelId: string;
  agentStarted: boolean;
  agentRegistered: boolean;
  capabilities: Array<{
    type: string;
    materials: string[];
    assuranceTiers: number[];
    pricing: { baseCost: string; perMinute: string; minimum: string; currency: string };
  }>;
  adapters: Array<{
    id: string;
    type: "machine" | "sensor" | "camera";
    status: string;
    lastEvent?: string;
    errorCount: number;
  }>;
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
  evidenceBundles: number;
  lastBundleHash?: string;
  networkConnected: boolean;
  walletAddress?: string;
  walletBalance?: string;
  gatewayUrl?: string;
  gatewayReachable?: boolean;
  escrowMappings: number;
  pendingSettlements: number;
  errors: Array<{ timestamp: string; message: string; source: string }>;
}

const VALID_CAPABILITY_TYPES = new Set([
  "cnc-3axis", "cnc-5axis", "fdm", "sla", "sls", "dmls", "lathe", "laser-cut",
  "waterjet", "edm-wire", "edm-sinker", "injection-mold", "sheet-metal-bend",
  "sheet-metal-punch", "welding-mig", "welding-tig", "welding-laser",
  "surface-grinding", "cylindrical-grinding", "polishing", "anodizing", "plating",
  "heat-treat", "cmm-inspection", "surface-profilometry", "xray-ct-inspection",
  "courier-pickup", "courier-delivery",
  "hplc", "gc-ms", "lc-ms", "pcr", "qpcr", "sequencing", "mass-spec",
  "spectrophotometer", "cell-culture", "bioreactor", "flow-cytometry",
  "centrifuge", "autoclave", "lyophilizer", "liquid-handler", "plate-reader",
  "microscopy", "balance",
]);

export class DiagnosticEngine {
  diagnose(state: KernelState): DiagnosticResult {
    const checks: DiagnosticCheck[] = [];

    // ── Agent checks ────────────────────────────────────────────

    checks.push({
      name: "Agent started",
      category: "agent",
      status: state.agentStarted ? "pass" : "fail",
      message: state.agentStarted ? "Kernel agent is running" : "Kernel agent is not started",
      fix: state.agentStarted ? undefined : "Call kernelAgent.start() after creating the agent",
    });

    checks.push({
      name: "Broker registration",
      category: "agent",
      status: state.agentRegistered ? "pass" : "fail",
      message: state.agentRegistered ? "Capabilities registered with broker" : "Not registered with broker",
      fix: state.agentRegistered ? undefined : "Call brokerAgent.registerKernelCapabilities(kernelAgent.id, { kernelId, capabilities, reputation })",
    });

    checks.push({
      name: "Wallet configured",
      category: "agent",
      status: state.walletAddress ? "pass" : "warn",
      message: state.walletAddress ? `Wallet: ${state.walletAddress.slice(0, 10)}...` : "No wallet configured",
      fix: state.walletAddress ? undefined : "Set KERNEL_PRIVATE_KEY env var or pass privateKey to KernelAgent constructor",
    });

    if (state.walletBalance !== undefined) {
      const balance = parseFloat(state.walletBalance);
      checks.push({
        name: "Wallet balance",
        category: "agent",
        status: balance > 0 ? "pass" : "warn",
        message: balance > 0 ? `Balance: ${state.walletBalance}` : "Wallet has zero balance",
        fix: balance > 0 ? undefined : "Fund wallet with ETH (for gas) and USDC (for operator bonds)",
      });
    }

    // ── Capability checks ───────────────────────────────────────

    if (state.capabilities.length === 0) {
      checks.push({
        name: "Capabilities defined",
        category: "capability",
        status: "fail",
        message: "No capabilities defined",
        fix: "Define at least one capability with a valid BuiltinCapabilityType",
      });
    } else {
      for (const cap of state.capabilities) {
        const validType = VALID_CAPABILITY_TYPES.has(cap.type);
        checks.push({
          name: `Capability type: ${cap.type}`,
          category: "capability",
          status: validType ? "pass" : "fail",
          message: validType ? `Valid capability type: ${cap.type}` : `Unknown capability type: ${cap.type}`,
          fix: validType ? undefined : `Use one of the 44 built-in types. Check @pcc/spec BuiltinCapabilityType.`,
        });

        if (cap.materials.length === 0) {
          checks.push({
            name: `Materials for ${cap.type}`,
            category: "capability",
            status: "warn",
            message: `No materials listed for ${cap.type}`,
            fix: "Add at least one material to the capability's materials array",
          });
        }

        const baseCost = parseFloat(cap.pricing.baseCost);
        const minimum = parseFloat(cap.pricing.minimum);
        if (isNaN(baseCost) || isNaN(minimum)) {
          checks.push({
            name: `Pricing for ${cap.type}`,
            category: "capability",
            status: "fail",
            message: `Invalid pricing for ${cap.type}: baseCost=${cap.pricing.baseCost}, minimum=${cap.pricing.minimum}`,
            fix: "Pricing values must be valid decimal strings (e.g., '25.00')",
          });
        }
      }
    }

    // ── Adapter checks ──────────────────────────────────────────

    if (state.adapters.length === 0) {
      checks.push({
        name: "Adapters configured",
        category: "adapter",
        status: "fail",
        message: "No device adapters configured",
        fix: "Create at least one MachineAdapter to wrap your device's API",
      });
    }

    const hasMachine = state.adapters.some(a => a.type === "machine");
    const hasSensor = state.adapters.some(a => a.type === "sensor");
    const hasCamera = state.adapters.some(a => a.type === "camera");
    const maxTier = Math.max(...state.capabilities.flatMap(c => c.assuranceTiers), 0);

    if (!hasMachine) {
      checks.push({
        name: "Machine adapter",
        category: "adapter",
        status: "fail",
        message: "No machine adapter found",
        fix: "Create a MachineAdapter that wraps your device's API (status, execute, progress, evidence)",
      });
    }

    if (maxTier >= 1 && !hasSensor) {
      checks.push({
        name: "Sensor adapter for Tier 1+",
        category: "adapter",
        status: "warn",
        message: "Assurance Tier 1+ requires sensor adapter but none found",
        fix: "Add a SensorAdapter (power/temperature/vibration) for evidence collection at Tier 1+",
      });
    }

    if (maxTier >= 2 && !hasCamera) {
      checks.push({
        name: "Camera adapter for Tier 2+",
        category: "adapter",
        status: "warn",
        message: "Assurance Tier 2+ requires camera adapter but none found",
        fix: "Add a CameraAdapter for QC inspection at Tier 2+",
      });
    }

    for (const adapter of state.adapters) {
      if (adapter.status === "error" || adapter.status === "offline") {
        checks.push({
          name: `Adapter ${adapter.id} status`,
          category: "adapter",
          status: "fail",
          message: `Adapter ${adapter.id} is ${adapter.status}`,
          fix: `Check the device at the configured connection string. Verify the device is powered on and reachable.`,
        });
      }

      if (adapter.errorCount > 5) {
        checks.push({
          name: `Adapter ${adapter.id} errors`,
          category: "adapter",
          status: "warn",
          message: `Adapter ${adapter.id} has ${adapter.errorCount} errors`,
          fix: "Check device logs. Common causes: network timeout, API auth expired, device in maintenance mode.",
        });
      }
    }

    // ── Evidence checks ─────────────────────────────────────────

    if (state.completedJobs > 0 && state.evidenceBundles === 0) {
      checks.push({
        name: "Evidence collection",
        category: "evidence",
        status: "fail",
        message: `${state.completedJobs} jobs completed but no evidence bundles generated`,
        fix: "Verify EvidenceEmitter is wired to adapters. Call emitter.registerStep() before execution and emitter.finalizeBundle() after.",
      });
    } else if (state.evidenceBundles > 0) {
      checks.push({
        name: "Evidence collection",
        category: "evidence",
        status: "pass",
        message: `${state.evidenceBundles} evidence bundles generated`,
      });
    }

    // ── Network checks ──────────────────────────────────────────

    checks.push({
      name: "Network connectivity",
      category: "network",
      status: state.networkConnected ? "pass" : "fail",
      message: state.networkConnected ? "Connected to A2A network" : "Not connected to network",
      fix: state.networkConnected ? undefined : "Check gateway URL and ensure NetworkTransport.connect() succeeded. Gateway must be reachable at the configured URL.",
    });

    if (state.gatewayUrl) {
      checks.push({
        name: "Gateway reachable",
        category: "network",
        status: state.gatewayReachable ? "pass" : "fail",
        message: state.gatewayReachable
          ? `Gateway reachable at ${state.gatewayUrl}`
          : `Gateway unreachable at ${state.gatewayUrl}`,
        fix: state.gatewayReachable ? undefined : "Verify the gateway is running. Check URL, port, and firewall rules.",
      });
    }

    // ── Settlement checks ───────────────────────────────────────

    if (state.completedJobs > 0 && state.escrowMappings === 0) {
      checks.push({
        name: "Escrow mappings",
        category: "settlement",
        status: "warn",
        message: "Jobs completed but no escrow mappings registered",
        fix: "Call kernelAgent.registerEscrowMapping(jobId, escrowAddress, milestoneIndex) to enable auto-settlement",
      });
    }

    if (state.pendingSettlements > 10) {
      checks.push({
        name: "Pending settlements",
        category: "settlement",
        status: "warn",
        message: `${state.pendingSettlements} settlements pending — possible batch flush issue`,
        fix: "Check gateway /api/settlement/status. Trigger manual flush: POST /api/settlement/flush",
      });
    }

    // ── Recent errors ───────────────────────────────────────────

    if (state.errors.length > 0) {
      const recentErrors = state.errors.slice(-3);
      for (const err of recentErrors) {
        checks.push({
          name: `Error from ${err.source}`,
          category: "adapter",
          status: "fail",
          message: `[${err.timestamp}] ${err.message}`,
        });
      }
    }

    // ── Compile result ──────────────────────────────────────────

    const passCount = checks.filter(c => c.status === "pass").length;
    const failCount = checks.filter(c => c.status === "fail").length;
    const warnCount = checks.filter(c => c.status === "warn").length;

    let summary: string;
    if (failCount === 0 && warnCount === 0) {
      summary = `All ${passCount} checks passed. Kernel is healthy and ready for jobs.`;
    } else if (failCount === 0) {
      summary = `${passCount} passed, ${warnCount} warnings. Kernel is functional but could be improved.`;
    } else {
      summary = `${failCount} failures, ${warnCount} warnings, ${passCount} passed. Fix failures before accepting jobs.`;
    }

    return {
      kernelId: state.kernelId,
      timestamp: new Date().toISOString(),
      checks,
      passCount,
      failCount,
      warnCount,
      summary,
    };
  }
}
