# PCC Demo Video — Remotion Build Plan

**Target**: PL Genesis Hackathon (deadline April 1, 2026)
**Format**: 1920×1080, 30fps, H.264, ~2:20
**Aesthetic**: Bioluminescent Solarpunk / Space-Age Control Room
**Render target**: DGX Spark (`spark-run npx remotion render`)

---

## Phase 0: Project Bootstrap

```bash
# Create Remotion project inside the PCC monorepo
cd physical-capability-cloud
mkdir -p packages/demo-video
cd packages/demo-video
npx create-video@latest --template blank

# Install all the Remotion packages we need
pnpm add remotion @remotion/cli @remotion/player
pnpm add -D @remotion/bundler @remotion/renderer
pnpm add -D @remotion/transitions @remotion/motion-blur
pnpm add -D @remotion/noise @remotion/paths
pnpm add -D @remotion/animation-utils @remotion/layout-utils
pnpm add -D @remotion/google-fonts @remotion/tailwind-v4
pnpm add -D tailwindcss@^4

# Copy PCC icon and any assets
cp ../../apps/dashboard/public/pcc-icon.svg public/
```

### Project Structure
```
packages/demo-video/
├─ public/
│  ├─ pcc-icon.svg
│  ├─ music/
│  │  └─ ambient-electronic.mp3     # dark synthwave / ambient electronic (royalty-free)
│  └─ screenshots/                   # real dashboard screenshots for demo scenes
│     ├─ command-center.png
│     ├─ discover.png
│     ├─ escrow.png
│     ├─ evidence.png
│     ├─ subnet.png
│     └─ depin.png
├─ src/
│  ├─ index.ts                       # registerRoot()
│  ├─ Root.tsx                       # Composition registrations
│  ├─ compositions/
│  │  └─ PCCDemo.tsx                 # Main 2:20 demo composition
│  ├─ scenes/
│  │  ├─ S01_Hook.tsx                # 0:00-0:12 — Globe + node reveal
│  │  ├─ S02_Problem.tsx             # 0:12-0:30 — Old vs New comparison
│  │  ├─ S03_Pipeline.tsx            # 0:30-1:00 — 6-phase animated pipeline
│  │  ├─ S04_AgentNegotiation.tsx    # 1:00-1:20 — Agent bidding terminal
│  │  ├─ S05_Evidence.tsx            # 1:20-1:40 — Sovereign evidence stack
│  │  ├─ S06_Dashboard.tsx           # 1:40-1:55 — Real dashboard showcase
│  │  ├─ S07_Stats.tsx               # 1:55-2:08 — Animated metric cards
│  │  ├─ S08_CTA.tsx                 # 2:08-2:20 — Logo + URL + QR
│  │  └─ Background.tsx              # Persistent particle + grid bg
│  ├─ components/
│  │  ├─ AnimatedTitle.tsx           # Spring-driven title entrance
│  │  ├─ AnimatedCounter.tsx         # Counting number animation
│  │  ├─ GlassPanel.tsx              # Remotion port of PCC GlassPanel
│  │  ├─ GlowBadge.tsx              # Neon pill badge
│  │  ├─ PulseIndicator.tsx          # Status dot with pulse
│  │  ├─ TypewriterText.tsx          # Character-by-character reveal
│  │  ├─ FlowDiagram.tsx            # SVG path drawing animation
│  │  ├─ ParticleField.tsx          # Noise-driven particle background
│  │  ├─ TerminalLog.tsx            # Agent negotiation log
│  │  ├─ BorderBeam.tsx             # Spinning gradient border
│  │  ├─ StaggeredCards.tsx         # Staggered reveal card grid
│  │  └─ ScreenshotFrame.tsx        # Dashboard screenshot with device frame
│  └─ lib/
│     ├─ colors.ts                   # PCC design tokens
│     ├─ fonts.ts                    # Font loading (Space Grotesk, Inter, JetBrains Mono)
│     ├─ animations.ts              # Reusable animation helpers
│     └─ data.ts                    # Real PCC metrics as typed constants
├─ remotion.config.ts
├─ package.json
└─ tsconfig.json
```

---

## Phase 1: Design System (lib/)

### colors.ts
```tsx
export const COLORS = {
  // Backgrounds
  bg: {
    deep: '#030308',
    primary: '#050a0e',
    secondary: '#090f15',
    tertiary: '#0d1520',
  },
  // Accents
  emerald: {
    500: '#10b981',
    neon: '#00ff88',
    mint: '#6effc0',
    glow: 'rgba(0,255,136,0.15)',
    subtle: 'rgba(0,255,136,0.07)',
  },
  teal: {
    300: '#80eaff',
    400: '#00d4ff',
    500: '#00a8cc',
  },
  gold: {
    400: '#ffaa00',
    500: '#e07b00',
    landing: '#D8A01B',
  },
  purple: '#B57BDB',
  pink: '#E070A0',
  blue: '#26619C',
  // Status
  status: {
    online: '#00ff88',
    executing: '#ffaa00',
    completed: '#10b981',
    failed: '#ff4444',
    offline: '#4a5568',
  },
  // Text
  text: {
    primary: '#E8E8F0',
    muted: '#7B7B9A',
    bright: '#ffffff',
  },
} as const;

export const GRADIENTS = {
  hero: 'linear-gradient(135deg, #00ff88 0%, #00d4ff 50%, #7c3aed 100%)',
  holographic: 'linear-gradient(135deg, #D8A01B 0%, #B57BDB 25%, #00D4D4 50%, #E070A0 75%, #26619C 100%)',
  glass: 'rgba(255,255,255,0.04)',
  glassBorder: 'rgba(255,255,255,0.12)',
} as const;
```

### fonts.ts
```tsx
import { loadFont as loadSpaceGrotesk } from '@remotion/google-fonts/SpaceGrotesk';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadJetBrainsMono } from '@remotion/google-fonts/JetBrainsMono';

const { fontFamily: spaceGrotesk } = loadSpaceGrotesk();
const { fontFamily: inter } = loadInter();
const { fontFamily: jetbrainsMono } = loadJetBrainsMono();

export const FONTS = {
  display: spaceGrotesk,
  body: inter,
  mono: jetbrainsMono,
} as const;
```

### data.ts — Real PCC Metrics
```tsx
export const PCC_METRICS = {
  packages: 22,
  tests: 1514,
  testFiles: 83,
  dashboardRoutes: 52,
  restEndpoints: 65,
  mcpTools: 49,
  a2aIntents: 27,
  sseStreams: 5,
  uiComponents: 64,
  sponsors: 6,
  addressableMarket: '$3.5T',
  platformFeeReduction: '20-40% → 1.5%',
  demoRuntime: '2.5 seconds',
} as const;

export const CAPABILITIES_TICKER = [
  'CNC milling', 'same-day delivery', 'HPLC analysis', 'PCB fabrication',
  '3D printing', 'furniture assembly', 'laser cutting', 'wet lab assays',
  'drone surveys', 'chemical synthesis', 'welding', 'gene sequencing',
  'equipment repair', 'injection molding', 'spectroscopy', 'soil sampling',
  'robotic assembly', 'quality inspection', 'flow cytometry', 'bioreactor',
] as const;

export const SPONSORS = [
  { name: 'Filecoin / Storacha', role: 'Evidence IPFS + archival' },
  { name: 'Lit Protocol', role: 'AES-256-GCM evidence encryption' },
  { name: 'Starknet', role: 'ZK proof anchoring' },
  { name: 'Bittensor', role: 'Decentralized evidence scoring' },
  { name: 'Base / Coinbase', role: 'Milestone escrow + x402 payments' },
  { name: 'Solana', role: 'Soulbound cNFTs + agent wallets' },
] as const;

export const SIX_PHASES = [
  { name: 'DISCOVER', icon: '🔍', color: '#00d4ff', desc: 'Agents find matching capabilities' },
  { name: 'BID', icon: '💰', color: '#ffaa00', desc: 'Operators compete in real-time auction' },
  { name: 'ESCROW', icon: '🔒', color: '#B57BDB', desc: 'Funds lock on-chain per milestone' },
  { name: 'EXECUTE', icon: '⚡', color: '#00ff88', desc: 'Physical work runs, evidence streams' },
  { name: 'VERIFY', icon: '✅', color: '#10b981', desc: 'Bittensor miners score evidence' },
  { name: 'SETTLE', icon: '🏦', color: '#D8A01B', desc: 'Funds auto-release, cNFT certifies' },
] as const;

export const AWS_COMPARISON = [
  { aws: 'Availability Zone', pcc: 'Shop Kernel (physical site)' },
  { aws: 'EC2 Instance Type', pcc: 'Capability Type ("5-axis CNC Tier-2")' },
  { aws: 'S3 Request', pcc: 'Evidence Bundle (content-addressed)' },
  { aws: 'CloudWatch', pcc: 'Sensor telemetry + evidence trail' },
  { aws: 'IAM', pcc: 'ERC-8004 machine DIDs' },
  { aws: 'Billing', pcc: 'Milestone escrow + x402 micropayments' },
] as const;
```

---

## Phase 2: Reusable Components

### AnimatedTitle.tsx
```tsx
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { FONTS, COLORS } from '../lib';

export const AnimatedTitle: React.FC<{
  text: string;
  delay?: number;
  fontSize?: number;
  color?: string;
  gradient?: string;
}> = ({ text, delay = 0, fontSize = 64, color = COLORS.text.primary, gradient }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
  });

  const y = interpolate(progress, [0, 1], [30, 0]);
  const opacity = progress;

  const textStyle: React.CSSProperties = {
    fontFamily: FONTS.display,
    fontSize,
    fontWeight: 700,
    color,
    opacity,
    transform: `translateY(${y}px)`,
    ...(gradient ? {
      background: gradient,
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
    } : {}),
  };

  return <div style={textStyle}>{text}</div>;
};
```

### TypewriterText.tsx
```tsx
import { useCurrentFrame, interpolate } from 'remotion';
import { FONTS, COLORS } from '../lib';

export const TypewriterText: React.FC<{
  text: string;
  delay?: number;
  charsPerFrame?: number;
  showCursor?: boolean;
  cursorColor?: string;
}> = ({ text, delay = 0, charsPerFrame = 0.5, showCursor = true, cursorColor = COLORS.gold[400] }) => {
  const frame = useCurrentFrame();
  const adjustedFrame = Math.max(0, frame - delay);
  const visibleChars = Math.min(Math.floor(adjustedFrame * charsPerFrame), text.length);
  const displayText = text.slice(0, visibleChars);

  // Blinking cursor: 1s cycle
  const cursorOpacity = Math.sin(frame * 0.2) > 0 ? 1 : 0;

  return (
    <span style={{ fontFamily: FONTS.mono, color: COLORS.text.primary }}>
      {displayText}
      {showCursor && (
        <span style={{ color: cursorColor, opacity: cursorOpacity }}>▌</span>
      )}
    </span>
  );
};
```

### AnimatedCounter.tsx
```tsx
import { useCurrentFrame, interpolate, Easing } from 'remotion';
import { FONTS, COLORS } from '../lib';

export const AnimatedCounter: React.FC<{
  from?: number;
  to: number;
  duration?: number;
  delay?: number;
  suffix?: string;
  prefix?: string;
  fontSize?: number;
  color?: string;
}> = ({ from = 0, to, duration = 60, delay = 0, suffix = '', prefix = '', fontSize = 48, color = COLORS.emerald.neon }) => {
  const frame = useCurrentFrame();
  const adjustedFrame = Math.max(0, frame - delay);

  const value = Math.round(interpolate(adjustedFrame, [0, duration], [from, to], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  }));

  return (
    <span style={{
      fontFamily: FONTS.mono,
      fontSize,
      fontWeight: 700,
      color,
      fontVariantNumeric: 'tabular-nums',
    }}>
      {prefix}{value.toLocaleString()}{suffix}
    </span>
  );
};
```

### GlassPanel.tsx
```tsx
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { COLORS, GRADIENTS } from '../lib';

export const GlassPanel: React.FC<{
  children: React.ReactNode;
  delay?: number;
  width?: number | string;
  padding?: number;
  glowColor?: string;
}> = ({ children, delay = 0, width = 'auto', padding = 24, glowColor = COLORS.emerald.neon }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
  });

  const scale = interpolate(progress, [0, 1], [0.95, 1]);
  const opacity = progress;

  return (
    <div style={{
      width,
      padding,
      background: GRADIENTS.glass,
      border: `1px solid ${GRADIENTS.glassBorder}`,
      borderRadius: 16,
      backdropFilter: 'blur(24px)',
      boxShadow: `0 0 30px ${COLORS.emerald.glow}`,
      transform: `scale(${scale})`,
      opacity,
    }}>
      {children}
    </div>
  );
};
```

### ParticleField.tsx — Noise-driven background
```tsx
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { noise2D } from '@remotion/noise';
import { COLORS } from '../lib';

const PARTICLE_COUNT = 60;

export const ParticleField: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  const particles = Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const baseX = noise2D(`x-${i}`, i * 0.1, 0) * 0.5 + 0.5;
    const baseY = noise2D(`y-${i}`, 0, i * 0.1) * 0.5 + 0.5;
    const driftX = noise2D(`dx-${i}`, t * 0.3, i * 0.1) * 40;
    const driftY = noise2D(`dy-${i}`, i * 0.1, t * 0.3) * 30;
    const size = 2 + noise2D(`s-${i}`, i * 0.2, t * 0.5) * 2;
    const alpha = 0.2 + noise2D(`a-${i}`, t * 0.2, i * 0.1) * 0.3;

    return {
      x: baseX * width + driftX,
      y: baseY * height + driftY,
      size,
      alpha: Math.max(0.05, alpha),
    };
  });

  return (
    <svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }}>
      {particles.map((p, i) => (
        <g key={i}>
          {/* Halo glow */}
          <circle cx={p.x} cy={p.y} r={p.size * 4}
            fill={`rgba(0, 255, 136, ${p.alpha * 0.15})`} />
          {/* Core dot */}
          <circle cx={p.x} cy={p.y} r={p.size}
            fill={`rgba(124, 179, 66, ${p.alpha})`} />
        </g>
      ))}
    </svg>
  );
};
```

### FlowDiagram.tsx — SVG path drawing
```tsx
import { useCurrentFrame, useVideoConfig, spring, interpolate } from 'remotion';
import { evolvePath } from '@remotion/paths';
import { COLORS } from '../lib';

export const FlowDiagram: React.FC<{
  path: string;
  delay?: number;
  duration?: number;
  color?: string;
  strokeWidth?: number;
}> = ({ path, delay = 0, duration = 40, color = COLORS.emerald.neon, strokeWidth = 3 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - delay,
    fps,
    durationInFrames: duration,
    config: { damping: 200 },
  });

  const { strokeDasharray, strokeDashoffset } = evolvePath(progress, path);

  return (
    <path
      d={path}
      stroke={color}
      strokeWidth={strokeWidth}
      fill="none"
      strokeDasharray={strokeDasharray}
      strokeDashoffset={strokeDashoffset}
      strokeLinecap="round"
    />
  );
};
```

### TerminalLog.tsx — Agent negotiation feed
```tsx
import { useCurrentFrame, interpolate, Easing } from 'remotion';
import { FONTS, COLORS } from '../lib';

type LogEntry = {
  tag: string;
  tagColor: string;
  text: string;
};

export const TerminalLog: React.FC<{
  entries: LogEntry[];
  delay?: number;
  framesPerEntry?: number;
}> = ({ entries, delay = 0, framesPerEntry = 8 }) => {
  const frame = useCurrentFrame();
  const adjustedFrame = Math.max(0, frame - delay);

  return (
    <div style={{
      fontFamily: FONTS.mono,
      fontSize: 16,
      padding: 20,
      background: 'rgba(0,0,0,0.7)',
      borderRadius: 12,
      border: `1px solid ${COLORS.emerald.subtle}`,
      lineHeight: 1.8,
    }}>
      {entries.map((entry, i) => {
        const entryFrame = adjustedFrame - i * framesPerEntry;
        const opacity = interpolate(entryFrame, [0, 5], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const x = interpolate(entryFrame, [0, 5], [-20, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        });

        if (entryFrame < 0) return null;

        return (
          <div key={i} style={{ opacity, transform: `translateX(${x}px)` }}>
            <span style={{ color: entry.tagColor, fontWeight: 700 }}>[{entry.tag}]</span>
            <span style={{ color: COLORS.text.primary }}> {entry.text}</span>
          </div>
        );
      })}
    </div>
  );
};
```

---

## Phase 3: Scene Breakdown (8 Scenes, 2:20 total at 30fps = 4200 frames)

### S01_Hook.tsx — Opening (0:00-0:12, frames 0-360)

**Visual**: Deep black background (#030308). Noise-driven particle field. PCC icon fades in at center, scales up with spring. Title "Physical Capability Cloud" fades in below with holographic gradient. Subtitle typewriter: "Every machine, lab, and factory on Earth just became a programmable endpoint."

Capability ticker scrolls across bottom: CNC milling → HPLC analysis → 3D printing → gene sequencing → ...

**Remotion pattern**:
```tsx
<AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
  <ParticleField />
  <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
    {/* PCC Icon with spring scale */}
    <Sequence from={10}>
      <Img src={staticFile('/pcc-icon.svg')} style={{
        width: 120,
        transform: `scale(${spring({ frame: frame - 10, fps, config: { damping: 200 } })})`,
      }} />
    </Sequence>
    {/* Title with holographic gradient */}
    <Sequence from={25}>
      <AnimatedTitle
        text="Physical Capability Cloud"
        fontSize={72}
        gradient={GRADIENTS.holographic}
      />
    </Sequence>
    {/* Typewriter tagline */}
    <Sequence from={50}>
      <TypewriterText
        text="Every machine, lab, and factory on Earth just became a programmable endpoint."
        charsPerFrame={0.8}
        cursorColor={COLORS.gold[400]}
      />
    </Sequence>
  </AbsoluteFill>
  {/* Bottom ticker */}
  <Sequence from={80}>
    <CapabilityTicker />
  </Sequence>
</AbsoluteFill>
```

### S02_Problem.tsx — Old vs New (0:12-0:30, frames 360-900)

**Visual**: Split screen. Left panel (red tint): "The Old Way" — manual quotes, phone calls, 3-7 day turnaround, 20-40% platform fees, no verification. Right panel (green tint): "PCC" — AI agents, competitive bidding, minutes not days, 1.5% fees, cryptographic proof.

Each bullet stagger-reveals. Numbers animate (counter component). The "40%" morphs down to "1.5%" with a satisfying spring animation.

**Key animation**: Side-by-side GlassPanels, left with red glow, right with green glow. Items stagger in with `spring({ frame: frame - i * 8, fps })`.

### S03_Pipeline.tsx — 6-Phase Flow (0:30-1:00, frames 900-1800)

**Visual**: The PCC 6-phase pipeline as an animated SVG flow diagram. Each phase is a node (GlassPanel with phase color glow). SVG paths draw between them using `evolvePath`. Each node lights up in sequence with `<Sequence from={...}>`.

```
DISCOVER → BID → ESCROW → EXECUTE → VERIFY → SETTLE
  🔍        💰      🔒        ⚡        ✅       🏦
```

**Animation sequence**:
1. Frames 0-15: DISCOVER node fades in with spring
2. Frames 15-25: Path draws from DISCOVER → BID
3. Frames 25-35: BID node lights up
4. Continue for all 6 phases
5. After all lit: pulse glow ripple runs through entire chain
6. Below: brief text for each phase fades in as it activates

### S04_AgentNegotiation.tsx — Competitive Bidding (1:00-1:20, frames 1800-2400)

**Visual**: Terminal-style log showing real agent negotiation. Three GlassPanels at top showing competing operators (BioLab Alpha, MachineShop Beta, CourierNet Gamma). Below: TerminalLog component showing the bidding in real-time.

**Log entries** (stagger reveal):
```
[BROKER] Broadcasting HPLC capability request to 3 operators...
[LAB-01] Bid: $3.50/sample — 99.2% purity — 4hr turnaround
[LAB-02] Bid: $3.80/sample — 99.5% purity — 2hr turnaround
[LAB-03] Bid: $3.20/sample — 98.8% purity — 6hr turnaround
[BROKER] Lowest bid: $3.20. Requesting final offers...
[LAB-01] Counter: $3.10/sample — matching 4hr turnaround
[LAB-03] Withdrawn.
[BROKER] Winner: LAB-01 at $3.10/sample ✓
[ESCROW] Milestone locked: $310.00 + $31.00 bond on Base Sepolia
```

Tag colors: `[BROKER]` = gold, `[LAB-*]` = teal, `[ESCROW]` = purple

### S05_Evidence.tsx — Sovereign Infrastructure Stack (1:20-1:40, frames 2400-3000)

**Visual**: Animated vertical cascade showing the 9-phase sovereign pipeline. Each step is a GlassPanel that cascades down with spring + stagger. SVG connection lines draw between them.

```
1. W3C DID Identity          → did:pcc:operator:lab-01
2. Verifiable Credential     → Operator authorization VC
3. Evidence Collection       → 6 events: peaks, purity, retention
4. AES-256-GCM Encryption   → Lit Protocol access conditions
5. IPFS Content Address      → bafy...3x7k (permanent, immutable)
6. Bittensor Consensus       → 5 miners, Yuma score: 0.94
7. ZK Proof Generation       → Inclusion proof (verify without seeing data)
8. Escrow Settlement         → $280 released, lock→fulfill→collect
9. Soulbound cNFT Mint       → Non-transferable competence attestation
```

Each step has its own glow color. Icons/badges appear as each step completes.

### S06_Dashboard.tsx — Real Dashboard Showcase (1:40-1:55, frames 3000-3450)

**Visual**: Real screenshots of the PCC dashboard in a device frame (browser chrome mockup). Quick cuts between 4-5 key pages:
1. Command Center (KPIs)
2. Workflow DAG Builder
3. Evidence Explorer
4. DePIN Dashboard
5. Operator Setup Wizard

Each screenshot slides in from right with `slide({ direction: 'from-right' })` transition.

**Overlay annotations**: Small GlowBadge callouts point to key features in each screenshot.

### S07_Stats.tsx — Metric Cards (1:55-2:08, frames 3450-3840)

**Visual**: Dark background with 4×3 grid of stat cards. Each card is a GlassPanel containing an AnimatedCounter and a label. Cards stagger in with 5-frame delay per card.

**Grid**:
```
| 22 Packages      | 1,514 Tests      | 52 Dashboard Routes |
| 65+ API Endpoints | 49 MCP Tools     | 27 A2A Intents      |
| 64+ Components   | 6 Sponsors       | 5 SSE Streams       |
| $3.5T Market     | 1.5% Fee         | 2.5s Demo Runtime   |
```

Each counter animates from 0 to its value over 60 frames with `Easing.out(Easing.cubic)`. Green glow on the numbers.

### S08_CTA.tsx — Closing (2:08-2:20, frames 3840-4200)

**Visual**: PCC icon large center. "capability.network" in display font below. Holographic gradient shimmer across the text. QR code (static image) for the URL. Sponsor logos in a row at bottom with subtle fade-in.

Final frame holds for 2 seconds with breathing glow animation on the icon.

---

## Phase 4: Main Composition

### PCCDemo.tsx
```tsx
import { AbsoluteFill, Audio, Series, staticFile, interpolate, useVideoConfig } from 'remotion';
import { TransitionSeries, springTiming, linearTiming } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';

import { S01_Hook } from '../scenes/S01_Hook';
import { S02_Problem } from '../scenes/S02_Problem';
import { S03_Pipeline } from '../scenes/S03_Pipeline';
import { S04_AgentNegotiation } from '../scenes/S04_AgentNegotiation';
import { S05_Evidence } from '../scenes/S05_Evidence';
import { S06_Dashboard } from '../scenes/S06_Dashboard';
import { S07_Stats } from '../scenes/S07_Stats';
import { S08_CTA } from '../scenes/S08_CTA';
import { ParticleField } from '../components/ParticleField';
import { COLORS } from '../lib/colors';

export const PCCDemo: React.FC = () => {
  const { durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg.deep }}>
      {/* Persistent particle background (entire video) */}
      <AbsoluteFill style={{ opacity: 0.4 }}>
        <ParticleField />
      </AbsoluteFill>

      {/* Scenes with transitions */}
      <TransitionSeries>
        {/* S01: Hook — 12 seconds (360 frames) */}
        <TransitionSeries.Sequence durationInFrames={360}>
          <S01_Hook />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={springTiming({ config: { damping: 200 } })}
          presentation={fade()}
        />

        {/* S02: Problem — 18 seconds (540 frames) */}
        <TransitionSeries.Sequence durationInFrames={540}>
          <S02_Problem />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 20 })}
          presentation={slide({ direction: 'from-right' })}
        />

        {/* S03: Pipeline — 30 seconds (900 frames) */}
        <TransitionSeries.Sequence durationInFrames={900}>
          <S03_Pipeline />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={springTiming({ config: { damping: 200 } })}
          presentation={fade()}
        />

        {/* S04: Agent Negotiation — 20 seconds (600 frames) */}
        <TransitionSeries.Sequence durationInFrames={600}>
          <S04_AgentNegotiation />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 20 })}
          presentation={fade()}
        />

        {/* S05: Evidence — 20 seconds (600 frames) */}
        <TransitionSeries.Sequence durationInFrames={600}>
          <S05_Evidence />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 15 })}
          presentation={slide({ direction: 'from-bottom' })}
        />

        {/* S06: Dashboard — 15 seconds (450 frames) */}
        <TransitionSeries.Sequence durationInFrames={450}>
          <S06_Dashboard />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={springTiming({ config: { damping: 200 } })}
          presentation={fade()}
        />

        {/* S07: Stats — 13 seconds (390 frames) */}
        <TransitionSeries.Sequence durationInFrames={390}>
          <S07_Stats />
        </TransitionSeries.Sequence>

        <TransitionSeries.Transition
          timing={linearTiming({ durationInFrames: 20 })}
          presentation={fade()}
        />

        {/* S08: CTA — 12 seconds (360 frames) */}
        <TransitionSeries.Sequence durationInFrames={360}>
          <S08_CTA />
        </TransitionSeries.Sequence>
      </TransitionSeries>

      {/* Background music with fade in/out */}
      <Audio
        src={staticFile('/music/ambient-electronic.mp3')}
        volume={(f) => interpolate(
          f,
          [0, 45, durationInFrames - 45, durationInFrames],
          [0, 0.25, 0.25, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        )}
      />
    </AbsoluteFill>
  );
};
```

### Root.tsx
```tsx
import { Composition, Folder, Still } from 'remotion';
import { PCCDemo } from './compositions/PCCDemo';

export const Root = () => (
  <>
    <Folder name="PCC Demo">
      <Composition
        id="PCCDemo-Full"
        component={PCCDemo}
        durationInFrames={4200}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="PCCDemo-Draft"
        component={PCCDemo}
        durationInFrames={4200}
        fps={30}
        width={960}
        height={540}
      />
    </Folder>
    <Folder name="Scenes (Preview)">
      {/* Individual scenes for isolated preview during development */}
      <Composition id="Hook" component={S01_Hook} durationInFrames={360} fps={30} width={1920} height={1080} />
      <Composition id="Problem" component={S02_Problem} durationInFrames={540} fps={30} width={1920} height={1080} />
      <Composition id="Pipeline" component={S03_Pipeline} durationInFrames={900} fps={30} width={1920} height={1080} />
      <Composition id="Negotiation" component={S04_AgentNegotiation} durationInFrames={600} fps={30} width={1920} height={1080} />
      <Composition id="Evidence" component={S05_Evidence} durationInFrames={600} fps={30} width={1920} height={1080} />
      <Composition id="Dashboard" component={S06_Dashboard} durationInFrames={450} fps={30} width={1920} height={1080} />
      <Composition id="Stats" component={S07_Stats} durationInFrames={390} fps={30} width={1920} height={1080} />
      <Composition id="CTA" component={S08_CTA} durationInFrames={360} fps={30} width={1920} height={1080} />
    </Folder>
    <Still id="Thumbnail" component={PCCDemo} width={1920} height={1080} />
  </>
);
```

---

## Phase 5: Audio Strategy

### Option A: Voiceover + Background Music
- Record voiceover matching the existing `voiceover-script.md` (condensed to 2:20)
- Layer with royalty-free dark ambient/electronic music
- Use `<Audio>` for both tracks, voiceover at `volume={0.9}`, music at `volume={0.2}`

### Option B: Music Only + Text
- Rely on animated text/TypewriterText for all messaging
- Stronger music presence at `volume={0.35}`
- Lower production overhead, still very effective for hackathon

### Option C: AI Voiceover (ElevenLabs)
```tsx
// Generate voiceover segments per scene via ElevenLabs API
// Place in public/voiceover/s01.mp3, s02.mp3, etc.
// Layer each with <Sequence from={sceneStart}><Audio src={...} /></Sequence>
```

**Recommendation**: Start with Option B (music only + text). Upgrade to Option C if time allows — AI voiceover adds polish but isn't required to win.

---

## Phase 6: Rendering Pipeline

### package.json scripts
```json
{
  "scripts": {
    "studio": "npx remotion studio",
    "render:draft": "npx remotion render src/index.ts PCCDemo-Draft --codec h264 --crf 28 --x264-preset ultrafast",
    "render:final": "npx remotion render src/index.ts PCCDemo-Full --codec h264 --crf 18",
    "render:4k": "npx remotion render src/index.ts PCCDemo-Full --codec h264 --crf 16 --scale 2",
    "render:thumbnail": "npx remotion still src/index.ts Thumbnail --frame 30 --image-format png",
    "render:scene": "npx remotion render src/index.ts"
  }
}
```

### Render on DGX Spark (MANDATORY for final render)
```bash
# Draft render locally for iteration (960x540, fast)
npx remotion render src/index.ts PCCDemo-Draft --codec h264 --crf 28 --x264-preset ultrafast

# Final render on Spark (1920x1080, high quality)
spark-run "cd ~/projects/physical-capability-cloud/packages/demo-video && npx remotion render src/index.ts PCCDemo-Full --codec h264 --crf 18"

# 4K render on Spark
spark-run "cd ~/projects/physical-capability-cloud/packages/demo-video && npx remotion render src/index.ts PCCDemo-Full --codec h264 --crf 16 --scale 2"
```

### Render math
- 4200 frames at 1080p30
- Each frame = headless Chrome screenshot
- Estimated render time: ~5-10 minutes on Spark, ~20-30 minutes locally
- Output: `out/PCCDemo-Full.mp4` (~15-25MB at CRF 18)

---

## Phase 7: Development Workflow

### Iteration loop
1. `pnpm studio` — open Remotion Studio at localhost:3000
2. Build one scene at a time (use individual scene compositions for preview)
3. Draft render after each scene to check timing
4. Once all scenes work individually, assemble in PCCDemo.tsx
5. Full draft render → timing/pacing review
6. Polish animations, adjust frame counts
7. Final render on Spark

### Screenshot capture (for S06_Dashboard)
```bash
# Take screenshots of the real dashboard running locally
# Start the PCC dashboard:
cd physical-capability-cloud && pnpm dev

# Use playwright to capture:
npx playwright-cli screenshot http://localhost:5173/dashboard --width 1920 --height 1080 --output packages/demo-video/public/screenshots/command-center.png
# Repeat for each dashboard page
```

---

## Execution Prompt

When ready to build, run `/go` with this prompt:

```
Build the PCC hackathon demo video using Remotion. Follow REMOTION_VIDEO_PLAN.md exactly.

Wave 1 (parallel):
- Set up the Remotion project in packages/demo-video (bootstrap, deps, config)
- Create lib/ files (colors.ts, fonts.ts, data.ts, animations.ts)

Wave 2 (parallel, after Wave 1):
- Build all reusable components (AnimatedTitle, TypewriterText, AnimatedCounter, GlassPanel, ParticleField, FlowDiagram, TerminalLog, BorderBeam, StaggeredCards, ScreenshotFrame)
- Create Root.tsx and index.ts entry point

Wave 3 (parallel, after Wave 2):
- Build S01_Hook.tsx and S02_Problem.tsx
- Build S03_Pipeline.tsx and S04_AgentNegotiation.tsx
- Build S05_Evidence.tsx and S06_Dashboard.tsx
- Build S07_Stats.tsx and S08_CTA.tsx

Wave 4 (after Wave 3):
- Assemble PCCDemo.tsx main composition
- Draft render to verify
- Polish timing and transitions

All code is TypeScript + React. Use Remotion APIs exclusively (spring, interpolate, Sequence, Series, TransitionSeries, AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig). Follow the PCC Bioluminescent Solarpunk design system (colors, fonts, glass panels, neon glows). 1920x1080, 30fps, 2:20 total.
```

---

## Key Remotion Patterns to Remember

1. **Every animation = `useCurrentFrame()` + `spring()` or `interpolate()`**
2. **Scene timing = `<Sequence from={N} durationInFrames={M}>`**
3. **Sequential scenes = `<Series>` with `offset={-15}` for overlaps**
4. **Scene transitions = `<TransitionSeries>` + `fade()`/`slide()`/`wipe()`**
5. **Always `extrapolateRight: 'clamp'`** to prevent animation overflow
6. **`spring({ config: { damping: 200 } })`** for smooth, no-bounce entrances
7. **Stagger = `spring({ frame: frame - i * STAGGER_DELAY, fps })`**
8. **Layering = nested `<AbsoluteFill>` components (last = top)**
9. **Static assets = `staticFile('/path')`** from `public/` folder
10. **Fonts = `@remotion/google-fonts` loaded at module level**
11. **Noise-driven organic motion = `noise2D('seed', x, frame/fps)`**
12. **SVG path drawing = `evolvePath(progress, svgPathD)`**
13. **Motion blur = `<CameraMotionBlur shutterAngle={180} samples={7}>`**
14. **Transform composition = `makeTransform([rotate(x), scale(y), translateX(z)])`**
