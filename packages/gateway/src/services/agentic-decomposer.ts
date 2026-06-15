/**
 * Agentic Request Decomposer — the composition engine keystone.
 *
 * Takes a natural-language capability request and produces a DAG of nodes
 * matched against the LIVE capability registry. Unlike the legacy template
 * decomposer (request-decomposer.ts), this:
 *
 *   1. Decomposes the goal via LLM (Anthropic Claude) into a DAG of intent
 *      nodes — each declares an action + a required capability type +
 *      quantity + dependencies, with no hardcoded template per domain.
 *   2. Matches each intent node against the registered capabilities table,
 *      preferring exact type matches and falling back to a token-overlap
 *      scorer so e.g. "wood-fired-pizza" routes to "Marios Pizzeria" even
 *      when the LLM emits "wood_fired_pizza".
 *   3. Derives the per-node estimatedCost from the matched capability's
 *      pricing.baseCost (× quantity), and the aggregate budget from the
 *      sum. evidenceRequirements come from the matched capability's
 *      assurance tier defaults.
 *
 * If the LLM is unavailable (no ANTHROPIC_API_KEY, SDK missing, or call
 * fails), the caller is expected to fall back to the template decomposer.
 * `tryAgenticDecompose` returns null on graceful failure.
 */

import type {
  CapabilityRequest,
  CapabilityNode,
  DecompositionResult,
  MaterialRequirement,
} from "@pcc/spec";
import type { ICapabilityRepository } from "@pcc/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lightweight capability shape we read from the repo, deliberately narrow
 * so this decomposer can stay free of the heavier facade DTO churn.
 */
export interface CandidateCapability {
  id: string;
  kernelId: string;
  type: string;
  name: string;
  description?: string;
  /** Raw pricing.baseCost — string, USDC by convention. May be empty. */
  baseCostUSDC: number;
  /** Pricing minimum (fallback for cost when baseCost is 0). */
  minimumUSDC: number;
  /** Assurance tiers this capability supports (drives evidence defaults). */
  assuranceTiers: number[];
  /** Free-text materials (used for fuzzy match boost). */
  materials: string[];
  /** Optional tags for fuzzy match boost. */
  tags?: string[];
}

/**
 * Minimal interface to abstract the LLM call. The default impl uses the
 * Anthropic SDK; tests inject a stub returning a fixed JSON DAG.
 */
export interface LLMClient {
  /**
   * Returns the raw text response from the LLM given a system prompt
   * + user message. Implementations must NOT add markdown or extra prose
   * around the JSON — the system prompt enforces JSON-only.
   */
  completeJSON(args: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<string>;
}

/** What the LLM emits per node, before matching + node construction. */
export interface IntentNode {
  /** Stable id within this request (e.g. "make-pizza"). */
  nodeId: string;
  /** Short label for UIs. */
  name: string;
  /** Action description (1-2 sentences). */
  description: string;
  /** Category bucket — "fabrication" / "logistics" / "design" / etc. */
  category: string;
  /** Slug describing the capability type to match. */
  requiredCapabilityType: string;
  /** Free-text materials list for matcher hints + downstream node. */
  materials?: MaterialRequirement[];
  /** Optional evidence requirement hints from the LLM. */
  evidenceRequirements?: string[];
  /** Quantity of the capability needed (e.g. 1 pizza, 1 delivery). */
  quantity: number;
  /** Estimated hours — LLM's rough guess; later multiplied by urgency. */
  estimatedHours: number;
  /** Other nodeIds this node depends on (forms the DAG edges). */
  dependencies: string[];
  /** True when this node can run in parallel with siblings. */
  parallel: boolean;
}

/** What the LLM returns: a wrapped DAG. */
export interface IntentDag {
  goal: string;
  nodes: IntentNode[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

export const AGENTIC_SYSTEM_PROMPT = `You are the agentic composition planner for the Physical Capability Cloud (PCC) — a substrate that coordinates physical-world capabilities (manufacturing, logistics, food, services) into agent-composed workflows.

INPUT: a natural-language goal describing something the user wants made, delivered, performed, analyzed, or built in the physical world.

OUTPUT: strict JSON describing a DAG of intent nodes that compose to satisfy the goal. Each node declares the capability type required to fulfill it.

Return EXACTLY this JSON shape — no markdown, no prose, no fences:
{
  "goal": "<one-sentence restatement>",
  "nodes": [
    {
      "nodeId": "<kebab-case stable id>",
      "name": "<short label>",
      "description": "<one or two sentences>",
      "category": "fabrication|logistics|design|verification|laboratory|food|service|assembly|documentation|procurement|software",
      "requiredCapabilityType": "<canonical slug, kebab-case>",
      "quantity": 1,
      "estimatedHours": 0.5,
      "dependencies": [],
      "parallel": false,
      "materials": [],
      "evidenceRequirements": ["<short token>"]
    }
  ],
  "notes": "<optional one-liner explaining trade-offs>"
}

Capability-type slugs you can use freely (non-exhaustive):
  Food / hospitality: wood-fired-pizza, neapolitan-pizza, bartending, catering, food-prep
  Logistics: local-courier-delivery, courier-pickup, last-mile-delivery, freight, fulfillment
  Manufacturing: fdm, sla, cnc-3axis, cnc-5axis, laser-cut, waterjet, sheet-metal, injection-mold, pcb
  Lab: hplc, mass-spec, pcr, sequencing, cell-culture, microscopy, sample-prep, assay
  Documents: document-printing, large-format-printing, scanning, binding
  Soft: cad, embedded-software, qa, assembly, procurement, data-analysis

Pick the slug that best fits the action. If nothing on the list fits, mint a new kebab-case slug that names the action precisely (e.g. "rug-cleaning", "house-painting", "tax-prep"). Do NOT default to "documentation" or "custom".

RULES:
- Decompose the goal into the FEWEST nodes that make sense for THIS specific request. A pizza+delivery is TWO nodes: make + deliver. A CAD bracket is ONE node (cad) unless explicitly asked for fabrication. Don't add design+procurement+QA scaffolding the user didn't ask for.
- Dependencies form a true DAG — no cycles, ids stable across nodes.
- "quantity" is units of the capability needed (e.g. 1 pizza, 2 deliveries). Default 1.
- "estimatedHours" is YOUR rough estimate; downstream applies urgency multipliers.
- Set "parallel": true when a node can run alongside its sibling under the same parent dependency set.
- Output JSON only. No backticks, no prose, no "Here is the JSON:".`;

export function buildUserMessage(req: CapabilityRequest): string {
  return [
    `GOAL TITLE: ${req.title}`,
    `GOAL DESCRIPTION: ${req.description}`,
    `URGENCY: ${req.urgency ?? "standard"}`,
    `BUDGET: ${req.budget} ${req.currency ?? "USDC"} (cap)`,
    "",
    "Produce the JSON DAG for this goal. Output JSON only.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Default Anthropic client
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = process.env.AGENTIC_DECOMPOSE_MODEL ?? "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 2000;

/**
 * Build the default LLM client. Returns null if the SDK or key is missing —
 * caller treats that as "no agentic path available, fall back".
 */
export async function buildDefaultLLMClient(opts?: {
  apiKey?: string;
  model?: string;
}): Promise<LLMClient | null> {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  let AnthropicCtor: any;
  try {
    // @ts-ignore — optional peer dependency
    const mod = await import("@anthropic-ai/sdk");
    AnthropicCtor = (mod as any).default ?? (mod as any).Anthropic;
  } catch {
    return null;
  }
  if (!AnthropicCtor) return null;

  const model = opts?.model ?? DEFAULT_MODEL;
  const client = new AnthropicCtor({ apiKey, maxRetries: 1 });

  return {
    async completeJSON({ system, user, maxTokens }) {
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      });
      const textBlock = (resp.content as any[]).find((b) => b.type === "text") as
        | { type: "text"; text: string }
        | undefined;
      return textBlock?.text ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// JSON parsing — tolerant of fence-wrapped or trailing-prose output.
// ---------------------------------------------------------------------------

export function parseIntentDag(raw: string): IntentDag | null {
  if (!raw) return null;
  const direct = safeParse(raw);
  if (direct) return validateIntentDag(direct);

  // Try extracting the first {...} block.
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    const second = safeParse(m[0]);
    if (second) return validateIntentDag(second);
  }
  return null;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); }
  catch { return null; }
}

function validateIntentDag(obj: unknown): IntentDag | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.nodes)) return null;
  const nodes: IntentNode[] = [];
  for (const raw of o.nodes) {
    if (!raw || typeof raw !== "object") continue;
    const n = raw as Record<string, unknown>;
    if (typeof n.nodeId !== "string" || typeof n.name !== "string") continue;
    if (typeof n.requiredCapabilityType !== "string") continue;
    const deps = Array.isArray(n.dependencies)
      ? n.dependencies.filter((d): d is string => typeof d === "string")
      : [];
    const evidence = Array.isArray(n.evidenceRequirements)
      ? (n.evidenceRequirements as unknown[]).filter((e): e is string => typeof e === "string")
      : undefined;
    const materials = Array.isArray(n.materials)
      ? (n.materials as MaterialRequirement[])
      : [];
    nodes.push({
      nodeId: n.nodeId,
      name: n.name,
      description: typeof n.description === "string" ? n.description : "",
      category: typeof n.category === "string" ? n.category : "service",
      requiredCapabilityType: n.requiredCapabilityType,
      quantity: typeof n.quantity === "number" && n.quantity > 0 ? n.quantity : 1,
      estimatedHours: typeof n.estimatedHours === "number" && n.estimatedHours >= 0
        ? n.estimatedHours : 0.25,
      dependencies: deps,
      parallel: n.parallel === true,
      materials,
      evidenceRequirements: evidence,
    });
  }
  if (nodes.length === 0) return null;
  return {
    goal: typeof o.goal === "string" ? o.goal : "",
    nodes,
    notes: typeof o.notes === "string" ? o.notes : undefined,
  };
}

// ---------------------------------------------------------------------------
// Capability matching — exact type, then fuzzy.
// ---------------------------------------------------------------------------

/**
 * Pick the best matching candidate for a required capability type.
 * Returns null when nothing scores above the floor (= match:none).
 *
 * Scoring:
 *   - exact `type` equality: 1.0
 *   - normalized type equality (kebab/snake/underscore -> hyphen): 0.95
 *   - substring of either direction: 0.7
 *   - name/description token overlap: up to 0.5
 *   - tag inclusion: +0.1
 */
export function matchCapability(
  requiredType: string,
  candidates: CandidateCapability[],
): { capability: CandidateCapability; score: number } | null {
  if (candidates.length === 0) return null;

  const needle = normalizeSlug(requiredType);
  const needleTokens = tokens(requiredType);

  let best: { capability: CandidateCapability; score: number } | null = null;

  for (const cap of candidates) {
    let score = 0;

    const haystackType = normalizeSlug(cap.type);
    if (cap.type === requiredType) score = 1.0;
    else if (haystackType === needle) score = Math.max(score, 0.95);
    else if (haystackType.includes(needle) || needle.includes(haystackType)) {
      score = Math.max(score, 0.7);
    }

    // Name/description token overlap
    const haystackTokens = tokens(`${cap.name} ${cap.description ?? ""} ${cap.type}`);
    const overlap = needleTokens.filter((t) => haystackTokens.includes(t)).length;
    if (overlap > 0 && needleTokens.length > 0) {
      score = Math.max(score, Math.min(0.5, overlap / needleTokens.length * 0.5));
    }

    // Tag boost
    if (cap.tags && cap.tags.some((tag) => normalizeSlug(tag) === needle)) {
      score += 0.1;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { capability: cap, score };
    }
  }

  // Floor: <0.35 means we don't trust the match — return match:none.
  if (best && best.score >= 0.35) return best;
  return null;
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/--+/g, "-");
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s\-_,./]+/)
    .filter((t) => t.length >= 3);
}

// ---------------------------------------------------------------------------
// Tier -> default evidence requirements
// ---------------------------------------------------------------------------

const TIER_DEFAULT_EVIDENCE: Record<number, string[]> = {
  0: ["device_health_snapshot"],
  1: ["bundle_hash", "completion_event"],
  2: ["photo_evidence", "device_health", "event_log", "sensor_data"],
  3: ["zk_proof", "multi_verifier_attestation", "ipfs_bundle"],
};

function defaultEvidenceForCapability(cap: CandidateCapability): string[] {
  if (!cap.assuranceTiers || cap.assuranceTiers.length === 0) {
    return TIER_DEFAULT_EVIDENCE[1];
  }
  const highest = Math.max(...cap.assuranceTiers);
  return TIER_DEFAULT_EVIDENCE[highest] ?? TIER_DEFAULT_EVIDENCE[1];
}

// ---------------------------------------------------------------------------
// Urgency multipliers (mirrors request-decomposer for consistency)
// ---------------------------------------------------------------------------

const URGENCY_TIME_MULTIPLIER: Record<string, number> = {
  standard: 1.0,
  rush: 0.7,
  emergency: 0.5,
};

const URGENCY_COST_MULTIPLIER: Record<string, number> = {
  standard: 1.0,
  rush: 1.4,
  emergency: 2.0,
};

// ---------------------------------------------------------------------------
// Critical path + parallel tracks — same algorithm as request-decomposer,
// duplicated here so the agentic decomposer can stand alone.
// ---------------------------------------------------------------------------

function calculateCriticalPath(nodes: CapabilityNode[]): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const ect = new Map<string, number>();

  function getECT(nodeId: string): number {
    if (ect.has(nodeId)) return ect.get(nodeId)!;
    const node = nodeMap.get(nodeId);
    if (!node) return 0;
    const depMax = node.dependencies.length > 0
      ? Math.max(...node.dependencies.map(getECT))
      : 0;
    const result = depMax + node.estimatedHours;
    ect.set(nodeId, result);
    return result;
  }
  nodes.forEach((n) => getECT(n.id));

  const hasDependents = new Set<string>();
  nodes.forEach((n) => n.dependencies.forEach((d) => hasDependents.add(d)));
  const endNodes = nodes.filter((n) => !hasDependents.has(n.id));

  let criticalEnd = endNodes[0]?.id ?? nodes[nodes.length - 1]?.id;
  let maxTime = 0;
  for (const node of endNodes) {
    const t = ect.get(node.id) ?? 0;
    if (t > maxTime) {
      maxTime = t;
      criticalEnd = node.id;
    }
  }

  const path: string[] = [];
  let current: string | undefined = criticalEnd;
  while (current) {
    path.unshift(current);
    const node = nodeMap.get(current);
    if (!node || node.dependencies.length === 0) break;
    let nextId: string | undefined;
    let nextECT = -1;
    for (const depId of node.dependencies) {
      const t = ect.get(depId) ?? 0;
      if (t > nextECT) { nextECT = t; nextId = depId; }
    }
    current = nextId;
  }
  return path;
}

function calculateParallelTracks(nodes: CapabilityNode[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parallel) continue;
    const key = [...node.dependencies].sort().join(",");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(node.id);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

// ---------------------------------------------------------------------------
// Repo adapter — turns a CapabilityRepository row into a CandidateCapability
// ---------------------------------------------------------------------------

export function loadCandidatesFromRepo(repo: ICapabilityRepository): CandidateCapability[] {
  return repo.findAll().map((row) => rowToCandidate(row as Record<string, unknown>));
}

function rowToCandidate(row: Record<string, unknown>): CandidateCapability {
  const pricing = (row.pricing && typeof row.pricing === "object"
    ? row.pricing as Record<string, unknown>
    : {});
  const baseCost = parseAmount(pricing.baseCost);
  const minimum = parseAmount(pricing.minimum);
  return {
    id: String(row.id),
    kernelId: String(row.kernelId ?? (row as Record<string, unknown>).kernel_id ?? ""),
    type: String(row.type ?? ""),
    name: String(row.name ?? row.type ?? row.id),
    description: typeof row.description === "string" ? row.description : undefined,
    baseCostUSDC: baseCost,
    minimumUSDC: minimum,
    assuranceTiers: Array.isArray(row.assuranceTiers)
      ? row.assuranceTiers as number[]
      : Array.isArray((row as Record<string, unknown>).assurance_tiers)
        ? (row as Record<string, unknown>).assurance_tiers as number[]
        : [],
    materials: Array.isArray(row.materials) ? row.materials as string[] : [],
    tags: Array.isArray(row.tags) ? row.tags as string[] : undefined,
  };
}

function parseAmount(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AgenticDecomposeOptions {
  /** Candidate capabilities to match against. Pass [] to allow match:none on everything. */
  candidates: CandidateCapability[];
  /** Injected LLM client. When omitted, the caller is expected to provide one. */
  llm: LLMClient;
  /** Optional model override surfaced to the LLM client's completeJSON. */
  maxTokens?: number;
}

/**
 * Decompose a request via LLM + match. Returns the matched DAG + sums.
 * Throws if the LLM returns unparseable JSON or emits zero nodes — the
 * route is expected to catch and fall back to the template decomposer.
 */
export async function agenticDecomposeRequest(
  req: CapabilityRequest,
  opts: AgenticDecomposeOptions,
): Promise<DecompositionResult> {
  const raw = await opts.llm.completeJSON({
    system: AGENTIC_SYSTEM_PROMPT,
    user: buildUserMessage(req),
    maxTokens: opts.maxTokens,
  });

  const intent = parseIntentDag(raw);
  if (!intent || intent.nodes.length === 0) {
    throw new Error("agentic-decomposer: LLM returned unparseable or empty DAG");
  }

  return buildDagFromIntent(req, intent, opts.candidates);
}

/**
 * Pure synchronous core — useful for tests that bypass the LLM entirely
 * and supply an IntentDag directly. Same outputs as agenticDecomposeRequest.
 */
export function buildDagFromIntent(
  req: CapabilityRequest,
  intent: IntentDag,
  candidates: CandidateCapability[],
): DecompositionResult {
  const urgency = req.urgency ?? "standard";
  const timeMult = URGENCY_TIME_MULTIPLIER[urgency] ?? 1.0;
  const costMult = URGENCY_COST_MULTIPLIER[urgency] ?? 1.0;

  const idPrefix = req.id;
  const validNodeIds = new Set(intent.nodes.map((n) => n.nodeId));
  const evidenceSet = new Set<string>();

  const nodes: CapabilityNode[] = intent.nodes.map((iNode) => {
    const match = matchCapability(iNode.requiredCapabilityType, candidates);
    const matched = match?.capability;

    // Cost: matched cap baseCost (or minimum if 0) × quantity × urgency.
    // If unmatched, fall back to a small placeholder (10 USDC × quantity)
    // so unmatched nodes don't show as free.
    const quantity = iNode.quantity ?? 1;
    let unitCost = 0;
    if (matched) {
      unitCost = matched.baseCostUSDC > 0 ? matched.baseCostUSDC : matched.minimumUSDC;
    }
    if (unitCost <= 0) unitCost = 10; // unmatched / zero-priced fallback
    const estimatedCost = Math.round(unitCost * quantity * costMult * 100) / 100;

    const estimatedHours = Math.round(iNode.estimatedHours * timeMult * 10) / 10;

    const evidenceRequirements = (() => {
      if (matched) {
        const fromCap = defaultEvidenceForCapability(matched);
        for (const e of fromCap) evidenceSet.add(e);
        return fromCap;
      }
      if (iNode.evidenceRequirements && iNode.evidenceRequirements.length > 0) {
        for (const e of iNode.evidenceRequirements) evidenceSet.add(e);
        return iNode.evidenceRequirements;
      }
      const fallback = ["completion_event"];
      for (const e of fallback) evidenceSet.add(e);
      return fallback;
    })();

    // Dependencies: only keep ids that exist in this intent (drop hallucinated).
    const dependencies = iNode.dependencies
      .filter((d) => validNodeIds.has(d))
      .map((d) => `${idPrefix}-${d}`);

    return {
      id: `${idPrefix}-${iNode.nodeId}`,
      requestId: req.id,
      name: iNode.name,
      description: iNode.description,
      capabilityType: matched?.type ?? iNode.requiredCapabilityType,
      category: iNode.category,
      estimatedCost,
      estimatedHours,
      dependencies,
      parallel: iNode.parallel,
      status: "pending",
      materials: iNode.materials ?? [],
      evidenceRequirements,
      matchedCapabilityId: matched?.id,
      matchedKernelId: matched?.kernelId,
      quantity,
      decompositionSource: "agentic",
    };
  });

  const totalEstimatedCost = Math.round(
    nodes.reduce((sum, n) => sum + n.estimatedCost, 0) * 100,
  ) / 100;
  const totalEstimatedHours = Math.round(
    nodes.reduce((sum, n) => sum + n.estimatedHours, 0) * 10,
  ) / 10;
  const criticalPath = calculateCriticalPath(nodes);
  const parallelTracks = calculateParallelTracks(nodes);
  const matchCount = nodes.filter((n) => n.matchedCapabilityId).length;

  return {
    nodes,
    totalEstimatedCost,
    totalEstimatedHours,
    criticalPath,
    parallelTracks,
    source: "agentic",
    matchCount,
    evidenceRequirements: [...evidenceSet],
  };
}

/**
 * Convenience wrapper that handles client construction + graceful failure.
 * Returns null when the LLM is unavailable OR the call/parse fails — caller
 * falls back to the template decomposer.
 *
 * The `candidatesSource` callback is invoked synchronously after the LLM
 * call returns to grab the latest capability snapshot.
 */
export async function tryAgenticDecompose(
  req: CapabilityRequest,
  candidatesSource: () => CandidateCapability[],
  opts?: { client?: LLMClient | null; maxTokens?: number },
): Promise<DecompositionResult | null> {
  const client = opts?.client ?? (await buildDefaultLLMClient());
  if (!client) return null;

  try {
    return await agenticDecomposeRequest(req, {
      candidates: candidatesSource(),
      llm: client,
      maxTokens: opts?.maxTokens,
    });
  } catch {
    return null;
  }
}
