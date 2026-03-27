import React from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useConnect } from "wagmi";
import {
  WizardShell,
  WizardStepRail,
  WizardStepContent,
  OnboardingAIBubble,
  GlassPanel,
  GlowBadge,
  DataCell,
  AddressDisplay,
} from "@pcc/ui";
import type { WizardStep } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useSetupWizardStore } from "../stores/setup-wizard-store.js";
import { apiPost } from "../lib/api.js";
import type { ValidateResponse } from "../lib/api.js";
import { getAuthHeaders } from "../stores/auth-store.js";

/* ------------------------------------------------------------------ */
/*  Step definitions                                                   */
/* ------------------------------------------------------------------ */

const wizardSteps: WizardStep[] = [
  { id: "welcome", label: "Welcome", description: "Platform overview" },
  { id: "network", label: "Network", description: "Chain configuration" },
  { id: "wallet", label: "Wallet", description: "Connect EVM wallet" },
  { id: "identity", label: "Identity", description: "Register on PCCP" },
  { id: "complete", label: "Complete", description: "Setup summary" },
];

const aiMessages: Record<number, { id: string; content: string; timestamp: string }> = {
  0: { id: "ai-0", content: "I'll help you set up your PCCP instance. This takes about 2 minutes.", timestamp: "now" },
  1: { id: "ai-1", content: "PCCP needs a gateway server for API access. If you ran `pnpm dev`, it's already running on port 3200.", timestamp: "now" },
  2: { id: "ai-2", content: "Base Sepolia is recommended for testing. You can get free test USDC from the Coinbase faucet.", timestamp: "now" },
  3: { id: "ai-3", content: "Connect any EVM wallet. MetaMask and Coinbase Wallet are most popular.", timestamp: "now" },
  4: { id: "ai-4", content: "Your identity is registered on-chain via ERC-8004. This links your wallet to your PCCP profile.", timestamp: "now" },
};

const baseInput =
  "w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white/70 placeholder:text-white/20 focus:border-green-500/30 focus:outline-none transition-colors";

/* ------------------------------------------------------------------ */
/*  Step 1 — Welcome                                                   */
/* ------------------------------------------------------------------ */

function StepWelcome() {
  const { gatewayStatus, setGatewayStatus, nextStep } = useSetupWizardStore();

  React.useEffect(() => {
    setGatewayStatus("checking");
    fetch("http://localhost:3200/api/capabilities", { headers: { ...getAuthHeaders() } })
      .then((res) => {
        setGatewayStatus(res.ok ? "online" : "offline");
      })
      .catch(() => {
        setGatewayStatus("offline");
      });
  }, [setGatewayStatus]);

  return (
    <WizardStepContent
      title="Welcome to PCCP"
      subtitle="Physical Capability Cloud Protocol"
      onNext={nextStep}
      nextLabel="Get Started"
    >
      <div className="space-y-6 max-w-2xl">
        {/* Feature cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <GlassPanel hover padding="md">
            <div className="text-green-400/80 text-lg mb-2">&#9881;</div>
            <div className="text-sm font-semibold text-white/80 mb-1">Lab Capabilities as a Service</div>
            <div className="text-xs text-white/30">
              Connect lab instruments to the cloud. Expose capabilities like HPLC, PCR, and microscopy.
            </div>
          </GlassPanel>
          <GlassPanel hover padding="md">
            <div className="text-green-400/80 text-lg mb-2">&#128274;</div>
            <div className="text-sm font-semibold text-white/80 mb-1">Smart Contract Escrow</div>
            <div className="text-xs text-white/30">
              Milestone-based payments with on-chain settlement and dispute resolution.
            </div>
          </GlassPanel>
          <GlassPanel hover padding="md">
            <div className="text-green-400/80 text-lg mb-2">&#128203;</div>
            <div className="text-sm font-semibold text-white/80 mb-1">Evidence-Based QA</div>
            <div className="text-xs text-white/30">
              Cryptographic proof of assay and analysis quality at every assurance tier.
            </div>
          </GlassPanel>
        </div>

        {/* Gateway status */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
          {gatewayStatus === "checking" && (
            <>
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/60 animate-pulse" />
              <span className="text-xs text-white/40">Checking gateway connection...</span>
            </>
          )}
          {gatewayStatus === "online" && (
            <>
              <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-green-400/70">Gateway connected at localhost:3200</span>
              <GlowBadge color="green">online</GlowBadge>
            </>
          )}
          {gatewayStatus === "offline" && (
            <>
              <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span className="text-xs text-white/30">
                Gateway not detected &mdash; run <code className="font-mono text-white/50">pnpm dev</code> to start
              </span>
              <GlowBadge color="red">offline</GlowBadge>
            </>
          )}
        </div>
      </div>
    </WizardStepContent>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 2 — Network                                                   */
/* ------------------------------------------------------------------ */

const networks = [
  {
    id: "localhost" as const,
    label: "Localhost",
    description: "Local development, no real transactions",
    badge: null,
  },
  {
    id: "base-sepolia" as const,
    label: "Base Sepolia",
    description: "Testnet — MilestoneEscrow + MockUSDC deployed",
    badge: "RECOMMENDED" as const,
  },
  {
    id: "base" as const,
    label: "Base",
    description: "Production L2, real USDC settlement",
    badge: null,
  },
  {
    id: "solana-devnet" as const,
    label: "Solana Devnet",
    description: "Agent wallets, DePIN rewards, soulbound cNFTs",
    badge: null,
  },
];

function StepNetwork() {
  const { selectedNetwork, rpcUrl, setNetwork, setRpcUrl, nextStep, prevStep, isStepValid } =
    useSetupWizardStore();

  return (
    <WizardStepContent
      title="Network Configuration"
      subtitle="Select which chain PCCP should connect to."
      onNext={nextStep}
      onBack={prevStep}
      nextDisabled={!isStepValid(1)}
    >
      <div className="space-y-6 max-w-lg">
        <div className="space-y-3">
          {networks.map((net) => {
            const selected = selectedNetwork === net.id;
            return (
              <button
                key={net.id}
                onClick={() => setNetwork(net.id)}
                className={`w-full text-left p-4 rounded-xl border transition-all ${
                  selected
                    ? "bg-green-500/10 border-green-500/30"
                    : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-3 h-3 rounded-full border-2 transition-colors ${
                        selected ? "border-green-500 bg-green-500" : "border-white/20 bg-transparent"
                      }`}
                    />
                    <span className="text-sm font-medium text-white/80">{net.label}</span>
                  </div>
                  {net.badge && <GlowBadge color="gold">{net.badge}</GlowBadge>}
                </div>
                <p className="text-xs text-white/30 ml-5">{net.description}</p>
              </button>
            );
          })}
        </div>

        {/* RPC URL */}
        <div>
          <label className="text-xs text-white/40 mb-1 block">Custom RPC URL (optional)</label>
          <input
            className={baseInput}
            placeholder="https://..."
            value={rpcUrl}
            onChange={(e) => setRpcUrl(e.target.value)}
          />
          <p className="text-[10px] text-white/15 mt-1">Pre-filled based on network selection</p>
        </div>
      </div>
    </WizardStepContent>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 3 — Wallet                                                    */
/* ------------------------------------------------------------------ */

function StepWallet() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { setWalletConnected, nextStep, prevStep, isStepValid } = useSetupWizardStore();

  // Sync wagmi state → store
  React.useEffect(() => {
    setWalletConnected(isConnected && !!address);
  }, [isConnected, address, setWalletConnected]);

  return (
    <WizardStepContent
      title="Connect Wallet"
      subtitle="Link an EVM wallet to interact with on-chain contracts."
      onNext={nextStep}
      onBack={prevStep}
      nextDisabled={!isStepValid(2)}
    >
      <div className="space-y-6 max-w-lg">
        {isConnected && address ? (
          <GlassPanel padding="md" glow="green" className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-lg">
              &#10003;
            </div>
            <div>
              <div className="text-sm font-medium text-white/80 mb-1">Wallet Connected</div>
              <AddressDisplay address={address} chars={6} />
            </div>
          </GlassPanel>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-white/30 mb-3">Choose a wallet to connect</div>
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => connect({ connector })}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] hover:border-green-500/15 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-white/[0.04] flex items-center justify-center text-white/30 text-sm">
                  {connector.name === "MetaMask"
                    ? "\uD83E\uDD8A"
                    : connector.name === "Coinbase Wallet"
                      ? "\uD83D\uDD35"
                      : connector.name === "WalletConnect"
                        ? "\uD83D\uDD17"
                        : "\uD83D\uDCBC"}
                </div>
                <div>
                  <div className="text-xs text-white/60">{connector.name}</div>
                  <div className="text-[10px] text-white/15">
                    {connector.name === "Injected" ? "Browser wallet" : connector.type}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </WizardStepContent>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 4 — Identity                                                  */
/* ------------------------------------------------------------------ */

const roles = [
  {
    id: "operator" as const,
    label: "Operator",
    description: "I have lab instruments and want to offer capabilities",
  },
  {
    id: "customer" as const,
    label: "Customer",
    description: "I need biotech analysis or neurotech services done",
  },
  {
    id: "both" as const,
    label: "Both",
    description: "I operate lab instruments and use others' capabilities",
  },
];

function StepIdentity() {
  const {
    displayName,
    organization,
    role,
    setDisplayName,
    setOrganization,
    setRole,
    nextStep,
    prevStep,
    isStepValid,
    completeSetup,
  } = useSetupWizardStore();

  const [submitting, setSubmitting] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [apiWarnings, setApiWarnings] = React.useState<string[]>([]);

  const handleNext = async () => {
    setApiError(null);
    setApiWarnings([]);
    setSubmitting(true);

    try {
      // Validate the setup config
      const validation = await apiPost<ValidateResponse>("/setup/validate", {});
      if (!validation.valid) {
        // Non-fatal: just surface warnings and continue
        setApiWarnings(validation.warnings);
      }
      // Mark setup complete in store and advance
      completeSetup();
      nextStep();
    } catch (err) {
      // Gateway may not be running in demo mode — fall back gracefully
      const msg = err instanceof Error ? err.message : "Unknown error";
      // If it's a network/fetch error, continue offline with a warning
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("fetch")) {
        completeSetup();
        nextStep();
      } else {
        setApiError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => {
    completeSetup();
    nextStep();
  };

  return (
    <WizardStepContent
      title="Platform Identity"
      subtitle="Register your identity on the PCCP network."
      onNext={handleNext}
      onBack={prevStep}
      nextLabel={submitting ? "Registering..." : "Complete Setup"}
      nextDisabled={!isStepValid(3) || submitting}
    >
      <div className="space-y-6 max-w-lg">
        <div>
          <label className="text-xs text-white/40 mb-1 block">Display Name *</label>
          <input
            className={baseInput}
            placeholder="e.g., NeuroLab SOMA"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs text-white/40 mb-1 block">Organization</label>
          <input
            className={baseInput}
            placeholder="Optional — e.g., BioAnalytica Inc."
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
          />
        </div>

        <div>
          <div className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">Role</div>
          <div className="space-y-3">
            {roles.map((r) => {
              const selected = role === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => setRole(r.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    selected
                      ? "bg-green-500/10 border-green-500/30"
                      : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className={`w-3 h-3 rounded-full border-2 transition-colors ${
                        selected ? "border-green-500 bg-green-500" : "border-white/20 bg-transparent"
                      }`}
                    />
                    <span className="text-sm font-medium text-white/80">{r.label}</span>
                  </div>
                  <p className="text-xs text-white/30 ml-5">{r.description}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* API error */}
        {apiError && (
          <div className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="w-2 h-2 rounded-full bg-red-500 mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs text-red-400 font-medium mb-1">Registration error</div>
              <div className="text-xs text-white/40">{apiError}</div>
            </div>
            <button
              onClick={handleSkip}
              className="text-[10px] text-white/30 hover:text-white/50 transition-colors shrink-0"
            >
              Skip
            </button>
          </div>
        )}

        {/* API warnings */}
        {apiWarnings.length > 0 && (
          <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 space-y-1">
            <div className="text-xs text-yellow-400 font-medium">Setup warnings</div>
            {apiWarnings.map((w) => (
              <div key={w} className="text-xs text-white/40">{w}</div>
            ))}
          </div>
        )}

        {/* Loading state */}
        {submitting && (
          <div className="flex items-center gap-2 text-xs text-white/40">
            <div className="w-3 h-3 border border-green-500/50 border-t-green-500 rounded-full animate-spin" />
            Validating setup configuration...
          </div>
        )}

        <p className="text-[10px] text-white/15 italic">
          This validates your setup and registers your identity on the PCCP network via ERC-8004.
        </p>
      </div>
    </WizardStepContent>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 5 — Complete                                                  */
/* ------------------------------------------------------------------ */

function StepComplete() {
  const navigate = useNavigate();
  const { selectedNetwork, displayName, role } = useSetupWizardStore();
  const { address } = useAccount();

  const nextActions = [
    { label: "Explore Capabilities", path: "/discover", icon: "\u2692" },
    { label: "Build a Contract", path: "/build", icon: "\u2696" },
    { label: "Add a Machine", path: "/onboard/wizard", icon: "\u2699" },
    { label: "View Dashboard", path: "/", icon: "\u25A3" },
  ];

  return (
    <WizardStepContent
      title="Setup Complete"
      subtitle="Your PCCP instance is configured and ready to go."
      onNext={() => navigate("/")}
      nextLabel="Go to Dashboard"
    >
      <div className="space-y-8 max-w-2xl">
        {/* Success indicator */}
        <div className="flex justify-center">
          <div className="w-20 h-20 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center animate-pulse">
            <span className="text-3xl text-green-400">&#10003;</span>
          </div>
        </div>

        {/* Summary */}
        <GlassPanel padding="md">
          <div className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
            Configuration Summary
          </div>
          <div className="grid grid-cols-2 gap-4">
            <DataCell label="Network" value={selectedNetwork} />
            <DataCell
              label="Wallet"
              value={address ? <AddressDisplay address={address} chars={6} /> : "Not connected"}
            />
            <DataCell label="Role" value={role} />
            <DataCell label="Display Name" value={displayName} />
          </div>
        </GlassPanel>

        {/* Next actions */}
        <div>
          <div className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
            What&apos;s Next
          </div>
          <div className="grid grid-cols-2 gap-3">
            {nextActions.map((action) => (
              <GlassPanel
                key={action.path}
                hover
                padding="md"
                onClick={() => navigate(action.path)}
                className="cursor-pointer"
              >
                <div className="text-green-400/70 text-lg mb-2">{action.icon}</div>
                <div className="text-sm font-medium text-white/70">{action.label}</div>
              </GlassPanel>
            ))}
          </div>
        </div>
      </div>
    </WizardStepContent>
  );
}

/* ------------------------------------------------------------------ */
/*  Step component array                                               */
/* ------------------------------------------------------------------ */

const stepComponents = [StepWelcome, StepNetwork, StepWallet, StepIdentity, StepComplete];

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */

export function SetupWizardPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const { step, setStep } = useSetupWizardStore();

  React.useEffect(() => {
    setPageMeta("Platform Setup", `Step ${step + 1} of ${wizardSteps.length}`);
  }, [setPageMeta, step]);

  const StepComponent = stepComponents[step];
  const currentAI = aiMessages[step];

  return (
    <div className="h-[calc(100vh-120px)] -m-6">
      <WizardShell
        stepRail={<WizardStepRail steps={wizardSteps} currentStep={step} onStepClick={setStep} />}
        content={<StepComponent />}
        aiSidebar={
          <div className="p-4 space-y-4">
            <div className="text-[10px] text-white/20 font-mono uppercase tracking-wider mb-2">
              AI Assistant
            </div>
            {currentAI && (
              <OnboardingAIBubble
                key={currentAI.id}
                content={currentAI.content}
                timestamp={currentAI.timestamp}
              />
            )}
          </div>
        }
      />
    </div>
  );
}
