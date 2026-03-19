/**
 * Security types for PCC agent content scanning and audit.
 * Inspired by DESTILL AEGIS concepts, adapted for PCC's architecture.
 */

import type { Id, SHA256, Timestamp } from "./common.js";

/** Result of scanning content for security threats */
export interface ContentScanResult {
  /** Unique scan ID */
  id: Id;
  /** BLOCK = reject, PASS = allow, REVIEW = escalate to human */
  decision: "BLOCK" | "PASS" | "REVIEW";
  /** Confidence score 0-1 */
  confidence: number;
  /** Threat zone classification */
  zone: "SAFE" | "SUSPICIOUS" | "DECEPTIVE" | "MALICIOUS";
  /** Which scanner layers triggered */
  triggeredLayers: string[];
  /** Scan latency in milliseconds */
  latencyMs: number;
  /** SHA-256 hash of scanned content */
  contentHash: SHA256;
  /** POAW-style audit receipt */
  auditReceipt?: AuditReceipt;
  /** Timestamp */
  scannedAt: Timestamp;
}

/** Cryptographic proof that scanning work was performed */
export interface AuditReceipt {
  /** SHA-256 hash of the scan computation */
  scanHash: SHA256;
  /** Position in the audit chain */
  chainPosition: number;
  /** Number of scanner layers that participated */
  layersTriggered: number;
  /** Timestamp */
  timestamp: Timestamp;
}

/** Security error thrown when content is blocked */
export interface SecurityViolation {
  /** Blocked scan result */
  scanResult: ContentScanResult;
  /** Human-readable message */
  message: string;
  /** The intent type that was scanned */
  intentType: string;
  /** Agent that sent the blocked content */
  sourceAgentId: Id;
}

/** Alert when conversation drift is detected */
export interface DriftAlert {
  /** Conversation ID */
  conversationId: Id;
  /** Severity level */
  severity: "info" | "warning" | "critical";
  /** Drift score (0-1, higher = more drift) */
  driftScore: number;
  /** Recommendation */
  recommendation: "CONTINUE" | "REVIEW" | "TERMINATE";
  /** What triggered the alert */
  trigger: string;
  /** Timestamp */
  detectedAt: Timestamp;
}
