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

// ---------------------------------------------------------------------------
// Lazy-loaded pages (code-split per route)
// ---------------------------------------------------------------------------

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

function Shell() {
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
            actions={<><ConnectWallet /><TourRestartButton /></>}
          />
        }
        statusBar={<StatusBar kernelsOnline={2} activeJobs={3} networkStatus="connected" />}
      >
        <PageTransition>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
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
              <Route path="/agents" element={<AgentLogPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/onboard" element={<OnboardLandingPage />} />
              <Route path="/onboard/wizard" element={<OnboardWizardPage />} />
              <Route path="/onboard/wizard/:step" element={<OnboardWizardPage />} />
              <Route path="/marketplace" element={<MarketplacePage />} />
              <Route path="/marketplace/roi" element={<ROICalculatorPage />} />
              <Route path="/marketplace/:classId" element={<MarketplaceDetailPage />} />
              <Route path="/spaces" element={<SpaceFinderPage />} />
              <Route path="/spaces/:spaceId" element={<SpaceDetailPage />} />
              <Route path="/operator" element={<OperatorDashboardPage />} />
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
