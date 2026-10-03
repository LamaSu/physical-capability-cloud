// ADK R8: the onboarding agent drafts a device's safety envelope and typed I/O,
// the operator confirms it once, and only a confirmed envelope compiles.
export * from "./safety-envelope.js";
// The runtime envelope the kernel's governor and pcc-node enforce (strict; no defaults).
export * from "./operational-envelope.js";
// The reference check of that contract at command dispatch: one pure function, with parity fixtures (N86 part 2).
export * from "./envelope-runtime-check.js";
