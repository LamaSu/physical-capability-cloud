import React from "react";
import { cn } from "../utils.js";

export interface AgentAvatarProps {
  role: "user" | "broker" | "kernel" | "verifier" | "scheduler" | "courier" | "arbiter";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const roleIcons: Record<string, string> = {
  user: "👤",
  broker: "🤖",
  kernel: "🏭",
  verifier: "🔍",
  scheduler: "📊",
  courier: "📦",
  arbiter: "⚖️",
};

const roleColors: Record<string, string> = {
  user: "bg-green-500/15 border-green-500/20",
  broker: "bg-gold-400/15 border-gold-400/20",
  kernel: "bg-white/[0.06] border-white/[0.08]",
  verifier: "bg-blue-500/15 border-blue-500/20",
};

const sizeMap = { sm: "w-7 h-7 text-sm", md: "w-9 h-9 text-lg", lg: "w-12 h-12 text-xl" };

export function AgentAvatar({ role, size = "md", className }: AgentAvatarProps) {
  return (
    <div
      className={cn(
        "rounded-full border flex items-center justify-center flex-shrink-0",
        roleColors[role] ?? "bg-white/[0.04] border-white/[0.08]",
        sizeMap[size],
        className,
      )}
    >
      {roleIcons[role] ?? "❓"}
    </div>
  );
}
