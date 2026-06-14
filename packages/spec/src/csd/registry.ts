/**
 * CSD Registry — loads, validates, stores, and resolves Capability StructureDefinitions.
 *
 * Three operations:
 *   register(csd)           — validate + store in memory
 *   get(url)                — lookup by canonical URI
 *   resolve(url)            — lookup + apply baseDefinition inheritance
 */

import { type CSD, CsdSchema } from "./schema.js";

// JSON imports resolved at build time via TypeScript's resolveJsonModule
import fdmCsd from "../csds/fdm.csd.json" with { type: "json" };
import slaCsd from "../csds/sla.csd.json" with { type: "json" };
import cnc3axisCsd from "../csds/cnc-3axis.csd.json" with { type: "json" };
import laserCutCsd from "../csds/laser-cut.csd.json" with { type: "json" };
import print2dCsd from "../csds/2d-print.csd.json" with { type: "json" };

/**
 * Per-CSD usage attribution. In-memory map; the persistence layer in
 * `capability_template_store` (packages/db/src/schema/templates.ts) already
 * carries the matching shape — moving these counters to SQLite is a follow-on
 * that doesn't change the public API here. Marketplace mechanics (rating,
 * fork, royalty) layer on top of this without changing the registry surface.
 */
export interface CsdUsage {
  /** Number of times this CSD has been adopted via an A2A skill / capability create. */
  count: number;
  /** Recent agent identifiers that adopted this CSD. Capped at 50 to bound memory. */
  recentAdopters: string[];
  /** Last time recordUsage was called for this CSD. */
  lastUsedAt: string | null;
}

/**
 * Score a CSD against a free-form description query.
 *
 * Cheap keyword overlap, no ML, no embeddings. Tokenizes the query and the
 * CSD's name + description + tags into lowercase word sets; the score is
 * the count of matching tokens, with a bonus for exact name match and a
 * small bias toward shorter CSD names (more specific). Returns 0 if no
 * tokens overlap. Good enough for the substrate — swap in graph-search or
 * embeddings later without changing the public API.
 */
function relevanceScore(csd: CSD, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const nameTokens = tokenize(csd.name ?? "");
  const descTokens = tokenize(csd.description ?? "");
  const tagTokens = new Set<string>();
  const tags = (csd as Record<string, unknown>).tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === "string") for (const tok of tokenize(t)) tagTokens.add(tok);
    }
  }
  let score = 0;
  for (const tok of queryTokens) {
    if (nameTokens.has(tok)) score += 3;          // name match weighs heaviest
    if (tagTokens.has(tok)) score += 2;           // tags second
    if (descTokens.has(tok)) score += 1;          // description third
  }
  // Slight bias toward shorter names — more specific is more useful.
  if (score > 0 && csd.name) score += Math.max(0, 30 - csd.name.length) / 100;
  return score;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

export class CsdRegistry {
  private csds: Map<string, CSD> = new Map();
  private usage: Map<string, CsdUsage> = new Map();

  /**
   * Validate a CSD document and store it in the registry.
   * Throws if the document does not conform to the CSD schema.
   */
  register(csd: CSD): void {
    const result = CsdSchema.safeParse(csd);
    if (!result.success) {
      const messages = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      throw new Error(`Invalid CSD "${(csd as Record<string, unknown>).url ?? "unknown"}": ${messages}`);
    }
    this.csds.set(result.data.url, result.data);
  }

  /**
   * Record that an agent has adopted a CSD (e.g. via pcc-author-integration).
   * Bumps the usage counter and tracks recent adopters (deduped, capped at 50).
   * No-op if the CSD URL is not registered — we don't track ghost usage.
   */
  recordUsage(url: string, byAgentId: string): void {
    if (!this.csds.has(url)) return;
    const now = new Date().toISOString();
    let u = this.usage.get(url);
    if (!u) {
      u = { count: 0, recentAdopters: [], lastUsedAt: null };
      this.usage.set(url, u);
    }
    u.count += 1;
    u.lastUsedAt = now;
    // Keep recentAdopters deduped + capped (newest at end)
    const idx = u.recentAdopters.indexOf(byAgentId);
    if (idx >= 0) u.recentAdopters.splice(idx, 1);
    u.recentAdopters.push(byAgentId);
    if (u.recentAdopters.length > 50) u.recentAdopters.shift();
  }

  /** Get usage attribution for a CSD. Returns zeros for never-used CSDs. */
  getUsage(url: string): CsdUsage {
    return this.usage.get(url) ?? { count: 0, recentAdopters: [], lastUsedAt: null };
  }

  /**
   * Find a CSD URL whose `type` field matches the given capability type string.
   * Used by the author-integration handler to map a free-text capability type
   * (e.g. "make-pizza") back to a registered CSD so usage can be attributed.
   * Returns the first match — CSD types should be unique by convention.
   */
  findUrlByType(type: string): string | undefined {
    for (const [url, csd] of this.csds.entries()) {
      const csdType = (csd as Record<string, unknown>).type;
      if (typeof csdType === "string" && csdType === type) return url;
    }
    return undefined;
  }

  /**
   * Suggest up to `limit` CSDs that best match a free-form description query.
   * Falls back to popularity (usage count desc) when the query is empty.
   * Each returned entry carries the CSD, the relevance score, and current usage.
   *
   * This is the substrate behind the pcc-suggest-templates A2A skill: a user's
   * agent describes what they're trying to onboard in plain English, the
   * registry returns N candidate templates the user's agent can pick from.
   */
  suggest(
    query: string,
    opts?: { limit?: number; kind?: CSD["kind"] },
  ): Array<{ csd: CSD; score: number; usage: CsdUsage }> {
    const limit = opts?.limit ?? 5;
    const tokens = tokenize(query);
    let candidates: CSD[] = this.list();
    if (opts?.kind) candidates = candidates.filter((c) => c.kind === opts.kind);

    const scored = candidates.map((csd) => ({
      csd,
      score: relevanceScore(csd, tokens),
      usage: this.getUsage(csd.url),
    }));

    // If no query tokens, sort by popularity instead.
    if (tokens.size === 0) {
      scored.sort((a, b) => b.usage.count - a.usage.count);
      return scored.slice(0, limit);
    }
    // Drop zero-score entries, sort by score desc, tie-break on usage.
    return scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.usage.count - a.usage.count)
      .slice(0, limit);
  }

  /** Return CSDs sorted by usage count desc, capped at `limit`. */
  popular(limit = 10): Array<{ csd: CSD; usage: CsdUsage }> {
    return this.list()
      .map((csd) => ({ csd, usage: this.getUsage(csd.url) }))
      .sort((a, b) => b.usage.count - a.usage.count)
      .slice(0, limit);
  }

  /**
   * Look up a CSD by its canonical URI.
   * Returns undefined if not found.
   */
  get(url: string): CSD | undefined {
    return this.csds.get(url);
  }

  /**
   * Return all registered CSDs.
   */
  list(): CSD[] {
    return Array.from(this.csds.values());
  }

  /**
   * Return CSDs filtered by structural kind.
   */
  findByKind(kind: CSD["kind"]): CSD[] {
    return this.list().filter((c) => c.kind === kind);
  }

  /**
   * Validate an unknown document against the CSD schema.
   * Returns { valid: boolean; errors: string[] }.
   */
  validate(csd: unknown): { valid: boolean; errors: string[] } {
    const result = CsdSchema.safeParse(csd);
    if (result.success) {
      return { valid: true, errors: [] };
    }
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return { valid: false, errors };
  }

  /**
   * Resolve a CSD by URI, merging in fields from its baseDefinition chain.
   *
   * Inheritance rules (profile overrides base):
   *   - parameters: profile params replace base params with same key; new keys are appended
   *   - constraints: profile constraints replace base constraints with same key; new keys are appended
   *   - pricing: profile pricing overrides base pricing entirely (shallow merge)
   *   - name, description, status, version: profile wins
   *   - discovery, adapter, evidence: profile wins if present
   *
   * Throws if the URL is not registered or if the baseDefinition chain cannot be resolved.
   */
  resolve(url: string): CSD {
    const csd = this.get(url);
    if (!csd) {
      throw new Error(`CSD not found: "${url}"`);
    }

    if (!csd.baseDefinition) {
      // Base type — return as-is
      return csd;
    }

    // Recursively resolve the parent
    const parent = this.resolve(csd.baseDefinition);

    // Merge parameters: parent params, overridden by profile params with the same key
    const parentParamMap = new Map(parent.parameters.map((p) => [p.key, p]));
    const mergedParams = [...parent.parameters];
    for (const param of csd.parameters) {
      if (parentParamMap.has(param.key)) {
        const idx = mergedParams.findIndex((p) => p.key === param.key);
        mergedParams[idx] = param;
      } else {
        mergedParams.push(param);
      }
    }

    // Merge constraints: parent constraints overridden by profile constraints with the same key
    const parentConstraintMap = new Map(parent.constraints.map((c) => [c.key, c]));
    const mergedConstraints = [...parent.constraints];
    for (const constraint of csd.constraints) {
      if (parentConstraintMap.has(constraint.key)) {
        const idx = mergedConstraints.findIndex((c) => c.key === constraint.key);
        mergedConstraints[idx] = constraint;
      } else {
        mergedConstraints.push(constraint);
      }
    }

    const resolved: CSD = {
      // Start from parent
      ...parent,
      // Profile-level overrides
      ...csd,
      // Merged collections
      parameters: mergedParams,
      constraints: mergedConstraints,
      // evidence: profile wins if present, else inherit from parent
      evidence: csd.evidence ?? parent.evidence,
      // discovery: profile wins if present, else inherit from parent
      discovery: csd.discovery ?? parent.discovery,
      // adapter: profile wins if present, else inherit from parent
      adapter: csd.adapter ?? parent.adapter,
      // invariants: profile invariants appended after parent invariants
      invariants: [...(parent.invariants ?? []), ...(csd.invariants ?? [])],
    };

    return resolved;
  }

  /**
   * Return the number of registered CSDs.
   */
  get size(): number {
    return this.csds.size;
  }
}

/**
 * Create a CsdRegistry pre-loaded with all built-in CSDs.
 *
 * Built-in CSDs:
 *   pcc://capabilities/fdm/v2
 *   pcc://capabilities/sla/v2
 *   pcc://capabilities/cnc-3axis/v2
 *   pcc://capabilities/laser-cut/v2
 *   pcc://capabilities/2d-print/v1
 */
export function loadBuiltinCsds(): CsdRegistry {
  const registry = new CsdRegistry();

  const builtins = [fdmCsd, slaCsd, cnc3axisCsd, laserCutCsd, print2dCsd];
  for (const raw of builtins) {
    // Use validate first to get a clear error message, then register
    const result = CsdSchema.safeParse(raw);
    if (!result.success) {
      const url = (raw as Record<string, unknown>).url ?? "unknown";
      const messages = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      throw new Error(`Built-in CSD "${url}" failed schema validation: ${messages}`);
    }
    registry.register(result.data);
  }

  return registry;
}

// retrigger CI: 2026-06-14
