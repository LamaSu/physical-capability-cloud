import React, { useState } from "react";
import { useUIStore } from "../stores/ui-store.js";
import { GlassPanel, GlowBadge, DataCell, cn } from "@pcc/ui";

const AGENT_PACKAGE_URL_SUFFIX = "/agent-package.json";

const techBadges = [
  "Metaplex Core",
  "Meteora DLMM",
  "Lit Protocol",
  "Bittensor / POA Subnet",
  "Arkhai / Alkahest",
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

function FeedbackModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [type, setType] = useState<"bug" | "comment" | "difficulty" | "suggestion">("bug");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

  if (!open) return null;

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, message, page: window.location.pathname }),
      });
      if (res.ok) {
        setStatus("sent");
        setMessage("");
        setTimeout(() => { setStatus("idle"); onClose(); }, 1500);
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 rounded-xl border border-white/[0.08] bg-gray-900/95 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white">Report a Bug or Leave Feedback</h2>
          <p className="text-xs text-white/40">Found something weird? Having trouble? Let us know. All reports go directly to the dev team.</p>

          <div className="flex gap-2">
            {(["bug", "difficulty", "suggestion", "comment"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`px-3 py-1.5 text-xs rounded-lg border capitalize transition-all ${
                  type === t
                    ? "bg-teal-500/20 border-teal-500/40 text-teal-300"
                    : "border-white/[0.08] text-white/40 hover:text-white/60"
                }`}
              >
                {t === "bug" ? "Bug Report" : t === "difficulty" ? "Having Trouble" : t === "suggestion" ? "Suggestion" : "Comment"}
              </button>
            ))}
          </div>

          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              type === "bug" ? "Describe the bug: what happened, what you expected, and steps to reproduce..."
                : type === "difficulty" ? "What are you having trouble with? What were you trying to do?"
                : type === "suggestion" ? "What would you like to see improved or added?"
                : "Any comments or thoughts..."
            }
            rows={5}
            maxLength={5000}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-4 py-3 text-sm text-white/80 placeholder-white/25 outline-none focus:border-teal-500/40 transition-colors resize-none"
          />

          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/20">{message.length}/5000</span>
            <div className="flex gap-3">
              <button onClick={onClose} className="px-4 py-2 text-xs text-white/40 hover:text-white/60 transition-colors">Cancel</button>
              <button
                onClick={handleSubmit}
                disabled={!message.trim() || status === "sending"}
                className={cn(
                  "px-6 py-2 rounded-lg text-sm font-medium transition-all",
                  status === "sent"
                    ? "bg-green-500/20 text-green-400 border border-green-500/30"
                    : status === "error"
                    ? "bg-red-500/20 text-red-400 border border-red-500/30"
                    : "bg-teal-500 hover:bg-teal-400 text-white disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                {status === "sending" ? "Sending..." : status === "sent" ? "Submitted!" : status === "error" ? "Failed — retry?" : "Submit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentChatPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [copied, setCopied] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

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

          {/* Bug Report / Feedback Button */}
          <button
            onClick={() => setFeedbackOpen(true)}
            className={cn(
              "px-6 py-3 rounded-lg text-sm font-medium transition-all duration-200",
              "border-2 border-dashed border-white/20 text-white/50",
              "hover:border-teal-400/40 hover:text-teal-300 hover:bg-teal-500/5",
            )}
          >
            Report Bugs / Leave Feedback
          </button>
        </section>

        <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

        {/* Demo Videos */}
        <section className="space-y-6">
          <h2 className="text-2xl font-bold text-white text-center">Demo</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="aspect-video rounded-lg overflow-hidden border border-white/[0.06]">
              <iframe
                width="100%"
                height="100%"
                src="https://www.youtube.com/embed/MxWOh0DJhGE"
                title="PCCP Demo"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="w-full h-full"
              />
            </div>
            <div className="aspect-video rounded-lg overflow-hidden border border-white/[0.06]">
              <iframe
                width="100%"
                height="100%"
                src="https://www.youtube.com/embed/7Dxt_UkZZto"
                title="PCCP Technical Walkthrough"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="w-full h-full"
              />
            </div>
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
                  Arkhai/Alkahest escrow on Base Sepolia — demand attestation locks funds, arbiter validates evidence, releases on proof
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
                  Bittensor POA subnet miners verify evidence quality via 6-check gate + 5-dimension scoring
                </li>
                <li>
                  Yuma Consensus aggregates miner scores into Assurance Score (0-1.0)
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
