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
  SetupIcon,
  NewDeviceIcon,
  OrchestratorIcon,
  ProtocolLibraryIcon,
  ProtocolBuilderIcon,
  ProtocolRunIcon,
  SubnetIcon,
  DePINIcon,
  SWFIcon,
  TelemetryIcon,
  TracesIcon,
  NegotiationIcon,
  IPRevenueIcon,
  WalletIcon,
  BatchBoardIcon,
  NegotiationSessionIcon,
  AgentPackageIcon,
  SponsorIcon,
  SystemDashboardIcon,
} from "./nav-icons.js";

export const navGroups: NavGroup[] = [
  {
    title: "Command Center",
    items: [
      { label: "Dashboard", path: "/", icon: <DashboardIcon /> },
    ],
  },
  {
    title: "Workflows",
    items: [
      { label: "Discover", path: "/discover", icon: <DiscoverIcon /> },
      { label: "Build Contract", path: "/build", icon: <BuildIcon /> },
      { label: "Negotiations", path: "/negotiate", icon: <NegotiationIcon /> },
      { label: "Neg. Sessions", path: "/negotiate/session", icon: <NegotiationSessionIcon /> },
      { label: "New Device", path: "/build/new-device", icon: <NewDeviceIcon /> },
      { label: "Workflows", path: "/workflow", icon: <WorkflowIcon /> },
      { label: "Jobs", path: "/jobs", icon: <JobsIcon /> },
    ],
  },
  {
    title: "Onboarding",
    items: [
      { label: "Add Machine", path: "/onboard", icon: <OnboardIcon /> },
      { label: "Onboard Kit", path: "/onboard/kit", icon: <OnboardIcon /> },
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
    title: "Protocols",
    items: [
      { label: "Protocol Library", path: "/protocols", icon: <ProtocolLibraryIcon /> },
      { label: "Protocol Builder", path: "/protocols/new", icon: <ProtocolBuilderIcon /> },
      { label: "Active Runs", path: "/protocol-runs", icon: <ProtocolRunIcon /> },
    ],
  },
  {
    title: "Monitoring",
    items: [
      { label: "Telemetry", path: "/telemetry", icon: <TelemetryIcon /> },
      { label: "Traces", path: "/traces", icon: <TracesIcon /> },
      { label: "Sensors", path: "/sensors", icon: <SensorIcon /> },
      { label: "Batches", path: "/batches", icon: <BatchIcon /> },
      { label: "Batch Board", path: "/batch-board", icon: <BatchBoardIcon /> },
      { label: "Evidence", path: "/evidence", icon: <EvidenceIcon /> },
      { label: "Process Logs", path: "/logs", icon: <LogsIcon /> },
      { label: "Orchestrator", path: "/orchestrator", icon: <OrchestratorIcon /> },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { label: "Kernels", path: "/kernels", icon: <KernelsIcon /> },
      { label: "Wallet", path: "/wallet", icon: <WalletIcon /> },
      { label: "Escrow", path: "/escrow", icon: <EscrowIcon /> },
      { label: "Settlement", path: "/settlement", icon: <EscrowIcon /> },
    ],
  },
  {
    title: "Network",
    items: [
      { label: "Agent Log", path: "/agents", icon: <AgentsIcon /> },
      { label: "Agent Package", path: "/agent-package", icon: <AgentPackageIcon /> },
    ],
  },
  {
    title: "Sovereign",
    items: [
      { label: "Oracles", path: "/subnet", icon: <SubnetIcon /> },
      { label: "DePIN", path: "/depin", icon: <DePINIcon /> },
      { label: "Wealth Fund", path: "/swf", icon: <SWFIcon /> },
      { label: "IP Revenue", path: "/ip", icon: <IPRevenueIcon /> },
    ],
  },
  {
    title: "Hackathon",
    items: [
      { label: "System Dashboard", path: "/system", icon: <SystemDashboardIcon /> },
      { label: "Sponsor Telemetry", path: "/sponsors", icon: <SponsorIcon /> },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Setup Wizard", path: "/setup", icon: <SetupIcon /> },
      { label: "Settings", path: "/settings", icon: <SettingsIcon /> },
    ],
  },
];
