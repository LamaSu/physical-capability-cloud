/**
 * Stage 1 — web procedure → StepDraft[].
 *
 * Calls an injected LlmPlanner. The orchestrator does NOT lock to a
 * specific provider; pass any planner that satisfies the interface
 * (Anthropic, OpenAI, Gemini, local). Mirrors PRISM ProtocolPlanner
 * (multi-agent or single-agent variants — both expose a single .plan()
 * method here).
 */

import {
  StepDraftSchema,
  type LlmPlanner,
  type StepDraft,
} from "./types.js";

export interface IngestOptions {
  planner: LlmPlanner;
  procedureText: string;
  knownInstruments: string[];
  systemPrompt?: string;
}

export class IngestError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
    this.name = "IngestError";
  }
}

export async function ingestProcedure(
  opts: IngestOptions,
): Promise<StepDraft[]> {
  const raw = await opts.planner.plan({
    procedureText: opts.procedureText,
    knownInstruments: opts.knownInstruments,
    systemPrompt: opts.systemPrompt,
  });
  // Validate every step — the LLM may hallucinate fields.
  const parsed: StepDraft[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r = StepDraftSchema.safeParse(raw[i]);
    if (!r.success) {
      throw new IngestError(
        `LLM returned invalid StepDraft at index ${i}`,
        r.error.issues,
      );
    }
    parsed.push(r.data);
  }
  // Reject empty plans — almost always an LLM failure mode.
  if (parsed.length === 0) {
    throw new IngestError("LLM returned zero steps");
  }
  // Enforce instrument vocab — the LLM must stay in-bounds.
  const vocab = new Set(opts.knownInstruments);
  if (vocab.size > 0) {
    const offenders = parsed
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !vocab.has(s.instrument));
    if (offenders.length > 0) {
      throw new IngestError(
        `LLM referenced unknown instruments: ${offenders
          .map(({ s, i }) => `[${i}]${s.instrument}`)
          .join(", ")}`,
      );
    }
  }
  return parsed;
}

/**
 * Reference system prompt — captures PRISM's structured-output framing
 * without locking the planner to a specific provider.
 */
export const REFERENCE_SYSTEM_PROMPT = `\
You are a laboratory protocol planner. Given a free-form scientific
procedure, emit a JSON array of atomic robot actions. Each action is one
object with these fields:

  name        : short label
  instrument  : slug from the provided lab vocabulary
  action      : driver action slug
  reagent     : (optional) reagent name
  volumeUl    : (optional) volume in microliters
  source      : (optional) source location slug
  target      : (optional) target location slug
  notes       : (optional) free-form key/value bag

Rules:
- One physical action per step. Split multi-volume dispenses into one
  step per well.
- Only use instruments from the lab vocabulary. If a procedure step
  cannot be performed, omit it AND report this back in a top-level
  "warnings" key.
- Return only valid JSON. No prose.`;
