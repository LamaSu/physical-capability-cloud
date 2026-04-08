import React, { useState } from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

// ── Section data ──────────────────────────────────────────────────

const STEPS = [
  {
    number: "01",
    title: "Define Capabilities",
    description: "Describe what your equipment can do — not the machine itself, but the capability it provides. 44 built-in types cover manufacturing, biotech, and logistics.",
    details: [
      "Choose from cnc-3axis, fdm, sla, hplc, liquid-handler, centrifuge, and 38 more",
      "Set materials, tolerances, work envelope dimensions",
      "Configure pricing: base cost + per-minute + per-gram + minimum",
      "Select assurance tiers (0-3) based on your evidence collection hardware",
    ],
    badge: "Required",
    badgeColor: "green" as const,
  },
  {
    number: "02",
    title: "Write Device Adapters",
    description: "Wrap your device's API into PCC's standard interface. Three adapter types depending on your equipment.",
    details: [
      "MachineAdapter — any device that runs jobs (getStatus, execute, getProgress, onEvidence)",
      "SensorAdapter — power, temperature, vibration monitoring (startRecording, stopRecording)",
      "CameraAdapter — vision/QC inspection (captureSnapshot, runInspection)",
      "Templates provided for HTTP REST, OPC-UA, Modbus TCP, and SiLA 2 protocols",
    ],
    badge: "Core",
    badgeColor: "teal" as const,
  },
  {
    number: "03",
    title: "Configure Shop Kernel",
    description: "The kernel is your runtime — it manages adapters, orchestrates job execution, and collects cryptographic evidence.",
    details: [
      "EvidenceEmitter collects sensor events into content-addressed bundles",
      "JobRunner coordinates: load program → start sensors → execute → inspect → finalize",
      "Optional IPFS archival via Helia for immutable evidence storage",
      "HTTP server for health checks and direct API access",
    ],
    badge: "Required",
    badgeColor: "green" as const,
  },
  {
    number: "04",
    title: "Create Kernel Agent",
    description: "The agent is your identity on the A2A network. It wraps your kernel and handles typed intents from users and brokers.",
    details: [
      "Automatically handles: request_quote, execute_job, cancel_job, job_status_query",
      "Wallet integration for signing messages and receiving payments",
      "Machine profiles for the contract builder's car-configurator pricing",
      "DID generation (did:pcc:kernel:your-kernel-id) for verifiable identity",
    ],
    badge: "Required",
    badgeColor: "green" as const,
  },
  {
    number: "05",
    title: "Connect & Register",
    description: "Connect to the PCC gateway and register your capabilities with the broker. Users can now discover your equipment.",
    details: [
      "In-process MessageBus for testing, WebSocket relay for production",
      "Broker registration makes your capabilities searchable across the network",
      "Agent card published: ID, role, wallet, capabilities, supported intents",
      "Auto-reconnect with message queuing (up to 100 messages while offline)",
    ],
    badge: "Final",
    badgeColor: "cyan" as const,
  },
];

const ADAPTER_PROTOCOLS = [
  { name: "HTTP / REST", description: "Any device with a web API (OctoPrint, custom controllers)", template: "GenericHttpAdapter", badgeColor: "green" as const, glow: "green" as const },
  { name: "OPC-UA", description: "Industrial machines — Siemens, FANUC, Haas, ABB, KUKA, Beckhoff", template: "OPCUAAdapter", badgeColor: "teal" as const, glow: "green" as const },
  { name: "Modbus TCP", description: "Sensors — power meters, temperature controllers, PLCs", template: "ModbusSensorAdapter", badgeColor: "cyan" as const, glow: "green" as const },
  { name: "SiLA 2", description: "Lab instruments — Hamilton, Tecan, Beckman liquid handlers", template: "SiLAAdapter", badgeColor: "gold" as const, glow: "gold" as const },
  { name: "MQTT", description: "IoT sensors and edge devices", template: "Custom adapter", badgeColor: "gray" as const, glow: "none" as const },
  { name: "Custom", description: "Serial, WebSocket, gRPC, or any programmatic interface", template: "MachineAdapter interface", badgeColor: "gray" as const, glow: "none" as const },
];

const ASSURANCE_TIERS = [
  { tier: 0, name: "None", evidence: "Execution events only", bond: "0%", challenge: "1 hour", badgeColor: "gray" as const, glow: "none" as const },
  { tier: 1, name: "Basic", evidence: "+ Sensor data (power, temperature)", bond: "5%", challenge: "4 hours", badgeColor: "green" as const, glow: "green" as const },
  { tier: 2, name: "Production", evidence: "+ Camera snapshots + CV inspection", bond: "15%", challenge: "24 hours", badgeColor: "gold" as const, glow: "gold" as const },
  { tier: 3, name: "Regulatory", evidence: "+ Encryption + ZK proofs + Bittensor consensus", bond: "25%", challenge: "72 hours", badgeColor: "red" as const, glow: "gold" as const },
];

const CAPABILITY_TYPES = {
  Manufacturing: [
    "cnc-3axis", "cnc-5axis", "fdm", "sla", "sls", "dmls", "lathe", "laser-cut",
    "waterjet", "edm-wire", "edm-sinker", "injection-mold", "sheet-metal-bend",
    "sheet-metal-punch", "welding-mig", "welding-tig", "welding-laser",
    "surface-grinding", "cylindrical-grinding", "polishing", "anodizing", "plating",
    "heat-treat", "cmm-inspection", "surface-profilometry", "xray-ct-inspection",
  ],
  Biotech: [
    "hplc", "gc-ms", "lc-ms", "pcr", "qpcr", "sequencing", "mass-spec",
    "spectrophotometer", "cell-culture", "bioreactor", "flow-cytometry",
    "centrifuge", "autoclave", "lyophilizer", "liquid-handler", "plate-reader",
    "microscopy", "balance",
  ],
  Logistics: ["courier-pickup", "courier-delivery"],
};

// ── Code snippet ────────────────────────────────────────────────

const QUICK_START_CODE = `import { quickStart } from "@pcc/onboard-kit";

const { kernelAgent, stop } = await quickStart({
  kernelId: "kernel_your_shop",
  name: "Your Workshop",
  location: { lat: 37.77, lng: -122.41 },
  capability: {
    type: "fdm",
    name: "Prusa MK4",
    materials: ["pla", "petg", "abs"],
    assuranceTiers: [0, 1],
    pricing: {
      baseCost: "5.00",
      perMinute: "0.10",
      minimum: "10.00",
    },
  },
});
// Your machine is now discoverable on the network`;

const SCAFFOLD_CODE = `# Generate a complete kernel project from config
npx pcc-onboard scaffold \\
  --config my-shop.json \\
  --output ./my-kernel

# Validates config, then generates:
#   src/adapters/       (device API wrappers)
#   src/capabilities.ts (network-advertised capabilities)
#   src/kernel.ts       (runtime entry point)
#   src/agent.ts        (A2A network agent)
#   src/__tests__/      (adapter tests)
#   .env.example        (credentials template)`;

// ── Component ───────────────────────────────────────────────────

export function OnboardKitPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [activeCapCategory, setActiveCapCategory] = useState<string>("Manufacturing");
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  React.useEffect(() => {
    setPageMeta("Onboard Kit", "SDK for teams to connect their equipment to the PCC network");
  }, [setPageMeta]);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedSnippet(id);
      setTimeout(() => setCopiedSnippet(null), 2000);
    });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-10 pb-16">

      {/* ── Hero ──────────────────────────────────────────────── */}
      <div className="text-center space-y-4 pt-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-400 text-xs font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
          @pcc/onboard-kit v0.1.0
        </div>
        <h1 className="text-3xl font-bold text-white/90">
          Connect Any Device to the Network
        </h1>
        <p className="text-sm text-white/40 max-w-2xl mx-auto leading-relaxed">
          Hand this package to your AI agent. It reads the instructions, wraps your device API,
          and your equipment becomes discoverable — accepting jobs, collecting cryptographic evidence,
          and receiving payment through milestone escrow.
        </p>
      </div>

      {/* ── Quick Start ──────────────────────────────────────── */}
      <GlassPanel padding="lg" glow="green" className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white/85">Quick Start</h2>
          <GlowBadge color="green">~20 lines of code</GlowBadge>
        </div>
        <p className="text-xs text-white/40">
          One function call creates adapters, kernel, agent, and evidence pipeline.
          Mock mode — no real hardware needed for testing.
        </p>
        <div className="relative">
          <pre className="bg-black/40 border border-white/[0.06] rounded-lg p-4 text-xs text-green-300/80 font-mono overflow-x-auto leading-relaxed">
            {QUICK_START_CODE}
          </pre>
          <button
            onClick={() => copyToClipboard(QUICK_START_CODE, "quickstart")}
            className="absolute top-2 right-2 px-2 py-1 text-[10px] rounded bg-white/[0.06] border border-white/[0.08] text-white/40 hover:text-white/70 hover:bg-white/[0.1] transition-colors"
          >
            {copiedSnippet === "quickstart" ? "Copied" : "Copy"}
          </button>
        </div>
      </GlassPanel>

      {/* ── Install ──────────────────────────────────────────── */}
      <GlassPanel padding="md" className="space-y-3">
        <h3 className="text-sm font-semibold text-white/70">Install</h3>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-black/40 border border-white/[0.06] rounded px-3 py-2 text-xs text-cyan-300/70 font-mono">
            pnpm add @pcc/spec @pcc/kernel @pcc/a2a @pcc/agent-runtime @pcc/agent-kernel @pcc/onboard-kit
          </code>
          <button
            onClick={() => copyToClipboard("pnpm add @pcc/spec @pcc/kernel @pcc/a2a @pcc/agent-runtime @pcc/agent-kernel @pcc/onboard-kit", "install")}
            className="shrink-0 px-2 py-2 text-[10px] rounded bg-white/[0.06] border border-white/[0.08] text-white/40 hover:text-white/70 transition-colors"
          >
            {copiedSnippet === "install" ? "Copied" : "Copy"}
          </button>
        </div>
      </GlassPanel>

      {/* ── Scaffolder ───────────────────────────────────────── */}
      <GlassPanel padding="lg" className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white/85">Scaffolder</h2>
          <GlowBadge color="teal">CLI tool</GlowBadge>
        </div>
        <p className="text-xs text-white/40">
          Provide a JSON config describing your devices and capabilities.
          The scaffolder generates a complete, buildable kernel project.
        </p>
        <div className="relative">
          <pre className="bg-black/40 border border-white/[0.06] rounded-lg p-4 text-xs text-cyan-300/80 font-mono overflow-x-auto leading-relaxed">
            {SCAFFOLD_CODE}
          </pre>
          <button
            onClick={() => copyToClipboard(SCAFFOLD_CODE, "scaffold")}
            className="absolute top-2 right-2 px-2 py-1 text-[10px] rounded bg-white/[0.06] border border-white/[0.08] text-white/40 hover:text-white/70 hover:bg-white/[0.1] transition-colors"
          >
            {copiedSnippet === "scaffold" ? "Copied" : "Copy"}
          </button>
        </div>
      </GlassPanel>

      {/* ── Integration Steps ────────────────────────────────── */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-white/85">Integration Steps</h2>
        <p className="text-xs text-white/40">
          From "I have a device with an API" to "live on the network accepting jobs"
        </p>
        <div className="space-y-2">
          {STEPS.map((step) => (
            <GlassPanel
              key={step.number}
              hover
              padding="md"
              className="cursor-pointer"
              onClick={() => setExpandedStep(expandedStep === step.number ? null : step.number)}
            >
              <div className="flex items-start gap-4">
                <div className="shrink-0 w-10 h-10 rounded-lg bg-teal-500/10 border border-teal-500/20 flex items-center justify-center">
                  <span className="text-sm font-bold text-teal-400/80">{step.number}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-white/80">{step.title}</h3>
                    <GlowBadge color={step.badgeColor}>{step.badge}</GlowBadge>
                  </div>
                  <p className="text-xs text-white/40 leading-relaxed">{step.description}</p>
                  {expandedStep === step.number && (
                    <ul className="mt-3 space-y-1.5">
                      {step.details.map((detail, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-white/50">
                          <span className="shrink-0 mt-1 w-1 h-1 rounded-full bg-teal-400/50" />
                          <span>{detail}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <svg
                  className={`shrink-0 w-4 h-4 text-white/20 transition-transform ${expandedStep === step.number ? "rotate-180" : ""}`}
                  viewBox="0 0 20 20" fill="currentColor"
                >
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </div>
            </GlassPanel>
          ))}
        </div>
      </div>

      {/* ── Supported Protocols ───────────────────────────────── */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-white/85">Adapter Templates</h2>
        <p className="text-xs text-white/40">
          Pre-built templates for common device protocols. Your AI agent uses these as a starting point.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {ADAPTER_PROTOCOLS.map((proto) => (
            <GlassPanel key={proto.name} padding="md" glow={proto.glow} className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white/80">{proto.name}</h3>
                <GlowBadge color={proto.badgeColor}>{proto.template}</GlowBadge>
              </div>
              <p className="text-xs text-white/35 leading-relaxed">{proto.description}</p>
            </GlassPanel>
          ))}
        </div>
      </div>

      {/* ── Capability Types ──────────────────────────────────── */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-white/85">44 Capability Types</h2>
        <div className="flex gap-2 mb-3">
          {Object.keys(CAPABILITY_TYPES).map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCapCategory(cat)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                activeCapCategory === cat
                  ? "bg-teal-500/15 border-teal-500/30 text-teal-400"
                  : "bg-white/[0.03] border-white/[0.08] text-white/40 hover:text-white/60"
              }`}
            >
              {cat} ({CAPABILITY_TYPES[cat as keyof typeof CAPABILITY_TYPES].length})
            </button>
          ))}
        </div>
        <GlassPanel padding="md">
          <div className="flex flex-wrap gap-2">
            {CAPABILITY_TYPES[activeCapCategory as keyof typeof CAPABILITY_TYPES].map((type) => (
              <span
                key={type}
                className="px-2.5 py-1 text-xs rounded-md bg-white/[0.04] border border-white/[0.08] text-white/50 font-mono"
              >
                {type}
              </span>
            ))}
          </div>
        </GlassPanel>
      </div>

      {/* ── Assurance Tiers ───────────────────────────────────── */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-white/85">Assurance Tiers</h2>
        <p className="text-xs text-white/40">
          Each tier adds more evidence collection, higher operator bonds, and longer challenge windows.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {ASSURANCE_TIERS.map((tier) => (
            <GlassPanel key={tier.tier} padding="md" glow={tier.glow} className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold text-white/20">{tier.tier}</span>
                <GlowBadge color={tier.badgeColor}>{tier.name}</GlowBadge>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-white/35">Evidence</span>
                  <span className="text-white/55">{tier.evidence}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/35">Bond</span>
                  <span className="text-white/55">{tier.bond}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/35">Challenge</span>
                  <span className="text-white/55">{tier.challenge}</span>
                </div>
              </div>
            </GlassPanel>
          ))}
        </div>
      </div>

      {/* ── Data Flow ─────────────────────────────────────────── */}
      <GlassPanel padding="lg" className="space-y-4">
        <h2 className="text-lg font-semibold text-white/85">Job Lifecycle</h2>
        <p className="text-xs text-white/40">
          Complete flow from discovery to payment
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { step: "Discover", desc: "User agent finds your capability via broker search", icon: "1" },
            { step: "Quote", desc: "Your kernel agent calculates price from capability + params", icon: "2" },
            { step: "Contract", desc: "User configures options, builds contract with pricing breakdown", icon: "3" },
            { step: "Fund Escrow", desc: "User locks USDC in MilestoneEscrow smart contract", icon: "4" },
            { step: "Execute", desc: "Your adapters run the job, sensors collect evidence", icon: "5" },
            { step: "Evidence", desc: "EvidenceEmitter bundles events, hashes, signs, archives to IPFS", icon: "6" },
            { step: "Verify", desc: "Verifier market attests evidence meets tier requirements", icon: "7" },
            { step: "Payment", desc: "Challenge window expires, USDC released to your wallet", icon: "8" },
          ].map((item) => (
            <div key={item.icon} className="flex items-start gap-2">
              <div className="shrink-0 w-6 h-6 rounded-full bg-teal-500/15 border border-teal-500/25 flex items-center justify-center">
                <span className="text-[10px] font-bold text-teal-400/70">{item.icon}</span>
              </div>
              <div>
                <div className="text-xs font-semibold text-white/70">{item.step}</div>
                <div className="text-[10px] text-white/30 leading-relaxed">{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* ── Agent Instructions CTA ────────────────────────────── */}
      <GlassPanel glow="green" padding="lg" className="text-center space-y-4">
        <h2 className="text-lg font-semibold text-white/85">For Your AI Agent</h2>
        <p className="text-xs text-white/40 max-w-xl mx-auto leading-relaxed">
          The package includes <code className="text-cyan-400/70">AGENT_INSTRUCTIONS.md</code> — an 800+ line
          document your AI agent reads to execute the entire onboarding autonomously.
          12 steps, 4 appendices, complete type reference, and troubleshooting guide.
        </p>
        <div className="flex items-center justify-center gap-3">
          <a
            href="https://capability.network/tree/main/packages/onboard-kit"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-cyan-500/15 border border-cyan-500/25 text-cyan-400 hover:bg-cyan-500/25 transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            View on GitHub
          </a>
          <button
            onClick={() => copyToClipboard("npx pcc-onboard scaffold --config my-shop.json --output ./my-kernel", "cta")}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-white/[0.06] border border-white/[0.08] text-white/60 hover:text-white/80 hover:bg-white/[0.1] transition-colors"
          >
            {copiedSnippet === "cta" ? "Copied" : "Copy scaffold command"}
          </button>
        </div>
      </GlassPanel>

      {/* ── Need Help? ────────────────────────────────────────── */}
      <GlassPanel padding="lg" className="space-y-3">
        <h2 className="text-lg font-semibold text-white/85">Need Help?</h2>
        <p className="text-xs text-white/40 leading-relaxed">
          If your device's protocol isn't covered by the templates, or you hit an issue during onboarding,
          our <span className="text-teal-400/70">PCC Support Agent</span> is on the network. It has complete
          knowledge of the platform architecture and can troubleshoot adapter issues, evidence collection
          problems, settlement failures, and network connectivity in real-time.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => window.location.href = "/agents"}
            className="px-3 py-1.5 text-xs rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400 hover:bg-teal-500/20 transition-colors"
          >
            Open Agent Chat
          </button>
          <button
            onClick={() => window.location.href = "/onboard/wizard"}
            className="px-3 py-1.5 text-xs rounded-lg bg-white/[0.04] border border-white/[0.08] text-white/50 hover:text-white/70 transition-colors"
          >
            Use Onboarding Wizard Instead
          </button>
        </div>
      </GlassPanel>
    </div>
  );
}
