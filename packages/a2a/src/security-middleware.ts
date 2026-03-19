/**
 * Security middleware for the A2A MessageBus.
 * Scans intent payloads before delivery. Blocks or escalates threats.
 */

import type { A2AMessage } from "./types.js";
import type { ContentScanResult, SecurityViolation } from "@pcc/spec";
import type { ContentScanner, ScanContext } from "./content-scanner.js";
import { canonicalize } from "@pcc/spec";

export class SecurityError extends Error {
  readonly violation: SecurityViolation;

  constructor(violation: SecurityViolation) {
    super(violation.message);
    this.name = "SecurityError";
    this.violation = violation;
  }
}

export interface SecurityMiddlewareConfig {
  /** The content scanner to use */
  scanner: ContentScanner;
  /** What to do with REVIEW decisions (default: "pass") */
  reviewAction: "pass" | "block" | "log";
  /** Callback for scan events (logging, monitoring) */
  onScan?: (message: A2AMessage, result: ContentScanResult) => void;
  /** Callback for blocked messages */
  onBlock?: (message: A2AMessage, result: ContentScanResult) => void;
  /** Callback for review messages */
  onReview?: (message: A2AMessage, result: ContentScanResult) => void;
  /** Intent types to skip scanning (e.g., "error" responses) */
  skipIntentTypes?: string[];
}

export class SecurityMiddleware {
  private config: SecurityMiddlewareConfig;
  private scanCount = 0;
  private blockCount = 0;
  private reviewCount = 0;

  constructor(config: SecurityMiddlewareConfig) {
    this.config = config;
  }

  /**
   * Scan a message before delivery. Returns the scan result.
   * Throws SecurityError if the message should be blocked.
   */
  async scanMessage(message: A2AMessage): Promise<ContentScanResult> {
    // Skip scanning for certain intent types
    if (this.config.skipIntentTypes?.includes(message.intent.type)) {
      return {
        id: "",
        decision: "PASS",
        confidence: 1,
        zone: "SAFE",
        triggeredLayers: [],
        latencyMs: 0,
        contentHash: "" as any,
        scannedAt: new Date().toISOString(),
      };
    }

    // Serialize intent payload for scanning
    const content = canonicalize(message.intent);

    const context: ScanContext = {
      sourceAgentId: message.from,
      intentType: message.intent.type,
      conversationId: message.conversationId,
    };

    const result = await this.config.scanner.scan(content, context);
    this.scanCount++;

    // Notify listeners
    this.config.onScan?.(message, result);

    if (result.decision === "BLOCK") {
      this.blockCount++;
      this.config.onBlock?.(message, result);

      throw new SecurityError({
        scanResult: result,
        message: `Message blocked: ${result.zone} content detected (${result.triggeredLayers.join(", ")})`,
        intentType: message.intent.type,
        sourceAgentId: message.from,
      });
    }

    if (result.decision === "REVIEW") {
      this.reviewCount++;
      this.config.onReview?.(message, result);

      if (this.config.reviewAction === "block") {
        throw new SecurityError({
          scanResult: result,
          message: `Message requires review: ${result.zone} content detected`,
          intentType: message.intent.type,
          sourceAgentId: message.from,
        });
      }
    }

    return result;
  }

  /** Get scanning statistics */
  get stats() {
    return {
      scanned: this.scanCount,
      blocked: this.blockCount,
      reviewed: this.reviewCount,
      passRate: this.scanCount > 0 ? (this.scanCount - this.blockCount) / this.scanCount : 1,
    };
  }
}
