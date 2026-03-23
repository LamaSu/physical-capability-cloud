import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { initTelemetry, Sentry } from "./lib/telemetry.js";
import "./index.css";

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
