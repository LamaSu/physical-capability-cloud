import { z } from "zod";

export interface SettlementDeploymentIdentity {
  /** The record's chainId; equals the DTO's top-level chainId. */
  chainId: number;
  /** Lower-case 0x + 40 hex. */
  factory: `0x${string}`;
  /** Lower-case 0x + 40 hex. */
  implementation: `0x${string}`;
  /** 64 lower-case hex digits, no 0x: sha256 of the record's exact bytes. */
  recordSha256: string;
}

export const SettlementDeploymentIdentitySchema = z.object({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  factory: z.string().regex(/^0x[0-9a-f]{40}$/),
  implementation: z.string().regex(/^0x[0-9a-f]{40}$/),
  recordSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type RecheckRoute = "lifecycle" | "receipt" | "provenance";
export type RecheckSource = "chain-header" | "chain-state" | "chain-code" | "chain-log"
  | "derived" | "echo" | "registry" | "gateway-claim" | "offchain" | "kit";
export type RecheckRead =
  | { readonly kind: "call"; readonly contract: "escrow" | "factory"; readonly fn: string; readonly args: readonly string[]; readonly output: string }
  | { readonly kind: "code"; readonly contract: "escrow" | "implementation"; readonly check: "eip1167" | "codehash" }
  | { readonly kind: "logs"; readonly contract: "escrow"; readonly event: string; readonly unitIdTopic: 1 | 2 }
  | { readonly kind: "header"; readonly what: string };
export interface RecheckField {
  readonly routes: readonly RecheckRoute[];
  readonly pointer: string;
  readonly source: RecheckSource | readonly RecheckSource[];
  readonly reads: readonly RecheckRead[];
  /** JSON pointers or deployment.<field> dependencies, including across routes. */
  readonly inputs?: readonly string[];
  readonly rule: string;
  readonly money: boolean;
  readonly knownDrift?: "E2" | "E4.1" | "E4.2" | "E4.3";
}
export interface RecheckDeployment extends SettlementDeploymentIdentity {
  readonly network: string;
  readonly implementationCodehash: `0x${string}`;
  readonly usdc: `0x${string}`;
  /** Lower bound for log scans, not the factory's creation block. */
  readonly recordBlockNumber: number;
  readonly scheduleId: string;
  readonly scheduleTestnetOnly: boolean;
  readonly challengeWindowSec: number;
  readonly appealWindowSec: number;
  readonly backupWindowSec: number;
  readonly emergencyReviewWindowSec: number;
  readonly readSurface: string;
}
