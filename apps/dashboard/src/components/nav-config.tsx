import React from "react";
import type { NavGroup } from "@pcc/ui";
import {
  DashboardIcon,
  DiscoverIcon,
  BuildIcon,
  WorkflowIcon,
  JobsIcon,
  KernelsIcon,
  EscrowIcon,
  AgentsIcon,
  SettingsIcon,
  OnboardIcon,
  MarketplaceIcon,
  SpaceFinderIcon,
  OperatorIcon,
  SensorIcon,
  BatchIcon,
  EvidenceIcon,
  LogsIcon,
  LogisticsIcon,
} from "./nav-icons.js";

export const navGroups: NavGroup[] = [
  {
    title: "Ground Control",
    items: [
      { label: "Dashboard", path: "/", icon: <DashboardIcon /> },
    ],
  },
  {
    title: "Manufacturing",
    items: [
      { label: "Discover", path: "/discover", icon: <DiscoverIcon /> },
      { label: "Build Contract", path: "/build", icon: <BuildIcon /> },
      { label: "Workflows", path: "/workflow", icon: <WorkflowIcon /> },
      { label: "Jobs", path: "/jobs", icon: <JobsIcon /> },
    ],
  },
  {
    title: "Onboarding",
    items: [
      { label: "Add Machine", path: "/onboard", icon: <OnboardIcon /> },
      { label: "Marketplace", path: "/marketplace", icon: <MarketplaceIcon /> },
      { label: "Find Space", path: "/spaces", icon: <SpaceFinderIcon /> },
      { label: "Operator", path: "/operator", icon: <OperatorIcon /> },
    ],
  },
  {
    title: "Logistics",
    items: [
      { label: "Logistics Hub", path: "/logistics", icon: <LogisticsIcon /> },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { label: "Sensors", path: "/sensors", icon: <SensorIcon /> },
      { label: "Batches", path: "/batches", icon: <BatchIcon /> },
      { label: "Evidence", path: "/evidence", icon: <EvidenceIcon /> },
      { label: "Process Logs", path: "/logs", icon: <LogsIcon /> },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { label: "Kernels", path: "/kernels", icon: <KernelsIcon /> },
      { label: "Escrow", path: "/escrow", icon: <EscrowIcon /> },
    ],
  },
  {
    title: "Network",
    items: [
      { label: "Agent Log", path: "/agents", icon: <AgentsIcon /> },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Settings", path: "/settings", icon: <SettingsIcon /> },
    ],
  },
];
