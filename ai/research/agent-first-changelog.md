# Agent-First Web Presence Rebuild

**Date**: 2026-03-26
**Status**: DONE
**Iterations**: 1 of 5 (clean first pass)

## Summary

Rebuilt PCC's web presence as agent-first. The main product is now a context pack that users copy into their AI. The web UI is a fallback with telemetry.

## Changes

### Created

1. **`packages/gateway/src/routes/context-pack.ts`** -- New route serving the complete agent context pack
   - `GET /agent-context-pack` -- Full markdown document (text/markdown) with all 130+ API endpoints, data types, workflow templates, role definitions, SSE streams, and deployed contract addresses. Dynamic `{baseUrl}` injection from request origin or `PCC_PUBLIC_URL` env var.
   - `GET /agent-context-pack.json` -- Structured JSON version for programmatic consumption. Contains endpoint groups, data type schemas, SSE stream definitions, contract addresses, and links.
   - Registered BEFORE auth gates (public endpoint, like well-known routes).
   - 5-minute cache with CORS `*` for cross-origin agent access.

### Rewritten

2. **`apps/dashboard/src/pages/LandingPage.tsx`** -- Complete rewrite, agent-first design
   - Hero: "Your Agent Is Your Interface" (large gradient text)
   - Subtitle explaining agent-first infrastructure
   - **Big Copy Button**: "Copy Agent Pack" -- fetches `/agent-context-pack` and copies to clipboard, with loading/copied/error states and glow animation
   - Fallback: copies the URL if content copy fails
   - "How It Works" section: 3 steps (Copy, Paste, Agent builds UI) with SVG icons
   - "What Your Agent Can Do" grid: 6 capability cards
   - "For Developers" section: links to agent-package.json, ERC-8004, GitHub, API docs
   - Footer: "Or try the limited web dashboard" linking to /app
   - Design: dark (#050510), purple/violet palette, subtle mouse-tracked ambient gradients, grid texture
   - Old "Egyptian Mew" aesthetic completely removed

### Modified

3. **`apps/dashboard/src/SpatialApp.tsx`** -- Added agent prompt banner + telemetry
   - Agent prompt banner (fixed top-center, z-10000): "You are using the limited web interface. Get the agent pack -> Your AI builds a better interface than this."
   - `useSpatialTelemetry()` hook: tracks `spatial_app_loaded`, `spatial_panel_open`, `spatial_chat_command`, `spatial_gesture_toggle` via existing PostHog/GA4/Sentry telemetry
   - Telemetry data shows what web fallback users WANT, informing context pack improvements

4. **`apps/dashboard/src/App.tsx`** -- Route changes
   - `/` -- LandingPage (agent-first landing, unchanged)
   - `/app` and `/app/*` -- SpatialApp (fallback web dashboard with agent prompt banner)
   - `/spatial` -- SpatialApp (legacy compat)
   - `/legacy/*` -- DashboardShell (old dashboard for bookmarked routes)
   - All other existing routes unchanged (/, /start, /whitepaper, /go, /operator/mobile)

5. **`packages/gateway/src/server.ts`** -- Registered context-pack route
   - Import `contextPackRoutes` from `./routes/context-pack.js`
   - Registered after wellKnownRoutes, before feedbackRoutes (public, before auth)

## Test Results

- **Gateway**: 229/229 tests passing (11 test files)
- **Dashboard**: No test files (passWithNoTests)
- **Build**: All 23 packages built successfully (gateway cache miss compiled cleanly, dashboard Vite build succeeded)

## API Endpoints Added

| Method | Path | Content-Type | Description |
|--------|------|-------------|-------------|
| GET | /agent-context-pack | text/markdown | Full context pack for AI ingestion |
| GET | /agent-context-pack.json | application/json | Structured context pack |

## Context Pack Coverage

The markdown context pack documents **130+ API endpoints** across 30+ route groups:
- Discovery & Marketplace (10 endpoints)
- Contract Builder (3)
- Jobs (5)
- Escrow & Settlement (18)
- Evidence & Verification (17)
- Operator Management (7)
- Operator Setup (6)
- Onboarding (7)
- Device Discovery (3)
- CSD (4)
- Sensors & Telemetry (6)
- Batches (5)
- Protocols (14)
- DePIN Rewards (3)
- IP & Royalties (14)
- SWF Governance (8)
- Fiat Ramp (6)
- Spaces (3)
- Logistics (11)
- Orchestrator (6)
- Agents & Negotiation (4)
- Bounties & Pools (5)
- Anomaly Detection (4)
- Registry (2)
- Subnet (4)
- Devices (3)
- SDK & Dev Tools (3)
- Gasless (1)
- Auth & API Keys (3)
- System (7)
- SSE Streams (5)
- Well-Known (2)

Plus: data type definitions, 5 workflow templates (user, operator, verifier, IP, fiat), deployed contract addresses, and role definitions.
