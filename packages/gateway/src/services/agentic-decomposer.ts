/**
 * Agentic Request Decomposer
 *
 * Turns a natural-language capability request into a dependency DAG by:
 *
 *   1. PLANNING the steps with an LLM (the "agentic" part) — or a deterministic
 *      offline heuristic when no LLM is configured / reachable.
 *   2. MATCHING each planned step to a *registered capability instance* via
 *      semantic (token-overlap) search over the live capability registry.
 *   3. DERIVING the budget from the matched capabilities' prices and the
 *      evidence requirements from each matched capability — instead of the old
 *      hardcoded template (which always produced a document-print+logistics DAG,
 *      a fixed `pdf_proof` evidence list, and a default budget of 1000).
 *
 * This is the composition keystone: "margherita pizza made and delivered to
 * Manhattan" must yield [make-pizza → a wood-fired-pizza cap] + [deliver → a
 * local-courier-delivery cap], priced from those two caps — NOT a printing DAG.
 *
 * Design notes:
 *   - The engine (`decomposeAgentic`) is PURE and dependency-injected (LLM +
 *     matcher + optional legacy fallback) so it is fully testable offline with
 *     deterministic stubs — no network, no API key.
 *   - The Anthropic client is loaded lazily and degrades to `null` when the SDK
 *     or `ANTHROPIC_API_KEY` is absent (mirrors services/commentary-narrator.ts).
 *   - When there is no LLM AND nothing matched, we fall back to the legacy
 *     keyword templates so existing rich decompositions (robotics, lab, …)
 *     keep working. We do NOT fall back when an LLM produced the plan — an
 *     LLM plan with no provider is "no capability available", not "wrong plan",
 *     so we never silently reintroduce a document DAG.
 */

import type {
  CapabilityRequest,
  CapabilityNode,
  DecompositionResult,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Public contracts (dependency-injected — see decomposeAgentic)
// ---------------------------------------------------------------------------

/** One abstract step the planner proposes before grounding it to a capability. */
export interface PlannedStep {
  /** Human-readable node name, e.g. "Make the pizza". */
  name: string;
  /** What this step does, in prose. */
  description: string;
  /** Free-text query used to find the best registered capability. */
  searchQuery: string;
  /** Optional explicit capability type the planner is confident about. */
  capabilityTypeHint?: string;
  /** Coarse role — drives category + evidence defaults when unmatched. */
  kind?: StepKind;
}

export type StepKind = "make" | "process" | "deliver" | "inspect" | "generic";

/** A capability as the matcher needs to see it (transport-agnostic). */
export interface CapabilityLite {
  id: string;
  type: string;
  name: string;
  description?: string;
  tags?: string[];
  materials?: string[];
  kernelId: string;
  pricing?: { currency?: string; baseCost?: string; minimum?: string };
  assuranceTiers?: number[];
}

/** The capability a step was matched to, with the data nodes need. */
export interface MatchedCapability {
  capabilityId: string;
  capabilityType: string;
  name: string;
  kernelId: string;
  /** Headline price as a number (parsed from pricing.baseCost ?? minimum). */
  price: number;
  currency: string;
  assuranceTiers: number[];
  tags: string[];
  materials: string[];
  /** Match confidence in [0,1]. */
  score: number;
}

export interface CapabilityMatcher {
  /** Best capability for a query (and optional type hint), or null if none clears the threshold. */
  match(query: string, typeHint?: string): Promise<MatchedCapability | null>;
}

export interface DecomposerLLM {
  /** Plan the ordered steps for a goal. Implementations may throw on failure. */
  planSteps(goal: { title: string; description: string }): Promise<PlannedStep[]>;
}

export interface DecomposeDeps {
  /** LLM planner. `null`/absent → use the offline heuristic. */
  llm?: DecomposerLLM | null;
  /** Capability matcher (semantic search over the registry). */
  matcher: CapabilityMatcher;
  /**
   * Legacy keyword-template decomposer. Used ONLY when no LLM ran AND no step
   * matched any capability — preserves the historical rich templates without
   * ever reintroducing a document DAG for a non-document goal.
   */
  legacyFallback?: (req: CapabilityRequest) => DecompositionResult;
}

// ---------------------------------------------------------------------------
// Tokenization + semantic scoring (no embeddings — cheap, offline, deterministic)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "your", "that", "this", "from", "are",
  "was", "were", "need", "want", "please", "would", "like", "have", "has",
  "get", "got", "made", "make", "making", "into", "out", "one", "two", "inch",
  "inches", "some", "any", "all", "can", "will", "should", "must", "near",
  "around", "about", "via", "per", "each", "then", "them", "they", "our",
]);

/** Lowercase → strip punctuation → tokens of length ≥ 3, minus stopwords. */
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Do two tokens refer to the same concept? Exact match, or a shared prefix of
 * ≥ 4 chars when both are ≥ 4 chars — so "pizza"~"pizzeria", "deliver"~
 * "delivered"~"delivery", "print"~"printing", but NOT "make"~"market".
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  return i >= 4;
}

function anyMatch(token: string, bag: readonly string[]): boolean {
  for (const t of bag) if (tokensMatch(token, t)) return true;
  return false;
}

const FIELD_WEIGHT = { type: 3, name: 2, tags: 2, materials: 1.5, description: 1 } as const;

/**
 * Score how well a query describes a capability. Returns confidence in [0,1]
 * plus whether at least one "strong" (type/name/tag) field was hit. The score
 * is the average best-field-weight across the query's meaningful tokens,
 * mapped onto [0,1] (an average weight of 2 ⇒ confidence 1).
 */
export function scoreCapability(
  query: string,
  cap: CapabilityLite,
): { score: number; strongHit: boolean } {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { score: 0, strongHit: false };

  const typeToks = tokenize(cap.type);
  const nameToks = tokenize(cap.name);
  const tagToks = (cap.tags ?? []).flatMap(tokenize);
  const matToks = (cap.materials ?? []).flatMap(tokenize);
  const descToks = tokenize(cap.description ?? "");

  let weightSum = 0;
  let strongHit = false;

  for (const qt of queryTokens) {
    let best = 0;
    if (anyMatch(qt, typeToks)) best = Math.max(best, FIELD_WEIGHT.type);
    if (anyMatch(qt, nameToks)) best = Math.max(best, FIELD_WEIGHT.name);
    if (anyMatch(qt, tagToks)) best = Math.max(best, FIELD_WEIGHT.tags);
    if (anyMatch(qt, matToks)) best = Math.max(best, FIELD_WEIGHT.materials);
    if (anyMatch(qt, descToks)) best = Math.max(best, FIELD_WEIGHT.description);
    if (best >= FIELD_WEIGHT.tags) strongHit = true;
    weightSum += best;
  }

  const avg = weightSum / queryTokens.length;
  return { score: Math.min(1, avg / 2), strongHit };
}

/** Default minimum confidence for a match to count. */
export const DEFAULT_MATCH_THRESHOLD = 0.3;

/**
 * Build a CapabilityMatcher over a capability source. The source is a thunk so
 * the route can back it with the live CapabilityFacade and tests can back it
 * with an in-memory array — the scoring is identical either way.
 */
export function createMatcher(
  listCapabilities: () => Promise<CapabilityLite[]> | CapabilityLite[],
  opts?: { threshold?: number },
): CapabilityMatcher {
  const threshold = opts?.threshold ?? DEFAULT_MATCH_THRESHOLD;
  return {
    async match(query, typeHint) {
      const caps = await listCapabilities();
      let best: MatchedCapability | null = null;

      for (const cap of caps) {
        // A confident type-hint match is an instant strong signal.
        const hintHit =
          !!typeHint && tokenize(typeHint).some((t) => anyMatch(t, tokenize(cap.type)));
        const { score, strongHit } = scoreCapability(query, cap);
        const effScore = hintHit ? Math.max(score, 0.9) : score;

        if (effScore < threshold) continue;
        if (!strongHit && !hintHit) continue;

        if (!best || effScore > best.score) {
          best = toMatched(cap, effScore);
        }
      }
      return best;
    },
  };
}

function toMatched(cap: CapabilityLite, score: number): MatchedCapability {
  return {
    capabilityId: cap.id,
    capabilityType: cap.type,
    name: cap.name,
    kernelId: cap.kernelId,
    price: capPrice(cap),
    currency: cap.pricing?.currency ?? "USDC",
    assuranceTiers: cap.assuranceTiers ?? [0, 1],
    tags: cap.tags ?? [],
    materials: cap.materials ?? [],
    score: Math.round(score * 100) / 100,
  };
}

/** Headline price for budget derivation: baseCost, else minimum, else 0. */
export function capPrice(cap: CapabilityLite): number {
  const raw = cap.pricing?.baseCost ?? cap.pricing?.minimum ?? "0";
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Offline heuristic planner — used when no LLM is configured
// ---------------------------------------------------------------------------

/** Words that signal a distinct "deliver it to me" sub-step. */
const DELIVERY_CUES = [
  "deliver", "delivered", "delivery", "courier", "ship", "shipped", "shipping",
  "mail", "drop off", "dropoff", "drop-off", "to my", "to me", "send to",
  "bring to", "last-mile", "last mile",
];

function hasDeliveryCue(text: string): boolean {
  const t = text.toLowerCase();
  return DELIVERY_CUES.some((c) => t.includes(c));
}

/**
 * Split a goal at its delivery clause so the "make" query doesn't drag the
 * delivery words (which would confuse matching). Returns [makePart, deliverPart].
 */
function splitOnDelivery(text: string): [string, string] {
  const re = /\b(and\s+)?(deliver(?:ed|y)?|courier(?:ed)?|ship(?:ped|ping)?|mail(?:ed)?|drop[\s-]?off|sent?|bring)\b/i;
  const m = re.exec(text);
  if (!m || m.index <= 0) return [text, text];
  return [text.slice(0, m.index).trim(), text.slice(m.index).trim()];
}

/**
 * Deterministic offline plan. Produces a primary "make/produce" step and, when
 * the goal clearly asks for delivery, a second "deliver" step. Crucially it
 * does NOT use any fixed domain template — grounding happens via capability
 * matching, so a non-document goal can never become a document DAG here.
 */
export function heuristicPlan(goal: { title: string; description: string }): PlannedStep[] {
  const text = `${goal.title}. ${goal.description}`.trim();
  const steps: PlannedStep[] = [];

  if (hasDeliveryCue(text)) {
    const [makePart, deliverPart] = splitOnDelivery(goal.description || text);
    steps.push({
      name: "Produce the requested item",
      description: makePart || goal.description || goal.title,
      searchQuery: stripDeliveryWords(makePart || goal.title),
      kind: "make",
    });
    steps.push({
      name: "Deliver to the requester",
      description: deliverPart || "Deliver the finished item to the requester.",
      searchQuery: `courier delivery ${deliverPart}`.trim(),
      kind: "deliver",
    });
  } else {
    steps.push({
      name: "Fulfil the request",
      description: goal.description || goal.title,
      searchQuery: `${goal.title} ${goal.description}`.trim(),
      kind: "make",
    });
  }
  return steps;
}

function stripDeliveryWords(text: string): string {
  return text
    .replace(/\b(deliver(?:ed|y)?|courier(?:ed)?|ship(?:ped|ping)?|mail(?:ed)?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Evidence + category derivation — FROM THE MATCHED CAPABILITY (not pdf_proof)
// ---------------------------------------------------------------------------

interface Domain {
  category: string;
  base: string[];
  tier2?: string[];
}

/** Classify a capability into a domain from its type/name/tags. */
function classifyDomain(cap: MatchedCapability | null, kind?: StepKind): Domain {
  const hay = cap
    ? `${cap.capabilityType} ${cap.name} ${cap.tags.join(" ")}`.toLowerCase()
    : "";
  const has = (...ws: string[]) => ws.some((w) => hay.includes(w));

  if (kind === "deliver" || has("deliver", "courier", "logistics", "ship", "last-mile", "last mile")) {
    return {
      category: "logistics",
      base: ["delivery_confirmation", "recipient_location"],
      tier2: ["photo_at_dropoff", "gps_breadcrumb_trail"],
    };
  }
  if (has("pizza", "food", "kitchen", "bake", "cook", "meal", "culinary", "wood-fired")) {
    return {
      category: "food-prep",
      base: ["photo_of_completed_item", "completion_timestamp"],
      tier2: ["kitchen_ticket_log", "temperature_log"],
    };
  }
  if (has("hplc", "assay", "pcr", "chromatograph", "spectro", "sequenc", "analysis", "lab", "microscop")) {
    return {
      category: "laboratory",
      base: ["raw_data_files", "instrument_log"],
      tier2: ["chromatogram_screenshot", "signed_coa"],
    };
  }
  if (has("print", "2d-print", "ipp", "document")) {
    return {
      category: "documentation",
      base: ["photo_of_printed_output"],
      tier2: ["print_job_log"],
    };
  }
  if (has("cnc", "fdm", "sla", "laser", "mill", "machin", "fabricat", "3d", "assembly")) {
    return {
      category: "fabrication",
      base: ["photo_of_parts", "dimensional_check"],
      tier2: ["inspection_report"],
    };
  }
  // `kind === "deliver"` is already handled above, so the generic fallback
  // category is "fabrication" (a make/process/inspect/generic step).
  return { category: "fabrication", base: ["photo_of_completed_work"] };
}

/**
 * Evidence requirements derived from the matched capability: the domain sets
 * the base proofs, the capability's max assurance tier sets the depth. This is
 * the replacement for the old hardcoded `["pdf_proof"]`.
 */
export function deriveEvidence(cap: MatchedCapability | null, kind?: StepKind): string[] {
  const domain = classifyDomain(cap, kind);
  const ev = [...domain.base];
  const maxTier = cap ? Math.max(0, ...cap.assuranceTiers) : 0;
  if (maxTier >= 1 && !ev.includes("completion_event")) ev.push("completion_event");
  if (maxTier >= 2 && domain.tier2) for (const e of domain.tier2) if (!ev.includes(e)) ev.push(e);
  if (maxTier >= 3) ev.push("multi_verifier_attestation", "ipfs_storage_cid");
  return ev;
}

// ---------------------------------------------------------------------------
// Critical path + parallel tracks (linear chains here; reused legacy logic shape)
// ---------------------------------------------------------------------------

function criticalPath(nodes: CapabilityNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ect = new Map<string, number>();
  const get = (id: string): number => {
    if (ect.has(id)) return ect.get(id)!;
    const n = byId.get(id);
    if (!n) return 0;
    const dep = n.dependencies.length ? Math.max(...n.dependencies.map(get)) : 0;
    const r = dep + n.estimatedHours;
    ect.set(id, r);
    return r;
  };
  nodes.forEach((n) => get(n.id));

  const hasDependents = new Set<string>();
  nodes.forEach((n) => n.dependencies.forEach((d) => hasDependents.add(d)));
  const ends = nodes.filter((n) => !hasDependents.has(n.id));

  let end = ends[0]?.id ?? nodes[nodes.length - 1]?.id;
  let max = -1;
  for (const n of ends) {
    const t = ect.get(n.id) ?? 0;
    if (t > max) { max = t; end = n.id; }
  }

  const path: string[] = [];
  let cur: string | undefined = end;
  while (cur) {
    path.unshift(cur);
    const n = byId.get(cur);
    if (!n || n.dependencies.length === 0) break;
    let nextId: string | undefined;
    let nextE = -1;
    for (const d of n.dependencies) {
      const t = ect.get(d) ?? 0;
      if (t > nextE) { nextE = t; nextId = d; }
    }
    cur = nextId;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Estimation helpers
// ---------------------------------------------------------------------------

const URGENCY_TIME: Record<string, number> = { standard: 1.0, rush: 0.7, emergency: 0.5 };
const HOURS_BY_KIND: Record<StepKind, number> = {
  make: 2, process: 1.5, deliver: 1, inspect: 0.5, generic: 1.5,
};
/** Fallback unit cost for an unmatched node so totals stay > 0. */
const UNMATCHED_UNIT_COST = 10;

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

/**
 * Decompose a request agentically. See file header for the full contract.
 *
 * Returns a DecompositionResult enriched with:
 *   - per-node match fields (matchStatus / matchedCapabilityId / …)
 *   - matchedCount, derivedBudget (Σ matched prices), usedLLM, usedFallback
 */
export async function decomposeAgentic(
  req: CapabilityRequest,
  deps: DecomposeDeps,
): Promise<DecompositionResult> {
  const { llm, matcher, legacyFallback } = deps;
  const timeMult = URGENCY_TIME[req.urgency ?? "standard"] ?? 1.0;

  // 1. PLAN — LLM first (the agentic path), heuristic otherwise.
  let usedLLM = false;
  let steps: PlannedStep[] = [];
  if (llm) {
    try {
      steps = await llm.planSteps({ title: req.title, description: req.description });
      usedLLM = Array.isArray(steps) && steps.length > 0;
    } catch {
      usedLLM = false;
      steps = [];
    }
  }
  if (steps.length === 0) steps = heuristicPlan({ title: req.title, description: req.description });

  // 2. MATCH each step to a registered capability.
  const matches = await Promise.all(
    steps.map((s) => matcher.match(s.searchQuery, s.capabilityTypeHint).catch(() => null)),
  );

  // 3. BUILD nodes (linear chain: step i depends on step i-1).
  const nodes: CapabilityNode[] = steps.map((step, i) => {
    const m = matches[i] ?? null;
    const kind = step.kind ?? "generic";
    const domain = classifyDomain(m, kind);
    const hours = Math.round(HOURS_BY_KIND[kind] * timeMult * 10) / 10;
    const cost = m ? m.price : UNMATCHED_UNIT_COST;

    const node: CapabilityNode = {
      id: `${req.id}-step-${i + 1}`,
      requestId: req.id,
      name: step.name,
      description: step.description,
      capabilityType: m ? m.capabilityType : (step.capabilityTypeHint ?? kind),
      category: domain.category,
      estimatedCost: Math.round(cost * 100) / 100,
      estimatedHours: hours,
      dependencies: i === 0 ? [] : [`${req.id}-step-${i}`],
      parallel: false,
      status: "pending",
      materials: m ? m.materials.map((name) => ({ name, quantity: 1, unit: "each", estimatedCost: 0 })) : [],
      evidenceRequirements: deriveEvidence(m, kind),
      matchStatus: m ? "matched" : "none",
      matchedCapabilityId: m?.capabilityId,
      matchedCapabilityName: m?.name,
      matchedKernelId: m?.kernelId,
      matchScore: m?.score,
    };
    return node;
  });

  const matchedCount = nodes.filter((n) => n.matchStatus === "matched").length;

  // 4. FALLBACK — only when neither an LLM nor any capability grounded the plan.
  //    This preserves the legacy rich templates (robotics/lab/…) without ever
  //    reintroducing a document DAG for a non-document goal.
  if (matchedCount === 0 && !usedLLM && legacyFallback) {
    const legacy = legacyFallback(req);
    return {
      ...legacy,
      nodes: legacy.nodes.map((n) => ({ ...n, matchStatus: "none" as const })),
      matchedCount: 0,
      usedLLM: false,
      usedFallback: true,
    };
  }

  // 5. Totals + derived budget (Σ matched prices only).
  const totalEstimatedCost = Math.round(nodes.reduce((s, n) => s + n.estimatedCost, 0) * 100) / 100;
  const totalEstimatedHours = Math.round(nodes.reduce((s, n) => s + n.estimatedHours, 0) * 10) / 10;
  const derivedBudget = matchedCount > 0
    ? Math.round(matches.reduce((s, m) => s + (m?.price ?? 0), 0) * 100) / 100
    : undefined;

  return {
    nodes,
    totalEstimatedCost,
    totalEstimatedHours,
    criticalPath: criticalPath(nodes),
    parallelTracks: [],
    matchedCount,
    derivedBudget,
    usedLLM,
    usedFallback: false,
  };
}

// ---------------------------------------------------------------------------
// Anthropic-backed planner (lazy + degradable) — production path
// ---------------------------------------------------------------------------

export const DECOMPOSE_SYSTEM_PROMPT = `You are the planning brain of the Physical Capability Cloud (PCC) — a marketplace where physical capabilities (make pizza, deliver a package, CNC mill, run an HPLC assay, …) are offered as billable, evidence-backed steps.

Given a natural-language goal, decompose it into the MINIMUM ordered sequence of physical capability steps needed to fully satisfy it. Each step will be matched to a registered capability provider, so describe each step the way you would search for the provider that performs it.

Rules:
- Output ONLY a JSON array. No prose, no markdown fences.
- Each element: { "name": string, "description": string, "searchQuery": string, "capabilityTypeHint"?: string, "kind"?: "make"|"process"|"deliver"|"inspect"|"generic" }.
- "searchQuery" is the few words you'd use to find the provider (e.g. "wood-fired margherita pizza", "local courier delivery").
- Steps are executed in order; step N depends on step N-1.
- Do NOT invent steps the goal does not require. A "pizza delivered" goal is exactly two steps: make the pizza, then deliver it. Do NOT add documentation, printing, or logistics-paperwork steps unless the goal is literally about documents.
- Use the requester's domain. Never default to printing/couriering documents.`;

interface AnthropicLike {
  messages: {
    create: (args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: "user" | "assistant"; content: string }>;
    }) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
  };
}

let cachedCtor: Promise<any | null> | null = null;

async function loadAnthropic(): Promise<any | null> {
  if (cachedCtor) return cachedCtor;
  cachedCtor = (async () => {
    try {
      // @ts-ignore — optional peer dependency, loaded at runtime
      const mod = await import("@anthropic-ai/sdk");
      return (mod as any).default ?? (mod as any).Anthropic ?? null;
    } catch {
      return null;
    }
  })();
  return cachedCtor;
}

/** Reset the cached SDK import — tests only. */
export function _resetAnthropicCache(): void {
  cachedCtor = null;
}

/**
 * Tolerantly extract the first JSON array from a model response (handles bare
 * arrays and ```json fenced blocks). Returns [] on any parse failure.
 */
export function parsePlannedSteps(text: string): PlannedStep[] {
  if (!text) return [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && typeof s.name === "string" && typeof s.searchQuery === "string")
      .map((s) => ({
        name: String(s.name),
        description: String(s.description ?? s.name),
        searchQuery: String(s.searchQuery),
        capabilityTypeHint: s.capabilityTypeHint ? String(s.capabilityTypeHint) : undefined,
        kind: ["make", "process", "deliver", "inspect", "generic"].includes(s.kind) ? s.kind : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Create an Anthropic-backed planner, or `null` when the SDK isn't installed or
 * no API key is configured (the route then uses the offline heuristic).
 */
export async function createAnthropicDecomposer(opts?: {
  apiKey?: string;
  model?: string;
}): Promise<DecomposerLLM | null> {
  const apiKey = opts?.apiKey ?? process.env.PCC_DECOMPOSE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const Ctor = await loadAnthropic();
  if (!Ctor) return null;

  let client: AnthropicLike;
  try {
    client = new Ctor({ apiKey }) as AnthropicLike;
  } catch {
    return null;
  }
  const model = opts?.model ?? process.env.PCC_DECOMPOSE_MODEL ?? "claude-sonnet-4-5";

  return {
    async planSteps(goal) {
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        system: DECOMPOSE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Goal title: ${goal.title}\nGoal: ${goal.description}\n\nReturn the JSON array of steps.`,
          },
        ],
      });
      const text = (res.content ?? [])
        .map((b) => (b.type === "text" ? b.text ?? "" : ""))
        .join("");
      return parsePlannedSteps(text);
    },
  };
}
