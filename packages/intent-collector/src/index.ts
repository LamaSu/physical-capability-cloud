/**
 * @pcc/intent-collector — public exports.
 *
 * Embeddable SDK for any agent app (Node, Bun, Vite, Next.js, Express
 * middleware, etc.) to capture intent-shaped outbound HTTP calls and post
 * them as DemandEnvelopes to PCC's /api/intents/ingest endpoint.
 *
 * Phase 2.2 of the intent-network-interception roadmap; complements the
 * MCP-side @pcc/intent-broker (an agent must explicitly call its tool) by
 * intercepting calls the agent makes WITHOUT knowing PCC exists.
 *
 * See README.md for framework integration examples.
 */

export {
  IntentCollectorClient,
  loadCollectorConfig,
  type IntentCollectorConfig,
  type CapturedEnvelope,
  type SubmitResult,
  type Hasher,
} from "./client.js";

export {
  URL_PATTERNS,
  matchUrlPattern,
  type UrlPattern,
  type UrlPatternMatch,
} from "./url-patterns.js";
