import React from "react";
import { cn } from "../utils.js";

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-white/[0.06]", className)} />
  );
}
