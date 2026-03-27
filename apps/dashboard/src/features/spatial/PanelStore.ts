import { create } from "zustand";
import type { ComponentType } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelPosition {
  x: number;
  y: number;
}

export interface PanelSize {
  w: number;
  h: number;
}

export interface PanelState {
  id: string;
  title: string;
  /** Lazy loader that returns { default: ComponentType } */
  loader: () => Promise<{ default: ComponentType }>;
  position: PanelPosition;
  size: PanelSize;
  zIndex: number;
  minimized: boolean;
}

interface PanelStoreState {
  panels: Map<string, PanelState>;
  nextZIndex: number;

  openPanel: (
    id: string,
    title: string,
    loader: () => Promise<{ default: ComponentType }>,
    opts?: Partial<Pick<PanelState, "position" | "size">>,
  ) => void;
  closePanel: (id: string) => void;
  closeAll: () => void;
  bringToFront: (id: string) => void;
  updatePosition: (id: string, pos: PanelPosition) => void;
  updateSize: (id: string, size: PanelSize) => void;
  minimizePanel: (id: string) => void;
  restorePanel: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Cascade offset — each new panel staggers from the previous
// ---------------------------------------------------------------------------

const CASCADE_OFFSET = 30;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 500;

function cascadePosition(panelCount: number): PanelPosition {
  const offset = panelCount * CASCADE_OFFSET;
  return {
    x: 80 + (offset % 300),
    y: 60 + (offset % 200),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePanelStore = create<PanelStoreState>((set, get) => ({
  panels: new Map(),
  nextZIndex: 10,

  openPanel: (id, title, loader, opts) => {
    set((state) => {
      const panels = new Map(state.panels);

      // If panel already open, just bring it to front
      if (panels.has(id)) {
        const existing = panels.get(id)!;
        panels.set(id, { ...existing, minimized: false, zIndex: state.nextZIndex });
        return { panels, nextZIndex: state.nextZIndex + 1 };
      }

      const position = opts?.position ?? cascadePosition(panels.size);
      const size = opts?.size ?? { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };

      const panel: PanelState = {
        id,
        title,
        loader,
        position,
        size,
        zIndex: state.nextZIndex,
        minimized: false,
      };

      panels.set(id, panel);
      return { panels, nextZIndex: state.nextZIndex + 1 };
    });
  },

  closePanel: (id) => {
    set((state) => {
      const panels = new Map(state.panels);
      panels.delete(id);
      return { panels };
    });
  },

  closeAll: () => {
    set({ panels: new Map() });
  },

  bringToFront: (id) => {
    set((state) => {
      const panels = new Map(state.panels);
      const panel = panels.get(id);
      if (!panel) return state;
      panels.set(id, { ...panel, zIndex: state.nextZIndex });
      return { panels, nextZIndex: state.nextZIndex + 1 };
    });
  },

  updatePosition: (id, pos) => {
    set((state) => {
      const panels = new Map(state.panels);
      const panel = panels.get(id);
      if (!panel) return state;
      panels.set(id, { ...panel, position: pos });
      return { panels };
    });
  },

  updateSize: (id, size) => {
    set((state) => {
      const panels = new Map(state.panels);
      const panel = panels.get(id);
      if (!panel) return state;
      panels.set(id, { ...panel, size });
      return { panels };
    });
  },

  minimizePanel: (id) => {
    set((state) => {
      const panels = new Map(state.panels);
      const panel = panels.get(id);
      if (!panel) return state;
      panels.set(id, { ...panel, minimized: true });
      return { panels };
    });
  },

  restorePanel: (id) => {
    set((state) => {
      const panels = new Map(state.panels);
      const panel = panels.get(id);
      if (!panel) return state;
      panels.set(id, { ...panel, minimized: false, zIndex: state.nextZIndex });
      return { panels, nextZIndex: state.nextZIndex + 1 };
    });
  },
}));
