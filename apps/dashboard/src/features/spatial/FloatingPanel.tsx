import React, { Suspense, lazy, useCallback, useRef, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { PanelState } from "./PanelStore.js";
import { usePanelStore } from "./PanelStore.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;

// ---------------------------------------------------------------------------
// Loading fallback inside panels
// ---------------------------------------------------------------------------

function PanelLoader() {
  return (
    <div className="flex items-center justify-center h-full min-h-[120px]">
      <div className="animate-pulse text-emerald-400/60 text-sm tracking-wide">Loading...</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FloatingPanel
// ---------------------------------------------------------------------------

interface FloatingPanelProps {
  panel: PanelState;
}

export function FloatingPanel({ panel }: FloatingPanelProps) {
  const { closePanel, bringToFront, updatePosition, updateSize } = usePanelStore();

  // Lazy-load the page component
  const [LazyComponent, setLazyComponent] = useState<React.ComponentType | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    panel
      .loader()
      .then((mod) => {
        if (!cancelled) setLazyComponent(() => mod.default);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [panel.loader]);

  // ---- Drag state ----
  const dragRef = useRef<{ startX: number; startY: number; panelX: number; panelY: number } | null>(
    null,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  const handlePointerDownTitleBar = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      bringToFront(panel.id);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        panelX: panel.position.x,
        panelY: panel.position.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [panel.id, panel.position, bringToFront],
  );

  const handlePointerMoveTitleBar = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      updatePosition(panel.id, {
        x: dragRef.current.panelX + dx,
        y: dragRef.current.panelY + dy,
      });
    },
    [panel.id, updatePosition],
  );

  const handlePointerUpTitleBar = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ---- Resize state ----
  const resizeRef = useRef<{
    startX: number;
    startY: number;
    panelW: number;
    panelH: number;
  } | null>(null);

  const handlePointerDownResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      bringToFront(panel.id);
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        panelW: panel.size.w,
        panelH: panel.size.h,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [panel.id, panel.size, bringToFront],
  );

  const handlePointerMoveResize = useCallback(
    (e: React.PointerEvent) => {
      if (!resizeRef.current) return;
      const dx = e.clientX - resizeRef.current.startX;
      const dy = e.clientY - resizeRef.current.startY;
      const w = Math.max(MIN_WIDTH, resizeRef.current.panelW + dx);
      const h = Math.max(MIN_HEIGHT, resizeRef.current.panelH + dy);
      updateSize(panel.id, { w, h });
    },
    [panel.id, updateSize],
  );

  const handlePointerUpResize = useCallback(() => {
    resizeRef.current = null;
  }, []);

  // ---- Click to bring to front ----
  const handlePanelClick = useCallback(() => {
    bringToFront(panel.id);
  }, [panel.id, bringToFront]);

  if (panel.minimized) return null;

  return (
    <motion.div
      ref={panelRef}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.92 }}
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
      className="absolute select-none"
      style={{
        left: panel.position.x,
        top: panel.position.y,
        width: panel.size.w,
        height: panel.size.h,
        zIndex: panel.zIndex,
      }}
      onPointerDown={handlePanelClick}
    >
      {/* Glass card */}
      <div className="flex flex-col h-full rounded-2xl overflow-hidden bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] shadow-2xl shadow-black/40 ring-1 ring-white/[0.04]">
        {/* Title bar — draggable */}
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06] cursor-grab active:cursor-grabbing bg-white/[0.02] shrink-0"
          onPointerDown={handlePointerDownTitleBar}
          onPointerMove={handlePointerMoveTitleBar}
          onPointerUp={handlePointerUpTitleBar}
        >
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400/60" />
            <span className="text-xs font-medium text-white/70 tracking-wide select-none">
              {panel.title}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {/* Minimize button */}
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                usePanelStore.getState().minimizePanel(panel.id);
              }}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title="Minimize"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                className="text-white/40 hover:text-yellow-400/80"
              >
                <rect x="2" y="5.5" width="8" height="1" rx="0.5" fill="currentColor" />
              </svg>
            </button>
            {/* Close button */}
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                closePanel(panel.id);
              }}
              className="p-1 rounded hover:bg-white/10 transition-colors"
              title="Close"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                className="text-white/40 hover:text-red-400/80"
              >
                <path
                  d="M3 3L9 9M9 3L3 9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Content — scrollable */}
        <div className="flex-1 overflow-auto p-4 text-white/80 text-sm [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {loadError ? (
            <div className="text-red-400/70 text-xs">Failed to load panel: {loadError}</div>
          ) : LazyComponent ? (
            <Suspense fallback={<PanelLoader />}>
              <LazyComponent />
            </Suspense>
          ) : (
            <PanelLoader />
          )}
        </div>

        {/* Resize handle (bottom-right corner) */}
        <div
          className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize z-10"
          onPointerDown={handlePointerDownResize}
          onPointerMove={handlePointerMoveResize}
          onPointerUp={handlePointerUpResize}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            className="absolute bottom-1 right-1 text-white/20"
          >
            <path d="M12 2L2 12M12 6L6 12M12 10L10 12" stroke="currentColor" strokeWidth="1" />
          </svg>
        </div>
      </div>
    </motion.div>
  );
}
