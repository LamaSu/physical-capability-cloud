/**
 * GeminiComparisonService — uses Google's Gemini multimodal API to compare
 * a captured photo against a reference document/image.
 *
 * When no API key is configured the service returns a sentinel "unavailable"
 * result rather than throwing, so callers can degrade gracefully.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComparisonResult {
  /** 0.0–1.0 match score; -1 means comparison was unavailable (no API key). */
  matchScore: number;
  verdict: "match" | "partial_match" | "no_match";
  discrepancies: string[];
  reasoning: string;
  modelUsed: string;
  tokensUsed: { prompt: number; completion: number };
}

/** Shape of the JSON Gemini is prompted to return. */
interface GeminiJsonResponse {
  matchScore: number;
  verdict: "match" | "partial_match" | "no_match";
  discrepancies: string[];
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert raw bytes to a base-64 string (browser + Node 16+ safe). */
function toBase64(bytes: Uint8Array): string {
  // Use Buffer in Node environments; fall back to btoa via Uint8 chunking
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Sniff the MIME type from the first few bytes. */
function detectMimeType(bytes: Uint8Array): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "image/webp";
  }
  return "image/jpeg"; // safe default
}

// ---------------------------------------------------------------------------
// GeminiComparisonService
// ---------------------------------------------------------------------------

export class GeminiComparisonService {
  private readonly apiKey: string | undefined;
  private readonly model = "gemini-2.0-flash";

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env["GEMINI_API_KEY"];
  }

  async compare(
    capturedImage: Uint8Array,
    referenceImage: Uint8Array,
    context?: string
  ): Promise<ComparisonResult> {
    const key = this.apiKey;

    if (!key) {
      return {
        matchScore: -1,
        verdict: "no_match",
        discrepancies: [],
        reasoning:
          "GEMINI_API_KEY not set — comparison unavailable",
        modelUsed: this.model,
        tokensUsed: { prompt: 0, completion: 0 },
      };
    }

    // Dynamically import to keep the dep optional for consumers that don't
    // need real Gemini calls (tests, mock environments).
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(key);
    const geminiModel = genAI.getGenerativeModel({ model: this.model });

    const capturedMime = detectMimeType(capturedImage);
    const referenceMime = detectMimeType(referenceImage);

    const contextNote = context
      ? `\n\nContext: ${context}`
      : "";

    const prompt =
      `Compare these two images.` +
      ` Image 1 is a photo of a physical output (e.g., a printed document or manufactured item).` +
      ` Image 2 is the reference design or document.` +
      ` Score the match from 0.0 to 1.0 where 1.0 is a perfect match.` +
      ` List any discrepancies.` +
      contextNote +
      ` Respond ONLY with valid JSON in exactly this shape (no markdown fences):` +
      ` {"matchScore": <number 0.0-1.0>, "verdict": "match"|"partial_match"|"no_match", "discrepancies": [<string>, ...], "reasoning": "<string>"}`;

    const imagePart1 = {
      inlineData: {
        data: toBase64(capturedImage),
        mimeType: capturedMime,
      },
    };

    const imagePart2 = {
      inlineData: {
        data: toBase64(referenceImage),
        mimeType: referenceMime,
      },
    };

    const response = await geminiModel.generateContent([
      prompt,
      imagePart1,
      imagePart2,
    ]);

    const candidate = response.response.candidates?.[0];
    const rawText =
      candidate?.content?.parts
        ?.map((p: { text?: string }) => p.text ?? "")
        .join("") ?? "";

    // Strip markdown fences if Gemini ignored the instruction
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let parsed: GeminiJsonResponse;
    try {
      parsed = JSON.parse(jsonText) as GeminiJsonResponse;
    } catch {
      // Graceful degradation: return a partial result with raw reasoning
      return {
        matchScore: 0,
        verdict: "no_match",
        discrepancies: ["Could not parse Gemini response as JSON"],
        reasoning: rawText,
        modelUsed: this.model,
        tokensUsed: { prompt: 0, completion: 0 },
      };
    }

    // Extract token usage if available
    const usageMetadata = response.response.usageMetadata;
    const promptTokens = usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = usageMetadata?.candidatesTokenCount ?? 0;

    // Clamp matchScore to [0, 1]
    const matchScore = Math.max(0, Math.min(1, parsed.matchScore ?? 0));

    // Validate verdict
    const allowedVerdicts = ["match", "partial_match", "no_match"] as const;
    const verdict = allowedVerdicts.includes(
      parsed.verdict as (typeof allowedVerdicts)[number]
    )
      ? (parsed.verdict as ComparisonResult["verdict"])
      : "no_match";

    return {
      matchScore,
      verdict,
      discrepancies: Array.isArray(parsed.discrepancies)
        ? parsed.discrepancies.filter((d): d is string => typeof d === "string")
        : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      modelUsed: this.model,
      tokensUsed: { prompt: promptTokens, completion: completionTokens },
    };
  }
}
