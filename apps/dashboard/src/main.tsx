import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { initTelemetry, telemetryBeaconOrigins, Sentry } from "./lib/telemetry.js";
import { installGatewayKeyGuard } from "./lib/authorized-fetch.js";
import "./index.css";

// Defence in depth for N50: a fetch or beacon to any origin but the configured
// gateway is inspected, and refused if it carries an API key. Installed before
// telemetry and the app can send anything. The telemetry host may receive
// beacons the guard can't read synchronously (PostHog sends Blob beacons on
// unload), but a body the guard can read is still checked.
installGatewayKeyGuard({ unreadableBeaconOrigins: telemetryBeaconOrigins() });

// Initialize PostHog, GA4, and Sentry before the React tree mounts.
initTelemetry();

ReactDOM.createRoot(document.getElementById("root")!, {
  // Wire Sentry into React 19's new error handler hooks so all render errors
  // (caught and uncaught) are captured with full component stack traces.
  onUncaughtError: Sentry.reactErrorHandler((error, errorInfo) => {
    console.warn("Uncaught error", error, errorInfo.componentStack);
  }),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
