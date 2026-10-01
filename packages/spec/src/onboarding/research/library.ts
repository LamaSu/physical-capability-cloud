/**
 * Research prompt library (R5) — ready-to-fire research orchestrations, plus
 * the coaching that teaches the human what to ask.
 *
 * Source spec: returns/pcc-kits-work/research-prompts-spec-R5-20260929.md.
 * adk wires every entry into R6's event index (index.json) by `trigger`.
 *
 * `trigger` is `string | readonly string[]` rather than a single string only:
 * the spec's own entry 1 (`identify-make-model`) fires on EITHER
 * `identify.no_candidate` OR `identify.low_confidence` — one library entry,
 * two trigger ids. "id`s and triggers are unique" (spec's test list) is
 * checked over the FLATTENED set of trigger ids across all entries.
 */

import { z } from "zod";
import { INTAKE_FIELD_IDS } from "../intake/fields.js";
import { httpsUrl, nonBlankText } from "../citation-rules.js";

// ── Closed placeholder set ───────────────────────────────────────────────

/** The only placeholders a `prompt`/`searches` template may use. */
export const RESEARCH_PLACEHOLDERS = [
  "vendor",
  "model",
  "description",
  "capability",
  "protocol",
  "parameter",
] as const;
export type ResearchPlaceholder = (typeof RESEARCH_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{([a-zA-Z]+)\}/g;

/** Every `{word}` placeholder found in `text`, in first-seen order. */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const word = match[1];
    if (word && !found.includes(word)) found.push(word);
  }
  return found;
}

// ── Entry shape ──────────────────────────────────────────────────────────

export const ResearchCoachingSchema = z
  .object({
    /** The exact sentence the agent shows the human, as a sentence they can say. */
    ask: z.string().min(1),
    /** One line, plain language, on why this matters. */
    why: z.string().min(1),
  })
  .strict();
export type ResearchCoaching = z.infer<typeof ResearchCoachingSchema>;

export const ResearchLibraryEntrySchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, "id is kebab-case"),
    trigger: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    goal: z.string().min(1),
    prompt: z.string().min(1),
    searches: z.array(z.string().min(1)).min(2).max(5),
    mustReturn: z.array(z.string().min(1)).min(1),
    acceptance: z.string().min(1),
    /** Intake field id(s) (or artifact names) this result feeds. */
    fills: z.array(z.string().min(1)).min(1),
    /** R2 rule 4: mandatory for anything touching safety, money, or I/O limits. */
    humanConfirmRequired: z.boolean(),
    coaching: ResearchCoachingSchema,
  })
  .strict();
export type ResearchLibraryEntry = z.infer<typeof ResearchLibraryEntrySchema>;

// ── The library — ~10 initial entries (R5 spec) ─────────────────────────

export const RESEARCH_LIBRARY: readonly ResearchLibraryEntry[] = [
  {
    id: "identify-make-model",
    trigger: ["identify.no_candidate", "identify.low_confidence"],
    goal: "Identify the device's vendor and model from a label, photo, or description.",
    prompt:
      "Identify the vendor and model of a physical device described as: {description}. Use any visible label text and photos.",
    searches: [
      "{description} vendor model identification",
      "{description} nameplate label lookup",
    ],
    mustReturn: ["vendor", "model", "confidence", "sources"],
    acceptance:
      "A vendor+model pair backed by at least one cited source (manufacturer site, label OCR, or datasheet), not a guess.",
    fills: ["device.vendor", "device.model"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: identify the make and model of this device from this photo and description.",
      why: "Getting the exact model right means we can find the right manual, safety limits, and remote-control protocol automatically.",
    },
  },
  {
    id: "find-remote-interface",
    trigger: "adapter.unknown_protocol",
    goal: "Find how to remotely control or query {vendor} {model} — protocol, port, auth, and example commands.",
    prompt:
      "Find the remote-control or telemetry interface for {vendor} {model}: protocol (REST, serial, SiLA 2, OPC UA, Modbus, or vendor SDK), port, authentication, a docs URL, and quoted example commands.",
    searches: [
      "{vendor} {model} API documentation",
      "{vendor} {model} remote control protocol",
      "{vendor} {model} SDK OR Modbus OR OPC UA OR SiLA",
    ],
    mustReturn: ["protocol", "port", "authentication", "docsUrl", "exampleCommands", "mappedAdapterType"],
    acceptance:
      "A protocol name and at least one quoted example command from a manufacturer doc or SDK reference, with mappedAdapterType matching a kernel AdapterType.",
    fills: ["device.adapterType"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: find the programming manual for {model} and list how it is remote-controlled.",
      why: "Knowing how it connects — USB, network, or serial — narrows the search, and the right protocol means the agent can actually drive the device instead of guessing at commands.",
    },
  },
  {
    id: "find-io-ranges",
    trigger: "io.ranges_unknown",
    goal: "Find the typed I/O parameter ranges for {capability} on {vendor} {model}.",
    prompt:
      "Find the parameter names, units, min, max, step and allowed values for {capability} on {vendor} {model}, quoted from the manual.",
    searches: [
      "{vendor} {model} {parameter} range manual",
      "{vendor} {model} specifications datasheet",
      "{capability} {vendor} {model} parameter limits",
    ],
    mustReturn: ["parameters (name, unit, min, max, step, allowedValues)", "citation"],
    acceptance:
      "Parameter ranges quoted verbatim from a manufacturer manual or datasheet section, not inferred or guessed.",
    fills: ["capability.parameters"],
    humanConfirmRequired: true,
    coaching: {
      ask: "Ask me: find the parameter ranges for {capability} in the {model} manual, and quote the numbers.",
      why: "This reads the manual and published protocols to see what a typical job puts in and gets out — wrong ranges can damage the device or the job, so we always get them quoted exactly.",
    },
  },
  {
    id: "find-safety-limits",
    trigger: "safety.limits_unknown",
    goal: "Find the manufacturer's safety limits, hazards, PPE, supervision and e-stop guidance for {vendor} {model}.",
    prompt:
      "Find the manufacturer's safety limits, hazard classes, required PPE, supervision requirements, and e-stop guidance for {vendor} {model}, quoted from the manual.",
    searches: [
      "{vendor} {model} safety manual",
      "{vendor} {model} hazard PPE requirements",
      "{vendor} {model} emergency stop specification",
    ],
    mustReturn: ["limits", "hazards", "ppe", "supervision", "estop", "citation"],
    acceptance:
      "Safety limits and hazard guidance quoted from a manufacturer manual or safety datasheet, never a forum guess or inference.",
    fills: ["safety.limits", "safety.hazards", "safety.estop", "safety.commandRate"],
    humanConfirmRequired: true,
    coaching: {
      ask: "Ask me: find the safety limits and e-stop requirements for the {model} in its manual, quoted word for word.",
      why: "Each limit comes with the page it's from, and the e-stop location still gets checked on the device itself — safety limits are never guessed or defaulted, since they protect you and anyone near the machine.",
    },
  },
  {
    id: "find-calibration",
    trigger: "calibration.procedure_unknown",
    goal: "Find the calibration procedure, interval, and reference standards for {vendor} {model}.",
    prompt:
      "Find the calibration procedure, recommended interval, and reference standards for {vendor} {model}.",
    searches: [
      "{vendor} {model} calibration procedure",
      "{vendor} {model} calibration interval",
      "{vendor} {model} reference standard calibration",
    ],
    mustReturn: ["procedure", "intervalDays", "referenceStandards", "citation"],
    acceptance:
      "A calibration procedure and interval cited to a manufacturer manual or metrology reference, not a forum post.",
    fills: ["calibration.procedureRef"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: find the calibration procedure and interval for the {model}.",
      why: "You still self-declare your last calibration date — this just finds the procedure to follow.",
    },
  },
  {
    id: "find-consumables",
    trigger: "consumables.unknown",
    goal: "Find part numbers, lifetime, and restock cadence for {model}'s consumables.",
    prompt:
      "Find the consumable parts for {vendor} {model}: part numbers, expected lifetime, and restock cadence.",
    searches: [
      "{vendor} {model} consumable parts list",
      "{vendor} {model} replacement parts lifetime",
      "{model} consumables restock",
    ],
    mustReturn: ["items (partNumber, lifetime)", "citation"],
    acceptance: "Part numbers and lifetimes cited to a manufacturer parts list or manual, not a guess.",
    fills: ["consumables.items", "consumables.restockedBy"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: find the consumable parts list and restock cadence for the {model}.",
      why: "This checks what a job usually uses up and how often it needs restocking — you'll confirm which of these apply to you, so downtime never catches you mid-job.",
    },
  },
  {
    id: "find-evidence-signals",
    trigger: "evidence.sources_unknown",
    goal: "Find which logs, signatures, or telemetry {vendor} {model} emits and how to export them.",
    prompt:
      "Find what execution logs, digital signatures, or telemetry {vendor} {model} can emit, and how to export them.",
    searches: [
      "{vendor} {model} export log API",
      "{vendor} {model} telemetry signature",
      "{vendor} {model} job log format",
    ],
    mustReturn: ["sources (kind, exportMethod)", "citation"],
    acceptance:
      "A concrete export method (API endpoint, file format, or protocol) cited to a manufacturer doc, not assumed.",
    fills: ["evidence.controllerRunLog"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: find out what logs or signals the {model} can export, and how.",
      why: "The more the device can prove about its own work, the higher the assurance tier it can reach.",
    },
  },
  {
    id: "search-existing-csd",
    trigger: "csd.not_found",
    goal: "Search PCC's CSD registry, then kits, before authoring a new capability contract.",
    prompt:
      "Search for an existing CSD (Capability StructureDefinition) matching {capability} for {vendor} {model} before writing a new one.",
    searches: [
      "site:capability.network csd {capability}",
      "{capability} capability structuredefinition existing",
      "{vendor} {model} PCC kit existing",
    ],
    mustReturn: ["matches (url, similarity)", "citation"],
    acceptance: "An explicit registry search result (a match or a confirmed empty result), never skipped.",
    fills: ["capability.type"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: search the CSD registry for an existing capability like this one before you write a new one.",
      why: "Reusing an existing contract is faster and more trusted than authoring a new one from scratch.",
    },
  },
  {
    id: "search-existing-kit",
    trigger: "kit.not_found",
    goal: "Search the Kit registry by model, family, and interface before building a new kit.",
    prompt:
      "Search the Kit registry for an existing kit matching {vendor} {model} or its device family and interface.",
    searches: [
      "{vendor} {model} PCC kit",
      "{vendor} device family kit existing",
      "{protocol} adapter kit existing",
    ],
    mustReturn: ["matches (url, similarity)", "citation"],
    acceptance: "An explicit registry search result (a match or a confirmed empty result), never skipped.",
    fills: ["device.adapterType"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: check whether a kit already exists for this device or its family before we build one.",
      why: "Reuse comes before building — someone may have already solved this.",
    },
  },
  {
    id: "find-open-scaffold",
    trigger: "adapter.no_kit",
    goal: "Find open-source drivers for {vendor} {model} and list them with their licenses, without installing or running any.",
    prompt:
      "Find open-source drivers or scaffolds for {vendor} {model} (e.g. PyLabRobot, SiLA 2 drivers, OctoPrint plugins) and list each with its license. Do not install or run any code.",
    searches: [
      "{vendor} {model} PyLabRobot driver",
      "{vendor} {model} SiLA 2 driver",
      "{vendor} {model} OctoPrint plugin OR open source driver",
    ],
    mustReturn: ["candidates (name, url, license)", "citation"],
    acceptance: "A list of candidate open-source projects with their licenses cited, none installed or executed.",
    fills: ["device.adapterType"],
    humanConfirmRequired: false,
    coaching: {
      ask: "Ask me: find any open-source drivers for this device and list their licenses — don't install anything yet.",
      why: "Someone may have already built and open-sourced this driver; Gate A security review comes before any code runs.",
    },
  },
] as const;

// ── Findings shape (addendum: sensors, adk) ─────────────────────────────

/**
 * Where a finding's value comes from. `doc` and `section` must each be
 * non-blank after trim (a blank one is refused; the value is never trimmed or
 * transformed), and `url`, when present, must be an `https:` URL without
 * embedded credentials.
 *
 * `contentHash` (`sha256:` + 64 lowercase hex, of the cited text) is optional,
 * but findings should carry it so the citation can be checked against the cited
 * text later; without it a citation is only as good as its doc/section/url.
 */
export const ResearchCitationSchema = z
  .object({
    doc: nonBlankText,
    section: nonBlankText,
    url: httpsUrl.optional(),
    contentHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, "contentHash is sha256: followed by 64 lowercase hex digits")
      .optional(),
  })
  .strict();
export type ResearchCitation = z.infer<typeof ResearchCitationSchema>;

/** A one- or two-sided bound. R8 turns it into a limit only when both sides are known. */
export const ResearchRangeSchema = z
  .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
  .strict()
  .refine((r) => r.min !== undefined || r.max !== undefined, { message: "a range needs min or max" })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: "a range's min must not exceed its max",
  });

/**
 * Every R5 finding's shape. `citation` is required (not optional) — a value
 * without a citation can never become a limit, per the spec addendum. A
 * finding should carry `citation.contentHash` so the citation can be checked
 * later (see ResearchCitationSchema).
 */
export const ResearchFindingSchema = z
  .object({
    /** The template quantity the finding is about (R8 keys limits by it); needed for limits and I/O ranges. */
    quantity: z.string().min(1).max(120).optional(),
    claim: z.string().min(1),
    /** A scalar, or a range {min?, max?} for limits and I/O bounds (sensors' R8 reads ranges; #4254). */
    value: z.union([z.string(), z.number(), z.boolean(), ResearchRangeSchema]),
    unit: z.string().optional(),
    citation: ResearchCitationSchema,
    retrievedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ResearchFinding = z.infer<typeof ResearchFindingSchema>;

// ── Validation ───────────────────────────────────────────────────────────

/** Entries that touch safety, I/O, or money per their own text — scanned over
 *  `goal`/`mustReturn`/`acceptance` only (not `prompt`/`searches`, which can
 *  mention the same nouns incidentally without the entry being about them). */
const SAFETY_IO_MONEY_PATTERN =
  /\b(safety|hazard|e-?stop|ppe|supervision|i\/o|io|range|parameter|price|pricing|payout|cost|fee)\b/i;

function touchesSafetyIoOrMoney(entry: ResearchLibraryEntry): boolean {
  const haystack = `${entry.goal} ${entry.mustReturn.join(" ")} ${entry.acceptance}`;
  return SAFETY_IO_MONEY_PATTERN.test(haystack);
}

// ── The no-execution policy ──────────────────────────────────────────────
//
// The library is meant to be PASSIVE: an entry tells the agent to search, read
// and quote, not to run, install, contact or actuate anything.
// `entryInstructsExecution` enforces that as a closed list of verbs (below) over
// ALL of an entry's instruction-bearing text, not just its `prompt`.

/** The closed set of execution verbs, word-boundaried and case-insensitive. Base
 *  forms only: "installing" or "executed" are not matched, so wording that
 *  merely describes a prohibition (e.g. "none installed or executed") is not an
 *  instruction. */
const EXECUTION_VERB_PATTERN = new RegExp(
  String.raw`\b(?:install|execute|run|launch|start\s+the|flash|upload|download\s+and\s+run|` +
    String.raw`send\s+(?:(?:a|the|this)\s+)?command|connect\s+to\s+the\s+device|ssh|telnet|sudo|` +
    String.raw`pip\s+install|npm\s+install|apt\s+install|curl|wget|power[- ]cycle|actuate)\b`,
  "gi",
);

/** A negation that excuses a verb coming LATER in the same clause. */
const NEGATION_PATTERN = /\b(?:do\s+not|don['’]t|never|must\s+not|should\s+not|avoid|without)\b/i;

/** Clause boundaries: sentence punctuation, a line break, and " then ". */
const CLAUSE_BOUNDARY = /[.;!?\n]|\s+then\s+/i;

function clauseInstructsExecution(clause: string): boolean {
  const negation = NEGATION_PATTERN.exec(clause);
  const negatedFrom = negation ? negation.index : Number.POSITIVE_INFINITY;
  for (const verb of clause.matchAll(EXECUTION_VERB_PATTERN)) {
    // excused only by a negation EARLIER in the SAME clause
    if (!(negatedFrom < (verb.index ?? 0))) return true;
  }
  return false;
}

/** Every string anywhere inside `value` (a string, or arrays/objects of them). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
}

/** All instruction-bearing text of an entry: goal, prompt, every search,
 *  coaching (every string in it), mustReturn and acceptance. Missing or
 *  non-string members are skipped (the entry schema reports those). */
function instructionBearingText(entry: ResearchLibraryEntry): string[] {
  const texts: string[] = [];
  collectStrings(
    [entry.goal, entry.prompt, entry.searches, entry.coaching, entry.mustReturn, entry.acceptance],
    texts,
  );
  return texts;
}

/**
 * True when ANY instruction-bearing text of `entry` tells the agent to run,
 * install, contact or actuate something. Each text is split into clauses (on
 * `.`, `;`, `!`, `?`, a line break, and " then "); a clause instructs
 * execution when it contains a verb from the closed set — install, execute,
 * run, launch, start the, flash, upload, download and run, send (a|the|this)
 * command, connect to the device, ssh, telnet, sudo, pip/npm/apt install, curl,
 * wget, power-cycle, actuate — unless a negation (do not, don't, never, must
 * not, should not, avoid, without) appears EARLIER in the SAME clause. A
 * negation in another clause excuses nothing: "Do not install A. Execute B."
 * instructs execution.
 */
export function entryInstructsExecution(entry: ResearchLibraryEntry): boolean {
  return instructionBearingText(entry).some((text) =>
    text.split(CLAUSE_BOUNDARY).some((clause) => clauseInstructsExecution(clause)),
  );
}

export interface ResearchLibraryValidationReport {
  ok: boolean;
  schemaErrors: { id: string; issues: string[] }[];
  duplicateIds: string[];
  duplicateTriggers: string[];
  invalidPlaceholders: { id: string; placeholder: string }[];
  missingHumanConfirm: string[];
  installOrExecuteInstructions: string[];
  unknownFills: { id: string; fieldId: string }[];
}

/** Validate the research library against the R5 spec's acceptance checklist. */
export function validateResearchLibrary(
  library: readonly ResearchLibraryEntry[] = RESEARCH_LIBRARY,
): ResearchLibraryValidationReport {
  const schemaErrors: { id: string; issues: string[] }[] = [];
  const seenIds = new Map<string, number>();
  const seenTriggers = new Map<string, number>();
  const duplicateIds: string[] = [];
  const duplicateTriggers: string[] = [];
  const invalidPlaceholders: { id: string; placeholder: string }[] = [];
  const missingHumanConfirm: string[] = [];
  const installOrExecuteInstructions: string[] = [];
  const unknownFills: { id: string; fieldId: string }[] = [];

  const intakeFieldIdSet = new Set(INTAKE_FIELD_IDS);
  const placeholderSet = new Set<string>(RESEARCH_PLACEHOLDERS);

  for (const entry of library) {
    const parsed = ResearchLibraryEntrySchema.safeParse(entry);
    if (!parsed.success) {
      schemaErrors.push({
        id: entry.id ?? "<unknown>",
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      continue;
    }

    const idCount = (seenIds.get(entry.id) ?? 0) + 1;
    seenIds.set(entry.id, idCount);
    if (idCount > 1 && !duplicateIds.includes(entry.id)) duplicateIds.push(entry.id);

    const triggers = Array.isArray(entry.trigger) ? entry.trigger : [entry.trigger];
    for (const trigger of triggers) {
      const triggerCount = (seenTriggers.get(trigger) ?? 0) + 1;
      seenTriggers.set(trigger, triggerCount);
      if (triggerCount > 1 && !duplicateTriggers.includes(trigger)) duplicateTriggers.push(trigger);
    }

    for (const text of [entry.prompt, ...entry.searches]) {
      for (const placeholder of extractPlaceholders(text)) {
        if (!placeholderSet.has(placeholder)) {
          invalidPlaceholders.push({ id: entry.id, placeholder });
        }
      }
    }

    if (touchesSafetyIoOrMoney(entry) && !entry.humanConfirmRequired) {
      missingHumanConfirm.push(entry.id);
    }

    if (entryInstructsExecution(entry)) {
      installOrExecuteInstructions.push(entry.id);
    }

    for (const fieldId of entry.fills) {
      if (!intakeFieldIdSet.has(fieldId)) {
        unknownFills.push({ id: entry.id, fieldId });
      }
    }
  }

  return {
    ok:
      schemaErrors.length === 0 &&
      duplicateIds.length === 0 &&
      duplicateTriggers.length === 0 &&
      invalidPlaceholders.length === 0 &&
      missingHumanConfirm.length === 0 &&
      installOrExecuteInstructions.length === 0 &&
      unknownFills.length === 0,
    schemaErrors,
    duplicateIds,
    duplicateTriggers,
    invalidPlaceholders,
    missingHumanConfirm,
    installOrExecuteInstructions,
    unknownFills,
  };
}
