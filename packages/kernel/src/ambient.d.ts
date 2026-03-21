// Ambient module declarations for optional dependencies.
// These packages are dynamically imported at runtime with try/catch fallbacks.
// The declarations allow tsc to compile without the packages installed.

declare module "ipp" {
  const ipp: any;
  export default ipp;
  export const Printer: any;
  export const parse: any;
  export const serialize: any;
}

declare module "bonjour-service" {
  class Bonjour {
    constructor(opts?: any);
    find(opts: any, cb?: (service: any) => void): any;
    destroy(): void;
  }
  export default Bonjour;
}
