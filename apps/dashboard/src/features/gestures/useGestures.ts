import { useCallback, useEffect, useRef } from "react";
import type { GestureEvent } from "./GestureRecognizer.js";
import { usePanelStore } from "../spatial/PanelStore.js";
import { useSpatialChatStore } from "../chat/ChatStore.js";

// ---------------------------------------------------------------------------
// useGestures — connects gesture events to panel actions
// ---------------------------------------------------------------------------

/** Find the panel whose bounding box contains the given normalized screen point */
function findPanelAtPoint(
  normalizedX: number,
  normalizedY: number,
): string | null {
  const screenX = normalizedX * window.innerWidth;
  const screenY = normalizedY * window.innerHeight;

  const panels = usePanelStore.getState().panels;
  let best: string | null = null;
  let bestZ = -1;

  for (const [id, panel] of panels) {
    if (panel.minimized) continue;
    const { x, y } = panel.position;
    const { w, h } = panel.size;
    if (
      screenX >= x &&
      screenX <= x + w &&
      screenY >= y &&
      screenY <= y + h &&
      panel.zIndex > bestZ
    ) {
      best = id;
      bestZ = panel.zIndex;
    }
  }
  return best;
}

export function useGestures() {
  const lastGestureRef = useRef<string>("none");
  const dragPanelRef = useRef<string | null>(null);
  const dragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const handleGesture = useCallback((event: GestureEvent) => {
    const { type, x, y } = event;
    const store = usePanelStore.getState();

    switch (type) {
      case "open_palm": {
        // Drag: if we have a drag target, move it
        if (dragPanelRef.current) {
          const screenX = x * window.innerWidth;
          const screenY = y * window.innerHeight;
          store.updatePosition(dragPanelRef.current, {
            x: screenX - dragOffsetRef.current.dx,
            y: screenY - dragOffsetRef.current.dy,
          });
        } else {
          // Start drag on the panel under hand
          const panelId = findPanelAtPoint(x, y);
          if (panelId) {
            const panel = store.panels.get(panelId);
            if (panel) {
              const screenX = x * window.innerWidth;
              const screenY = y * window.innerHeight;
              dragPanelRef.current = panelId;
              dragOffsetRef.current = {
                dx: screenX - panel.position.x,
                dy: screenY - panel.position.y,
              };
              store.bringToFront(panelId);
            }
          }
        }
        break;
      }

      case "fist": {
        // Bring to front the panel under the fist
        const panelId = findPanelAtPoint(x, y);
        if (panelId && lastGestureRef.current !== "fist") {
          store.bringToFront(panelId);
        }
        dragPanelRef.current = null;
        break;
      }

      case "flick": {
        // Close the panel under the flick
        const panelId = findPanelAtPoint(x, y);
        if (panelId) {
          store.closePanel(panelId);
        }
        dragPanelRef.current = null;
        break;
      }

      case "peace": {
        // Toggle chat sidebar
        if (lastGestureRef.current !== "peace") {
          useSpatialChatStore.getState().toggleSidebar();
        }
        dragPanelRef.current = null;
        break;
      }

      case "pinch": {
        // Resize: not implementing full resize via pinch for now
        // (would need two-hand tracking for intuitive UX)
        // Just bring panel to front
        const panelId = findPanelAtPoint(x, y);
        if (panelId) {
          store.bringToFront(panelId);
        }
        dragPanelRef.current = null;
        break;
      }

      default:
        // "none" — release drag
        dragPanelRef.current = null;
        break;
    }

    lastGestureRef.current = type;
  }, []);

  return { handleGesture };
}
