import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { noise2D } from "@remotion/noise";

const PARTICLE_COUNT = 50;

export const ParticleField: React.FC<{ opacity?: number }> = ({
  opacity = 0.4,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  return (
    <svg
      width={width}
      height={height}
      style={{ position: "absolute", top: 0, left: 0, opacity }}
    >
      {Array.from({ length: PARTICLE_COUNT }, (_, i) => {
        const baseX = (noise2D(`x-${i}`, i * 0.1, 0) * 0.5 + 0.5) * width;
        const baseY = (noise2D(`y-${i}`, 0, i * 0.1) * 0.5 + 0.5) * height;
        const driftX = noise2D(`dx-${i}`, t * 0.3, i * 0.1) * 40;
        const driftY = noise2D(`dy-${i}`, i * 0.1, t * 0.3) * 30;
        const size = 2 + noise2D(`s-${i}`, i * 0.2, t * 0.5) * 2;
        const alpha = Math.max(
          0.05,
          0.2 + noise2D(`a-${i}`, t * 0.2, i * 0.1) * 0.3,
        );

        const cx = baseX + driftX;
        const cy = baseY + driftY;

        return (
          <g key={i}>
            <circle
              cx={cx}
              cy={cy}
              r={size * 4}
              fill={`rgba(0, 255, 136, ${alpha * 0.15})`}
            />
            <circle
              cx={cx}
              cy={cy}
              r={size}
              fill={`rgba(124, 179, 66, ${alpha})`}
            />
          </g>
        );
      })}
    </svg>
  );
};
