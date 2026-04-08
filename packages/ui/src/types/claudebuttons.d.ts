/** Type declarations for claudebuttons Web Component library */

declare module "claudebuttons/react" {
  import type { FC } from "react";

  export interface ClaudeButtonProps {
    command: string;
    variant?: "filled" | "outline" | "ghost";
    theme?: "branded" | "branded-alt" | "dark" | "light" | "system";
    shape?: "rounded" | "pill" | "square";
    size?: "sm" | "md" | "lg";
    autoLaunch?: boolean;
    className?: string;
    style?: React.CSSProperties;
  }

  export const ClaudeCodeButton: FC<ClaudeButtonProps>;
  export const CoworkButton: FC<ClaudeButtonProps>;
}

declare module "claudebuttons" {
  export interface ButtonConfig {
    command: string;
    variant?: "filled" | "outline" | "ghost";
    theme?: "branded" | "branded-alt" | "dark" | "light" | "system";
    shape?: "rounded" | "pill" | "square";
    size?: "sm" | "md" | "lg";
  }

  export function createClaudeCodeButton(config: ButtonConfig): HTMLElement;
  export function createCoworkButton(config: ButtonConfig): HTMLElement;
  export function injectStructuredData(): void;
}
