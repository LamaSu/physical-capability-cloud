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
 * Per-CSD usage attribution.
 *
 * In-memory by default; SQLite-backed when a CsdUsageRepository is supplied to
 * the CsdRegistry constructor. The public registry API (recordUsage / getUsage
 * / suggest / popular / findUrlByType) is unchanged either way — only the
 * storage swaps.
 *
 * Marketplace mechanics (rating, fork, royalty) layer on top of this without
 * changing the registry surface.
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
 * Storage contract for CsdUsage. CsdRegistry calls these methods when wired
 * to a persistent backend. The default (no repo) keeps the in-memory Map.
 *
 * Implementations live in @pcc/store; @pcc/spec defines the interface only so
 * the spec package stays storage-agnostic (no @pcc/store dependency from spec,
 * which would create a cycle).
 */
export interface CsdUsageRepository {
  /** Read usage for one CSD URL. Return the zero shape if never recorded. */
  get(url: string): CsdUsage;
  /**
   * Record one adoption. Implementation handles count increment, lastUsedAt
   * stamp, and the deduped recent-adopter list (capped at 50, newest at end).
   */
  record(url: string, byAgentId: string): void;
  /** Bulk-load usage for a set of URLs. Used by suggest()/popular() to avoid N+1 reads. */
  getMany(urls: readonly string[]): Map<string, CsdUsage>;
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

/**
 * In-memory CsdUsageRepository — the default backing store. Kept fast for
 * the suggest-templates test suite and any consumer that doesn't need the
 * counter to survive process restart. Swapped at construction time when the
 * gateway wires a SQLite-backed implementation.
 */
class InMemoryCsdUsageRepository implements CsdUsageRepository {
  private usage: Map<string, CsdUsage> = new Map();

  get(url: string): CsdUsage {
    return this.usage.get(url) ?? { count: 0, recentAdopters: [], lastUsedAt: null };
  }

  record(url: string, byAgentId: string): void {
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

  getMany(urls: readonly string[]): Map<string, CsdUsage> {
    const out = new Map<string, CsdUsage>();
    for (const u of urls) out.set(u, this.get(u));
    return out;
  }
}

export class CsdRegistry {
  private csds: Map<string, CSD> = new Map();
  private usageRepo: CsdUsageRepository;

  /**
   * @param usageRepo Optional storage backend for usage attribution. Defaults
   *   to an in-memory map. Pass a CsdUsageRepository implementation (e.g. the
   *   SQLite-backed one in @pcc/store) to make counters survive restart.
   */
  constructor(usageRepo?: CsdUsageRepository) {
    this.usageRepo = usageRepo ?? new InMemoryCsdUsageRepository();
  }

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
    this.usageRepo.record(url, byAgentId);
  }

  /** Get usage attribution for a CSD. Returns zeros for never-used CSDs. */
  getUsage(url: string): CsdUsage {
    return this.usageRepo.get(url);
  }

  /**
   * Find a CSD URL whose canonical URL contains the given capability type
   * slug. CSD URLs follow the convention `pcc://capabilities/<type-slug>/<version>`,
   * so we extract the slug from the path and match. Used by the
   * author-integration handler to map a free-text capability type
   * (e.g. "fdm", "make-pizza") back to a registered CSD so usage can be
   * attributed. Returns the first match — type slugs are unique by convention.
   *
   * Falls back to matching the CSD's `name` field case-insensitively when no
   * URL slug match is found, so an agent passing a friendly type ("FDM") still
   * resolves to the right CSD.
   */
  findUrlByType(type: string): string | undefined {
    const lower = type.toLowerCase();
    // Pass 1: URL-path slug match (most common — pcc://capabilities/<slug>/<v>)
    for (const [url] of this.csds.entries()) {
      const m = url.match(/^pcc:\/\/capabilities\/([^/]+)\//i);
      if (m && m[1]!.toLowerCase() === lower) return url;
    }
    // Pass 2: explicit `type` field (CSDs that opt in to it later)
    for (const [url, csd] of this.csds.entries()) {
      const csdType = (csd as Record<string, unknown>).type;
      if (typeof csdType === "string" && csdType.toLowerCase() === lower) return url;
    }
    // Pass 3: name match, case-insensitive
    for (const [url, csd] of this.csds.entries()) {
      if (typeof csd.name === "string" && csd.name.toLowerCase() === lower) return url;
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

    // One bulk usage read avoids N round-trips on SQLite-backed implementations.
    const usageMap = this.usageRepo.getMany(candidates.map((c) => c.url));
    const zero: CsdUsage = { count: 0, recentAdopters: [], lastUsedAt: null };
    const scored = candidates.map((csd) => ({
      csd,
      score: relevanceScore(csd, tokens),
      usage: usageMap.get(csd.url) ?? zero,
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
    const all = this.list();
    const usageMap = this.usageRepo.getMany(all.map((c) => c.url));
    const zero: CsdUsage = { count: 0, recentAdopters: [], lastUsedAt: null };
    return all
      .map((csd) => ({ csd, usage: usageMap.get(csd.url) ?? zero }))
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
 *
 * @param usageRepo Optional persistent usage backend (e.g. SQLite-backed).
 *   When omitted, the registry uses an in-memory map — matches the original
 *   pre-persistence behavior. The gateway wires the SQLite implementation
 *   here when `PCC_CSD_PERSIST=true`.
 */
export function loadBuiltinCsds(usageRepo?: CsdUsageRepository): CsdRegistry {
  const registry = new CsdRegistry(usageRepo);

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
