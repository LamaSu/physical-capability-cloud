/**
 * Content Scanner — pluggable content security for A2A messages.
 *
 * Interface allows swapping backends:
 * - PatternScanner: local regex/heuristic (ships with PCC, no external deps)
 * - DestillScanner: DESTILL AEGIS API (when API key available)
 */

import type { ContentScanResult, SHA256 } from "@pcc/spec";
import { sha256, canonicalize, ids } from "@pcc/spec";

/** Abstract scanner interface — implement for each backend */
export interface ContentScanner {
  /** Scan text content and return a result */
  scan(content: string, context?: ScanContext): Promise<ContentScanResult>;
  /** Scanner name for logging */
  readonly name: string;
}

export interface ScanContext {
  /** Which agent sent this */
  sourceAgentId?: string;
  /** Intent type being carried */
  intentType?: string;
  /** Conversation ID for multi-turn context */
  conversationId?: string;
}

/**
 * Pattern-based scanner — local, zero external dependencies.
 * Catches common prompt injection patterns, jailbreaks, and social engineering.
 * NOT a replacement for DESTILL's 108-agent cascade, but provides baseline protection.
 */
export class PatternScanner implements ContentScanner {
  readonly name = "pattern-scanner";

  // Prompt injection patterns (ordered by severity)
  private readonly injectionPatterns: Array<{ pattern: RegExp; severity: number; label: string }> = [
    // Direct injection
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, severity: 0.95, label: "direct_injection" },
    { pattern: /ignore\s+(all\s+)?prior\s+(instructions|prompts|rules)/i, severity: 0.95, label: "direct_injection" },
    { pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|context)/i, severity: 0.95, label: "direct_injection" },
    { pattern: /forget\s+(everything|all)\s+(you\s+)?(know|were\s+told|learned)/i, severity: 0.9, label: "memory_wipe" },
    // System prompt extraction
    { pattern: /reveal\s+(your\s+)?system\s+prompt/i, severity: 0.9, label: "system_prompt_extraction" },
    { pattern: /show\s+(me\s+)?(your\s+)?(system|initial|original)\s+(prompt|instructions)/i, severity: 0.9, label: "system_prompt_extraction" },
    { pattern: /what\s+(are|is)\s+your\s+(system|initial|original)\s+(prompt|instructions)/i, severity: 0.85, label: "system_prompt_extraction" },
    { pattern: /repeat\s+(your\s+)?(system|initial)\s+(prompt|instructions)\s+(back|verbatim)/i, severity: 0.9, label: "system_prompt_extraction" },
    // DAN/jailbreak
    { pattern: /\bDAN\b.*\bmode\b/i, severity: 0.95, label: "dan_jailbreak" },
    { pattern: /you\s+are\s+now\s+(?:in\s+)?(?:DAN|developer|unrestricted|jailbreak)\s+mode/i, severity: 0.95, label: "jailbreak" },
    { pattern: /act\s+as\s+(?:an?\s+)?(?:unrestricted|uncensored|unfiltered)/i, severity: 0.9, label: "jailbreak" },
    { pattern: /pretend\s+(?:you\s+)?(?:are|have)\s+no\s+(?:restrictions|limits|rules|guidelines)/i, severity: 0.9, label: "jailbreak" },
    // Role override
    { pattern: /you\s+are\s+no\s+longer\s+a/i, severity: 0.85, label: "role_override" },
    { pattern: /from\s+now\s+on\s+you\s+(?:are|will)\s+(?:be|act\s+as)/i, severity: 0.8, label: "role_override" },
    // Encoded/obfuscated injection
    { pattern: /base64\s*[:=]\s*[A-Za-z0-9+/]{20,}/i, severity: 0.7, label: "encoded_payload" },
    { pattern: /\[SYSTEM\]|\[INST\]|\<\|im_start\|system\>/i, severity: 0.9, label: "format_injection" },
    // Social engineering
    { pattern: /this\s+is\s+(?:an?\s+)?(?:emergency|urgent|critical).*(?:override|bypass|skip)/i, severity: 0.85, label: "social_engineering" },
    { pattern: /(?:admin|administrator|developer|root)\s+(?:override|access|mode)/i, severity: 0.85, label: "privilege_escalation" },
  ];

  async scan(content: string, context?: ScanContext): Promise<ContentScanResult> {
    const startTime = performance.now();
    const triggeredLayers: string[] = [];
    let maxSeverity = 0;

    // Run all patterns
    for (const { pattern, severity, label } of this.injectionPatterns) {
      if (pattern.test(content)) {
        triggeredLayers.push(label);
        if (severity > maxSeverity) maxSeverity = severity;
      }
    }

    // Additional heuristic: unusually long content (context flooding)
    if (content.length > 10000) {
      triggeredLayers.push("context_flooding");
      maxSeverity = Math.max(maxSeverity, 0.6);
    }

    // Additional: high ratio of special characters (obfuscation)
    const specialCharRatio = (content.match(/[^\w\s.,!?;:'"()-]/g) || []).length / Math.max(content.length, 1);
    if (specialCharRatio > 0.3 && content.length > 100) {
      triggeredLayers.push("obfuscation_detected");
      maxSeverity = Math.max(maxSeverity, 0.5);
    }

    const latencyMs = performance.now() - startTime;
    const contentHash = await sha256(content) as SHA256;

    // Decision logic
    let decision: "BLOCK" | "PASS" | "REVIEW";
    let zone: "SAFE" | "SUSPICIOUS" | "DECEPTIVE" | "MALICIOUS";

    if (maxSeverity >= 0.9) {
      decision = "BLOCK";
      zone = "MALICIOUS";
    } else if (maxSeverity >= 0.7) {
      decision = "REVIEW";
      zone = "DECEPTIVE";
    } else if (maxSeverity >= 0.4) {
      decision = "REVIEW";
      zone = "SUSPICIOUS";
    } else {
      decision = "PASS";
      zone = "SAFE";
    }

    const scanId = ids.job(); // reuse ID generator

    return {
      id: scanId,
      decision,
      confidence: maxSeverity > 0 ? maxSeverity : 1 - maxSeverity,
      zone,
      triggeredLayers,
      latencyMs,
      contentHash,
      auditReceipt: {
        scanHash: await sha256(`${scanId}:${contentHash}:${decision}`) as SHA256,
        chainPosition: 0, // local scanner doesn't chain
        layersTriggered: triggeredLayers.length,
        timestamp: new Date().toISOString(),
      },
      scannedAt: new Date().toISOString(),
    };
  }
}

/** No-op scanner that passes everything (for testing/dev) */
export class NoOpScanner implements ContentScanner {
  readonly name = "noop-scanner";

  async scan(content: string): Promise<ContentScanResult> {
    const contentHash = await sha256(content) as SHA256;
    return {
      id: ids.job(),
      decision: "PASS",
      confidence: 1,
      zone: "SAFE",
      triggeredLayers: [],
      latencyMs: 0,
      contentHash,
      scannedAt: new Date().toISOString(),
    };
  }
}
