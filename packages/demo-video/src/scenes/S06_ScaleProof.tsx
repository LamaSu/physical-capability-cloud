/**
 * S06_ScaleProof — Counter Slam (330 frames / 11s)
 * 4 metric counters in a 2x2 grid. Discord #3: tests counter red→green.
 */
import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { C, F, SIZE, SafeFrame, VStack, HStack, Panel, T, Reveal, Spacer, countTo } from "../lib";

const lerpColor = (from: string, to: string, t: number): string => {
  const p = (h: string) => { const x = h.replace("#", ""); return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]; };
  const [r1, g1, b1] = p(from);
  const [r2, g2, b2] = p(to);
  const c = (n: number) => Math.round(Math.max(0, Math.min(255, n)));
  return `rgb(${c(r1 + (r2 - r1) * t)},${c(g1 + (g2 - g1) * t)},${c(b1 + (b2 - b1) * t)})`;
};

const Metric: React.FC<{
  value: string;
  label: string;
  color: string;
  border?: string;
}> = ({ value, label, color, border }) => (
  <Panel flex={1} padding={28} bg={C.surface} border={border || `1px solid ${C.border}`}>
    <VStack gap={8} align="center">
      <T font={F.brutalist} size={72} color={color} weight={700} align="center">{value}</T>
      <T font={F.swiss} size={36} color={C.muted} weight={500} align="center" uppercase tracking="0.1em">{label}</T>
    </VStack>
  </Panel>
);

export const S06_ScaleProof: React.FC = () => {
  const frame = useCurrentFrame();
  const c1 = countTo(frame, 3000, 90, 0);
  const colorT = interpolate(frame, [75, 90], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const c1Color = lerpColor(C.discord, C.accent1, colorT);
  const c2 = countTo(frame, 154, 90, 20);
  const c3 = countTo(frame, 347, 90, 40);

  return (
    <SafeFrame justify="center" gap={40}>
      {/* Row 1: Tests + Tools */}
      <HStack gap={32} align="stretch">
        <Reveal at={0} type="slam"><Metric value={`${c1.toLocaleString()}+`} label="Tests" color={c1Color} /></Reveal>
        <Reveal at={20} type="slam"><Metric value={`${c2}`} label="Agent Tools" color={C.accent2} /></Reveal>
      </HStack>

      {/* Row 2: Endpoints + Apache */}
      <HStack gap={32} align="stretch">
        <Reveal at={40} type="slam"><Metric value={`${c3}`} label="Endpoints" color={C.accent2} /></Reveal>
        <Reveal at={60} type="slam"><Metric value="Apache 2.0" label="Open Forever" color={C.accent1} border={`2px solid ${C.accent1}`} /></Reveal>
      </HStack>

      <Spacer height={16} />
      <Reveal at={180}>
        <T font={F.swiss} size={SIZE.body} color={C.fg} align="center" weight={500}>
          25 packages. One protocol. Live at capability.network.
        </T>
      </Reveal>
    </SafeFrame>
  );
};

export default S06_ScaleProof;
