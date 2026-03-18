import React from "react";
import { useNavigate } from "react-router-dom";
import { GlassPanel } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

const pathways = [
  {
    title: "Add a Machine",
    description: "Register any machine — from desktop 3D printers to industrial bio-reactors. Our AI assistant will help extract capabilities from your documentation.",
    path: "/onboard/wizard",
    icon: "M12 4v8m0 0l-3-3m3 3l3-3M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2",
    glow: "green" as const,
  },
  {
    title: "Onboard Kit",
    description: "SDK package for AI agents. Hand this to your team's agent — it wraps your device API and connects to the network autonomously. 44 capability types, 6 adapter templates.",
    path: "/onboard/kit",
    icon: "M10 2a1 1 0 011 0h2a1 1 0 011 0v2h2a1 1 0 011 1v2a1 1 0 01-1 1h-2v6h2a1 1 0 011 1v2a1 1 0 01-1 1h-2v2a1 1 0 01-1 0h-2a1 1 0 01-1 0v-2H8a1 1 0 01-1-1v-2a1 1 0 011-1h2V8H8a1 1 0 01-1-1V5a1 1 0 011-1h2V2z",
    glow: "green" as const,
  },
  {
    title: "Equipment Marketplace",
    description: "Explore demand heatmaps, supply gaps, price trends, and ROI projections. Find the most profitable equipment to bring online.",
    path: "/marketplace",
    icon: "M3 3h14l-1.5 9H4.5L3 3zM7 17a1 1 0 100-2 1 1 0 000 2zM14 17a1 1 0 100-2 1 1 0 000 2z",
    glow: "gold" as const,
  },
  {
    title: "Find a Space",
    description: "Browse hosting locations with power, environmental controls, and safety features that match your machine requirements.",
    path: "/spaces",
    icon: "M3 10l7-7 7 7v7a1 1 0 01-1 1H4a1 1 0 01-1-1v-7zM9 17v-5h2v5",
    glow: "none" as const,
  },
];

export function OnboardLandingPage() {
  const navigate = useNavigate();
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Add Machine", "Onboard any machine to the PCCP network");
  }, [setPageMeta]);

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold text-white/90">Expand the Physical Cloud</h1>
        <p className="text-sm text-white/40">
          Every machine you onboard grows the network. Choose your path below.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {pathways.map((p) => (
          <GlassPanel
            key={p.path}
            hover
            glow={p.glow}
            padding="lg"
            className="space-y-4 text-center"
            onClick={() => navigate(p.path)}
          >
            <div className="w-12 h-12 mx-auto rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400/60">
                <path d={p.icon} />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-white/80">{p.title}</h3>
            <p className="text-xs text-white/35 leading-relaxed">{p.description}</p>
          </GlassPanel>
        ))}
      </div>
    </div>
  );
}
