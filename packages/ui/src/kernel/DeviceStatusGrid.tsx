import React from "react";
import type { KernelDevice } from "@pcc/spec";
import { PulseIndicator } from "../primitives/PulseIndicator.js";
import { cn } from "../utils.js";

export interface DeviceStatusGridProps {
  devices: KernelDevice[];
  className?: string;
}

const deviceTypeIcons: Record<KernelDevice["type"], string> = {
  machine: "⚙️",
  sensor: "📡",
  camera: "📷",
  robot: "🤖",
  tee: "🔐",
};

const statusToPulse: Record<KernelDevice["status"], "online" | "executing" | "failed" | "offline"> = {
  idle: "online",
  busy: "executing",
  error: "failed",
  offline: "offline",
  maintenance: "executing",
};

export function DeviceStatusGrid({ devices, className }: DeviceStatusGridProps) {
  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      {devices.map((device) => (
        <div
          key={device.id}
          className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]"
        >
          <span className="text-lg">{deviceTypeIcons[device.type]}</span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-white/70 truncate">{device.model}</div>
            <div className="text-[10px] text-white/30 font-mono">{device.type} · {device.firmware}</div>
          </div>
          <PulseIndicator status={statusToPulse[device.status]} size="sm" />
        </div>
      ))}
    </div>
  );
}
