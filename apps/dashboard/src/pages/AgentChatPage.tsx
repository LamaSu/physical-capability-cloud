import React, { useState } from "react";
import { useUIStore } from "../stores/ui-store.js";
import { GlassPanel, GlowBadge, DataCell, cn } from "@pcc/ui";

const AGENT_PACKAGE_URL_SUFFIX = "/agent-package.json";

const techBadges = [
  "Metaplex Core",
  "Meteora DLMM",
  "Lit Protocol",
  "Bittensor",
  "Helia/IPFS",
  "Base Sepolia",
  "Solana",
  "x402",
  "W3C DID",
  "ZK/Noir",
];

const codeExample = `// 1. Fetch the agent package
const pkg = await fetch("https://pcc-gateway-production.up.railway.app/agent-package.json").then(r => r.json());

// 2. Give your agent the tools
const response = await yourLLM.chat({
  system: pkg.system_prompt,
  tools: pkg.tools,
  message: "Find me an HPLC analysis lab"
});

// 3. Execute tool calls against PCC
for (const tool of response.tool_calls) {
  const endpoint = pkg.tools.find(t => t.name === tool.name).endpoint;
  const result = await fetch(endpoint.path, { method: endpoint.method, body: JSON.stringify(tool.input) });
  // Feed result back to your agent...
}`;

export function AgentChatPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [copied, setCopied] = useState(false);

  React.useEffect(() => {
    setPageMeta("PCC Network", "Verifiable on-chain skill wrapper for physical capabilities");
  }, [setPageMeta]);

  const handleCopy = async () => {
    const url = `${window.location.origin}${AGENT_PACKAGE_URL_SUFFIX}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto w-full px-6 py-12 space-y-16">

        {/* Hero */}
        <section className="text-center space-y-6">
          <h1 className="text-5xl font-bold tracking-tight text-white">
            Physical Capability Cloud
          </h1>
          <p className="text-xl text-white/60 max-w-2xl mx-auto">
            Verifiable on-chain skill wrapper for any physical capability
          </p>
          <div className="space-y-3">
            <button
              onClick={handleCopy}
              className={cn(
                "px-8 py-3 rounded-lg text-lg font-semibold transition-all duration-200",
                "bg-teal-500 hover:bg-teal-400 text-white shadow-[0_0_30px_rgba(20,184,166,0.3)]",
                "hover:shadow-[0_0_40px_rgba(20,184,166,0.5)]",
                copied && "bg-teal-400",
              )}
            >
              {copied ? "Copied!" : "Copy Agent Package URL"}
            </button>
            <p className="text-sm text-white/40">
              Feed this to your agent. 28 tools. Any LLM. No setup.
            </p>
          </div>
        </section>

        {/* How It Works */}
        <section className="space-y-6">
          <h2 className="text-2xl font-bold text-white text-center">How It Works</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

            {/* Agent Layer */}
            <GlassPanel padding="lg" className="space-y-4">
              <h3 className="text-lg font-semibold text-teal-300">Agent Layer</h3>
              <ul className="space-y-3 text-sm text-white/70 leading-relaxed">
                <li>
                  Agents fetch <code className="text-teal-300 bg-white/5 px-1 rounded">/agent-package.json</code> — one
                  file with system prompt + 28 tools + endpoint mappings
                </li>
                <li>
                  Tools map to REST endpoints: <code className="text-teal-300 bg-white/5 px-1 rounded">list_kernels</code>,{" "}
                  <code className="text-teal-300 bg-white/5 px-1 rounded">search_capabilities</code>,{" "}
                  <code className="text-teal-300 bg-white/5 px-1 rounded">build_contract</code>, etc.
                </li>
                <li>
                  A2A protocol: 27 typed intents (DiscoverCapabilities, RequestQuote, SubmitWorkflow, PaymentConfirmation)
                </li>
                <li>
                  Three agent roles: <strong className="text-white/90">UserAgent</strong> (discovers, negotiates),{" "}
                  <strong className="text-white/90">BrokerAgent</strong> (routes, escrows),{" "}
                  <strong className="text-white/90">KernelAgent</strong> (executes jobs)
                </li>
                <li>
                  Works with any LLM — Claude, GPT, Llama, custom. No vendor lock-in.
                </li>
              </ul>
            </GlassPanel>

            {/* Crypto Layer */}
            <GlassPanel padding="lg" className="space-y-4">
              <h3 className="text-lg font-semibold text-teal-300">Crypto Layer</h3>
              <ul className="space-y-3 text-sm text-white/70 leading-relaxed">
                <li>
                  Machine capabilities registered as soulbound NFTs (Metaplex Core + PermanentFreezeDelegate)
                </li>
                <li>
                  Real-time pricing via Meteora DLMM pools — operators deposit liquidity, requesters swap at market rate
                </li>
                <li>
                  MilestoneEscrow on Base Sepolia — funds locked per milestone, released on evidence, slashed on dispute
                </li>
                <li>
                  Payments: Solana USDC (SPL tokens) + EVM USDC (Base) + x402 micropayments
                </li>
                <li>
                  W3C DIDs (did:key Ed25519) for machine identity, Verifiable Credentials for capability proofs
                </li>
              </ul>
            </GlassPanel>

            {/* Verification Layer */}
            <GlassPanel padding="lg" className="space-y-4">
              <h3 className="text-lg font-semibold text-teal-300">Verification Layer</h3>
              <ul className="space-y-3 text-sm text-white/70 leading-relaxed">
                <li>
                  Evidence encrypted with Lit Protocol (AES-256-GCM + on-chain access conditions)
                </li>
                <li>
                  Stored on IPFS via Helia — content-addressed, immutable
                </li>
                <li>
                  Bittensor subnet miners verify evidence quality independently
                </li>
                <li>
                  Yuma Consensus aggregates miner scores into a single trust signal
                </li>
                <li>
                  ZK proofs (Noir circuits) for dispute resolution without revealing raw data
                </li>
                <li>
                  Assurance Tiers 0-3: self-reported, sensor-backed, third-party verified, ZK-proven with bonds
                </li>
              </ul>
            </GlassPanel>
          </div>
        </section>

        {/* The Stack */}
        <section className="space-y-6">
          <h2 className="text-2xl font-bold text-white text-center">The Stack</h2>
          <div className="flex flex-wrap justify-center gap-3">
            {techBadges.map((badge) => (
              <GlowBadge key={badge} color="teal">
                {badge}
              </GlowBadge>
            ))}
          </div>
        </section>

        {/* For Builders */}
        <section className="space-y-6">
          <h2 className="text-2xl font-bold text-white text-center">For Builders</h2>
          <GlassPanel padding="none" className="overflow-hidden">
            <pre className="p-6 text-sm text-teal-300/90 font-mono leading-relaxed overflow-x-auto">
              <code>{codeExample}</code>
            </pre>
          </GlassPanel>
        </section>

        {/* Footer */}
        <footer className="flex flex-col sm:flex-row items-center justify-center gap-6 pb-8 pt-4 border-t border-white/[0.06]">
          <a
            href="https://github.com/global-mysterysnailrevolution/physical-capability-cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-white/40 hover:text-white/70 transition-colors"
          >
            GitHub
          </a>
          <button
            onClick={() => useUIStore.getState().setMode("dashboard")}
            className={cn(
              "px-6 py-2 rounded-lg text-sm font-medium transition-all duration-200",
              "border border-teal-500/30 text-teal-300 hover:bg-teal-500/10",
            )}
          >
            Explore Dashboard
          </button>
        </footer>
      </div>
    </div>
  );
}
