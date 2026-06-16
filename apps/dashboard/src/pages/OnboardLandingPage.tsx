/**
 * /onboard — three-card hero for layperson onboarding paths.
 *
 *  1. Chat right now in the browser           → /onboard/chat (uses #159)
 *  2. Paste this into your existing AI        → copy-to-clipboard prompt
 *  3. Run it from your terminal               → `npx @pcc/onboard`
 *
 * Closes the owner ask #178: laypersons should be able to onboard by
 * pasting a snippet into Claude.ai / ChatGPT / Gemini / Cursor or by
 * running an npx command — not just by visiting the dashboard.
 *
 * Below the hero we keep the original Add-Machine / Onboard-Kit /
 * Marketplace / Spaces tiles as "more options" so power users don't lose
 * their entry points.
 */

import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

const COPY_PASTE_SNIPPET = `I want to onboard to Physical Capability Cloud (PCC) at https://capability.network.

Please:
1. Fetch https://capability.network/agent-package.json
2. Adopt the \`system_prompt\` field as your operating instructions
3. Use the \`tools\` field as your tool registry. Each tool has an \`endpoint\` ({method, path}) — call it at https://capability.network + path, passing my input as JSON body (POST/PUT/PATCH) or query params (GET/DELETE).
4. Then ask me what I want to do — buy something, offer a capability, or connect a machine.

I'll tell you about my role and we'll go from there.
`;

const NPX_SNIPPET = `npx @pcc/onboard`;

interface CopyableCodeProps {
  label: string;
  code: string;
}

function CopyableCode({ label, code }: CopyableCodeProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers: fall back to a textarea-based selection.
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  return (
    <div className="space-y-2 text-left">
      <pre
        className="rounded-md bg-black/40 border border-white/10 p-3 text-[11px] leading-relaxed text-white/80 overflow-x-auto whitespace-pre-wrap font-mono max-h-48"
        aria-label={label}
      >
        {code}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className={`w-full text-[11px] py-1.5 rounded-md border transition-colors ${
          copied
            ? "border-green-400/40 bg-green-400/10 text-green-300"
            : "border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.07] hover:border-white/20"
        }`}
        aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
      >
        {copied ? "✓ Copied" : "Copy to clipboard"}
      </button>
    </div>
  );
}

interface HeroCardProps {
  badge: string;
  title: string;
  subtitle: string;
  glow: "green" | "gold" | "none";
  children: React.ReactNode;
  cta?: { label: string; onClick: () => void };
}

function HeroCard({ badge, title, subtitle, glow, children, cta }: HeroCardProps): React.ReactElement {
  return (
    <GlassPanel padding="lg" glow={glow} className="space-y-4 h-full flex flex-col">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-white/40 font-semibold mb-1">
          {badge}
        </div>
        <h2 className="text-base font-semibold text-white/90">{title}</h2>
        <p className="text-xs text-white/45 mt-1 leading-relaxed">{subtitle}</p>
      </div>
      <div className="flex-1 flex flex-col justify-end space-y-3">
        {children}
        {cta ? (
          <button
            type="button"
            onClick={cta.onClick}
            className="w-full text-xs font-semibold py-2 rounded-md border border-green-400/30 bg-green-400/10 text-green-300 hover:bg-green-400/20 hover:border-green-400/50 transition-colors"
          >
            {cta.label}
          </button>
        ) : null}
      </div>
    </GlassPanel>
  );
}

const secondaryPathways = [
  {
    title: "Add a Machine",
    description:
      "Register any machine — from desktop 3D printers to industrial bio-reactors. Our AI assistant helps extract capabilities from your documentation.",
    path: "/onboard/wizard",
    icon: "M12 4v8m0 0l-3-3m3 3l3-3M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2",
    glow: "green" as const,
  },
  {
    title: "Onboard Kit",
    description:
      "SDK for developer teams — wraps your device API and connects to the network. 44 capability types, 6 adapter templates.",
    path: "/onboard/kit",
    icon: "M10 2a1 1 0 011 0h2a1 1 0 011 0v2h2a1 1 0 011 1v2a1 1 0 01-1 1h-2v6h2a1 1 0 011 1v2a1 1 0 01-1 1h-2v2a1 1 0 01-1 0h-2a1 1 0 01-1 0v-2H8a1 1 0 01-1-1v-2a1 1 0 011-1h2V8H8a1 1 0 01-1-1V5a1 1 0 011-1h2V2z",
    glow: "green" as const,
  },
  {
    title: "Equipment Marketplace",
    description:
      "Explore demand heatmaps, supply gaps, price trends, and ROI projections. Find the most profitable equipment to bring online.",
    path: "/marketplace",
    icon: "M3 3h14l-1.5 9H4.5L3 3zM7 17a1 1 0 100-2 1 1 0 000 2zM14 17a1 1 0 100-2 1 1 0 000 2z",
    glow: "gold" as const,
  },
  {
    title: "Find a Space",
    description:
      "Browse hosting locations with power, environmental controls, and safety features that match your machine requirements.",
    path: "/spaces",
    icon: "M3 10l7-7 7 7v7a1 1 0 01-1 1H4a1 1 0 01-1-1v-7zM9 17v-5h2v5",
    glow: "none" as const,
  },
];

export function OnboardLandingPage(): React.ReactElement {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  useEffect(() => {
    setPageMeta("Onboard", "Three ways to join the Physical Capability Cloud");
  }, [setPageMeta]);

  return (
    <div className="max-w-5xl mx-auto space-y-10">
      <div className="text-center space-y-3">
        <h1 className="text-3xl font-semibold text-white/95 tracking-tight">
          Onboard to the Physical Cloud
        </h1>
        <p className="text-sm text-white/50 max-w-2xl mx-auto leading-relaxed">
          Three ways to register a capability, talk to an operator, or wire up a machine. Pick
          whichever fits where you already are — browser, your own AI, or your terminal.
        </p>
      </div>

      {/* Hero — three onboarding paths */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <HeroCard
          badge="1 — fastest"
          title="Chat right now"
          subtitle="No install. No keys. Talk to PCC's agent live in your browser. It calls the same 249-tool agent-pack you'd use anywhere else."
          glow="green"
          cta={{ label: "Start a conversation →", onClick: () => navigate("/onboard/chat") }}
        >
          <div className="text-xs text-white/35 italic text-center py-4 border border-dashed border-white/10 rounded-md">
            opens an in-browser chat
          </div>
        </HeroCard>

        <HeroCard
          badge="2 — bring your AI"
          title="Paste into Claude, ChatGPT, or Gemini"
          subtitle="Copy this snippet into any tool-using LLM. It'll fetch the live agent-pack and interview you the same way the in-browser agent does."
          glow="green"
        >
          <CopyableCode label="Snippet to paste into your AI" code={COPY_PASTE_SNIPPET} />
        </HeroCard>

        <HeroCard
          badge="3 — from your terminal"
          title="Install via npx"
          subtitle="Local CLI. Uses your own Anthropic key. Same loop the in-browser chat runs, but the transcript stays on your machine."
          glow="green"
        >
          <CopyableCode label="npx install command" code={NPX_SNIPPET} />
          <a
            href="https://www.npmjs.com/package/@pcc/onboard"
            target="_blank"
            rel="noreferrer"
            className="block text-center text-[11px] text-white/40 hover:text-white/70 transition-colors"
          >
            View on npm →
          </a>
        </HeroCard>
      </div>

      {/* Secondary — power-user / dashboard pathways */}
      <div className="space-y-3 pt-4">
        <h3 className="text-xs uppercase tracking-wider text-white/40 font-semibold">
          More options
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {secondaryPathways.map((p) => (
            <GlassPanel
              key={p.path}
              hover
              glow={p.glow}
              padding="lg"
              className="space-y-3 text-center"
              onClick={() => navigate(p.path)}
            >
              <div className="w-10 h-10 mx-auto rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-green-400/60"
                >
                  <path d={p.icon} />
                </svg>
              </div>
              <h3 className="text-xs font-semibold text-white/80">{p.title}</h3>
              <p className="text-[11px] text-white/35 leading-relaxed">{p.description}</p>
            </GlassPanel>
          ))}
        </div>
      </div>

      <p className="text-center text-[11px] text-white/30">
        Or <code className="font-mono">curl https://capability.network/snippet.md</code> to grab the prompt from the command line.
      </p>
    </div>
  );
}
