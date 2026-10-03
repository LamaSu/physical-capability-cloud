import React, { useEffect, useCallback } from "react";
import { ParticleBackground } from "@pcc/ui";
import { PanelManager } from "./features/spatial/PanelManager.js";
import { ChatBar } from "./features/chat/ChatBar.js";
import { ChatSidebar } from "./features/chat/ChatSidebar.js";
import { HandTracker } from "./features/gestures/HandTracker.js";
import { ConnectWallet } from "./components/ConnectWallet.js";
import { ModeToggle } from "./components/ModeToggle.js";
import { trackEvent } from "./lib/telemetry.js";

// ---------------------------------------------------------------------------
// SpatialApp — full-screen dark canvas with floating panels + chat
//
// Replaces the traditional sidebar+pages layout. The entire screen is a void
// where panels materialize on demand from the chat bar at the bottom.
// ---------------------------------------------------------------------------

/**
 * useSpatialTelemetry — tracks panel opens, chat commands, and gesture usage
 * in the spatial interface so we know what users WANT (to improve the context pack).
 */
function useSpatialTelemetry() {
  // Track that the user loaded the spatial fallback UI
  useEffect(() => {
    trackEvent("spatial_app_loaded", { source: "web_fallback" });
  }, []);

  // Track panel opens
  const trackPanelOpen = useCallback((panelId: string) => {
    trackEvent("spatial_panel_open", { panelId });
  }, []);

  // Track chat commands
  const trackChatCommand = useCallback((command: string) => {
    trackEvent("spatial_chat_command", {
      command: command.slice(0, 100), // Truncate for privacy
      length: command.length,
    });
  }, []);

  // Track gesture toggle
  const trackGestureToggle = useCallback((enabled: boolean) => {
    trackEvent("spatial_gesture_toggle", { enabled });
  }, []);

  return { trackPanelOpen, trackChatCommand, trackGestureToggle };
}

export function SpatialApp() {
  // Initialize telemetry hooks (fires load event on mount)
  useSpatialTelemetry();

  return (
    <div data-shell="spatial" className="fixed inset-0 bg-black overflow-hidden">
      {/* Particle background */}
      <ParticleBackground />

      {/* Subtle grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      {/* Agent prompt banner */}

      {/* Top bar — minimal, just wallet + mode toggle */}
      <div className="absolute top-0 left-0 right-0 z-[9999] flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-3">
          <div className="text-sm font-bold tracking-wider text-white/20">PCC</div>
          <div className="text-[10px] text-emerald-500/40 font-mono uppercase tracking-widest">
            Spatial
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ModeToggle />
          <ConnectWallet />
        </div>
      </div>

      {/* Floating panel area — the entire viewport */}
      <div className="absolute inset-0 pt-10 pb-14">
        <PanelManager />
      </div>

      {/* Chat sidebar (toggleable) */}
      <ChatSidebar />

      {/* Chat bar (fixed bottom) */}
      <ChatBar />

      {/* Hand gesture tracker (bottom-right) */}
      <HandTracker />
    </div>
  );
}
