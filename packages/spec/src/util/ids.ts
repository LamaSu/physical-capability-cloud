/**
 * ID generation utilities.
 * Prefixed IDs for readability: cwm_xxx, step_xxx, kernel_xxx, etc.
 */

export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

export const ids = {
  cwm: () => generateId("cwm"),
  step: () => generateId("step"),
  kernel: () => generateId("kernel"),
  capability: () => generateId("cap"),
  job: () => generateId("job"),
  evidence: () => generateId("ev"),
  bundle: () => generateId("bun"),
  escrow: () => generateId("esc"),
  dispute: () => generateId("dis"),
  verifier: () => generateId("ver"),
  verification: () => generateId("vreq"),
  attestation: () => generateId("att"),
  custody: () => generateId("cust"),
  slot: () => generateId("slot"),
  device: () => generateId("dev"),
} as const;
