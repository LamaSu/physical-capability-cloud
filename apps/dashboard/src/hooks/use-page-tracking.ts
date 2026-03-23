import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageView } from "../lib/telemetry.js";

/**
 * usePageTracking — must be called inside a component that is a descendant
 * of <BrowserRouter> (i.e., inside DashboardShell or AgentShell).
 *
 * Fires a page view event to PostHog, GA4, and (implicitly via route data)
 * Sentry on every pathname/search change.
 */
export function usePageTracking(): void {
  const location = useLocation();

  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);
}
