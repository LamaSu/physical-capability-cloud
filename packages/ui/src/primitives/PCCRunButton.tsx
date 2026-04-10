import React, { useCallback, useEffect, useRef } from "react";
import { cn } from "../utils.js";
import { ClaudeCodeButton, CoworkButton } from "claudebuttons/react";

export interface PCCRunButtonProps {
  /** The CLI command to run in Claude Code */
  command: string;
  /** Button mode — claude-code launches a command, cowork starts collaboration */
  mode?: "claude-code" | "cowork";
  /** Visual variant */
  variant?: "filled" | "outline" | "ghost";
  /** Button shape */
  shape?: "rounded" | "pill" | "square";
  /** Size */
  size?: "sm" | "md" | "lg";
  /** Auto-launch Claude Desktop when available */
  autoLaunch?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Event callbacks — wire these to PostHog or your analytics pipeline */
  onCopy?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  onDownload?: () => void;
  onLaunchDesktop?: () => void;
}

/**
 * PCC-themed wrapper around claudebuttons — "Run on Claude Code" / "Run on Cowork"
 * buttons with Solarpunk Ground Control styling (emerald glow, glass morphism).
 *
 * @example
 * <PCCRunButton command="pcc negotiate --capability hplc-analysis" />
 * <PCCRunButton command="pcc setup" mode="cowork" variant="outline" />
 */
export function PCCRunButton({
  command,
  mode = "claude-code",
  variant = "filled",
  shape = "pill",
  size = "md",
  autoLaunch = false,
  className,
  onCopy,
  onOpen,
  onClose,
  onDownload,
  onLaunchDesktop,
}: PCCRunButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Wire claudebuttons custom events to callback props
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handlers: Array<[string, () => void]> = [];
    if (onCopy) handlers.push(["cb-copy", onCopy]);
    if (onOpen) handlers.push(["cb-open", onOpen]);
    if (onClose) handlers.push(["cb-close", onClose]);
    if (onDownload) handlers.push(["cb-download", onDownload]);
    if (onLaunchDesktop) handlers.push(["cb-launch-desktop", onLaunchDesktop]);

    for (const [event, handler] of handlers) {
      el.addEventListener(event, handler);
    }

    return () => {
      for (const [event, handler] of handlers) {
        el.removeEventListener(event, handler);
      }
    };
  }, [onCopy, onOpen, onClose, onDownload, onLaunchDesktop]);

  const ButtonComponent = mode === "cowork" ? CoworkButton : ClaudeCodeButton;

  return (
    <div
      ref={containerRef}
      className={cn("inline-flex", className)}
      style={{
        // PCC Solarpunk theme overrides via CSS custom properties
        // claudebuttons reads these for theming
        ["--cb-bg" as string]: "rgba(255, 255, 255, 0.04)",
        ["--cb-border" as string]: "rgba(0, 255, 136, 0.25)",
        ["--cb-accent" as string]: "#00ff88",
        ["--cb-text" as string]: "rgba(255, 255, 255, 0.9)",
        ["--cb-hover-bg" as string]: "rgba(0, 255, 136, 0.12)",
        ["--cb-hover-border" as string]: "rgba(0, 255, 136, 0.4)",
        ["--cb-hover-shadow" as string]: "0 0 20px rgba(0, 255, 136, 0.25)",
        ["--cb-radius" as string]: shape === "pill" ? "9999px" : shape === "square" ? "0px" : "12px",
        ["--cb-font" as string]: "'JetBrains Mono', ui-monospace, monospace",
      }}
    >
      <ButtonComponent
        command={command}
        variant={variant}
        theme="dark"
        shape={shape}
        size={size}
        autoLaunch={autoLaunch}
      />
    </div>
  );
}
