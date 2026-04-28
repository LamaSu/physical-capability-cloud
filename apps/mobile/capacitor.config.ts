import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor 7 configuration for the PCC Operator/User mobile app.
 *
 * Architecture decision (see ARCHITECTURE.md): we use `server.url` to wrap the
 * already-deployed PWA at https://capability.network/operator/mobile rather
 * than bundling a per-release web build. This means we ship updates by
 * deploying the dashboard, not by submitting a new app-store binary.
 *
 * For dev / preview, point CAP_SERVER_URL at your local Vite dev server
 * (e.g. http://10.0.2.2:5173 for Android emulator, http://localhost:5173 for
 * iOS simulator).
 */
const isDev = process.env.CAP_DEV === "1";
const serverUrl =
  process.env.CAP_SERVER_URL ??
  (isDev ? "http://localhost:5173" : "https://capability.network");

const config: CapacitorConfig = {
  appId: "network.capability.mobile",
  appName: "PCC",
  // webDir is required by the CLI even when server.url is set (used for
  // copy/sync of assets like splash and icon overlays). We point it at a
  // small static folder we maintain in this package.
  webDir: "public",
  server: {
    url: serverUrl,
    androidScheme: "https",
    cleartext: isDev,
    allowNavigation: ["capability.network", "*.capability.network"],
  },
  ios: {
    contentInset: "automatic",
    scheme: "PCC",
    backgroundColor: "#0A1A0F",
  },
  android: {
    backgroundColor: "#0A1A0F",
    allowMixedContent: false,
    captureInput: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: "#0A1A0F",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
  },
};

export default config;
