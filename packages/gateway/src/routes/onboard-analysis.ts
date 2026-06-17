/**
 * Onboarding capability analysis — derives a capability shape from an
 * operator's free-text description.
 *
 * Why this exists
 * ---------------
 * POST /api/onboard/analyze used to return a hardcoded FDM 3D-printer
 * `DocumentAnalysisResult` regardless of input — fed a rideshare description
 * it still returned build-volume + nozzle temps + PLA. This module replaces
 * that stub with input-derived analysis, using the same agentic approach as
 * the live v3 onboard-chat endpoint (an Anthropic model primed with PCC
 * domain context):
 *
 *   - PRIMARY (production): prime the model with PCC capability context and
 *     have it extract a structured DocumentAnalysisResult from the text via
 *     forced tool-use. This is the "v3 agentic analysis" path.
 *   - FALLBACK (no ANTHROPIC_API_KEY / SDK unavailable / LLM error): a
 *     deterministic keyword classifier maps the text to the closest PCC
 *     capability type. Mirrors onboard-chat's graceful no-key degradation —
 *     the endpoint stays useful offline and, critically, never returns a
 *     wrong-domain hardcoded result.
 *
 * @pcc/spec is imported type-only, so this module pulls in NO runtime
 * workspace dependency (its unit tests run without any built dist).
 */

import type {
  DocumentAnalysisResult,
  AISuggestedCapability,
  CapabilityType,
  ToleranceSpec,
} from "@pcc/spec";

// ── Anthropic client surface (minimal, mockable) ─────────────────────
//
// We model only the slice of the Anthropic Messages API we use. Tests inject
// a fake implementation via `analyzeOnboardingText(text, { client })`, so the
// agentic path can be exercised deterministically without a network call.

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

type AnthropicResponseBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export interface AnalysisAnthropicClient {
  messages: {
    create: (args: {
      model: string;
      max_tokens: number;
      system: string;
      tools: AnthropicToolDef[];
      tool_choice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
      messages: Array<{ role: "user" | "assistant"; content: unknown }>;
    }) => Promise<{ content: AnthropicResponseBlock[]; stop_reason?: string }>;
  };
}

// ── Constants ────────────────────────────────────────────────────────

/** Anthropic model — keep in lockstep with onboard-chat.ts. */
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

/** Tool the model must call to return structured analysis. */
const ANALYSIS_TOOL_NAME = "record_capability_analysis";

const ANALYSIS_TOOL: AnthropicToolDef = {
  name: ANALYSIS_TOOL_NAME,
  description:
    "Record the capability analysis extracted from the operator's description. " +
    "Call this exactly once with everything you derived from the text.",
  input_schema: {
    type: "object",
    additionalProperties: true,
    properties: {
      suggestedCapabilities: {
        type: "array",
        description: "Capabilities the operator offers, derived from the text. Usually one.",
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            type: {
              type: "string",
              description:
                "Capability type slug, e.g. fdm, sla, cnc-3axis, cnc-5axis, laser-cut, " +
                "waterjet, injection-mold, hplc, chromatography, mass-spec, pcr, sequencing, " +
                "cell-culture, microscopy, document-printing, large-format-printing, scanning, " +
                "courier-pickup, courier-delivery, inspection, assembly, or a short " +
                "lowercase-hyphen slug (e.g. rideshare) when none fit. Use 'custom' as a last resort.",
            },
            name: { type: "string" },
            description: { type: "string" },
            materials: { type: "array", items: { type: "string" } },
            confidence: { type: "number" },
            sourceReason: { type: "string" },
          },
          required: ["type", "name"],
        },
      },
      extractedSpecs: {
        type: "object",
        description: "Key→value specs actually implied by the text. Empty object if none.",
        additionalProperties: { type: "string" },
      },
      extractedMaterials: {
        type: "array",
        description: "Materials mentioned or clearly implied. Empty array if none.",
        items: { type: "string" },
      },
      extractedTolerances: { type: "array", items: { type: "object", additionalProperties: true } },
      confidence: { type: "number", description: "Overall confidence 0..1." },
    },
    required: ["suggestedCapabilities", "confidence"],
  },
};

const ANALYSIS_SYSTEM_PROMPT = `You are PCC's capability analyst. PCC is a control plane for physical manufacturing and service capabilities — operators expose billable CAPABILITIES (what their equipment or service can DO), not raw machines.

Given an operator's free-text description, extract the capability they offer and classify it into the most appropriate \`type\`. Reference types:
- 3D printing: fdm, sla, sls, mjf
- Machining / forming: cnc-3axis, cnc-5axis, lathe, laser-cut, waterjet, sheet-metal, injection-mold
- Transport / logistics: courier-pickup, courier-delivery (use a slug like "rideshare" for passenger transport / driving services)
- Lab / biotech: hplc, chromatography, mass-spec, pcr, sequencing, cell-culture, microscopy, spectroscopy, centrifuge, assay, liquid-handler
- Document services: document-printing, large-format-printing, scanning, binding
- Other: inspection, assembly, custom
You may also coin a short lowercase-hyphen slug if none fit. Use "custom" only as a last resort.

Hard rules:
- Derive EVERYTHING from the provided text. NEVER invent specs, dimensions, tolerances, or materials the text does not support. If the operator does not do 3D printing, do NOT return 3D-printing specs (no build volume, no nozzle temps, no PLA).
- extractedSpecs: only specs implied by the text (key→value strings). Empty object if none.
- extractedMaterials: only materials mentioned/implied. Empty array if none (e.g. a rideshare driver has no materials).
- Set an honest confidence in 0..1.

Always respond by calling the \`${ANALYSIS_TOOL_NAME}\` tool exactly once. Do not write prose.`;

// ── Lazy Anthropic SDK loader (degradable, cached) ───────────────────

let cachedSdk: Promise<{ ctor: unknown | null }> | null = null;

async function loadAnthropicSdk(): Promise<{ ctor: unknown | null }> {
  if (cachedSdk) return cachedSdk;
  cachedSdk = (async () => {
    try {
      // @ts-ignore — resolved at runtime from the gateway's deps
      const mod = await import("@anthropic-ai/sdk");
      const ctor = (mod as any).default ?? (mod as any).Anthropic ?? null;
      return { ctor };
    } catch {
      return { ctor: null };
    }
  })();
  return cachedSdk;
}

/** Reset the cached SDK import — tests only. */
export function _resetAnalysisSdkCache(): void {
  cachedSdk = null;
}

async function makeAnalysisClient(apiKey: string): Promise<AnalysisAnthropicClient | null> {
  const { ctor } = await loadAnthropicSdk();
  if (!ctor) return null;
  try {
    return new (ctor as new (o: { apiKey: string }) => AnalysisAnthropicClient)({ apiKey });
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────

export interface AnalyzeOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Defaults to ANTHROPIC_MODEL / claude-sonnet-4-6. */
  model?: string;
  /** sourceDocumentId stamped onto the result. */
  sourceDocumentId?: string;
  /**
   * Inject a client (or `null` to force the heuristic path). When omitted, a
   * real client is built from `apiKey`. Tests pass a fake to exercise the
   * agentic path deterministically.
   */
  client?: AnalysisAnthropicClient | null;
}

export interface AnalyzeOutcome {
  analysis: DocumentAnalysisResult;
  /** Which path produced the result. */
  mode: "llm" | "heuristic";
  /** Set when the LLM path was attempted but fell back to the heuristic. */
  warning?: string;
}

/**
 * Analyze an operator's free-text description into a DocumentAnalysisResult.
 *
 * Tries the agentic LLM path first (when a client / API key is available),
 * and always falls back to the deterministic keyword classifier rather than
 * throwing — the endpoint must never return a wrong-domain result or a 500
 * for a well-formed request.
 */
export async function analyzeOnboardingText(
  text: string,
  opts: AnalyzeOptions = {},
): Promise<AnalyzeOutcome> {
  const clean = (text ?? "").trim();
  const sourceDocumentId = opts.sourceDocumentId ?? "doc-inline";

  if (!clean) {
    return { analysis: heuristicAnalyze("", sourceDocumentId), mode: "heuristic" };
  }

  // Resolve the client: explicit injection (incl. null) wins; otherwise build
  // a real one from the API key when present.
  let client: AnalysisAnthropicClient | null;
  if (opts.client !== undefined) {
    client = opts.client;
  } else {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    client = apiKey ? await makeAnalysisClient(apiKey) : null;
  }

  if (!client) {
    return { analysis: heuristicAnalyze(clean, sourceDocumentId), mode: "heuristic" };
  }

  try {
    const res = await client.messages.create({
      model: opts.model ?? DEFAULT_MODEL,
      max_tokens: 1500,
      system: ANALYSIS_SYSTEM_PROMPT,
      tools: [ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME },
      messages: [
        {
          role: "user",
          content: `Analyze this operator description and record the capability analysis:\n\n${clean}`,
        },
      ],
    });

    const toolBlock = res.content.find(
      (b): b is Extract<AnthropicResponseBlock, { type: "tool_use" }> =>
        b.type === "tool_use" && b.name === ANALYSIS_TOOL_NAME,
    );

    if (toolBlock) {
      const normalized = normalizeLlmAnalysis(toolBlock.input, sourceDocumentId);
      if (normalized.suggestedCapabilities.length > 0) {
        return { analysis: normalized, mode: "llm" };
      }
    }

    // Model returned nothing usable — fall back rather than emit an empty result.
    return {
      analysis: heuristicAnalyze(clean, sourceDocumentId),
      mode: "heuristic",
      warning: "LLM returned no usable analysis; used keyword classification.",
    };
  } catch (err) {
    return {
      analysis: heuristicAnalyze(clean, sourceDocumentId),
      mode: "heuristic",
      warning: `LLM analysis failed (${(err as Error).message}); used keyword classification.`,
    };
  }
}

// ── Request body coalescing ──────────────────────────────────────────

/**
 * Pull the text-to-analyze out of a request body. Accepts the common field
 * names a caller might use, plus document/documents shapes. Returns "" when
 * nothing usable is present.
 */
export function coalesceAnalysisText(body: unknown): string {
  if (typeof body === "string") return body.trim();
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, any>;

  const singles = [
    b.text,
    b.description,
    b.content,
    b.documentText,
    b.document_text,
    b.notes,
    b.summary,
    b.prompt,
    b.message,
    b.document?.text,
    b.document?.content,
    b.doc?.text,
    b.doc?.content,
  ];
  for (const c of singles) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }

  if (Array.isArray(b.documents)) {
    const joined = b.documents
      .map((d: any) => (typeof d === "string" ? d : d?.text ?? d?.content ?? ""))
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
      .join("\n");
    if (joined.trim()) return joined.trim();
  }

  return "";
}

/** Pull a sourceDocumentId hint out of a request body, if any. */
export function coalesceSourceDocumentId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, any>;
  const id = b.sourceDocumentId ?? b.documentId ?? b.document?.id ?? b.doc?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// ── LLM output normalization ─────────────────────────────────────────

function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
      else if (val != null) out[k] = String(val);
    }
  }
  return out;
}

function toleranceArray(v: unknown): ToleranceSpec[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is ToleranceSpec => !!x && typeof x === "object" && !Array.isArray(x));
}

let suggestionCounter = 0;
function nextSuggestionId(): string {
  suggestionCounter += 1;
  return `sug-${suggestionCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLlmAnalysis(
  raw: Record<string, unknown>,
  sourceDocumentId: string,
): DocumentAnalysisResult {
  const rawCaps = Array.isArray(raw.suggestedCapabilities) ? raw.suggestedCapabilities : [];
  const suggestedCapabilities: AISuggestedCapability[] = rawCaps
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => {
      const tol = c.tolerances;
      const env = c.envelope;
      return {
        id: typeof c.id === "string" && c.id ? c.id : nextSuggestionId(),
        type: (typeof c.type === "string" && c.type ? c.type : "custom") as CapabilityType,
        name: typeof c.name === "string" && c.name ? c.name : "Capability",
        description: typeof c.description === "string" ? c.description : "",
        materials: stringArray(c.materials),
        tolerances:
          tol && typeof tol === "object" && !Array.isArray(tol) ? (tol as ToleranceSpec) : undefined,
        envelope:
          env && typeof env === "object" && !Array.isArray(env) ? (env as any) : undefined,
        suggestedParams: [],
        confidence: clamp01(c.confidence, 0.7),
        sourceReason:
          typeof c.sourceReason === "string" && c.sourceReason
            ? c.sourceReason
            : "Derived from the operator description by LLM analysis",
      };
    });

  return {
    suggestedCapabilities,
    extractedSpecs: stringRecord(raw.extractedSpecs),
    extractedMaterials: stringArray(raw.extractedMaterials),
    extractedTolerances: toleranceArray(raw.extractedTolerances),
    confidence: clamp01(raw.confidence, 0.7),
    sourceDocumentId,
  };
}

// ── Deterministic keyword classifier (fallback) ──────────────────────

interface ClassBucket {
  type: CapabilityType;
  name: string;
  description: string;
  materials: string[];
  specs: Record<string, string>;
  /** [substring, weight] — matched case-insensitively against the text. */
  keywords: Array<[string, number]>;
}

const BUCKETS: ClassBucket[] = [
  {
    type: "fdm",
    name: "FDM 3D Printing",
    description: "Fused-deposition 3D printing from thermoplastic filament.",
    materials: ["PLA", "PETG", "ABS", "TPU"],
    specs: { process: "FDM (fused deposition modeling)" },
    keywords: [
      ["fdm", 3], ["fused deposition", 3], ["3d print", 3], ["3d-print", 3],
      ["filament", 2], ["nozzle", 2], ["extruder", 2], ["extrusion", 1],
      ["pla", 2], ["petg", 2], ["prusa", 2], ["ender", 2], ["bambu", 2],
      ["layer height", 2], ["build volume", 2], ["build plate", 2],
    ],
  },
  {
    type: "sla",
    name: "SLA Resin Printing",
    description: "Vat-photopolymerization (resin) 3D printing.",
    materials: ["standard resin", "tough resin"],
    specs: { process: "SLA (stereolithography)" },
    keywords: [
      ["sla", 3], ["resin print", 3], ["resin printer", 3], ["photopolymer", 3],
      ["msla", 3], ["vat photopoly", 3], ["uv resin", 2],
    ],
  },
  {
    type: "cnc-3axis",
    name: "CNC Machining",
    description: "Subtractive CNC machining of metal and plastic stock.",
    materials: ["aluminum", "steel", "brass", "acetal"],
    specs: { process: "CNC machining" },
    keywords: [
      ["cnc", 3], ["milling", 2], ["machining", 2], ["3-axis", 2], ["5-axis", 2],
      ["lathe", 2], ["turning center", 2], ["tool path", 2], ["toolpath", 2],
      ["haas", 2], ["mazak", 2], ["end mill", 2],
    ],
  },
  {
    type: "laser-cut",
    name: "Laser Cutting",
    description: "Laser cutting and engraving of sheet stock.",
    materials: ["acrylic", "plywood", "MDF"],
    specs: { process: "laser cutting" },
    keywords: [
      ["laser cut", 3], ["laser-cut", 3], ["laser cutter", 3], ["laser engrav", 2],
      ["co2 laser", 3], ["fiber laser", 3],
    ],
  },
  {
    type: "injection-mold",
    name: "Injection Molding",
    description: "Plastic injection molding from tooling.",
    materials: ["ABS", "polypropylene", "nylon"],
    specs: { process: "injection molding" },
    keywords: [
      ["injection mold", 4], ["injection-mold", 4], ["injection moulding", 4], ["mold tooling", 3],
    ],
  },
  {
    type: "rideshare",
    name: "Rideshare / Passenger Transport",
    description: "On-demand passenger transport (rideshare / driving service).",
    materials: [],
    specs: { service: "passenger transport" },
    keywords: [
      ["rideshare", 4], ["ride share", 4], ["ride-share", 4], ["pick up passengers", 4],
      ["passenger", 3], ["passengers", 3], ["chauffeur", 3], ["uber", 3], ["lyft", 3],
      ["drive people", 3], ["driving people", 3], ["commuters", 2], ["fare", 2],
      ["trips a day", 2], ["airport pickup", 2], ["airport run", 2], ["driver", 2],
      ["sedan", 1], ["minivan", 1], ["my car", 1],
    ],
  },
  {
    type: "courier-delivery",
    name: "Courier / Local Delivery",
    description: "Local courier and parcel delivery service.",
    materials: [],
    specs: { service: "parcel delivery" },
    keywords: [
      ["courier", 3], ["parcel", 3], ["last mile", 3], ["last-mile", 3],
      ["deliver packages", 3], ["package delivery", 3], ["freight", 2], ["logistics", 1],
    ],
  },
  {
    type: "hplc",
    name: "HPLC Analysis",
    description: "High-performance liquid chromatography analysis.",
    materials: ["acetonitrile", "methanol", "buffer"],
    specs: { technique: "HPLC" },
    keywords: [
      ["hplc", 4], ["chromatography", 3], ["mobile phase", 3], ["analyte", 2],
      ["lc-ms", 3], ["mass spec", 3], ["mass-spec", 3], ["gc-ms", 3],
    ],
  },
  {
    type: "document-printing",
    name: "Document Printing",
    description: "Document, copy, and small-format print services.",
    materials: ["paper", "toner"],
    specs: { service: "document printing" },
    keywords: [
      ["document printing", 4], ["print shop", 3], ["copy shop", 3], ["photocopy", 3],
      ["officejet", 3], ["business cards", 3], ["toner", 2], ["flyer", 2], ["brochure", 2],
    ],
  },
  {
    type: "pcb",
    name: "PCB Assembly",
    description: "Printed circuit board fabrication and assembly.",
    materials: ["FR-4", "solder"],
    specs: { service: "PCB assembly" },
    keywords: [
      ["printed circuit board", 4], ["pcb", 3], ["pick and place", 3],
      ["solder paste", 3], ["reflow oven", 3],
    ],
  },
];

const CUSTOM_BUCKET: ClassBucket = {
  type: "custom",
  name: "Custom Capability",
  description: "General capability derived from the operator description.",
  materials: [],
  specs: {},
  keywords: [],
};

/** Minimum keyword score before we trust a bucket over "custom". */
const MIN_BUCKET_SCORE = 2;

/**
 * Deterministically classify free text into the closest PCC capability. Used
 * when the agentic LLM path is unavailable. Reads the actual words, so the
 * result reflects the input (a rideshare description never returns FDM).
 */
export function heuristicAnalyze(text: string, sourceDocumentId: string): DocumentAnalysisResult {
  const haystack = (text ?? "").toLowerCase();

  let best: ClassBucket = CUSTOM_BUCKET;
  let bestScore = 0;
  for (const bucket of BUCKETS) {
    let score = 0;
    for (const [kw, weight] of bucket.keywords) {
      if (haystack.includes(kw)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = bucket;
    }
  }
  if (bestScore < MIN_BUCKET_SCORE) best = CUSTOM_BUCKET;

  // Honest, modest confidence: keyword classification is not full extraction.
  const confidence = best === CUSTOM_BUCKET ? 0.2 : Math.min(0.6, 0.35 + bestScore * 0.03);
  const sourceReason =
    "Keyword classification — agentic LLM analysis unavailable. " +
    "Set ANTHROPIC_API_KEY on the gateway for full document extraction.";

  const suggestion: AISuggestedCapability = {
    id: nextSuggestionId(),
    type: best.type,
    name: best.name,
    description: best.description,
    materials: [...best.materials],
    suggestedParams: [],
    confidence,
    sourceReason,
  };

  return {
    suggestedCapabilities: [suggestion],
    extractedSpecs: { ...best.specs },
    extractedMaterials: [...best.materials],
    extractedTolerances: [],
    confidence,
    sourceDocumentId,
  };
}
