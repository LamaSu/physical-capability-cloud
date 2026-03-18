import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell, Sidebar, TopBar, StatusBar, ParticleBackground } from "@pcc/ui";
import { navGroups } from "./components/nav-config.js";
import { useUIStore } from "./stores/ui-store.js";
import { PageTransition } from "./components/PageTransition.js";
import { NotificationToasts } from "./components/NotificationToasts.js";
import { OnboardingTour, TourRestartButton } from "./components/OnboardingTour.js";
import { WalletProvider } from "./providers/WalletProvider.js";
import { ConnectWallet } from "./components/ConnectWallet.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ModeToggle } from "./components/ModeToggle.js";

// ---------------------------------------------------------------------------
// Lazy-loaded pages (code-split per route)
// ---------------------------------------------------------------------------

const AgentChatPage = lazy(() => import("./pages/AgentChatPage.js").then(m => ({ default: m.AgentChatPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage.js").then(m => ({ default: m.DashboardPage })));
const DiscoverPage = lazy(() => import("./pages/DiscoverPage.js").then(m => ({ default: m.DiscoverPage })));
const BuilderPage = lazy(() => import("./pages/BuilderPage.js").then(m => ({ default: m.BuilderPage })));
const WorkflowPage = lazy(() => import("./pages/WorkflowPage.js").then(m => ({ default: m.WorkflowPage })));
const JobsPage = lazy(() => import("./pages/JobsPage.js").then(m => ({ default: m.JobsPage })));
const JobDetailPage = lazy(() => import("./pages/JobDetailPage.js").then(m => ({ default: m.JobDetailPage })));
const KernelsPage = lazy(() => import("./pages/KernelsPage.js").then(m => ({ default: m.KernelsPage })));
const KernelDetailPage = lazy(() => import("./pages/KernelDetailPage.js").then(m => ({ default: m.KernelDetailPage })));
const EscrowPage = lazy(() => import("./pages/EscrowPage.js").then(m => ({ default: m.EscrowPage })));
const AgentLogPage = lazy(() => import("./pages/AgentLogPage.js").then(m => ({ default: m.AgentLogPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage.js").then(m => ({ default: m.SettingsPage })));
const OnboardLandingPage = lazy(() => import("./pages/OnboardLandingPage.js").then(m => ({ default: m.OnboardLandingPage })));
const OnboardWizardPage = lazy(() => import("./pages/OnboardWizardPage.js").then(m => ({ default: m.OnboardWizardPage })));
const MarketplacePage = lazy(() => import("./pages/MarketplacePage.js").then(m => ({ default: m.MarketplacePage })));
const MarketplaceDetailPage = lazy(() => import("./pages/MarketplaceDetailPage.js").then(m => ({ default: m.MarketplaceDetailPage })));
const ROICalculatorPage = lazy(() => import("./pages/ROICalculatorPage.js").then(m => ({ default: m.ROICalculatorPage })));
const SpaceFinderPage = lazy(() => import("./pages/SpaceFinderPage.js").then(m => ({ default: m.SpaceFinderPage })));
const SpaceDetailPage = lazy(() => import("./pages/SpaceDetailPage.js").then(m => ({ default: m.SpaceDetailPage })));
const OperatorDashboardPage = lazy(() => import("./pages/OperatorDashboardPage.js").then(m => ({ default: m.OperatorDashboardPage })));
const OperatorMachineDetailPage = lazy(() => import("./pages/OperatorMachineDetailPage.js").then(m => ({ default: m.OperatorMachineDetailPage })));
const RevenueDashboardPage = lazy(() => import("./pages/RevenueDashboardPage.js").then(m => ({ default: m.RevenueDashboardPage })));
const SensorDashboardPage = lazy(() => import("./pages/SensorDashboardPage.js").then(m => ({ default: m.SensorDashboardPage })));
const BatchTrackingPage = lazy(() => import("./pages/BatchTrackingPage.js").then(m => ({ default: m.BatchTrackingPage })));
const EvidenceExplorerPage = lazy(() => import("./pages/EvidenceExplorerPage.js").then(m => ({ default: m.EvidenceExplorerPage })));
const ProcessLogsPage = lazy(() => import("./pages/ProcessLogsPage.js").then(m => ({ default: m.ProcessLogsPage })));
const LogisticsHubPage = lazy(() => import("./pages/LogisticsHubPage.js").then(m => ({ default: m.LogisticsHubPage })));
const ShipmentDetailPage = lazy(() => import("./pages/ShipmentDetailPage.js").then(m => ({ default: m.ShipmentDetailPage })));
const SpaceBookingsPage = lazy(() => import("./pages/SpaceBookingsPage.js").then(m => ({ default: m.SpaceBookingsPage })));
const InstallationDetailPage = lazy(() => import("./pages/InstallationDetailPage.js").then(m => ({ default: m.InstallationDetailPage })));
const DeviceBuilderPage = lazy(() => import("./pages/DeviceBuilderPage.js").then(m => ({ default: m.DeviceBuilderPage })));
const SetupWizardPage = lazy(() => import("./pages/SetupWizardPage.js").then(m => ({ default: m.SetupWizardPage })));
const OrchestratorPage = lazy(() => import("./pages/OrchestratorPage.js").then(m => ({ default: m.OrchestratorPage })));
const OrchestratorDetailPage = lazy(() => import("./pages/OrchestratorDetailPage.js").then(m => ({ default: m.OrchestratorDetailPage })));
const ProtocolLibraryPage = lazy(() => import("./pages/ProtocolLibraryPage.js").then(m => ({ default: m.ProtocolLibraryPage })));
const ProtocolDetailPage = lazy(() => import("./pages/ProtocolDetailPage.js").then(m => ({ default: m.ProtocolDetailPage })));
const ProtocolBuilderPage = lazy(() => import("./pages/ProtocolBuilderPage.js").then(m => ({ default: m.ProtocolBuilderPage })));
const ProtocolRunPage = lazy(() => import("./pages/ProtocolRunPage.js").then(m => ({ default: m.ProtocolRunPage })));
const SubnetStatusPage = lazy(() => import("./pages/SubnetStatusPage.js").then(m => ({ default: m.SubnetStatusPage })));
const DePINDashboardPage = lazy(() => import("./pages/DePINDashboardPage.js").then(m => ({ default: m.DePINDashboardPage })));
const SettlementPage = lazy(() => import("./pages/SettlementPage.js").then(m => ({ default: m.SettlementPage })));
const OnboardKitPage = lazy(() => import("./pages/OnboardKitPage.js").then(m => ({ default: m.OnboardKitPage })));

// ---------------------------------------------------------------------------
// Loading fallback
// ---------------------------------------------------------------------------

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-pulse text-emerald-400/60 text-sm tracking-wide">Loading…</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Query client
// ---------------------------------------------------------------------------

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// ---------------------------------------------------------------------------
// Agent Chat Shell — full-height chat, no sidebar
// ---------------------------------------------------------------------------

function AgentShell() {
  const { currentPageTitle, currentPageSubtitle } = useUIStore();

  return (
    <div className="flex flex-col h-screen bg-black/90 relative">
      <ParticleBackground />
      <div className="relative z-10 flex flex-col h-full">
        {/* Minimal top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06] bg-black/40 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="text-sm font-medium text-white/70">{currentPageTitle}</div>
            {currentPageSubtitle && (
              <div className="text-xs text-white/30">{currentPageSubtitle}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle />
            <ConnectWallet />
          </div>
        </div>
        {/* Chat content */}
        <Suspense fallback={<PageLoader />}>
          <AgentChatPage />
        </Suspense>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Shell — full 45-page shell with sidebar
// ---------------------------------------------------------------------------

function DashboardShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarCollapsed, toggleSidebar, currentPageTitle, currentPageSubtitle } = useUIStore();

  return (
    <>
      <AppShell
        particles={<ParticleBackground />}
        sidebar={
          <Sidebar
            groups={navGroups}
            currentPath={location.pathname}
            onNavigate={navigate}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
          />
        }
        topBar={
          <TopBar
            title={currentPageTitle}
            subtitle={currentPageSubtitle}
            actions={<><ModeToggle /><ConnectWallet /><TourRestartButton /></>}
          />
        }
        statusBar={<StatusBar kernelsOnline={2} activeJobs={3} networkStatus="connected" />}
      >
        <PageTransition>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/discover" element={<DiscoverPage />} />
              <Route path="/build" element={<BuilderPage />} />
              <Route path="/build/new-device" element={<DeviceBuilderPage />} />
              <Route path="/build/:type" element={<BuilderPage />} />
              <Route path="/workflow" element={<WorkflowPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/jobs/:jobId" element={<JobDetailPage />} />
              <Route path="/kernels" element={<KernelsPage />} />
              <Route path="/kernels/:kernelId" element={<KernelDetailPage />} />
              <Route path="/escrow" element={<EscrowPage />} />
              <Route path="/settlement" element={<SettlementPage />} />
              <Route path="/agents" element={<AgentLogPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/onboard" element={<OnboardLandingPage />} />
              <Route path="/onboard/kit" element={<OnboardKitPage />} />
              <Route path="/onboard/wizard" element={<OnboardWizardPage />} />
              <Route path="/onboard/wizard/:step" element={<OnboardWizardPage />} />
              <Route path="/marketplace" element={<MarketplacePage />} />
              <Route path="/marketplace/roi" element={<ROICalculatorPage />} />
              <Route path="/marketplace/:classId" element={<MarketplaceDetailPage />} />
              <Route path="/spaces" element={<SpaceFinderPage />} />
              <Route path="/spaces/:spaceId" element={<SpaceDetailPage />} />
              <Route path="/operator" element={<OperatorDashboardPage />} />
              <Route path="/operator/revenue" element={<RevenueDashboardPage />} />
              <Route path="/operator/:machineId" element={<OperatorMachineDetailPage />} />
              <Route path="/sensors" element={<SensorDashboardPage />} />
              <Route path="/sensors/:kernelId" element={<SensorDashboardPage />} />
              <Route path="/batches" element={<BatchTrackingPage />} />
              <Route path="/batches/:batchId" element={<BatchTrackingPage />} />
              <Route path="/evidence" element={<EvidenceExplorerPage />} />
              <Route path="/evidence/:bundleId" element={<EvidenceExplorerPage />} />
              <Route path="/logs" element={<ProcessLogsPage />} />
              <Route path="/logistics" element={<LogisticsHubPage />} />
              <Route path="/logistics/shipments/:shipmentId" element={<ShipmentDetailPage />} />
              <Route path="/logistics/bookings" element={<SpaceBookingsPage />} />
              <Route path="/logistics/bookings/:bookingId" element={<SpaceBookingsPage />} />
              <Route path="/logistics/installations" element={<InstallationDetailPage />} />
              <Route path="/logistics/installations/:installationId" element={<InstallationDetailPage />} />
              <Route path="/orchestrator" element={<OrchestratorPage />} />
              <Route path="/orchestrator/:kernelId" element={<OrchestratorDetailPage />} />
              <Route path="/protocols" element={<ProtocolLibraryPage />} />
              <Route path="/protocols/new" element={<ProtocolBuilderPage />} />
              <Route path="/protocols/:templateId" element={<ProtocolDetailPage />} />
              <Route path="/protocols/:templateId/edit" element={<ProtocolBuilderPage />} />
              <Route path="/protocol-runs" element={<ProtocolRunPage />} />
              <Route path="/protocol-runs/:runId" element={<ProtocolRunPage />} />
              <Route path="/subnet" element={<SubnetStatusPage />} />
              <Route path="/depin" element={<DePINDashboardPage />} />
              <Route path="/setup" element={<SetupWizardPage />} />
            </Routes>
          </Suspense>
        </PageTransition>
      </AppShell>
      <NotificationToasts />
      <OnboardingTour />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shell router — picks agent or dashboard shell based on mode
// ---------------------------------------------------------------------------

function Shell() {
  const interfaceMode = useUIStore((s) => s.interfaceMode);

  if (interfaceMode === "agent") {
    return <AgentShell />;
  }

  return <DashboardShell />;
}

export function App() {
  return (
    <ErrorBoundary>
      <WalletProvider>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Shell />
          </BrowserRouter>
        </QueryClientProvider>
      </WalletProvider>
    </ErrorBoundary>
  );
}
