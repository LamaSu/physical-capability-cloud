// packages/gateway/src/services/intent-classifier.ts
//
// Deterministic intent classification for the NL query interface.
//
// Uses keyword matching and regex patterns — no LLM required for the MVP.
// At scale, an LLM intent classifier sits in front of this for free-form
// queries that don't match any pattern.
//
// Accuracy target: ≥80% for the defined intent set.
// Architecture: classify intent → extract slots → look up template → execute SQL.

import type { QueryIntent, IntentClassification } from "@pcc/spec";

// ── Intent patterns ────────────────────────────────────────────────────────

/** Keyword → intent mapping patterns */
const INTENT_PATTERNS: Array<{
  intent: QueryIntent;
  keywords: string[];
  patterns: RegExp[];
  slotExtractors: Record<string, RegExp>;
}> = [
  {
    intent: "job_status",
    keywords: ["status", "happening", "progress", "where is"],
    patterns: [/(?:status|state|progress)\s+(?:of\s+)?(?:job|order)\s+(\S+)/i, /job\s+(\S+)/i],
    slotExtractors: { jobId: /(?:job|order|PCC[-_]?)\s*(\S+)/i },
  },
  {
    intent: "find_capability",
    keywords: ["find", "search", "looking for", "need a", "who can"],
    patterns: [/find\s+(?:a\s+)?(\w+)\s+(?:for|that|near|in)/i],
    slotExtractors: {
      capabilityType: /(?:find|search|need)\s+(?:a\s+)?(\w[\w\s-]+?)(?:\s+(?:for|near|in|that))/i,
      location: /(?:near|in|around)\s+(.+?)(?:\s+(?:for|that|with)|$)/i,
    },
  },
  {
    intent: "cheapest_capability",
    keywords: ["cheapest", "lowest price", "best price", "most affordable"],
    patterns: [/cheapest\s+(.+?)(?:\s+for|\s+near|$)/i],
    slotExtractors: {
      capabilityType: /cheapest\s+(.+?)(?:\s+for|\s+near|$)/i,
      material: /(?:for|using|with)\s+(\w+)/i,
    },
  },
  {
    intent: "spend_analytics",
    keywords: ["spend", "spent", "cost", "expenses", "total"],
    patterns: [/(?:how much|total)\s+(?:have I\s+)?(?:spent|spend|cost)/i],
    slotExtractors: {
      period: /(?:this|last|past)\s+(week|month|quarter|year)/i,
    },
  },
  {
    intent: "operator_stats",
    keywords: ["reputation", "my kernel", "my stats", "performance"],
    patterns: [/(?:my|kernel)\s+(?:reputation|stats|performance|score)/i],
    slotExtractors: { kernelId: /kernel\s+(\S+)/i },
  },
  {
    intent: "evidence_lookup",
    keywords: ["evidence", "verification", "proof", "show evidence"],
    patterns: [/(?:show|get|view)\s+(?:the\s+)?(?:evidence|verification|proof)/i],
    slotExtractors: { jobId: /(?:for|of)\s+(?:job\s+)?(\S+)/i },
  },
  {
    intent: "settlement_status",
    keywords: ["escrow", "settlement", "payment", "released", "paid"],
    patterns: [/(?:escrow|settlement|payment)\s+(?:status|state)/i, /(?:has|been)\s+(?:released|paid|settled)/i],
    slotExtractors: { jobId: /(?:for|of)\s+(?:job\s+)?(\S+)/i },
  },
  {
    intent: "template_search",
    keywords: ["template", "templates", "profile"],
    patterns: [/(?:templates?|profiles?)\s+(?:for|exist)\s+(.+)/i],
    slotExtractors: { machineModel: /(?:for|exist)\s+(.+)/i },
  },
  {
    intent: "compliance_query",
    keywords: ["compliance", "regulation", "tier", "evidence need", "requirements"],
    patterns: [/(?:what|which)\s+(?:evidence|compliance|requirements)/i],
    slotExtractors: { tier: /tier\s+(\d)/i },
  },
  {
    intent: "network_status",
    keywords: ["how many kernels", "network", "online", "total"],
    patterns: [/how many\s+(?:kernels|operators|machines)/i],
    slotExtractors: {},
  },
  {
    intent: "job_history",
    keywords: ["my jobs", "history", "recent jobs", "past jobs"],
    patterns: [/(?:my|recent|past|last)\s+(?:\d+\s+)?jobs/i],
    slotExtractors: { limit: /(?:last|recent)\s+(\d+)/i },
  },
  {
    intent: "kernel_health",
    keywords: ["healthy", "health", "online", "working"],
    patterns: [/is\s+(?:kernel\s+)?(\S+)\s+(?:healthy|online|working)/i],
    slotExtractors: { kernelId: /kernel\s+(\S+)/i },
  },
];

// ── Classifier ─────────────────────────────────────────────────────────────

export class IntentClassifier {
  /**
   * Classify a natural language query into an intent + slot values.
   *
   * Scoring:
   *   - Each keyword match adds +0.2 (up to 1.0 total)
   *   - Each regex pattern match adds +0.5
   *   - Confidence is clamped to [0, 1]
   *
   * Returns the highest-scoring intent, or network_status at 0 confidence
   * if nothing matches.
   */
  classify(query: string): IntentClassification {
    const lower = query.toLowerCase().trim();
    let bestMatch: {
      intent: QueryIntent;
      confidence: number;
      slots: Record<string, string | number | boolean>;
    } | null = null;

    for (const pattern of INTENT_PATTERNS) {
      let score = 0;

      // Keyword matching (each keyword hit = +0.2, max 1.0)
      for (const kw of pattern.keywords) {
        if (lower.includes(kw)) score += 0.2;
      }

      // Regex pattern matching (+0.5 per match)
      for (const re of pattern.patterns) {
        if (re.test(lower)) score += 0.5;
      }

      const confidence = Math.min(score, 1.0);

      if (!bestMatch || confidence > bestMatch.confidence) {
        // Extract slots
        const slots: Record<string, string | number | boolean> = {};
        for (const [name, re] of Object.entries(pattern.slotExtractors)) {
          const match = query.match(re);
          if (match?.[1]) {
            const val = match[1].trim();
            slots[name] = /^\d+$/.test(val) ? parseInt(val, 10) : val;
          }
        }
        bestMatch = { intent: pattern.intent, confidence, slots };
      }
    }

    return bestMatch
      ? { ...bestMatch, originalQuery: query }
      : {
          intent: "network_status" as QueryIntent,
          confidence: 0,
          slots: {},
          originalQuery: query,
        };
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────

let _classifier: IntentClassifier | null = null;

export function getIntentClassifier(): IntentClassifier {
  if (!_classifier) _classifier = new IntentClassifier();
  return _classifier;
}

/** Reset singleton (for tests) */
export function resetIntentClassifier(): void {
  _classifier = null;
}
