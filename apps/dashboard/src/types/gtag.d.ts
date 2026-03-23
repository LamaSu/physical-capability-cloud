// Type augmentations for the Google Analytics gtag.js global API.
// gtag is dynamically injected by initTelemetry() when VITE_GA_MEASUREMENT_ID is set.

interface Window {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dataLayer: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gtag: (...args: any[]) => void;
}
