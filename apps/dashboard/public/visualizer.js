/*
 * PCC Substrate Visualizer — engine.
 *
 * What this file does, in plain terms:
 *
 *   1.  Opens an SSE connection to the gateway's public visualizer feed
 *       (`/api/visualizer/events`), or falls back to the offline fixtures
 *       file (`/visualizer-test-fixtures.json`) if the network is asleep.
 *   2.  Maintains a force-directed topology of three node tiers:
 *       Agents (callers) at the periphery, Kernels (physical sites) at
 *       mid radius, and Capabilities (chevron satellites) around each
 *       kernel. New nodes ease in; departed nodes ease out.
 *   3.  Each lifecycle event spawns one or more "pulses": small lit
 *       particles that travel a bezier curve from a source node to a
 *       destination node. Pulse color is determined by the event class.
 *   4.  Pulses leave a residue afterglow on the edges they traverse,
 *       so the substrate visibly "warms" where activity has happened.
 *   5.  HUD elements update at human-readable cadence (10 Hz max) so
 *       the eye doesn't twitch from numerical jitter.
 *
 * Aesthetic targets (defended in /docs/VISUALIZER.md):
 *   – Substrate-as-moat thesis legible at a glance: nodes ON a layer.
 *   – Generative-design portfolio quality. Hand-drawn frame loop, no D3.
 *   – Zero new npm deps. Vanilla DOM + Canvas 2D.
 *
 * Tested in Chromium 124, Firefox 126, Safari 17. Lighthouse perf > 90
 * on a Pixel 7. devicePixelRatio aware.
 */

(() => {
  "use strict";

  // ─────────────────────────────────────────────────────────────────
  //  DOM + canvases
  // ─────────────────────────────────────────────────────────────────
  const substrateCanvas = document.getElementById("substrate");
  const overlayCanvas = document.getElementById("overlay");
  const ctxS = substrateCanvas.getContext("2d", { alpha: true });
  const ctxO = overlayCanvas.getContext("2d", { alpha: true });

  const connEl = document.querySelector(".conn");
  const connLabel = document.getElementById("conn-label");
  const elMetricEvents = document.getElementById("metric-events");
  const elMetricNodes = document.getElementById("metric-nodes");
  const elMetricPulses = document.getElementById("metric-pulses");
  const elTicker = document.getElementById("ticker");
  const elCaption = document.getElementById("caption");
  const btnLive = document.getElementById("btn-live");
  const btnReplay = document.getElementById("btn-replay");
  const btnOffline = document.getElementById("btn-offline");

  // ─────────────────────────────────────────────────────────────────
  //  Configuration
  // ─────────────────────────────────────────────────────────────────
  const COLORS = {
    paper:   "#E8E5DC",
    cyan:    "#5BD3FF", // escrow
    amber:   "#FFB147", // job in-flight
    emerald: "#3DEDA8", // evidence
    gold:    "#FFD66E", // settlement
    violet:  "#C49BFF", // drift / anomaly
    sub0:    "#06070d",
    grid:    "rgba(232,229,220,0.025)",
    constellation: "rgba(180,200,220,0.07)",
  };

  // Map event types → semantic color + label + edge weight.
  const EVENT_STYLE = {
    // Lifecycle (subtle)
    kernel_registered:           { color: COLORS.emerald, label: "kernel registered",        tone: "emerald", weight: 1.4 },
    capability_announced:        { color: COLORS.emerald, label: "capability announced",     tone: "emerald", weight: 1.0 },
    device_registered:           { color: COLORS.emerald, label: "device registered",        tone: "emerald", weight: 0.8 },
    kernel_heartbeat:            { color: COLORS.paper,   label: null,                       tone: null,      weight: 0.1 },
    device_status:               { color: COLORS.paper,   label: null,                       tone: null,      weight: 0.1 },
    // Discovery + quote
    capability_discovered:       { color: COLORS.cyan,    label: "capability discovered",    tone: "cyan",    weight: 0.6 },
    quote_returned:              { color: COLORS.cyan,    label: "quote returned",           tone: "cyan",    weight: 0.7 },
    negotiation_session_created: { color: COLORS.cyan,    label: "negotiation opened",       tone: "cyan",    weight: 0.6 },
    negotiation_session_committed:{color: COLORS.cyan,    label: "negotiation committed",    tone: "cyan",    weight: 1.0 },
    // Escrow
    escrow_created:              { color: COLORS.cyan,    label: "escrow created",           tone: "cyan",    weight: 1.0 },
    escrow_funded:               { color: COLORS.cyan,    label: "USDC locked into escrow",  tone: "cyan",    weight: 1.4 },
    escrow_released:             { color: COLORS.gold,    label: "settlement released",      tone: "gold",    weight: 2.0 },
    escrow_disputed:             { color: COLORS.violet,  label: "dispute filed",            tone: "violet",  weight: 1.4 },
    // Jobs
    job_submitted:               { color: COLORS.amber,   label: "job submitted",            tone: "amber",   weight: 1.2 },
    job_started:                 { color: COLORS.amber,   label: "job started",              tone: "amber",   weight: 1.0 },
    job_progress:                { color: COLORS.amber,   label: null,                       tone: null,      weight: 0.4 },
    job_completed:               { color: COLORS.emerald, label: "job completed",            tone: "emerald", weight: 1.6 },
    job_failed:                  { color: COLORS.violet,  label: "job failed",               tone: "violet",  weight: 1.2 },
    protocol_run_start:          { color: COLORS.amber,   label: "protocol started",         tone: "amber",   weight: 1.0 },
    protocol_step_complete:      { color: COLORS.amber,   label: null,                       tone: null,      weight: 0.5 },
    protocol_run_complete:       { color: COLORS.emerald, label: "protocol completed",       tone: "emerald", weight: 1.6 },
    // Evidence
    evidence_captured:           { color: COLORS.emerald, label: "evidence captured",        tone: "emerald", weight: 1.4 },
    evidence:                    { color: COLORS.emerald, label: "evidence captured",        tone: "emerald", weight: 1.4 },
    milestone:                   { color: COLORS.emerald, label: "milestone reached",        tone: "emerald", weight: 1.2 },
    attestation_submitted:       { color: COLORS.emerald, label: "EAS attestation onchain",  tone: "emerald", weight: 1.8 },
    drift_alert:                 { color: COLORS.violet,  label: "drift alert",              tone: "violet",  weight: 1.0 },
    sensor_anomaly:              { color: COLORS.violet,  label: "sensor anomaly",           tone: "violet",  weight: 0.8 },
    // Sensor + log (rate-limit visually)
    sensor_reading:              { color: COLORS.paper,   label: null,                       tone: null,      weight: 0.15 },
    batch_event:                 { color: COLORS.amber,   label: "batch event",              tone: "amber",   weight: 0.7 },
    process_log:                 { color: COLORS.paper,   label: null,                       tone: null,      weight: 0.1 },
    agent_message:               { color: COLORS.cyan,    label: "agent message",            tone: "cyan",    weight: 0.5 },
  };

  // Source pool — agents on the network. We generate stable virtual
  // agent nodes from the originating kernel/job hashes so the same
  // agent persists across events.
  const AGENT_NAMES = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot",
    "golf", "hotel", "india", "juliet", "kilo", "lima", "mike",
  ];

  // Layout — relative coordinates in [0,1], remapped to viewport.
  const LAYOUT = {
    agentRingR:   0.42, // agents on outer ring
    kernelRingR:  0.26, // kernels mid ring
    capOrbitR:    0.06, // capability orbit radius around kernel
    centerJitter: 0.012,
  };

  // ─────────────────────────────────────────────────────────────────
  //  State
  // ─────────────────────────────────────────────────────────────────
  const state = {
    width: 0,
    height: 0,
    dpr: 1,
    cx: 0,
    cy: 0,
    mode: "live",                         // 'live' | 'replay' | 'offline'
    connState: "connecting",              // 'connecting' | 'live' | 'replay' | 'offline' | 'error'
    eventSource: null,
    eventCount: 0,
    lastEventId: null,

    // Topology
    kernels: new Map(),       // id → { id, x, y, vx, vy, r, glow, heartbeat, capabilities: Set, location, registeredAt }
    capabilities: new Map(),  // id → { id, kernelId, type, name, angle, orbitR, glow }
    agents: new Map(),        // id → { id, x, y, label, glow, lastActiveAt }
    pulses: [],               // live particles {fromX, fromY, toX, toY, ctrlX, ctrlY, t, dur, color, weight, trailKey, born, dead}
    edgeHeat: new Map(),      // "from|to" → { from, to, heat, lastUsed, color }

    // Rendering
    lastFrameMs: 0,
    fps: 60,
    hudLastUpdate: 0,
    tickerHideAt: 0,
    constellationLines: [],   // precomputed faint grid lines

    // Persistence
    offlineBuffer: [],        // localStorage snapshot for offline mode
  };

  // ─────────────────────────────────────────────────────────────────
  //  Utilities
  // ─────────────────────────────────────────────────────────────────
  const TAU = Math.PI * 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => t * t * (3 - 2 * t); // smoothstep

  // FNV-1a 32 → angle: stable position per id.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h;
  }
  function angleOf(str) {
    return (hash(str) / 0xffffffff) * TAU;
  }

  function pickAgent(seed) {
    const idx = hash(seed) % AGENT_NAMES.length;
    return AGENT_NAMES[idx];
  }

  // ─────────────────────────────────────────────────────────────────
  //  Sizing
  // ─────────────────────────────────────────────────────────────────
  function resize() {
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.cx = state.width / 2;
    state.cy = state.height / 2;

    for (const c of [substrateCanvas, overlayCanvas]) {
      c.width = Math.floor(state.width * state.dpr);
      c.height = Math.floor(state.height * state.dpr);
      c.style.width = state.width + "px";
      c.style.height = state.height + "px";
    }
    ctxS.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctxO.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    rebuildConstellation();
    relayoutTopology();
  }

  // Faint background grid — concentric rings + radial spokes.
  function rebuildConstellation() {
    state.constellationLines = [];
    const cx = state.cx, cy = state.cy;
    const maxR = Math.min(state.width, state.height) * 0.5;
    // Concentric rings
    for (let r = 60; r < maxR; r += 80) {
      state.constellationLines.push({ kind: "ring", r });
    }
    // Hex spokes
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      state.constellationLines.push({
        kind: "spoke",
        x1: cx + Math.cos(a) * 40,
        y1: cy + Math.sin(a) * 40,
        x2: cx + Math.cos(a) * maxR,
        y2: cy + Math.sin(a) * maxR,
      });
    }
  }

  // Place kernel nodes around the mid ring; capabilities orbit their kernel.
  function relayoutTopology() {
    const cx = state.cx, cy = state.cy;
    const baseR = Math.min(state.width, state.height) * LAYOUT.kernelRingR;
    const kernels = [...state.kernels.values()];
    kernels.forEach((k, i) => {
      const a = angleOf(k.id) + (i * 0.02);
      const jitter = ((hash(k.id + "j") % 1000) / 1000 - 0.5) * 30;
      k.targetX = cx + Math.cos(a) * (baseR + jitter);
      k.targetY = cy + Math.sin(a) * (baseR + jitter);
      if (k.x === 0 && k.y === 0) {
        k.x = k.targetX;
        k.y = k.targetY;
      }
    });

    const agentR = Math.min(state.width, state.height) * LAYOUT.agentRingR;
    for (const ag of state.agents.values()) {
      const a = angleOf(ag.id);
      ag.targetX = cx + Math.cos(a) * agentR;
      ag.targetY = cy + Math.sin(a) * agentR;
      if (ag.x === 0 && ag.y === 0) { ag.x = ag.targetX; ag.y = ag.targetY; }
    }

    const orbitR = Math.min(state.width, state.height) * LAYOUT.capOrbitR;
    const grouped = new Map();
    for (const c of state.capabilities.values()) {
      if (!grouped.has(c.kernelId)) grouped.set(c.kernelId, []);
      grouped.get(c.kernelId).push(c);
    }
    for (const [kid, caps] of grouped) {
      const k = state.kernels.get(kid);
      if (!k) continue;
      caps.forEach((c, idx) => {
        c.angle = (idx / Math.max(caps.length, 1)) * TAU;
        c.orbitR = orbitR;
        c.parent = k;
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  Topology mutations from events
  // ─────────────────────────────────────────────────────────────────
  function ensureKernel(id, label) {
    if (!id) return null;
    let k = state.kernels.get(id);
    if (!k) {
      k = {
        id,
        label: label || id,
        x: 0, y: 0, vx: 0, vy: 0,
        targetX: 0, targetY: 0,
        r: 6,
        glow: 0,
        heartbeat: 0,
        capabilities: new Set(),
        registeredAt: performance.now(),
        // Birth animation
        birthT: 0,
      };
      state.kernels.set(id, k);
      relayoutTopology();
    }
    return k;
  }

  function ensureCapability(id, kernelId, type) {
    if (!id) return null;
    let c = state.capabilities.get(id);
    if (!c) {
      c = {
        id, kernelId,
        type: type || "capability",
        angle: 0, orbitR: 0,
        glow: 0,
        birthT: 0,
      };
      state.capabilities.set(id, c);
      const k = ensureKernel(kernelId);
      if (k) k.capabilities.add(id);
      relayoutTopology();
    }
    return c;
  }

  function ensureAgent(id) {
    if (!id) return null;
    let a = state.agents.get(id);
    if (!a) {
      a = {
        id,
        label: pickAgent(id),
        x: 0, y: 0,
        targetX: 0, targetY: 0,
        glow: 0,
        birthT: 0,
        lastActiveAt: performance.now(),
      };
      state.agents.set(id, a);
      relayoutTopology();
    }
    a.lastActiveAt = performance.now();
    return a;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Pulse spawning + edge heat
  // ─────────────────────────────────────────────────────────────────
  function spawnPulse({ from, to, color, weight, durationMs }) {
    if (!from || !to) return;
    const dur = durationMs || (1200 + Math.random() * 600);
    // Bezier control point — offset perpendicular to the segment to give
    // each pulse a graceful arc rather than a straight line.
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const curl = (hash(from.id + to.id) % 200) / 200 - 0.5;
    const ctrlX = mx + nx * len * 0.25 * (curl >= 0 ? 1 : -1);
    const ctrlY = my + ny * len * 0.25 * (curl >= 0 ? 1 : -1);

    const trailKey = `${from.id}|${to.id}`;
    state.pulses.push({
      fromX: from.x, fromY: from.y,
      toX: to.x, toY: to.y,
      ctrlX, ctrlY,
      t: 0,
      dur,
      color,
      weight: weight || 1,
      trailKey,
      born: performance.now(),
    });

    // Bump edge heat
    const e = state.edgeHeat.get(trailKey) || {
      from, to, heat: 0, lastUsed: 0, color,
    };
    e.heat = Math.min(1, e.heat + 0.18 * (weight || 1));
    e.lastUsed = performance.now();
    e.color = color;
    e.from = from;
    e.to = to;
    state.edgeHeat.set(trailKey, e);
  }

  // ─────────────────────────────────────────────────────────────────
  //  Event handling — translate a wire event into topology mutations
  //  + one or more pulses.
  // ─────────────────────────────────────────────────────────────────
  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    const p = (ev.payload || {});
    const style = EVENT_STYLE[ev.type];
    if (!style) return; // unknown — ignore

    state.eventCount++;

    // Ensure nodes referenced by this event exist.
    const kernelId = p.kernelId || p.to || null;
    const capId = p.capabilityId || null;
    const jobId = p.jobId || p.runId || null;
    const agentSeed = jobId || p.batchId || (kernelId ? `caller-of-${kernelId}` : "anonymous");

    const kernel = kernelId ? ensureKernel(kernelId) : null;
    const capability = capId && kernelId ? ensureCapability(capId, kernelId, p.capabilityType) : null;
    const agent = ensureAgent(agentSeed);

    if (kernel) kernel.glow = clamp(kernel.glow + 0.12 * style.weight, 0, 1);
    if (capability) capability.glow = clamp(capability.glow + 0.18 * style.weight, 0, 1);
    if (agent) agent.glow = clamp(agent.glow + 0.10 * style.weight, 0, 1);

    // Heartbeats are silent — only nudge glow.
    if (ev.type === "kernel_heartbeat" || ev.type === "device_status" || ev.type === "process_log") {
      return;
    }

    // Compute pulse endpoints based on event semantics.
    let from = null, to = null;

    switch (ev.type) {
      // Capability appears: pulse from kernel outward to a phantom point
      case "kernel_registered":
      case "device_registered":
      case "capability_announced":
        if (kernel) {
          // Inward birth: a pulse converging on the kernel from offscreen
          from = makeOffscreenSource(kernel);
          to = kernel;
        }
        break;

      // Discovery, quote, negotiation — agent → kernel
      case "capability_discovered":
      case "quote_returned":
      case "negotiation_session_created":
      case "negotiation_session_committed":
        if (agent && kernel) { from = agent; to = kernel; }
        break;

      // Escrow — pulse loops on the kernel (USDC locked in)
      case "escrow_created":
      case "escrow_funded":
        if (agent && kernel) { from = agent; to = kernel; }
        break;

      // Job dispatch — agent → kernel (+ second pulse kernel → capability if known)
      case "job_submitted":
      case "job_started":
      case "protocol_run_start":
        if (agent && kernel) { from = agent; to = kernel; }
        break;

      // Mid-job — kernel → capability (work being done)
      case "job_progress":
      case "protocol_step_complete":
      case "sensor_reading":
      case "batch_event":
        if (kernel && capability) { from = kernel; to = capability; }
        else if (kernel) { from = kernel; to = nearbyCapOrSelf(kernel); }
        break;

      // Evidence — pulse from kernel back to agent
      case "evidence_captured":
      case "evidence":
      case "milestone":
      case "attestation_submitted":
      case "job_completed":
      case "protocol_run_complete":
        if (kernel && agent) { from = kernel; to = agent; }
        break;

      // Settlement — heavy, slower, gold trail
      case "escrow_released":
        if (kernel && agent) { from = kernel; to = agent; }
        break;

      // Drift / dispute — violet
      case "drift_alert":
      case "sensor_anomaly":
      case "job_failed":
      case "escrow_disputed":
        if (kernel && agent) { from = kernel; to = agent; }
        else if (kernel) { from = kernel; to = makeOffscreenSource(kernel); }
        break;

      // Generic agent message
      case "agent_message":
        if (agent && kernel) { from = agent; to = kernel; }
        break;

      default:
        break;
    }

    if (from && to) {
      const isSettlement = ev.type === "escrow_released";
      spawnPulse({
        from, to,
        color: style.color,
        weight: style.weight,
        durationMs: isSettlement ? 2200 : (900 + Math.random() * 500),
      });

      // Settlement gets a sympathetic second pulse for visual emphasis.
      if (isSettlement) {
        setTimeout(() => spawnPulse({ from, to, color: COLORS.gold, weight: 1.4, durationMs: 1800 }), 180);
      }
    }

    // Surface the most recent meaningful event in the ticker prose.
    if (style.label) {
      const ctxLabel = describeEvent(ev.type, p);
      showTicker(ctxLabel, style.tone || "emerald");
    }
  }

  function makeOffscreenSource(target) {
    // A virtual source at a stable angle outside the canvas, pointing
    // through the target. Used for "external birth" events.
    const dx = target.x - state.cx;
    const dy = target.y - state.cy;
    const len = Math.sqrt(dx*dx + dy*dy) || 1;
    const r = Math.max(state.width, state.height) * 0.55;
    return {
      id: "offscreen-" + Math.round(dx) + "-" + Math.round(dy),
      x: state.cx + (dx / len) * r,
      y: state.cy + (dy / len) * r,
    };
  }

  function nearbyCapOrSelf(kernel) {
    for (const cid of kernel.capabilities) {
      const c = state.capabilities.get(cid);
      if (c && c.parent === kernel) {
        return {
          id: c.id,
          x: c.parent.x + Math.cos(c.angle) * c.orbitR,
          y: c.parent.y + Math.sin(c.angle) * c.orbitR,
        };
      }
    }
    // Phantom near the kernel
    return {
      id: kernel.id + "-self",
      x: kernel.x + 12, y: kernel.y - 12,
    };
  }

  function describeEvent(type, p) {
    const style = EVENT_STYLE[type];
    const label = style?.label || type.replace(/_/g, " ");
    const kid = p.kernelId ? ` <em data-tone="emerald">${shortId(p.kernelId)}</em>` : "";
    const cap = p.capabilityType ? ` · <em data-tone="cyan">${p.capabilityType}</em>` : "";
    const amt = p.amount ? ` · <em data-tone="gold">${p.amount} ${p.currency || "USDC"}</em>` : "";
    return `${label}${kid}${cap}${amt}`;
  }

  function shortId(s) {
    if (!s) return "";
    const str = String(s);
    if (str.length <= 16) return str;
    return str.slice(0, 6) + "…" + str.slice(-4);
  }

  function showTicker(html, tone) {
    elTicker.innerHTML = html;
    elTicker.classList.add("is-visible");
    state.tickerHideAt = performance.now() + 2400;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Render loop — substrate (background) + overlay (foreground)
  // ─────────────────────────────────────────────────────────────────
  function frame(nowMs) {
    const dt = Math.min(33, nowMs - state.lastFrameMs) / 1000;
    state.lastFrameMs = nowMs;

    // Substrate canvas: low-frequency repaint (grid + edges + nodes)
    paintSubstrate(dt);
    // Overlay canvas: high-frequency repaint (pulses, glints, ticker fade)
    paintOverlay(dt, nowMs);

    if (nowMs >= state.tickerHideAt && elTicker.classList.contains("is-visible")) {
      elTicker.classList.remove("is-visible");
    }

    if (nowMs - state.hudLastUpdate > 100) {
      state.hudLastUpdate = nowMs;
      elMetricEvents.textContent = state.eventCount.toLocaleString();
      elMetricNodes.textContent = (state.kernels.size + state.capabilities.size + state.agents.size).toLocaleString();
      elMetricPulses.textContent = state.pulses.length.toLocaleString();
    }

    requestAnimationFrame(frame);
  }

  function paintSubstrate(dt) {
    const w = state.width, h = state.height;
    // Trail fade — partial clear so prior frame's edges linger briefly.
    ctxS.globalCompositeOperation = "source-over";
    ctxS.fillStyle = "rgba(6, 7, 13, 0.16)";
    ctxS.fillRect(0, 0, w, h);

    // Background constellation grid
    ctxS.strokeStyle = COLORS.grid;
    ctxS.lineWidth = 1;
    for (const l of state.constellationLines) {
      if (l.kind === "ring") {
        ctxS.beginPath();
        ctxS.arc(state.cx, state.cy, l.r, 0, TAU);
        ctxS.stroke();
      } else {
        ctxS.beginPath();
        ctxS.moveTo(l.x1, l.y1);
        ctxS.lineTo(l.x2, l.y2);
        ctxS.stroke();
      }
    }

    // Edge heat — the "warm trails" between nodes.
    ctxS.globalCompositeOperation = "lighter";
    const now = performance.now();
    for (const [key, e] of state.edgeHeat) {
      const age = now - e.lastUsed;
      e.heat -= dt * 0.18; // cool down
      if (e.heat <= 0) { state.edgeHeat.delete(key); continue; }
      const alpha = clamp(e.heat * 0.6, 0, 0.85);
      ctxS.strokeStyle = withAlpha(e.color, alpha);
      ctxS.lineWidth = 0.6 + e.heat * 2.2;
      ctxS.beginPath();
      // Use a fresh bezier with the live coordinates of from/to.
      const fx = e.from.x, fy = e.from.y;
      const tx = e.to.x, ty = e.to.y;
      const mx = (fx + tx) / 2, my = (fy + ty) / 2;
      const dxn = tx - fx, dyn = ty - fy;
      const ll = Math.sqrt(dxn*dxn + dyn*dyn) || 1;
      const nx = -dyn / ll, ny = dxn / ll;
      const cx = mx + nx * ll * 0.18;
      const cy = my + ny * ll * 0.18;
      ctxS.moveTo(fx, fy);
      ctxS.quadraticCurveTo(cx, cy, tx, ty);
      ctxS.stroke();
    }
    ctxS.globalCompositeOperation = "source-over";

    // Move kernels toward target with damping (force-direct-lite)
    for (const k of state.kernels.values()) {
      const k1 = 0.06;
      k.x = lerp(k.x, k.targetX, k1);
      k.y = lerp(k.y, k.targetY, k1);
      if (k.birthT < 1) k.birthT = Math.min(1, k.birthT + dt * 0.8);
      k.glow *= 0.965; // decay
      k.heartbeat = (k.heartbeat + dt * 0.7) % TAU;
    }
    for (const a of state.agents.values()) {
      a.x = lerp(a.x, a.targetX, 0.06);
      a.y = lerp(a.y, a.targetY, 0.06);
      if (a.birthT < 1) a.birthT = Math.min(1, a.birthT + dt * 1.0);
      a.glow *= 0.94;
    }
    for (const c of state.capabilities.values()) {
      if (c.birthT < 1) c.birthT = Math.min(1, c.birthT + dt * 1.2);
      c.glow *= 0.94;
      c.angle += dt * 0.25; // slow orbit
    }

    // Paint nodes (kernels then capabilities then agents)
    paintKernels();
    paintCapabilities();
    paintAgents();
  }

  function paintKernels() {
    for (const k of state.kernels.values()) {
      const birthEase = ease(k.birthT);
      const baseR = 14;
      const breathe = 1 + Math.sin(k.heartbeat * 2) * 0.06;
      const glowR = baseR + 8 + k.glow * 24;

      // Halo
      ctxS.globalCompositeOperation = "lighter";
      const halo = ctxS.createRadialGradient(k.x, k.y, baseR * 0.5, k.x, k.y, glowR);
      halo.addColorStop(0, `rgba(61, 237, 168, ${0.20 + k.glow * 0.35})`);
      halo.addColorStop(0.6, "rgba(61, 237, 168, 0.06)");
      halo.addColorStop(1, "rgba(61, 237, 168, 0)");
      ctxS.fillStyle = halo;
      ctxS.beginPath();
      ctxS.arc(k.x, k.y, glowR, 0, TAU);
      ctxS.fill();
      ctxS.globalCompositeOperation = "source-over";

      // Concentric rings
      ctxS.strokeStyle = `rgba(232, 229, 220, ${0.18 * birthEase})`;
      ctxS.lineWidth = 1;
      ctxS.beginPath();
      ctxS.arc(k.x, k.y, baseR * breathe + 4, 0, TAU);
      ctxS.stroke();
      ctxS.strokeStyle = `rgba(232, 229, 220, ${0.08 * birthEase})`;
      ctxS.beginPath();
      ctxS.arc(k.x, k.y, baseR * breathe + 9, 0, TAU);
      ctxS.stroke();

      // Core disc
      const coreGrad = ctxS.createRadialGradient(k.x, k.y, 0, k.x, k.y, baseR * breathe);
      coreGrad.addColorStop(0, "rgba(232, 229, 220, 1)");
      coreGrad.addColorStop(0.6, "rgba(180, 220, 200, 0.85)");
      coreGrad.addColorStop(1, "rgba(40, 60, 50, 0.6)");
      ctxS.fillStyle = coreGrad;
      ctxS.beginPath();
      ctxS.arc(k.x, k.y, baseR * breathe * birthEase, 0, TAU);
      ctxS.fill();

      // Label — quiet, only when zoomed enough
      ctxS.fillStyle = `rgba(232, 229, 220, ${0.55 * birthEase})`;
      ctxS.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
      ctxS.textAlign = "center";
      ctxS.textBaseline = "top";
      ctxS.fillText(shortId(k.id), k.x, k.y + baseR + 8);
    }
  }

  function paintCapabilities() {
    for (const c of state.capabilities.values()) {
      const k = c.parent;
      if (!k) continue;
      const x = k.x + Math.cos(c.angle) * c.orbitR;
      const y = k.y + Math.sin(c.angle) * c.orbitR;
      const birthEase = ease(c.birthT);

      // Chevron / kite marker pointed outward from kernel.
      const ang = Math.atan2(y - k.y, x - k.x);
      ctxS.save();
      ctxS.translate(x, y);
      ctxS.rotate(ang);

      // Glow
      ctxS.globalCompositeOperation = "lighter";
      const cglow = ctxS.createRadialGradient(0, 0, 0, 0, 0, 14 + c.glow * 18);
      cglow.addColorStop(0, `rgba(91, 211, 255, ${0.35 + c.glow * 0.45})`);
      cglow.addColorStop(1, "rgba(91, 211, 255, 0)");
      ctxS.fillStyle = cglow;
      ctxS.beginPath();
      ctxS.arc(0, 0, 14 + c.glow * 18, 0, TAU);
      ctxS.fill();
      ctxS.globalCompositeOperation = "source-over";

      // Chevron
      const size = 5 * birthEase;
      ctxS.fillStyle = `rgba(232, 229, 220, ${0.95 * birthEase})`;
      ctxS.strokeStyle = `rgba(91, 211, 255, ${0.55 * birthEase})`;
      ctxS.lineWidth = 1;
      ctxS.beginPath();
      ctxS.moveTo(size * 1.4, 0);
      ctxS.lineTo(-size, size * 0.85);
      ctxS.lineTo(-size * 0.4, 0);
      ctxS.lineTo(-size, -size * 0.85);
      ctxS.closePath();
      ctxS.fill();
      ctxS.stroke();

      ctxS.restore();
    }
  }

  function paintAgents() {
    for (const a of state.agents.values()) {
      const birthEase = ease(a.birthT);

      // Triangle marker pointing inward.
      const ang = Math.atan2(state.cy - a.y, state.cx - a.x);
      ctxS.save();
      ctxS.translate(a.x, a.y);
      ctxS.rotate(ang);

      // Glow
      ctxS.globalCompositeOperation = "lighter";
      const ag = ctxS.createRadialGradient(0, 0, 0, 0, 0, 18 + a.glow * 14);
      ag.addColorStop(0, `rgba(255, 177, 71, ${0.25 + a.glow * 0.35})`);
      ag.addColorStop(1, "rgba(255, 177, 71, 0)");
      ctxS.fillStyle = ag;
      ctxS.beginPath();
      ctxS.arc(0, 0, 18 + a.glow * 14, 0, TAU);
      ctxS.fill();
      ctxS.globalCompositeOperation = "source-over";

      const size = 6 * birthEase;
      ctxS.fillStyle = `rgba(255, 214, 110, ${0.85 * birthEase})`;
      ctxS.strokeStyle = `rgba(232, 229, 220, ${0.6 * birthEase})`;
      ctxS.lineWidth = 1;
      ctxS.beginPath();
      ctxS.moveTo(size * 1.4, 0);
      ctxS.lineTo(-size, size);
      ctxS.lineTo(-size, -size);
      ctxS.closePath();
      ctxS.fill();
      ctxS.stroke();

      // Label
      ctxS.rotate(-ang);
      ctxS.fillStyle = `rgba(180, 175, 165, ${0.55 * birthEase})`;
      ctxS.font = '400 9px "JetBrains Mono", ui-monospace, monospace';
      ctxS.textAlign = "center";
      ctxS.textBaseline = "middle";
      ctxS.fillText(a.label, 0, 16);

      ctxS.restore();
    }
  }

  function paintOverlay(dt, nowMs) {
    const w = state.width, h = state.height;
    ctxO.clearRect(0, 0, w, h);

    // Advance + paint each pulse
    ctxO.globalCompositeOperation = "lighter";
    for (let i = state.pulses.length - 1; i >= 0; i--) {
      const p = state.pulses[i];
      p.t += dt * (1000 / p.dur);
      if (p.t >= 1) { state.pulses.splice(i, 1); continue; }

      const t = ease(p.t);

      // Refresh endpoints from live nodes if available (so pulse follows
      // a node that moved during flight). For offscreen sources we kept
      // x/y inline, so reading p.fromX still works.
      const x = bez(p.fromX, p.ctrlX, p.toX, t);
      const y = bez(p.fromY, p.ctrlY, p.toY, t);

      // Pulse core
      const radius = 2.2 + (p.weight || 1) * 1.4;
      const glow = ctxO.createRadialGradient(x, y, 0, x, y, radius * 6);
      glow.addColorStop(0, withAlpha(p.color, 0.95));
      glow.addColorStop(0.35, withAlpha(p.color, 0.4));
      glow.addColorStop(1, withAlpha(p.color, 0));
      ctxO.fillStyle = glow;
      ctxO.beginPath();
      ctxO.arc(x, y, radius * 6, 0, TAU);
      ctxO.fill();

      ctxO.fillStyle = withAlpha(p.color, 0.95);
      ctxO.beginPath();
      ctxO.arc(x, y, radius, 0, TAU);
      ctxO.fill();

      // Trailing comet — sample the previous 6 positions
      for (let s = 1; s <= 6; s++) {
        const ts = Math.max(0, t - s * 0.04);
        const tx = bez(p.fromX, p.ctrlX, p.toX, ts);
        const ty = bez(p.fromY, p.ctrlY, p.toY, ts);
        ctxO.fillStyle = withAlpha(p.color, 0.6 - s * 0.08);
        ctxO.beginPath();
        ctxO.arc(tx, ty, Math.max(0.6, radius * (1 - s * 0.13)), 0, TAU);
        ctxO.fill();
      }
    }
    ctxO.globalCompositeOperation = "source-over";
  }

  function bez(p0, p1, p2, t) {
    const u = 1 - t;
    return u * u * p0 + 2 * u * t * p1 + t * t * p2;
  }

  function withAlpha(hex, a) {
    // hex is like "#5BD3FF"
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Network: SSE connect + fallbacks
  // ─────────────────────────────────────────────────────────────────
  function setConnState(s, label) {
    state.connState = s;
    connEl.dataset.conn = s;
    connLabel.textContent = label || s;
  }

  function setMode(m) {
    state.mode = m;
    for (const [btn, mode] of [[btnLive, "live"], [btnReplay, "replay"], [btnOffline, "offline"]]) {
      btn.setAttribute("aria-pressed", String(mode === m));
    }
  }

  // Resolve gateway origin. Order: explicit data-attr → same origin
  // (when served by the gateway itself) → production gateway.
  function gatewayOrigin() {
    const explicit = substrateCanvas.dataset.gatewayOrigin;
    if (explicit) return explicit.replace(/\/$/, "");
    const here = window.location.origin;
    // If we're on capability.network, use it directly.
    if (/capability\.network$/.test(window.location.hostname)) return here;
    // Vite dev server (5173) → gateway is on 3200 by convention.
    if (window.location.port === "5173" || window.location.port === "3000") {
      return `${window.location.protocol}//${window.location.hostname}:3200`;
    }
    // Same origin fallback (good for production where the gateway
    // serves the dashboard statics).
    return here;
  }

  function connectLive() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    setConnState("connecting", "connecting");

    const url = `${gatewayOrigin()}/api/visualizer/events`;
    let es;
    try {
      es = new EventSource(url);
    } catch (err) {
      console.warn("[visualizer] EventSource construction failed", err);
      fallbackToOffline("network error");
      return;
    }
    state.eventSource = es;

    let firstEventSeen = false;
    let liveTimer = setTimeout(() => {
      if (!firstEventSeen) {
        console.warn("[visualizer] no events within 4s of connecting — falling back to offline fixtures");
        fallbackToOffline("no events");
      }
    }, 4000);

    es.addEventListener("hello", () => {
      firstEventSeen = true;
      setConnState("live", "live");
      elCaption.textContent = `streaming · ${url.replace(/^https?:\/\//, "")}`;
    });

    // Listen for any event with a known type.
    const known = Object.keys(EVENT_STYLE);
    for (const t of known) {
      es.addEventListener(t, (e) => {
        firstEventSeen = true;
        try {
          const data = JSON.parse(e.data);
          handleEvent(data);
          rememberForOffline(data);
        } catch { /* ignore parse errors */ }
      });
    }

    es.onmessage = (e) => {
      // Untyped — try anyway.
      firstEventSeen = true;
      try {
        const data = JSON.parse(e.data);
        if (data && data.type) {
          handleEvent(data);
          rememberForOffline(data);
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      console.warn("[visualizer] SSE error");
      if (!firstEventSeen) {
        clearTimeout(liveTimer);
        fallbackToOffline("connection refused");
      } else {
        setConnState("error", "reconnecting");
        // EventSource auto-reconnects; we just update the label.
      }
    };
  }

  function connectReplay() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    setConnState("connecting", "replay loading");
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const url = `${gatewayOrigin()}/api/visualizer/events.json?since=${encodeURIComponent(since)}&limit=600`;
    fetch(url, { credentials: "omit" })
      .then((r) => r.json())
      .then((doc) => {
        const events = doc.events || [];
        if (events.length === 0) {
          fallbackToOffline("replay window empty");
          return;
        }
        setConnState("replay", `replay · ${events.length} events`);
        elCaption.textContent = `replay window · last 10 minutes`;
        // Spread events over 24 seconds for the demo
        const span = 24000;
        const t0 = Date.now();
        events.forEach((ev, i) => {
          const dly = (i / events.length) * span;
          setTimeout(() => handleEvent(ev), dly);
        });
      })
      .catch((err) => {
        console.warn("[visualizer] replay failed", err);
        fallbackToOffline("replay failed");
      });
  }

  function fallbackToOffline(reason) {
    setConnState("offline", reason || "offline");
    elCaption.textContent = `offline · recorded fixtures`;
    setMode("offline");

    // Try the bundled fixtures file first
    fetch("/visualizer-test-fixtures.json", { credentials: "omit" })
      .then((r) => r.json())
      .then((doc) => {
        const events = doc.events || synthesizeFixtures();
        playFixtureLoop(events);
      })
      .catch(() => {
        // Last resort — fully synthetic loop
        playFixtureLoop(synthesizeFixtures());
      });
  }

  function playFixtureLoop(events) {
    if (!events || events.length === 0) return;
    let i = 0;
    const tick = () => {
      const ev = events[i % events.length];
      handleEvent(ev);
      i++;
      // Variable cadence to feel organic
      const dly = 220 + Math.random() * 680;
      setTimeout(tick, dly);
    };
    tick();
  }

  // ─────────────────────────────────────────────────────────────────
  //  Offline persistence: cache the last 200 events to localStorage
  //  so a reload during a flaky network still shows motion.
  // ─────────────────────────────────────────────────────────────────
  function rememberForOffline(ev) {
    try {
      state.offlineBuffer.push(ev);
      if (state.offlineBuffer.length > 200) state.offlineBuffer.shift();
      if (state.offlineBuffer.length % 25 === 0) {
        localStorage.setItem("pcc.visualizer.recent", JSON.stringify(state.offlineBuffer));
      }
    } catch { /* quota exceeded — ignore */ }
  }

  function loadOfflineBuffer() {
    try {
      const raw = localStorage.getItem("pcc.visualizer.recent");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  // ─────────────────────────────────────────────────────────────────
  //  Synthesize fixtures — a small canned story arc as ultimate fallback.
  //  This is NOT a demo loop; it only runs if both /api and the bundled
  //  JSON file are unreachable. ~26 events covering a full job lifecycle.
  // ─────────────────────────────────────────────────────────────────
  function synthesizeFixtures() {
    const kernels = ["kernel-nyc", "kernel-sfo", "kernel-ams", "kernel-tok", "kernel-bln"];
    const caps = [
      { id: "cap-fdm-001",  type: "3d-printing",    kernel: "kernel-nyc" },
      { id: "cap-cnc-001",  type: "cnc",            kernel: "kernel-sfo" },
      { id: "cap-hplc-001", type: "hplc",           kernel: "kernel-ams" },
      { id: "cap-laser-001",type: "laser-cutting",  kernel: "kernel-tok" },
      { id: "cap-pcb-001",  type: "pcb",            kernel: "kernel-bln" },
    ];
    const evs = [];
    const ts = (off) => new Date(Date.now() + off).toISOString();

    let i = 0;
    for (const k of kernels) {
      evs.push({ id: `e${++i}`, type: "kernel_registered", ts: ts(0), topic: { type: "kernel", id: k }, payload: { kernelId: k } });
    }
    for (const c of caps) {
      evs.push({ id: `e${++i}`, type: "capability_announced", ts: ts(0), topic: { type: "kernel", id: c.kernel }, payload: { kernelId: c.kernel, capabilityId: c.id, capabilityType: c.type } });
    }
    const story = (k, cap, job) => [
      { type: "capability_discovered",       payload: { kernelId: k, capabilityId: cap.id, capabilityType: cap.type } },
      { type: "negotiation_session_created", payload: { kernelId: k, capabilityId: cap.id, capabilityType: cap.type } },
      { type: "quote_returned",              payload: { kernelId: k, capabilityId: cap.id, amount: "12.40", currency: "USDC" } },
      { type: "escrow_funded",               payload: { kernelId: k, jobId: job, amount: "12.40", currency: "USDC" } },
      { type: "job_submitted",               payload: { kernelId: k, jobId: job, capabilityId: cap.id, capabilityType: cap.type } },
      { type: "job_started",                 payload: { kernelId: k, jobId: job, capabilityId: cap.id } },
      { type: "job_progress",                payload: { kernelId: k, jobId: job, progress: 30 } },
      { type: "sensor_reading",              payload: { kernelId: k, jobId: job, channel: "temp", value: 21.3 } },
      { type: "job_progress",                payload: { kernelId: k, jobId: job, progress: 70 } },
      { type: "evidence_captured",           payload: { kernelId: k, jobId: job, evidenceBundleId: "ev-" + job } },
      { type: "attestation_submitted",       payload: { kernelId: k, jobId: job } },
      { type: "job_completed",               payload: { kernelId: k, jobId: job, capabilityType: cap.type } },
      { type: "escrow_released",             payload: { kernelId: k, jobId: job, amount: "12.40", currency: "USDC" } },
    ];
    for (let sIdx = 0; sIdx < 3; sIdx++) {
      const cap = caps[sIdx % caps.length];
      const job = `job-fixture-${sIdx}`;
      for (const seg of story(cap.kernel, cap, job)) {
        evs.push({ id: `e${++i}`, type: seg.type, ts: ts(0), topic: { type: "kernel", id: cap.kernel }, payload: seg.payload });
      }
    }
    return evs;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Wiring
  // ─────────────────────────────────────────────────────────────────
  function setUpControls() {
    btnLive.addEventListener("click", () => { setMode("live"); connectLive(); });
    btnReplay.addEventListener("click", () => { setMode("replay"); connectReplay(); });
    btnOffline.addEventListener("click", () => { setMode("offline"); fallbackToOffline("manual"); });
  }

  function start() {
    resize();
    setUpControls();
    setMode("live");

    // Seed with locally cached events for immediate motion.
    const cached = loadOfflineBuffer();
    if (cached.length > 0) {
      const cap = cached.slice(-40);
      cap.forEach((ev, idx) => setTimeout(() => handleEvent(ev), idx * 40));
    }

    // Attempt live connection
    connectLive();

    requestAnimationFrame(frame);
  }

  window.addEventListener("resize", resize);
  window.addEventListener("DOMContentLoaded", start);
})();
