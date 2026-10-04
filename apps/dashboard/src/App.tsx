import React, { Suspense, lazy, useEffect, useSyncExternalStore } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell, Sidebar, TopBar, ParticleBackground } from "@pcc/ui";
import { navGroups } from "./components/nav-config.js";
import { useUIStore } from "./stores/ui-store.js";
import { useAuthStore, onIdentityChange, onAccountChange } from "./stores/auth-store.js";
import { resetAccountScopedState } from "./lib/account-scope.js";
import { endWalletSession } from "./lib/wallet-session.js";
import { onAccountChangePending, walletSessionEnding } from "./lib/account-generation.js";
import { LoginPage } from "./pages/LoginPage.js";
import { PageTransition } from "./components/PageTransition.js";
import { NotificationToasts } from "./components/NotificationToasts.js";
import { OnboardingTour, TourRestartButton } from "./components/OnboardingTour.js";
import { WalletProvider } from "./providers/WalletProvider.js";
import { ConnectWallet } from "./components/ConnectWallet.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ModeToggle } from "./components/ModeToggle.js";
import { LiveStatusBar } from "./components/LiveStatusBar.js";
import { Sentry } from "./lib/telemetry.js";
import { usePageTracking } from "./hooks/use-page-tracking.js";
import { SpatialApp } from "./SpatialApp.js";
import { AgentLandingHero } from "./components/AgentLandingHero.js";
import { FeedbackButton } from "./components/FeedbackButton.js";
import { APP_HOME, canonicalRedirect, workspaceForPath } from "./lib/workspaces.js";

// ---------------------------------------------------------------------------
// Lazy-loaded pages (code-split per route)
// ---------------------------------------------------------------------------

const LandingPage = lazy(() => import("./pages/LandingPage.js").then(m => ({ default: m.LandingPage })));
const StartPage = lazy(() => import("./pages/StartPage.js").then(m => ({ default: m.StartPage })));
const EarnFromYourWorkPage = lazy(() => import("./pages/EarnFromYourWorkPage.js").then(m => ({ default: m.EarnFromYourWorkPage })));
const AgentLinkPage = lazy(() => import("./pages/AgentLinkPage.js").then(m => ({ default: m.AgentLinkPage })));
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
const OnboardChatPage = lazy(() => import("./pages/OnboardChatPage.js").then(m => ({ default: m.OnboardChatPage })));
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
const SetupAgentPage = lazy(() => import("./pages/SetupAgentPage.js").then(m => ({ default: m.SetupAgentPage })));
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
const TelemetryPage = lazy(() => import("./pages/TelemetryPage.js").then(m => ({ default: m.TelemetryPage })));
const TracesPage = lazy(() => import("./pages/TracesPage.js").then(m => ({ default: m.TracesPage })));
const NegotiationPage = lazy(() => import("./pages/NegotiationPage.js").then(m => ({ default: m.NegotiationPage })));
const OperatorMobilePage = lazy(() => import("./pages/OperatorMobilePage.js").then(m => ({ default: m.OperatorMobilePage })));
const SWFDashboardPage = lazy(() => import("./pages/SWFDashboardPage.js").then(m => ({ default: m.SWFDashboardPage })));
const SWFGovernancePage = lazy(() => import("./pages/SWFGovernancePage.js").then(m => ({ default: m.SWFGovernancePage })));
const IPRevenuePage = lazy(() => import("./pages/IPRevenuePage.js").then(m => ({ default: m.IPRevenuePage })));
const WalletPage = lazy(() => import("./pages/WalletPage.js").then(m => ({ default: m.WalletPage })));
const WhitepaperPage = lazy(() => import("./pages/WhitepaperPage.js").then(m => ({ default: m.WhitepaperPage })));
const BatchBoardPage = lazy(() => import("./pages/BatchBoardPage.js").then(m => ({ default: m.BatchBoardPage })));
const NegotiationSessionPage = lazy(() => import("./pages/NegotiationSessionPage.js").then(m => ({ default: m.NegotiationSessionPage })));
const AgentPackagePage = lazy(() => import("./pages/AgentPackagePage.js").then(m => ({ default: m.AgentPackagePage })));
const SponsorTelemetryPage = lazy(() => import("./pages/SponsorTelemetryPage.js").then(m => ({ default: m.SponsorTelemetryPage })));
const SystemDashboardPage = lazy(() => import("./pages/SystemDashboardPage.js").then(m => ({ default: m.SystemDashboardPage })));
const AnalyticsDashboardPage = lazy(() => import("./pages/AnalyticsDashboardPage.js").then(m => ({ default: m.AnalyticsDashboardPage })));
const KernelLeaderboardPage = lazy(() => import("./pages/KernelLeaderboardPage.js").then(m => ({ default: m.KernelLeaderboardPage })));
const RateSchedulePublishPage = lazy(() => import("./pages/RateSchedulePublishPage.js").then(m => ({ default: m.RateSchedulePublishPage })));
const RateScheduleViewPage = lazy(() => import("./pages/RateScheduleViewPage.js").then(m => ({ default: m.RateScheduleViewPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage.js").then(m => ({ default: m.NotFoundPage })));

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

// A cached read belongs to the identity that made it: clear the cache whenever the signed-in
// identity changes, so the next identity never sees the previous one's jobs or money.
onIdentityChange(() => queryClient.clear());

// Everything else the browser holds belongs to the account too (astra 19c,
// 19d). When the API account changes (a key signed in or out, or another key):
// 1. Inside the set() that changed the key, before anything renders:
//    - every account-scoped store goes back to its initial state, and every
//      store action read under the previous account stops working
//      (lib/account-scope.ts);
//    - the previous wallet's address and SIWE session leave the auth store.
// 2. The signed-in shell unmounts, and stays unmounted while the wallet half
//    of the identity ends: wagmi disconnects and the gateway destroys its SIWE
//    cookie (lib/wallet-session.ts). Both live above this boundary, and the
//    next account's ConnectWallet used to re-adopt them.
// 3. The shell mounts again under a new key, for the new account. That drops
//    component state, and gives every query a fresh observer. If the gateway
//    can't confirm the cookie is gone, the next account doesn't load (fail
//    closed), and the page offers a retry.
// 4. Until a teardown confirms it, the account change is pending for the
//    whole browser (astra 19e, 19f; lib/account-generation.ts). The next
//    account's key is already stored, so a page reloaded or opened before
//    then would otherwise mount the next account straight away, beside the
//    previous account's cookie. A page that loads while it is pending
//    finishes the teardown before it mounts anything.
type AccountTransition = "settled" | "ending" | "failed";
/** The last page started a teardown and never saw it confirmed. */
let endingAtLoad = walletSessionEnding();
let account: { epoch: number; transition: AccountTransition } = { epoch: 0, transition: endingAtLoad ? "ending" : "settled" };
const accountListeners = new Set<() => void>();
let teardownRun = 0;

function setAccount(next: typeof account): void {
  account = next;
  for (const listener of accountListeners) listener();
}

function endPreviousWallet(): void {
  const run = ++teardownRun;
  setAccount({ ...account, transition: "ending" });
  void endWalletSession().then((ended) => {
    if (run !== teardownRun) return; // a later account change owns the transition now
    setAccount({ epoch: account.epoch + 1, transition: ended ? "settled" : "failed" });
  });
}

function accountChanged(): void {
  resetAccountScopedState();
  useAuthStore.setState({ address: null, sessionToken: null, isVerifying: false });
  endPreviousWallet();
}

onAccountChange(accountChanged);

// Another tab's change can reach this tab as the generation's move alone, before
// its key does (lib/account-generation.ts). It is a change all the same: end the
// wallet session before this tab shows anything more (astra 19g).
onAccountChangePending(() => {
  if (account.transition === "settled") accountChanged();
});

/** The account boundary: its epoch keys the shell; while it is in transition the shell isn't mounted. */
function useAccountBoundary(): typeof account {
  return useSyncExternalStore(
    (onChange) => {
      accountListeners.add(onChange);
      return () => accountListeners.delete(onChange);
    },
    () => account,
  );
}

/** Shown between accounts, instead of the shell. */
function AccountTransitionScreen({ failed }: { failed: boolean }) {
  return (
    <div role="status" className="min-h-screen flex items-center justify-center px-6 text-center text-sm text-white/60">
      {failed ? (
        <div className="space-y-3 max-w-md">
          <p>
            Couldn't confirm that the previous wallet session ended. Nothing of this account loads until it has, so the
            previous wallet can't act for it.
          </p>
          <button
            onClick={endPreviousWallet}
            className="px-3 py-1.5 rounded-lg text-xs border border-white/[0.12] text-white/80 hover:bg-white/[0.04]"
          >
            Try again
          </button>
        </div>
      ) : (
        <p>Signing out of the previous account…</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent workspace (/agent) — the live agent conversation, no sidebar
// ---------------------------------------------------------------------------

function AgentShell() {
  usePageTracking();

  return (
    <div className="flex flex-col h-screen bg-black/90 relative">
      <ParticleBackground />
      <div className="relative z-10 flex flex-col h-full min-h-0">
        {/* Minimal top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06] bg-black/40 backdrop-blur-sm">
          <div className="text-sm font-medium text-white/70">Agent</div>
          <div className="flex items-center gap-2">
            <FeedbackButton />
            <ModeToggle />
            <ConnectWallet />
          </div>
        </div>
        {/* The same live conversation as /onboard/chat (POST /api/onboard/chat) */}
        <div className="flex-1 min-h-0">
          <Suspense fallback={<PageLoader />}>
            <OnboardChatPage variant="agent" />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Shell — full 45-page shell with sidebar
// ---------------------------------------------------------------------------

function LogoutButton() {
  const logout = useAuthStore((s) => s.logout);
  // Why the last sign-out didn't finish, where the person asked for it (astra
  // 19j). logout() keeps its typed outcome in the store, above the account
  // boundary: an unconfirmed sign-out still remounts this shell (DECISIONS 04:14).
  const problem = useAuthStore((s) => (s.lastSignOut && s.lastSignOut.status !== "signed-out" ? s.lastSignOut.reason : null));
  return (
    <>
      <button
        onClick={() => logout()}
        className="w-full px-3 py-2 text-[10px] text-white/25 hover:text-red-400/70 hover:bg-white/[0.03] rounded-lg transition-all text-left tracking-wide uppercase"
      >
        Disconnect
      </button>
      {problem && (
        <p role="alert" className="px-3 pb-2 text-[10px] leading-snug text-red-400/70">
          {problem}
        </p>
      )}
    </>
  );
}

function DashboardShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sidebarCollapsed, toggleSidebar, currentPageTitle, currentPageSubtitle } = useUIStore();
  usePageTracking();

  return (
    <>
      <AppShell
        particles={<ParticleBackground />}
        sidebar={
          <div className="flex flex-col h-full">
            <div className="flex-1 overflow-y-auto">
              <Sidebar
                groups={navGroups}
                currentPath={location.pathname}
                onNavigate={navigate}
                collapsed={sidebarCollapsed}
                onToggle={toggleSidebar}
              />
            </div>
            <div className="border-t border-white/[0.06] p-2">
              <LogoutButton />
            </div>
          </div>
        }
        topBar={
          <TopBar
            title={currentPageTitle}
            subtitle={currentPageSubtitle}
            actions={<><FeedbackButton /><ModeToggle /><ConnectWallet /><TourRestartButton /></>}
          />
        }
        statusBar={<LiveStatusBar />}
      >
        <PageTransition>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/discover" element={<DiscoverPage />} />
              <Route path="/build" element={<BuilderPage />} />
              <Route path="/build/new-device" element={<DeviceBuilderPage />} />
              <Route path="/build/:type" element={<BuilderPage />} />
              <Route path="/workflow" element={<WorkflowPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="/jobs/:jobId" element={<JobDetailPage />} />
              <Route path="/kernels" element={<KernelsPage />} />
              <Route path="/kernels/leaderboard" element={<KernelLeaderboardPage />} />
              <Route path="/kernels/:kernelId" element={<KernelDetailPage />} />
              <Route path="/escrow" element={<EscrowPage />} />
              <Route path="/settlement" element={<SettlementPage />} />
              <Route path="/wallet" element={<WalletPage />} />
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
              <Route path="/swf" element={<SWFDashboardPage />} />
              <Route path="/swf/governance/:proposalId" element={<SWFGovernancePage />} />
              <Route path="/telemetry" element={<TelemetryPage />} />
              <Route path="/traces" element={<TracesPage />} />
              <Route path="/setup" element={<SetupWizardPage />} />
              <Route path="/setup/agent" element={<SetupAgentPage />} />
              <Route path="/negotiate" element={<NegotiationPage />} />
              <Route path="/negotiate/session" element={<NegotiationSessionPage />} />
              <Route path="/batch-board" element={<BatchBoardPage />} />
              <Route path="/agent-package" element={<AgentPackagePage />} />
              <Route path="/ip" element={<IPRevenuePage />} />
              <Route path="/sponsors" element={<SponsorTelemetryPage />} />
              <Route path="/system" element={<SystemDashboardPage />} />
              <Route path="/analytics" element={<AnalyticsDashboardPage />} />
              <Route path="/contributors/schedules/publish" element={<RateSchedulePublishPage />} />
              <Route path="/contributors/schedules/:hash" element={<RateScheduleViewPage />} />
              <Route path="*" element={<NotFoundPage />} />
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
// "/" — the landing page
// ---------------------------------------------------------------------------

/** The path this document was loaded at, before any in-app navigation. */
const BOOT_PATH = typeof window !== "undefined" ? window.location.pathname : "/";

/**
 * In production the gateway serves the static landing.html at "/", so an
 * in-app navigation to "/" does a full page load and shows that same page.
 * The SPA renders its own landing only when this document itself was loaded
 * at "/" (the vite dev server, or a host that serves the SPA there), which
 * also keeps the hand-off from ever looping.
 */
function RootLanding() {
  const handOff = BOOT_PATH !== "/";
  React.useEffect(() => {
    if (handOff) window.location.assign("/");
  }, [handOff]);
  if (handOff) return <PageLoader />;
  return (
    <Suspense fallback={<PageLoader />}>
      <AgentLandingHero />
      <LandingPage />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Shell router — the URL decides what renders (lib/workspaces.ts)
// ---------------------------------------------------------------------------

/** Pages that render without an API key. */
const PUBLIC_PATHS = new Set(["/", "/start", "/whitepaper", "/go", "/earn", "/onboard/chat"]);

function Shell() {
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const path = location.pathname;

  // Non-canonical addresses: /spatial -> /app, old bookmarks /legacy/jobs -> /jobs.
  const canonical = canonicalRedirect(path);
  if (canonical) {
    return <Navigate to={canonical + location.search + location.hash} replace />;
  }

  if (path === "/login") {
    return isAuthenticated ? <Navigate to={APP_HOME} replace /> : <LoginPage />;
  }

  // Auth gate — non-public pages ask for an API key
  if (!isAuthenticated && !PUBLIC_PATHS.has(path)) {
    return <LoginPage />;
  }

  if (path === "/") {
    return <RootLanding />;
  }

  if (path === "/start") {
    return (
      <Suspense fallback={<PageLoader />}>
        <StartPage />
      </Suspense>
    );
  }

  // Zero-friction contributor signup. Public — bundled wallet+APIkey+
  // schedule signup via POST /api/contributors/quickstart.
  if (path === "/earn") {
    return (
      <Suspense fallback={<PageLoader />}>
        <EarnFromYourWorkPage />
      </Suspense>
    );
  }

  if (path === "/whitepaper") {
    return (
      <Suspense fallback={<PageLoader />}>
        <WhitepaperPage />
      </Suspense>
    );
  }

  if (path === "/go") {
    return (
      <Suspense fallback={<PageLoader />}>
        <AgentLinkPage />
      </Suspense>
    );
  }

  // Conversational no-code onboarding (coord dc4d1ec8). Public so a layperson
  // can reach it from a marketing link without first signing in. The chat
  // page talks to POST /api/onboard/chat which is itself public on the gateway.
  if (path === "/onboard/chat") {
    return (
      <Suspense fallback={<PageLoader />}>
        <OnboardChatPage />
      </Suspense>
    );
  }

  if (path === "/operator/mobile") {
    return (
      <Suspense fallback={<PageLoader />}>
        <OperatorMobilePage />
      </Suspense>
    );
  }

  // Workspaces. Each has its own address, so a deep link always opens its
  // page; nothing held in memory overrides the URL.
  switch (workspaceForPath(path)) {
    case "spatial":
      return <SpatialApp />;
    case "agent":
      return <AgentShell />;
    default:
      return <DashboardShell />;
  }
}

export function App() {
  const boundary = useAccountBoundary();
  // Finish the teardown the last page left unconfirmed. By this effect wagmi
  // has begun restoring that page's wallet connection, so the teardown
  // disconnects what it restores (lib/wallet-session.ts).
  useEffect(() => {
    if (!endingAtLoad) return;
    endingAtLoad = false;
    endPreviousWallet();
  }, []);
  return (
    // Sentry.ErrorBoundary captures errors to Sentry before falling through
    // to the local ErrorBoundary for display. When VITE_SENTRY_DSN is not set,
    // Sentry.init() was never called so this boundary is a transparent passthrough.
    <Sentry.ErrorBoundary showDialog={false}>
      <ErrorBoundary>
        <WalletProvider>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              {boundary.transition === "settled" ? (
                <Shell key={boundary.epoch} />
              ) : (
                <AccountTransitionScreen failed={boundary.transition === "failed"} />
              )}
            </BrowserRouter>
          </QueryClientProvider>
        </WalletProvider>
      </ErrorBoundary>
    </Sentry.ErrorBoundary>
  );
}
