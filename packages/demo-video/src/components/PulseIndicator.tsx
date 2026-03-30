import React from "react";
import { useCurrentFrame, interpolate } from "remotion";

export const PulseIndicator: React.FC<{
  color?: string;
  size?: number;
  delay?: number;
}> = ({ color = "#34d399", size = 10, delay = 0 }) => {
  const frame = useCurrentFrame();
  const adjusted = Math.max(0, frame - delay);
  const pulse = interpolate(Math.sin(adjusted * 0.15), [-1, 1], [0.4, 1]);

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: color,
        boxShadow: `0 0 ${size}px ${color}`,
        opacity: pulse,
        display: "inline-block",
      }}
    />
  );
};
