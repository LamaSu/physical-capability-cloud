import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";

const MODEL_TEXT = "claude-haiku-4-5-20251001";
const MODEL_VISION = "claude-sonnet-4-6";
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
const RATE_PER_HOUR = 30;

const KNOWN_ADAPTERS = ["hamilton", "opentrons", "octoprint", "sila", "modbus", "opcua", "mock"] as const;
type KnownAdapter = (typeof KNOWN_ADAPTERS)[number];

interface IdentifyBody {
  text?: string;
  photoBase64?: string;
}

interface Candidate {
  vendor: string;
  model: string;
  confidence: number;
  mappedAdapterType: KnownAdapter | "generic-http";
  reasoning: string;
  apiDocsUrl?: string;
}

interface IdentifyResult {
  candidates: Candidate[];
  clarifyingQuestions: string[];
  askForPhoto?: boolean;
}

const SYSTEM = `You identify physical lab and manufacturing instruments from a free-text description and/or a photo of the device label/screen.

Return strict JSON matching this shape:
{
  "candidates": [
    {
      "vendor": "Hamilton",
      "model": "Microlab Prep",
      "confidence": 0.92,
      "mappedAdapterType": "hamilton",
      "reasoning": "label reads 'Hamilton Microlab Prep' with the green LED bezel typical of the ML Prep liquid handler",
      "apiDocsUrl": "https://www.hamiltoncompany.com/automated-liquid-handling/platforms/microlab-prep"
    }
  ],
  "clarifyingQuestions": ["Is this the standalone Microlab Prep or the Vantage variant?"],
  "askForPhoto": false
}

Rules:
- Up to 3 candidates ordered by confidence (0..1).
- "mappedAdapterType" MUST be one of: ${KNOWN_ADAPTERS.join(", ")}, or "generic-http" when the device speaks an open REST/HTTP API but is not on the known list, or "generic-http" for unknown.
- If the input is too vague (e.g. "a 3D printer", "lab thing"), set candidates=[], populate clarifyingQuestions, and set askForPhoto=true.
- Keep reasoning to one sentence per candidate. No marketing copy.
- apiDocsUrl: include only if you are confident the URL exists, otherwise omit.
- Output JSON only. No prose around it. No markdown fences.`;

export async function identifyDeviceRoutes(app: FastifyInstance) {
  const rateMap = new Map<string, { count: number; windowStart: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rateMap) if (now - e.windowStart > 3600_000) rateMap.delete(ip);
  }, 600_000);

  app.post("/api/onboard/identify-device", async (request, reply) => {
    const now = Date.now();
    const entry = rateMap.get(request.ip);
    if (entry && now - entry.windowStart < 3600_000 && entry.count >= RATE_PER_HOUR) {
      return reply.status(429).send({ error: "Too many identification requests, try again in an hour" });
    }
    if (!entry || now - entry.windowStart > 3600_000) {
      rateMap.set(request.ip, { count: 1, windowStart: now });
    } else {
      entry.count++;
    }

    const body = (request.body ?? {}) as IdentifyBody;
    const text = (body.text ?? "").trim();
    const photoBase64 = body.photoBase64;

    if (!text && !photoBase64) {
      return reply.status(400).send({ error: "Provide text, photoBase64, or both" });
    }
    if (text.length > 2000) {
      return reply.status(400).send({ error: "Text too long (max 2000 chars)" });
    }
    if (photoBase64) {
      // base64 inflates ~4/3; cap by decoded length.
      const decodedLen = Math.floor((photoBase64.length * 3) / 4);
      if (decodedLen > MAX_PHOTO_BYTES) {
        return reply.status(413).send({ error: "Photo too large (max 6MB)" });
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return reply.status(503).send({ error: "Device identification temporarily unavailable" });
    }

    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const userContent: Anthropic.ContentBlockParam[] = [];
    if (photoBase64) {
      const mediaType = sniffMediaType(photoBase64);
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: stripDataPrefix(photoBase64) },
      });
    }
    userContent.push({
      type: "text",
      text: text || "Identify the device shown in the photo.",
    });

    let resp: Anthropic.Message;
    try {
      resp = await client.messages.create({
        model: photoBase64 ? MODEL_VISION : MODEL_TEXT,
        max_tokens: 800,
        system: SYSTEM,
        messages: [{ role: "user", content: userContent }],
      });
    } catch (err) {
      request.log.error({ err }, "identify-device anthropic call failed");
      return reply.status(502).send({ error: "Identification model unavailable, try again" });
    }

    const textBlock = resp.content.find((b: Anthropic.ContentBlock) => b.type === "text") as
      | { type: "text"; text: string }
      | undefined;
    if (!textBlock) {
      return reply.status(502).send({ error: "Model returned no text" });
    }

    const parsed = safeParse(textBlock.text);
    if (!parsed) {
      return reply.status(502).send({ error: "Model returned unparseable output", raw: textBlock.text.slice(0, 500) });
    }

    const result: IdentifyResult = normalize(parsed);
    return reply.send(result);
  });
}

function stripDataPrefix(data: string): string {
  const m = data.match(/^data:image\/[a-z]+;base64,(.*)$/i);
  return m ? m[1] : data;
}

function sniffMediaType(data: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  const m = data.match(/^data:(image\/[a-z]+);base64,/i);
  if (m) {
    const t = m[1].toLowerCase();
    if (t === "image/jpeg" || t === "image/png" || t === "image/webp" || t === "image/gif") return t;
  }
  return "image/jpeg";
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch { /* try to extract */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch { /* fall through */ }
  }
  return null;
}

function normalize(raw: unknown): IdentifyResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const candidates = Array.isArray(r.candidates) ? r.candidates : [];
  const clarifyingQuestions = Array.isArray(r.clarifyingQuestions)
    ? (r.clarifyingQuestions as unknown[]).map(String).slice(0, 5)
    : [];
  const askForPhoto = typeof r.askForPhoto === "boolean" ? r.askForPhoto : undefined;
  return {
    candidates: candidates
      .slice(0, 3)
      .map((c) => normalizeCandidate(c))
      .filter((c): c is Candidate => c !== null),
    clarifyingQuestions,
    ...(askForPhoto !== undefined && { askForPhoto }),
  };
}

function normalizeCandidate(raw: unknown): Candidate | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const vendor = typeof c.vendor === "string" ? c.vendor.slice(0, 80) : "";
  const model = typeof c.model === "string" ? c.model.slice(0, 120) : "";
  const reasoning = typeof c.reasoning === "string" ? c.reasoning.slice(0, 280) : "";
  if (!vendor && !model) return null;
  const confidence = typeof c.confidence === "number" ? Math.max(0, Math.min(1, c.confidence)) : 0.5;
  const mappedRaw = typeof c.mappedAdapterType === "string" ? c.mappedAdapterType.toLowerCase() : "";
  const mappedAdapterType: KnownAdapter | "generic-http" = KNOWN_ADAPTERS.includes(mappedRaw as KnownAdapter)
    ? (mappedRaw as KnownAdapter)
    : "generic-http";
  const apiDocsUrl = typeof c.apiDocsUrl === "string" && /^https?:\/\//i.test(c.apiDocsUrl)
    ? c.apiDocsUrl.slice(0, 500)
    : undefined;
  return {
    vendor,
    model,
    confidence,
    mappedAdapterType,
    reasoning,
    ...(apiDocsUrl && { apiDocsUrl }),
  };
}
