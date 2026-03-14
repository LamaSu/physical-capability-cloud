import { type CSSProperties } from "react";

export interface BorderBeamProps {
  size?: number;
  duration?: number;
  delay?: number;
  colorFrom?: string;
  colorTo?: string;
  className?: string;
}

export function BorderBeam({
  size = 200,
  duration = 12,
  delay = 0,
  colorFrom = "#00BFA5",
  colorTo = "#7CB342",
  className = "",
}: BorderBeamProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 rounded-[inherit] ${className}`}
      style={{
        "--size": `${size}px`,
        "--duration": `${duration}s`,
        "--delay": `${delay}s`,
        "--color-from": colorFrom,
        "--color-to": colorTo,
      } as CSSProperties}
    >
      <div
        className="absolute inset-0 rounded-[inherit]"
        style={{
          background: `conic-gradient(from calc(var(--angle, 0deg)), transparent 80%, var(--color-from), var(--color-to), transparent 100%)`,
          mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          maskComposite: "exclude",
          padding: "1px",
          animation: `border-beam-spin var(--duration) linear var(--delay) infinite`,
        }}
      />
    </div>
  );
}
