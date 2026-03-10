import React from "react";

// Minimal inline SVG icons for sidebar navigation (no external dependency)
const icon = (d: string) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const DashboardIcon = () => icon("M3 10l7-7 7 7M5 8v8a1 1 0 001 1h3v-5h2v5h3a1 1 0 001-1V8");
export const DiscoverIcon = () => icon("M10 17a7 7 0 100-14 7 7 0 000 14zM14 14l3 3");
export const BuildIcon = () => icon("M4 6h12M4 10h12M4 14h8");
export const WorkflowIcon = () => icon("M4 4h4v4H4zM12 4h4v4h-4zM8 12h4v4H8zM6 8v4h2M14 8v-0l-2 4");
export const JobsIcon = () => icon("M4 4h12v12H4zM4 8h12M8 8v8");
export const KernelsIcon = () => icon("M3 5a2 2 0 012-2h10a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2V5zM3 12a2 2 0 012-2h10a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-3zM7 6h0M7 13h0");
export const EscrowIcon = () => icon("M10 2l2 4h4l-3 3 1 4-4-2-4 2 1-4-3-3h4l2-4z");
export const AgentsIcon = () => icon("M4 14s1-2 6-2 6 2 6 2M10 10a3 3 0 100-6 3 3 0 000 6z");
export const SettingsIcon = () => icon("M10 13a3 3 0 100-6 3 3 0 000 6zM16.5 10a6.5 6.5 0 01-.4 2.2l1.5 1.2-1.2 2-1.8-.6a6.5 6.5 0 01-1.9 1.1l-.4 1.9h-2.4l-.4-1.9a6.5 6.5 0 01-1.9-1.1l-1.8.6-1.2-2 1.5-1.2A6.5 6.5 0 013.5 10a6.5 6.5 0 01.4-2.2L2.4 6.6l1.2-2 1.8.6A6.5 6.5 0 017.3 4.1l.4-1.9h2.4l.4 1.9a6.5 6.5 0 011.9 1.1l1.8-.6 1.2 2-1.5 1.2a6.5 6.5 0 01.6 2.2z");
export const OnboardIcon = () => icon("M12 4v8m0 0l-3-3m3 3l3-3M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2");
export const MarketplaceIcon = () => icon("M3 3h14l-1.5 9H4.5L3 3zM7 17a1 1 0 100-2 1 1 0 000 2zM14 17a1 1 0 100-2 1 1 0 000 2z");
export const SpaceFinderIcon = () => icon("M3 10l7-7 7 7v7a1 1 0 01-1 1H4a1 1 0 01-1-1v-7zM9 17v-5h2v5");
export const OperatorIcon = () => icon("M10 10a3 3 0 100-6 3 3 0 000 6zM3 18a7 7 0 0114 0M15 6l2 2 3-3");
export const SensorIcon = () => icon("M3 10h2l2-5 3 10 3-10 2 5h2");
export const BatchIcon = () => icon("M4 4h12v3H4zM4 9h12v3H4zM4 14h12v3H4zM7 5.5h0M7 10.5h0M7 15.5h0");
export const EvidenceIcon = () => icon("M6 3h8l3 3v11a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1zM14 3v3h3M8 9h4M8 12h4M8 15h2");
export const LogsIcon = () => icon("M4 5h12M4 8h10M4 11h12M4 14h8M4 17h10");
export const LogisticsIcon = () => icon("M3 13h4l2-3h2l2 3h4M5 17h10M7 9V5h6v4M10 5V3");
export const ShipmentIcon = () => icon("M3 10h14l-2 6H5l-2-6zM6 10V6h8v4M10 6V3M7 13h0M13 13h0");
export const InstallIcon = () => icon("M10 3v4M6 5l1.5 2.5M14 5l-1.5 2.5M4 10h12v7H4v-7zM7 13h6M10 10v7");
export const SetupIcon = () => icon("M10 2v4M4 6l2 2M16 6l-2 2M10 18v-4M4 14l2-2M16 14l-2-2M6 10H2M18 10h-4");
export const NewDeviceIcon = () => icon("M10 3v14M3 10h14M5 5l10 10M15 5L5 15");
export const OrchestratorIcon = () => icon("M4 6a2 2 0 104 0 2 2 0 00-4 0M12 6a2 2 0 104 0 2 2 0 00-4 0M8 14a2 2 0 104 0 2 2 0 00-4 0M6 8l4 4M14 8l-4 4");
export const ProtocolLibraryIcon = () => icon("M4 3h9v14H4zM7 3v14M13 5h3v10h-3M7 7h4M7 10h4M7 13h3");
export const ProtocolBuilderIcon = () => icon("M6 3l-2 4h4l-2-4zM14 3l-2 4h4l-2-4zM10 11l-2 4h4l-2-4zM6 7v2l4 2M14 7v2l-4 2M4 17h12");
export const ProtocolRunIcon = () => icon("M7 4l8 6-8 6V4zM3 10h1M16 10h1M10 3v1M10 16v1");
