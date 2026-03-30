# Remotion Showcase Examples & Hackathon Demo Video Research

**Date**: 2026-03-27
**Purpose**: Research for PL Genesis hackathon demo video (Existing Code track, deadline April 1, 2026)

---

## 1. Remotion Overview

Remotion is a React framework for making videos programmatically. Core model: a video is a React app that renders frame-by-frame instead of once. Every component gets `useCurrentFrame()` → integer frame number → you write normal React/CSS/SVG/WebGL driven by that number.

**Key primitives:**
- `useCurrentFrame()` — current frame (integer, 0-based)
- `useVideoConfig()` — `{ fps, durationInFrames, width, height }`
- `interpolate(frame, [in], [out], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })` — map frame to any value
- `spring({ frame, fps, config })` — physics-based easing, returns 0→1
- `<Sequence from={N} durationInFrames={M}>` — time-slice a section of the timeline
- `<Series>` — auto-chain sequences back to back
- `<AbsoluteFill>` — full-frame overlay layer
- `<Composition>` — register a scene with width/height/fps/duration

**Rendering:** Browser preview (scrub timeline), then `npx remotion render` → MP4 via headless Chrome. Lambda or Render Cloud for serverless.

---

## 2. Official Templates Most Relevant to PCC Demo

From `remotion.dev/templates/`:

| Template | Why It Matters for PCC |
|----------|------------------------|
| **3D (React Three Fiber)** | Globe/network 3D visualization, 3D phone mockup with live UI inside |
| **Code Hike** | Animated code walkthroughs — show PCC agent code, TypeScript API, MCP tool calls |
| **Audiogram** | Audio waveform — good for voiceover-synced sections |
| **Overlay** | Compose screen recordings with animated annotations |
| **Prompt to Motion Graphics SaaS** | AI-generated animation scenes — rapid scene generation |
| **Stargazer** | Milestone celebration (e.g., "1450+ tests passing", "130+ API endpoints") |

**Best starter for PCC**: `npx create-video@latest --template=three` (3D) + Code Hike composition for the architecture walkthrough scene.

---

## 3. Real-World Remotion Showcases: What Works

### GitHub Unwrapped (remotion-dev/github-unwrapped)
- **What it is**: Personalized year-in-review video per GitHub user. Served 10,000+ users.
- **Stack**: Vite 5 + Remotion + AWS Lambda
- **Visually impressive**: Precomputed gradient animations, data-driven scenes (commit graphs, language breakdowns), each user gets a unique render
- **Technique**: Scene-per-stat pattern — each data point gets its own `<Sequence>`. Lambda parallelizes renders.
- **Hackathon lesson**: Data-driven video is memorable. Use real metrics from your project (1450 tests, 130 endpoints, 29 MCP tools) as animated stat cards.

### Typeframes (typeframes.com)
- **What it is**: Text → polished SaaS product intro video
- **Stack**: Remotion Player for live preview + Remotion Lambda for rendering
- **Visually impressive**: Cinematic product reveals, animated UI mockups, smooth transitions between feature callouts
- **Technique**: User inputs text, Remotion generates scene composition. Player embeds directly in the browser for real-time preview.
- **Hackathon lesson**: Show the product running inside a device frame — makes abstract tech look tangible.

### Shortvid.io (open source)
- **What it is**: Event announcement videos for dev conferences (Devfest Nantes, Touraine Tech)
- **Stack**: Remotion + Zod schema for configuration
- **Visually impressive**: Consistent brand animation, deployed on venue display screens at real conferences
- **Technique**: Zod schema drives video props — type-safe, composable, easily parameterized per speaker/session
- **Hackathon lesson**: Zod for `inputProps` validation → PCC already uses Zod heavily, reuse patterns.

### Creativly.ai Brand Video
- **What it is**: Full brand video built with Remotion + Claude Code
- **Stats**: 17 cinematic scenes, 13 transitions, 12,000+ lines of React
- **Visually impressive**: Cinematic quality, smooth inter-scene transitions, motion graphics grade output
- **Technique**: Claude Code iteratively built each scene. Each scene is a React component, transitions are `<Sequence>` overlaps with opacity/scale springs.
- **Hackathon lesson**: 17 scenes in a ~3 min video = ~10 seconds per scene. That's the right pacing. Claude Code can generate scenes rapidly.

### HTMLSync Product Demo
- **What it is**: Full product demo video for HTMLSync SaaS
- **Stack**: Remotion (all scenes except one) + ElevenLabs voiceover + Claude Code animations
- **Technique**: Screen recordings composited into device frames, animated callout arrows, voiceover auto-synced to scene durations
- **Hackathon lesson**: Pair ElevenLabs TTS with Remotion `<Audio>` to get a polished voiceover-synced video without recording your own voice.

---

## 4. Key Remotion Technical Techniques

### Spring + Interpolate (the bread-and-butter pattern)
```tsx
import { useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';

const frame = useCurrentFrame();
const { fps } = useVideoConfig();

// Physics-based enter animation
const driver = spring({ frame, fps, config: { damping: 12 } });
const opacity = interpolate(driver, [0, 1], [0, 1]);
const translateY = interpolate(driver, [0, 1], [40, 0]);

return (
  <div style={{ opacity, transform: `translateY(${translateY}px)` }}>
    {children}
  </div>
);
```

### Staggered Card Entrance (good for stat reveals)
```tsx
const cards = ['22 packages', '130+ APIs', '29 MCP tools', '1450+ tests'];
cards.map((label, i) => (
  <Sequence from={i * 8} key={i}>
    <StatCard label={label} />
  </Sequence>
))
```

### 3D Scene with React Three Fiber
```tsx
import { ThreeCanvas } from '@remotion/three';
// ThreeCanvas allows useCurrentFrame() inside R3F canvas
// Animations are declarative: driven by frame, not useFrame() loop
// Enables scrubbing — critical for rendering
```

### Code Hike Walkthrough
- Write annotated Markdown with code blocks
- Code Hike v1 passes structured content to React components
- Use `interpolateColors` on token transitions for highlight-sweep animations
- Token transition utils for smooth diff-style code changes

### Overlay Pattern (screen recording + annotations)
```tsx
<AbsoluteFill>
  <Video src={screenRecording} />
  <Sequence from={30}>
    <AnimatedCallout text="Agent executes MCP tool" x={400} y={200} />
  </Sequence>
</AbsoluteFill>
```

### Device Frame Pattern (makes UI real)
```tsx
// Phone/laptop mockup with live content inside
// @remotion/three template ships with a 3D phone with swappable video texture
<ThreeCanvas>
  <PhoneModel>
    <useOffthreadVideoTexture src={operatorPWARecording} />
  </PhoneModel>
</ThreeCanvas>
```

---

## 5. @remotion/three: 3D Capabilities

**Package**: `@remotion/three`

**Core API**:
- `<ThreeCanvas>` — R3F canvas where Remotion hooks (useCurrentFrame, spring, interpolate) work inside
- `useVideoTexture()` — embed a Remotion `<Video>` as a Three.js texture on any 3D mesh
- `useOffthreadVideoTexture()` — frame-exact texture for rendering (no motion blur artifacts)

**What you can build**:
- Rotating globe with network node overlays (PCC operator network visualization)
- 3D device frame with live PWA recording inside
- Particle systems driven by frame count (background atmosphere)
- GLB/GLTF model imports via `useGLTF` (robot arm for OpenDroids tie-in)
- Spline.design scenes embedded via `@remotion/spline`

**Key constraint**: Write animations as `frame`-driven math, NOT as `useFrame()` loops. This enables scrubbing and deterministic rendering.

---

## 6. Hackathon Demo Video Best Practices

### Ideal Length
- **2:00–2:30 minutes** is the sweet spot for web3/crypto hackathons
- Judges review dozens of submissions back-to-back
- PL Genesis judging is April 1–3: assume tired judges, low attention span
- Hard cap at 3:00 minutes. Never go over.

### Proven Structure (with frame counts at 30fps)

```
[0:00–0:15]  HOOK         — Visual impact first. Show the end result before the problem.
                             "What if AI agents could hire and pay humans, on-chain, in real time?"
                             Show: operator completing a real job, USDC landing in wallet.

[0:15–0:35]  PROBLEM      — 2–3 sentences max. Pain point that the ecosystem KNOWS.
                             For PCC: "Current verifiable work is either manual/slow, or automated but unverifiable"

[0:35–1:05]  SOLUTION     — Architecture in motion. Animated diagram, not static slide.
                             Show agent → MCP tool → job → verification → settlement flow.
                             One sentence per layer.

[1:05–1:40]  LIVE DEMO    — Real product, running. Screen recording composited into device frame.
                             Show: agent submitting job, operator PWA, photo verification, escrow release.
                             No slides. No diagrams. Real pixels.

[1:40–1:55]  IMPACT/SCALE — Animated stats: 130+ API endpoints, 29 MCP tools, Base Sepolia deployed,
                             Storacha evidence storage, Starknet ZK. Numbers moving = credibility.

[1:55–2:10]  ECOSYSTEM FIT — How it extends Protocol Labs stack.
                             "Storacha for evidence. IPFS for content addressing. Flow for smart contracts."

[2:10–2:20]  CTA          — Simple ask. "Try it at capability.network. Agent package at /agent-package.json"
```

### What Judges Look For (PL Genesis specific)
- **Technical depth**: Does it actually use the Protocol Labs stack meaningfully? (Not just IPFS gateway calls)
- **Novel integration**: Does it extend the ecosystem in a non-obvious way?
- **Existing Code track**: Evidence of prior work + meaningful NEW work added during the hacking period
- **Real deployment**: Live URL, real transactions, testnet is fine
- **Clarity**: Can a judge who has never heard of PCC understand it in 30 seconds?

### What Makes Web3 Demo Videos Stand Out
- Show real on-chain transactions (block explorer link in-frame)
- Animated wallet balance changes (before → after job completion)
- Network diagram that moves (nodes light up as messages propagate)
- Contrast: "old way vs PCC way" side-by-side timer
- Metrics with source: "47 second settlement" with a real stopwatch

### Common Mistakes to Avoid
1. **Opening with a logo animation** — judges skip within 5 seconds. Start with action.
2. **Slides without product** — if the product exists, show it running, always
3. **Technical jargon overload** — "ECIES + Ed25519 + pHash+SSIM" means nothing without context
4. **Long intros** — "Hi, I'm [name] and today I'm going to show you..." → cut it all
5. **Poor audio** — bad mic kills a great demo. Use ElevenLabs TTS if no good mic available.
6. **Private YouTube link** — judges can't watch it. Always set to Unlisted (not Public for stealth, not Private)
7. **Demo bugs on screen** — pre-record the happy path, don't do live demos in the video
8. **Static architecture diagrams** — animate the data flow. Motion = comprehension.
9. **No CTA** — leave judges knowing exactly where to go next
10. **Exceeding 3 minutes** — judges stop watching

---

## 7. Remotion Scene Recommendations for PCC Demo

### Scene 1: Hook (0–15s, 450 frames at 30fps)
- **Type**: 3D globe / network visualization
- **Tech**: `@remotion/three` globe with glowing nodes lighting up (operator locations)
- **Audio**: ElevenLabs hook narration OR punchy music beat drop
- **Text**: "The Physical Capability Cloud" fades in with spring animation

### Scene 2: Problem (15–35s, 600 frames)
- **Type**: Side-by-side comparison
- **Tech**: Two columns with `<Series>` timeline. Left: "Manual verification → 3 days, $200". Right: "PCC → 47 seconds, $0.25"
- **Animated counters** using `interpolate` to count up

### Scene 3: Architecture (35–65s, 900 frames)
- **Type**: Animated flow diagram
- **Tech**: SVG nodes + animated connecting lines (`stroke-dashoffset` interpolated from `useCurrentFrame`)
- **Flow**: Agent → MCP Tool Call → Job Posted → Operator PWA → Photo Verification → Hash-Chained Log → Escrow Release
- **Each node** enters with `spring({ frame: frame - nodeDelay, fps })` stagger

### Scene 4: Live Demo (65–100s, 1050 frames)
- **Type**: Device frame with screen recording
- **Tech**: `@remotion/three` phone model OR CSS device frame + `<Video src={recording} />`
- **Overlay**: Animated callouts (`<Sequence from={N}>`) highlighting key moments
- **Show**: Operator PWA camera capture → verification pipeline → USDC settlement

### Scene 5: Stats (100–115s, 450 frames)
- **Type**: Animated stat cards
- **Tech**: Staggered `<Sequence>` cards, each with spring entrance. Counter animation via `interpolate`.
- **Stats to show**: 22 packages, 130+ API endpoints, 29 MCP tools, 1450+ tests, Base Sepolia deployed, Storacha wired

### Scene 6: Ecosystem (115–130s, 450 frames)
- **Type**: Logo wall with integration callouts
- **Tech**: Protocol Labs ecosystem logos entering with springs, connection lines to PCC layer
- **Logos**: Filecoin, Storacha, IPFS, Flow/Base (for chain), Starknet ZK

### Scene 7: CTA (130–140s, 300 frames)
- **Type**: Clean card with URL
- **Tech**: Simple typography animation, `capability.network` URL
- **Optional**: QR code generated programmatically and composited into frame

---

## 8. Toolchain Recommendation

| Tool | Purpose | Notes |
|------|---------|-------|
| `remotion` + `@remotion/three` | Core video framework + 3D | Use ThreeCanvas for globe/network |
| `@remotion/media-utils` | Audio waveform visualization | For voiceover sync indicator |
| Code Hike | Code animation scenes | Architecture walkthrough |
| ElevenLabs | TTS voiceover | Use API, pipe audio as `<Audio src>` |
| OBS Studio | Screen recording | Record operator PWA + agent runs |
| Remotion Lambda | Final render | Avoid local render (OOM risk on tablet) |

**Spark note**: Render the final MP4 on DGX Spark via `spark-run npx remotion render`. 1080p 2.5min at 30fps = ~4500 frames, headless Chrome per frame. Local tablet will OOM.

---

## 9. Quick-Start Command

```bash
cd /c/Users/globa/physical-capability-cloud
npx create-video@latest demo-video -- --template three
# or start from blank if compositing multiple scene types:
npx create-video@latest demo-video -- --template blank
cd demo-video
npm install @remotion/three three @react-three/fiber @react-three/drei
npm install @codehike/mdx  # for code animation scenes
```

PCC already uses TypeScript/React everywhere — the Remotion codebase will feel identical to any other package in the monorepo.

---

## Sources

- [Remotion GitHub](https://github.com/remotion-dev/remotion)
- [Remotion Showcase](https://www.remotion.dev/showcase/)
- [Remotion Templates](https://www.remotion.dev/templates/)
- [Remotion Three.js Docs](https://www.remotion.dev/docs/three)
- [Remotion spring() API](https://www.remotion.dev/docs/spring)
- [Remotion interpolate() API](https://www.remotion.dev/docs/interpolate)
- [GitHub Unwrapped Repo](https://github.com/remotion-dev/github-unwrapped)
- [Code Hike + Remotion](https://codehike.org/blog/remotion)
- [Typeframes Success Story](https://www.remotion.dev/success-stories/typeframes)
- [Remotion GLB/Three Example](https://github.com/remotion-dev/remotion-three-gltf-example)
- [reactvideoeditor Templates](https://github.com/reactvideoeditor/remotion-templates)
- [Devpost: 6 Tips for Hackathon Demo Videos](https://info.devpost.com/blog/6-tips-for-making-a-hackathon-demo-video)
- [PL Genesis Hackathon](https://www.plgenesis.com/)
- [Remotion Animate Properties](https://www.remotion.dev/docs/animating-properties)
- [Remotion Docs Resources](https://www.remotion.dev/docs/resources)
- [Remotion Success Stories](https://www.remotion.dev/success-stories)
