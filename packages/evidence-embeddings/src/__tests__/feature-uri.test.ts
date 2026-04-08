import { describe, it, expect } from "vitest";
import {
  parseFeatureURI,
  buildFeatureURI,
  isValidFeatureURI,
  KNOWN_FEATURE_URIS,
} from "../feature-uri.js";

// ── parseFeatureURI ───────────────────────────────────────────────────

describe("parseFeatureURI", () => {
  it("parses a valid CLIP embedding URI", () => {
    const result = parseFeatureURI("pcc://clip@v1/embedding");
    expect(result).toEqual({
      protocol: "pcc",
      extractor: "clip",
      version: "v1",
      output: "embedding",
    });
  });

  it("parses a valid phash similarity URI", () => {
    const result = parseFeatureURI("pcc://phash@v1/similarity");
    expect(result).toEqual({
      protocol: "pcc",
      extractor: "phash",
      version: "v1",
      output: "similarity",
    });
  });

  it("parses a valid whisper transcript URI", () => {
    const result = parseFeatureURI("pcc://whisper@v1/transcript");
    expect(result).toEqual({
      protocol: "pcc",
      extractor: "whisper",
      version: "v1",
      output: "transcript",
    });
  });

  it("parses URIs with higher version numbers", () => {
    const result = parseFeatureURI("pcc://clip@v42/embedding");
    expect(result.version).toBe("v42");
  });

  it("parses URIs with hyphens and underscores in extractor", () => {
    const result = parseFeatureURI("pcc://my-custom_model@v1/output");
    expect(result.extractor).toBe("my-custom_model");
  });

  it("throws on empty string", () => {
    expect(() => parseFeatureURI("")).toThrow("Invalid feature URI");
  });

  it("throws on wrong protocol", () => {
    expect(() => parseFeatureURI("http://clip@v1/embedding")).toThrow(
      "Invalid feature URI",
    );
  });

  it("throws on missing version", () => {
    expect(() => parseFeatureURI("pcc://clip/embedding")).toThrow(
      "Invalid feature URI",
    );
  });

  it("throws on missing output", () => {
    expect(() => parseFeatureURI("pcc://clip@v1")).toThrow(
      "Invalid feature URI",
    );
  });

  it("throws on missing output with trailing slash", () => {
    expect(() => parseFeatureURI("pcc://clip@v1/")).toThrow(
      "Invalid feature URI",
    );
  });

  it("throws on uppercase extractor", () => {
    expect(() => parseFeatureURI("pcc://CLIP@v1/embedding")).toThrow(
      "Invalid feature URI",
    );
  });

  it("throws on version without v prefix", () => {
    expect(() => parseFeatureURI("pcc://clip@1/embedding")).toThrow(
      "Invalid feature URI",
    );
  });
});

// ── buildFeatureURI ───────────────────────────────────────────────────

describe("buildFeatureURI", () => {
  it("builds a valid URI from components", () => {
    expect(buildFeatureURI("clip", "v1", "embedding")).toBe(
      "pcc://clip@v1/embedding",
    );
  });

  it("builds URIs that round-trip through parse", () => {
    const uri = buildFeatureURI("whisper", "v2", "transcript");
    const parsed = parseFeatureURI(uri);
    expect(parsed).toEqual({
      protocol: "pcc",
      extractor: "whisper",
      version: "v2",
      output: "transcript",
    });
  });

  it("throws on empty extractor", () => {
    expect(() => buildFeatureURI("", "v1", "embedding")).toThrow(
      "Invalid extractor",
    );
  });

  it("throws on invalid version format", () => {
    expect(() => buildFeatureURI("clip", "1.0", "embedding")).toThrow(
      "Invalid version",
    );
  });

  it("throws on uppercase extractor", () => {
    expect(() => buildFeatureURI("CLIP", "v1", "embedding")).toThrow(
      "Invalid extractor",
    );
  });

  it("throws on empty output", () => {
    expect(() => buildFeatureURI("clip", "v1", "")).toThrow("Invalid output");
  });
});

// ── isValidFeatureURI ─────────────────────────────────────────────────

describe("isValidFeatureURI", () => {
  it("returns true for valid URIs", () => {
    expect(isValidFeatureURI("pcc://clip@v1/embedding")).toBe(true);
    expect(isValidFeatureURI("pcc://phash@v1/similarity")).toBe(true);
  });

  it("returns false for invalid URIs", () => {
    expect(isValidFeatureURI("")).toBe(false);
    expect(isValidFeatureURI("http://clip@v1/embedding")).toBe(false);
    expect(isValidFeatureURI("pcc://CLIP@v1/embedding")).toBe(false);
    expect(isValidFeatureURI("garbage")).toBe(false);
  });
});

// ── KNOWN_FEATURE_URIS ───────────────────────────────────────────────

describe("KNOWN_FEATURE_URIS", () => {
  it("all known URIs are parseable", () => {
    for (const uri of Object.values(KNOWN_FEATURE_URIS)) {
      expect(() => parseFeatureURI(uri)).not.toThrow();
    }
  });

  it("contains expected entries", () => {
    expect(KNOWN_FEATURE_URIS.CLIP_V1_EMBEDDING).toBe(
      "pcc://clip@v1/embedding",
    );
    expect(KNOWN_FEATURE_URIS.PHASH_V1_SIMILARITY).toBe(
      "pcc://phash@v1/similarity",
    );
    expect(KNOWN_FEATURE_URIS.WHISPER_V1_TRANSCRIPT).toBe(
      "pcc://whisper@v1/transcript",
    );
    expect(KNOWN_FEATURE_URIS.VLM_V1_DESCRIPTION).toBe(
      "pcc://vlm@v1/description",
    );
  });
});
