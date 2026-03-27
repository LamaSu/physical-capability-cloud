# Spatial Chat-First Dashboard - Changelog

**Date**: 2026-03-26
**Author**: Claude Opus 4.6 (1M context)

## Summary

Built a spatial chat-first dashboard for PCC that replaces the traditional sidebar+pages layout with a full-screen dark canvas where floating UI panels materialize on demand from a chat interface. Added hand gesture control via webcam using MediaPipe Hands.

## Architecture

Three new feature modules under `apps/dashboard/src/features/`:

### 1. Spatial Panel System (`features/spatial/`)

- **PanelStore.ts** — Zustand store managing a `Map<id, PanelState>` of floating panels with z-index management, cascade positioning, minimize/restore, and drag/resize state
- **PanelRegistry.ts** — Maps 37 panel IDs to lazy-loaded page components with keyword arrays for natural language matching. Includes `findPanelByKeyword()` fuzzy matcher
- **FloatingPanel.tsx** — Individual floating window with glass-morphism styling, pointer-event-based drag (title bar) and resize (corner handle), lazy component loading, spring enter/exit animations via Framer Motion
- **PanelManager.tsx** — Renders all active panels via AnimatePresence, plus a MinimizedDock showing minimized panels as clickable chips

### 2. Chat Interface (`features/chat/`)

- **ChatStore.ts** — Zustand store for spatial chat messages (user + system) with sidebar toggle state
- **ChatEngine.ts** — Command parser supporting slash commands (`/open`, `/close`, `/close all`, `/help`, `/list`, `/minimize`, `/clear`) and natural language panel opening via keyword matching
- **ChatBar.tsx** — Fixed bottom bar with text input, send button, and sidebar toggle. Processes commands via ChatEngine and displays system responses
- **ChatSidebar.tsx** — Toggleable left sidebar showing conversation history with slide-in animation. System messages with panelId are clickable to reopen panels

### 3. Hand Gesture Control (`features/gestures/`)

- **GestureRecognizer.ts** — Maps MediaPipe hand landmarks to 5 gesture types: pinch, open_palm (drag), fist (bring to front), peace (toggle sidebar), flick (close panel). Includes flick velocity detection with cooldown
- **HandTracker.tsx** — Loads MediaPipe Hands from CDN (avoids wasm bundling issues), manages webcam lifecycle, renders camera preview and gesture indicator. Opt-in via button
- **useGestures.ts** — React hook connecting gesture events to panel store actions. Finds panel under hand position using normalized screen coordinates

### 4. App Shell (`SpatialApp.tsx`)

- Full-screen dark canvas with particle background + subtle grid overlay
- Minimal top bar (PCC logo + mode toggle + wallet connect)
- Floating panel area spanning entire viewport
- Chat sidebar, chat bar, and hand tracker layered on top

## Files Created (12)

| File | Lines | Role |
|------|-------|------|
| `src/features/spatial/PanelStore.ts` | 133 | Zustand panel state management |
| `src/features/spatial/PanelRegistry.ts` | 269 | Panel ID to component mapping (37 panels) |
| `src/features/spatial/FloatingPanel.tsx` | 207 | Draggable/resizable glass-morphism panel |
| `src/features/spatial/PanelManager.tsx` | 47 | Renders all panels + minimized dock |
| `src/features/chat/ChatStore.ts` | 55 | Chat message state |
| `src/features/chat/ChatEngine.ts` | 127 | Command parser + NLP panel opener |
| `src/features/chat/ChatBar.tsx` | 88 | Bottom chat input bar |
| `src/features/chat/ChatSidebar.tsx` | 95 | Left conversation history |
| `src/features/gestures/GestureRecognizer.ts` | 128 | MediaPipe landmark to gesture mapper |
| `src/features/gestures/HandTracker.tsx` | 172 | MediaPipe Hands CDN loader + webcam |
| `src/features/gestures/useGestures.ts` | 99 | Gesture to panel action bridge |
| `src/SpatialApp.tsx` | 62 | Spatial app shell |

## Files Modified (3)

| File | Change |
|------|--------|
| `src/stores/ui-store.ts` | Added "spatial" to `InterfaceMode` union; set as default mode; changed `toggleMode` to cycle through 3 modes |
| `src/components/ModeToggle.tsx` | Updated to support 3 modes (Spatial/Agent Chat/Dashboard) with distinct colors (violet/teal/gray) |
| `src/App.tsx` | Imported SpatialApp; added `/spatial` direct route; added `interfaceMode === "spatial"` branch in Shell |

## Files NOT Modified

- No existing page components were modified (they render as-is inside floating panels)
- No existing stores were modified (PanelStore and ChatStore are new)
- No gateway routes were modified
- No package.json changes needed (MediaPipe loaded from CDN, Framer Motion/Zustand already installed)

## Visual Design

- **Background**: Pure black + tsparticles + 60px grid overlay at 3% opacity
- **Panels**: `bg-white/[0.04] backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl`
- **Title bar**: Green dot indicator + panel name + minimize/close buttons
- **Chat bar**: `bg-black/60 backdrop-blur-md border-t border-white/[0.06]`
- **Chat input**: `bg-white/[0.04]` with emerald focus ring
- **Emerald accent**: Send button, gesture indicator, focused panel glow
- **All animations**: Framer Motion spring physics (stiffness: 350, damping: 30)

## Verification

- TypeScript typecheck: PASS (0 errors)
- Vite build: PASS (7.92s, all chunks generated)
- All existing routes preserved via legacy dashboard mode
- Default mode is now "spatial" (users can cycle to agent/dashboard via ModeToggle)
- Direct URL `/spatial` always loads the spatial interface regardless of mode setting

## Panel Registry (37 panels)

dashboard, discover, build, workflow, jobs, kernels, escrow, settlement, wallet, agents, settings, onboard, marketplace, spaces, operator, revenue, sensors, batches, batch-board, evidence, logs, logistics, orchestrator, protocols, protocol-builder, protocol-runs, subnet, depin, swf, ip, telemetry, traces, negotiate, negotiate-session, setup, device-builder, roi, agent-package, onboard-kit

## Gesture Mappings

| Gesture | Action |
|---------|--------|
| Open palm + move | Drag panel under hand |
| Fist | Bring panel to front |
| Flick (fast wave) | Close panel under hand |
| Peace sign | Toggle chat sidebar |
| Pinch | Bring panel to front (resize reserved for future two-hand tracking) |
