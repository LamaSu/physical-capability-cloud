// ---------------------------------------------------------------------------
// Panel Registry — maps panel IDs to lazy-loaded page components
//
// Every entry has:
//   - title: display name shown in panel title bar
//   - component: dynamic import returning { default: ComponentType }
//   - keywords: words that trigger opening this panel from chat
// ---------------------------------------------------------------------------

export interface PanelRegistryEntry {
  title: string;
  component: () => Promise<{ default: React.ComponentType }>;
  keywords: string[];
}

export const panelRegistry: Record<string, PanelRegistryEntry> = {
  dashboard: {
    title: "Dashboard",
    component: () =>
      import("../../pages/DashboardPage.js").then((m) => ({ default: m.DashboardPage })),
    keywords: ["dashboard", "home", "overview", "main", "command center"],
  },
  discover: {
    title: "Discover",
    component: () =>
      import("../../pages/DiscoverPage.js").then((m) => ({ default: m.DiscoverPage })),
    keywords: ["discover", "search", "find capabilities", "explore"],
  },
  build: {
    title: "Build Contract",
    component: () =>
      import("../../pages/BuilderPage.js").then((m) => ({ default: m.BuilderPage })),
    keywords: ["build", "contract", "builder", "create contract"],
  },
  workflow: {
    title: "Workflows",
    component: () =>
      import("../../pages/WorkflowPage.js").then((m) => ({ default: m.WorkflowPage })),
    keywords: ["workflow", "workflows", "dag", "pipeline"],
  },
  jobs: {
    title: "Jobs",
    component: () =>
      import("../../pages/JobsPage.js").then((m) => ({ default: m.JobsPage })),
    keywords: ["jobs", "job", "tasks", "queue", "work"],
  },
  kernels: {
    title: "Kernels",
    component: () =>
      import("../../pages/KernelsPage.js").then((m) => ({ default: m.KernelsPage })),
    keywords: ["kernels", "kernel", "machines", "sites", "shop"],
  },
  escrow: {
    title: "Escrow",
    component: () =>
      import("../../pages/EscrowPage.js").then((m) => ({ default: m.EscrowPage })),
    keywords: ["escrow", "payment", "contract funds"],
  },
  settlement: {
    title: "Settlement",
    component: () =>
      import("../../pages/SettlementPage.js").then((m) => ({ default: m.SettlementPage })),
    keywords: ["settlement", "settle", "milestone"],
  },
  wallet: {
    title: "Wallet",
    component: () =>
      import("../../pages/WalletPage.js").then((m) => ({ default: m.WalletPage })),
    keywords: ["wallet", "balance", "usdc", "funds"],
  },
  agents: {
    title: "Agent Log",
    component: () =>
      import("../../pages/AgentLogPage.js").then((m) => ({ default: m.AgentLogPage })),
    keywords: ["agents", "agent log", "agent", "subnet"],
  },
  settings: {
    title: "Settings",
    component: () =>
      import("../../pages/SettingsPage.js").then((m) => ({ default: m.SettingsPage })),
    keywords: ["settings", "preferences", "config"],
  },
  onboard: {
    title: "Onboard",
    component: () =>
      import("../../pages/OnboardLandingPage.js").then((m) => ({ default: m.OnboardLandingPage })),
    keywords: ["onboard", "add machine", "register"],
  },
  marketplace: {
    title: "Marketplace",
    component: () =>
      import("../../pages/MarketplacePage.js").then((m) => ({ default: m.MarketplacePage })),
    keywords: ["marketplace", "market", "buy", "sell", "listing"],
  },
  spaces: {
    title: "Find Space",
    component: () =>
      import("../../pages/SpaceFinderPage.js").then((m) => ({ default: m.SpaceFinderPage })),
    keywords: ["spaces", "space", "hosting", "find space"],
  },
  operator: {
    title: "Operator",
    component: () =>
      import("../../pages/OperatorDashboardPage.js").then((m) => ({
        default: m.OperatorDashboardPage,
      })),
    keywords: ["operator", "operate", "operator dashboard"],
  },
  revenue: {
    title: "Revenue",
    component: () =>
      import("../../pages/RevenueDashboardPage.js").then((m) => ({
        default: m.RevenueDashboardPage,
      })),
    keywords: ["revenue", "earnings", "income", "money"],
  },
  sensors: {
    title: "Sensors",
    component: () =>
      import("../../pages/SensorDashboardPage.js").then((m) => ({
        default: m.SensorDashboardPage,
      })),
    keywords: ["sensors", "sensor", "readings", "telemetry sensors"],
  },
  batches: {
    title: "Batches",
    component: () =>
      import("../../pages/BatchTrackingPage.js").then((m) => ({ default: m.BatchTrackingPage })),
    keywords: ["batches", "batch", "batch tracking"],
  },
  "batch-board": {
    title: "Batch Board",
    component: () =>
      import("../../pages/BatchBoardPage.js").then((m) => ({ default: m.BatchBoardPage })),
    keywords: ["batch board", "kanban"],
  },
  evidence: {
    title: "Evidence",
    component: () =>
      import("../../pages/EvidenceExplorerPage.js").then((m) => ({
        default: m.EvidenceExplorerPage,
      })),
    keywords: ["evidence", "proof", "verification", "evidence explorer"],
  },
  logs: {
    title: "Process Logs",
    component: () =>
      import("../../pages/ProcessLogsPage.js").then((m) => ({ default: m.ProcessLogsPage })),
    keywords: ["logs", "process logs", "log"],
  },
  logistics: {
    title: "Logistics Hub",
    component: () =>
      import("../../pages/LogisticsHubPage.js").then((m) => ({ default: m.LogisticsHubPage })),
    keywords: ["logistics", "shipping", "logistics hub"],
  },
  orchestrator: {
    title: "Orchestrator",
    component: () =>
      import("../../pages/OrchestratorPage.js").then((m) => ({ default: m.OrchestratorPage })),
    keywords: ["orchestrator", "transfer", "instrument"],
  },
  protocols: {
    title: "Protocol Library",
    component: () =>
      import("../../pages/ProtocolLibraryPage.js").then((m) => ({
        default: m.ProtocolLibraryPage,
      })),
    keywords: ["protocols", "protocol", "library"],
  },
  "protocol-builder": {
    title: "Protocol Builder",
    component: () =>
      import("../../pages/ProtocolBuilderPage.js").then((m) => ({
        default: m.ProtocolBuilderPage,
      })),
    keywords: ["protocol builder", "create protocol"],
  },
  "protocol-runs": {
    title: "Protocol Runs",
    component: () =>
      import("../../pages/ProtocolRunPage.js").then((m) => ({ default: m.ProtocolRunPage })),
    keywords: ["protocol runs", "active runs", "run"],
  },
  subnet: {
    title: "Oracle Network",
    component: () =>
      import("../../pages/SubnetStatusPage.js").then((m) => ({ default: m.SubnetStatusPage })),
    keywords: ["subnet", "oracle", "oracles", "bittensor"],
  },
  depin: {
    title: "DePIN",
    component: () =>
      import("../../pages/DePINDashboardPage.js").then((m) => ({
        default: m.DePINDashboardPage,
      })),
    keywords: ["depin", "decentralized", "nft", "certificates"],
  },
  swf: {
    title: "Sovereign Wealth Fund",
    component: () =>
      import("../../pages/SWFDashboardPage.js").then((m) => ({ default: m.SWFDashboardPage })),
    keywords: ["swf", "wealth fund", "sovereign", "treasury"],
  },
  ip: {
    title: "IP Revenue",
    component: () =>
      import("../../pages/IPRevenuePage.js").then((m) => ({ default: m.IPRevenuePage })),
    keywords: ["ip", "intellectual property", "ip revenue", "royalties"],
  },
  telemetry: {
    title: "Telemetry",
    component: () =>
      import("../../pages/TelemetryPage.js").then((m) => ({ default: m.TelemetryPage })),
    keywords: ["telemetry", "metrics"],
  },
  traces: {
    title: "Traces",
    component: () =>
      import("../../pages/TracesPage.js").then((m) => ({ default: m.TracesPage })),
    keywords: ["traces", "trace", "span"],
  },
  negotiate: {
    title: "Negotiations",
    component: () =>
      import("../../pages/NegotiationPage.js").then((m) => ({ default: m.NegotiationPage })),
    keywords: ["negotiate", "negotiation", "deal"],
  },
  "negotiate-session": {
    title: "Negotiation Session",
    component: () =>
      import("../../pages/NegotiationSessionPage.js").then((m) => ({
        default: m.NegotiationSessionPage,
      })),
    keywords: ["negotiation session", "session"],
  },
  setup: {
    title: "Setup Wizard",
    component: () =>
      import("../../pages/SetupWizardPage.js").then((m) => ({ default: m.SetupWizardPage })),
    keywords: ["setup", "wizard", "install"],
  },
  "device-builder": {
    title: "Device Builder",
    component: () =>
      import("../../pages/DeviceBuilderPage.js").then((m) => ({ default: m.DeviceBuilderPage })),
    keywords: ["device builder", "new device"],
  },
  roi: {
    title: "ROI Calculator",
    component: () =>
      import("../../pages/ROICalculatorPage.js").then((m) => ({ default: m.ROICalculatorPage })),
    keywords: ["roi", "calculator", "return on investment"],
  },
  "agent-package": {
    title: "Agent Package",
    component: () =>
      import("../../pages/AgentPackagePage.js").then((m) => ({ default: m.AgentPackagePage })),
    keywords: ["agent package", "package", "tools"],
  },
  "onboard-kit": {
    title: "Onboard Kit",
    component: () =>
      import("../../pages/OnboardKitPage.js").then((m) => ({ default: m.OnboardKitPage })),
    keywords: ["onboard kit", "kit"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get all panel IDs as a list */
export function panelIds(): string[] {
  return Object.keys(panelRegistry);
}

/** Find a panel entry by keyword (fuzzy match) */
export function findPanelByKeyword(input: string): PanelRegistryEntry & { id: string } | null {
  const lower = input.toLowerCase().trim();

  // Direct ID match first
  if (panelRegistry[lower]) {
    return { id: lower, ...panelRegistry[lower] };
  }

  // Keyword search
  let bestMatch: (PanelRegistryEntry & { id: string }) | null = null;
  let bestScore = 0;

  for (const [id, entry] of Object.entries(panelRegistry)) {
    for (const kw of entry.keywords) {
      if (lower === kw) {
        return { id, ...entry }; // Exact keyword match
      }
      if (lower.includes(kw) || kw.includes(lower)) {
        const score = kw.length; // Longer keyword match = better
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { id, ...entry };
        }
      }
    }
  }

  return bestMatch;
}
