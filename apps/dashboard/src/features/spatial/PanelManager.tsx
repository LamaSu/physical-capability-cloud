import React from "react";
import { AnimatePresence } from "framer-motion";
import { usePanelStore } from "./PanelStore.js";
import { FloatingPanel } from "./FloatingPanel.js";

// ---------------------------------------------------------------------------
// MinimizedDock — shows minimized panels as small chips at the bottom
// ---------------------------------------------------------------------------

function MinimizedDock() {
  const panels = usePanelStore((s) => s.panels);
  const restorePanel = usePanelStore((s) => s.restorePanel);

  const minimized = Array.from(panels.values()).filter((p) => p.minimized);
  if (minimized.length === 0) return null;

  return (
    <div className="fixed bottom-16 left-1/2 -translate-x-1/2 flex gap-2 z-[9999]">
      {minimized.map((p) => (
        <button
          key={p.id}
          onClick={() => restorePanel(p.id)}
          className="px-3 py-1.5 rounded-lg bg-white/[0.06] backdrop-blur-md border border-white/[0.08] text-white/60 text-xs hover:bg-white/[0.10] hover:text-white/80 transition-all"
        >
          {p.title}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PanelManager — renders all active floating panels
// ---------------------------------------------------------------------------

export function PanelManager() {
  const panels = usePanelStore((s) => s.panels);
  const activePanels = Array.from(panels.values()).filter((p) => !p.minimized);

  return (
    <>
      <AnimatePresence mode="popLayout">
        {activePanels.map((panel) => (
          <FloatingPanel key={panel.id} panel={panel} />
        ))}
      </AnimatePresence>
      <MinimizedDock />
    </>
  );
}
