import React from "react";
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell, Sidebar, TopBar, StatusBar, ParticleBackground } from "@pcc/ui";
import { navGroups } from "./components/nav-config.js";
import { useUIStore } from "./stores/ui-store.js";
import { PageTransition } from "./components/PageTransition.js";
import { NotificationToasts } from "./components/NotificationToasts.js";
import { OnboardingTour, TourRestartButton } from "./components/OnboardingTour.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { DiscoverPage } from "./pages/DiscoverPage.js";
import { BuilderPage } from "./pages/BuilderPage.js";
import { WorkflowPage } from "./pages/WorkflowPage.js";
import { JobsPage } from "./pages/JobsPage.js";
import { JobDetailPage } from "./pages/JobDetailPage.js";
import { KernelsPage } from "./pages/KernelsPage.js";
import { KernelDetailPage } from "./pages/KernelDetailPage.js";
import { EscrowPage } from "./pages/EscrowPage.js";
import { AgentLogPage } from "./pages/AgentLogPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { OnboardLandingPage } from "./pages/OnboardLandingPage.js";
import { OnboardWizardPage } from "./pages/OnboardWizardPage.js";
import { MarketplacePage } from "./pages/MarketplacePage.js";
import { MarketplaceDetailPage } from "./pages/MarketplaceDetailPage.js";
import { ROICalculatorPage } from "./pages/ROICalculatorPage.js";
import { SpaceFinderPage } from "./pages/SpaceFinderPage.js";
import { SpaceDetailPage } from "./pages/SpaceDetailPage.js";
import { OperatorDashboardPage } from "./pages/OperatorDashboardPage.js";
import { OperatorMachineDetailPage } from "./pages/OperatorMachineDetailPage.js";
import { SensorDashboardPage } from "./pages/SensorDashboardPage.js";
import { BatchTrackingPage } from "./pages/BatchTrackingPage.js";
import { EvidenceExplorerPage } from "./pages/EvidenceExplorerPage.js";
import { ProcessLogsPage } from "./pages/ProcessLogsPage.js";
import { LogisticsHubPage } from "./pages/LogisticsHubPage.js";
import { ShipmentDetailPage } from "./pages/ShipmentDetailPage.js";
import { SpaceBookingsPage } from "./pages/SpaceBookingsPage.js";
import { InstallationDetailPage } from "./pages/InstallationDetailPage.js";

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
            actions={<TourRestartButton />}
          />
        }
        statusBar={<StatusBar kernelsOnline={2} activeJobs={3} networkStatus="connected" />}
      >
        <PageTransition>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/discover" element={<DiscoverPage />} />
            <Route path="/build" element={<BuilderPage />} />
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
          </Routes>
        </PageTransition>
      </AppShell>
      <NotificationToasts />
      <OnboardingTour />
    </>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
