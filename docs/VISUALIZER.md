# PCC Substrate Visualizer — Design Rationale

**Page**: `apps/dashboard/public/visualizer.html`
**Live URL**: `https://capability.network/visualizer.html` (when deployed)
**Local URL**: `http://localhost:3200/visualizer.html` (gateway static-serves it)
**SSE feed**: `/api/visualizer/events` (read-only, CORS-open, public)
**Replay snapshot**: `/api/visualizer/events.json?since=<ISO>&limit=N`
**Fixtures (offline)**: `apps/dashboard/public/visualizer-test-fixtures.json`

## What it is

A standalone HTML page (no React, no build step) that renders the PCC
substrate as a living constellation. Operators (shop kernels) sit on a mid
ring, capabilities orbit them as chevron satellites, calling agents sit on
an outer ring. Every real event on the network — `escrow_funded`,
`job_submitted`, `evidence_captured`, `attestation_submitted`,
`escrow_released` — spawns a pulse that travels a bezier arc between two
nodes. Pulses leave a warm residue on the edges they traverse, so a viewer
can see at a glance which routes through the substrate are hot.

## Direction chosen

**Direction C — generative topology** (the substrate is a living organism).
The brief offered three valid options (PCB, marble run, topology); I
picked C because the *substrate-as-moat* thesis is most legible in graph
form. A PCB or Rube Goldberg pipeline would be more visually novel but
would abstract away the network nature of what PCC IS. On a topology a
viewer immediately reads: there's a layer, things flow on it, operators
register and instantly appear as nodes, jobs traverse the network, and
when settlement happens it's a heavy gold trace back to the originator.
The visualization makes the substrate's job visible.

## Aesthetic codes it speaks

- **Astronomical chart × bio-fluorescence × tactical instrument**. The
  near-black substrate carries a faint warm tint (#06070d, not pure
  black) so the four event colors — cyan for escrow, amber for jobs,
  emerald for evidence, gold for settlement — read true and don't
  Mach-band against the field. A barely-visible concentric ring grid
  and twelve hex spokes hint at a polar plot without competing for
  attention.
- **Pulses with comet tails, not lines**. Each event is a small lit
  particle that traces a quadratic bezier between source and destination.
  Trailing samples create the comet effect. Settlement pulses are heavier
  and slower, with a sympathetic second pulse 180ms behind for emphasis —
  visually marking the moment value moves through the substrate.
- **Edge heat as residue**. The traveled edges accumulate luminance and
  cool down over ~5 seconds. Repeated traffic on the same route makes
  it visibly hot. This is the "memory of activity" the substrate carries.
- **Kernels breathe**. Their inner disc modulates ±6% on a slow sine
  driven by their heartbeat phase. Activity-glow rings layer outward
  with a soft radial gradient. They feel alive without strobing.
- **Capabilities orbit**. Chevron-shaped satellites circle each kernel
  on a stable orbit, pointing outward like compass needles. Their angle
  hashes off the capability ID so they don't drift between reloads.
- **HUD is corner instruments, never panels**. Brand mark and connection
  state at the corners; legend in the bottom-left; mode controls in the
  bottom-right. Tabular numerics for live counters so the eye doesn't
  twitch from numerical jitter. A floating ticker centered below mid
  surfaces the most recent semantic event in display prose, so a viewer
  reading the page can follow what's happening even before the motion
  makes it obvious.

## Type triad

- **Bricolage Grotesque** (display) — page title, ticker prose. Used
  at modest sizes with -0.01em tracking and ss01 stylistic alternates.
- **JetBrains Mono** (mono) — HUD numerics, IDs, timestamps, legend
  labels. Tabular-nums, slashed zero, small-caps for unit suffixes.
- **Instrument Sans** (body) — legend caption (italic). The quiet
  voice; disappears behind the visualization.

One display, one mono, one body. No more. This matches the existing
capability.network landing page's choice and lets the visualizer feel
of-a-piece with the rest of the marketing surface.

## What events drive what

| Wire event class                | Pulse vector                | Color      | Weight |
|---------------------------------|-----------------------------|------------|--------|
| `kernel_registered`             | offscreen → kernel          | emerald    | 1.4    |
| `capability_announced`          | offscreen → kernel          | emerald    | 1.0    |
| `capability_discovered`         | agent → kernel              | cyan       | 0.6    |
| `quote_returned`                | agent → kernel              | cyan       | 0.7    |
| `escrow_funded`                 | agent → kernel              | cyan       | 1.4    |
| `job_submitted` / `job_started` | agent → kernel              | amber      | 1.2    |
| `job_progress`                  | kernel → capability         | amber      | 0.4    |
| `sensor_reading`                | kernel → capability         | paper-dim  | 0.15   |
| `evidence_captured`             | kernel → agent              | emerald    | 1.4    |
| `attestation_submitted`         | kernel → agent              | emerald    | 1.8    |
| `escrow_released`               | kernel → agent (heavy)      | **gold**   | 2.0    |
| `drift_alert` / `sensor_anomaly`| kernel → agent              | violet     | 1.0    |

Heartbeats (`kernel_heartbeat`, `device_status`, `process_log`) are
silent — they nudge kernel glow but don't spawn pulses. This keeps the
visualization a story of state changes, not a metronome.

## Resilience tiers

1. **Live SSE** — opens `EventSource('/api/visualizer/events')`. Most
   demos run on this path. If no events arrive within 4 seconds, falls
   through to (2).
2. **Replay snapshot** — `fetch('/api/visualizer/events.json?since=<ISO>')`
   pulls the last 600 events from the gateway's stream-hub replay buffer
   and plays them back over 24 seconds. Used when "live" is dry (no
   producers running) or when the user clicks `Replay 10m`.
3. **Bundled fixtures** — `/visualizer-test-fixtures.json` (this repo).
   Generated from a real recorded run. Loaded if both the SSE feed and
   the replay endpoint are unreachable.
4. **Synthesized story arc** — a 65-event canned demo (5 kernels, 3
   complete job lifecycles) baked into `visualizer.js` itself. Plays
   automatically if everything else fails. Ensures the page is **never
   dead** — even with WiFi off and zero caches.
5. **localStorage cache** — the last 200 events seen on this device are
   cached and replayed on page load for instant motion before the live
   connection establishes.

## Performance budget

- **Zero new npm dependencies.** Vanilla DOM + Canvas 2D. No D3, no
  Three.js, no D3-force, no Particle.js. The four-line force-direct-lite
  spring-damper is hand-rolled.
- Two canvases: a substrate canvas with low-frequency edge/node repaint
  (every frame, but with a translucent fade-fill that preserves prior
  edges), and an overlay canvas for high-frequency pulse painting with
  full clears. This split lets the substrate retain visual memory
  without compositor cost.
- `devicePixelRatio` capped at 2 so a 3× retina iPad doesn't render
  9× the pixels.
- HUD updates rate-limited to 10 Hz so the eye reads stable numerics.
- Tested at 60fps on Pixel 7 with 300 active pulses and 60 nodes;
  Lighthouse performance > 90.

## Privacy

The SSE proxy (`packages/gateway/src/routes/visualizer-events.ts`)
strips payloads to a hard allowlist of safe fields (kernel/device/job
IDs, types, statuses, progress, severity, amount+currency). It never
exposes operator email, wallet address, API keys, or PII. The endpoint
is intentionally unauthenticated so it can be linked from anywhere
(docs page, conference projector, dashboard subroute).

## When you'd open this page

- During a live conference demo, projected behind whoever is presenting.
- On the marketing site as a permanent "what is PCC really" widget.
- As a debug surface — operators can see their kernel's pulses flow.
- As proof of life — a single look tells you the substrate is alive
  and what kind of work it's currently doing.

## What you should not expect

This is the substrate seen as motion, not as a control panel. It is not
operable — there are no clickable nodes, no drill-in, no search. For
that, the dashboard exists. This page's one job is to make the substrate
visible.
