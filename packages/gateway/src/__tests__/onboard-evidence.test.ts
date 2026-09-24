/**
 * Unit tests for routes/onboard-evidence.ts — the bounded /prove evidence
 * checks (B2), the adaptation of /prove events to the canonical isFabricated
 * predicate (B1), the evidence-tier CLAIM, and the canonical evidence record.
 */

import { describe, it, expect } from "vitest";
import { isFabricated } from "@pcc/spec";
import {
  EVENTS_MAX_COUNT,
  EVENTS_MAX_SERIALIZED_BYTES,
  EVIDENCE_MAX_DEPTH,
  JPEG_MAX_MARKERS,
  PHOTO_MAX_DECODED_BYTES,
  PHOTO_MAX_ENCODED_CHARS,
  buildEvidenceRecord,
  crc32,
  detectImageFormat,
  eventsDigest,
  evidenceRecordDigest,
  fabricatedEventIndices,
  inspectPhoto,
  isReservedDescription,
  parseImageDimensions,
  summarizeEvidence,
  toFabricationScreenInput,
  validateEvidenceShape,
  type ValidatedEvidence,
} from "../routes/onboard-evidence.js";
import {
  b64,
  makeJpeg,
  makePng,
  makeWebpVp8,
  makeWebpVp8l,
  makeWebpVp8x,
  referenceCrc32,
} from "./fixtures/onboard-images.js";

const NOW = new Date().toISOString();
const ev = (extra: Record<string, unknown> = {}) => ({ type: "execution_completed", timestamp: NOW, payload: {}, ...extra });

function shapeError(evidence: unknown): { status: number; error: string } | null {
  const r = validateEvidenceShape(evidence);
  return r.ok ? null : { status: r.rejection.status, error: r.rejection.error };
}

function validatedPhoto(buf: Buffer, prefix = "") {
  const r = validateEvidenceShape({ photoBase64: prefix + b64(buf) });
  if (!r.ok) throw new Error(`fixture rejected: ${r.rejection.error}`);
  return r.value.photo!;
}

describe("crc32", () => {
  it("matches the CRC-32 check value and an independent implementation", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(referenceCrc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    const sample = Buffer.from("IHDR\x00\x00\x00\x10\x00\x00\x00\x10\x08\x02\x00\x00\x00", "latin1");
    expect(crc32(sample)).toBe(referenceCrc32(sample));
  });
});

describe("image magic bytes + header-only dimensions", () => {
  it("identifies PNG, JPEG and WebP and nothing else", () => {
    expect(detectImageFormat(makePng(16, 16))).toBe("png");
    expect(detectImageFormat(makeJpeg(16, 16))).toBe("jpeg");
    expect(detectImageFormat(makeWebpVp8x(16, 16))).toBe("webp");
    expect(detectImageFormat(Buffer.from("GIF89a\x10\x00\x10\x00", "latin1"))).toBeNull();
    expect(detectImageFormat(Buffer.alloc(64))).toBeNull();
    expect(detectImageFormat(Buffer.from("%PDF-1.7\n"))).toBeNull();
  });

  it("reads PNG IHDR dimensions and rejects a bad CRC or illegal header", () => {
    expect(parseImageDimensions(makePng(640, 480), "png")).toEqual({ width: 640, height: 480 });
    expect(parseImageDimensions(makePng(60000, 60000), "png")).toEqual({ width: 60000, height: 60000 });
    expect(parseImageDimensions(makePng(640, 480, { corruptIhdrCrc: true }), "png")).toBeNull();
    expect(parseImageDimensions(makePng(640, 480, { bitDepth: 3 }), "png")).toBeNull();
    expect(parseImageDimensions(makePng(640, 480, { colorType: 5 }), "png")).toBeNull();
    expect(parseImageDimensions(makePng(640, 480).subarray(0, 30), "png")).toBeNull();
  });

  it("reads JPEG SOFn dimensions with a bounded marker scan", () => {
    expect(parseImageDimensions(makeJpeg(800, 600), "jpeg")).toEqual({ width: 800, height: 600 });
    expect(parseImageDimensions(makeJpeg(800, 600, { sofMarker: 0xc2 }), "jpeg")).toEqual({ width: 800, height: 600 });
    expect(parseImageDimensions(makeJpeg(800, 600, { extraApp1Segments: 20 }), "jpeg")).toEqual({ width: 800, height: 600 });
    // SOS before any frame header, a zero height, truncation, and a scan past the marker bound are unparseable.
    expect(parseImageDimensions(makeJpeg(800, 600, { sosBeforeSof: true }), "jpeg")).toBeNull();
    expect(parseImageDimensions(makeJpeg(800, 0), "jpeg")).toBeNull();
    expect(parseImageDimensions(makeJpeg(800, 600).subarray(0, 24), "jpeg")).toBeNull();
    expect(parseImageDimensions(makeJpeg(800, 600, { extraApp1Segments: JPEG_MAX_MARKERS }), "jpeg")).toBeNull();
  });

  it("reads WebP VP8X / VP8L / VP8 dimensions", () => {
    expect(parseImageDimensions(makeWebpVp8x(1024, 768), "webp")).toEqual({ width: 1024, height: 768 });
    expect(parseImageDimensions(makeWebpVp8l(300, 200), "webp")).toEqual({ width: 300, height: 200 });
    expect(parseImageDimensions(makeWebpVp8(320, 240), "webp")).toEqual({ width: 320, height: 240 });
    expect(parseImageDimensions(makeWebpVp8(320, 240, { keyFrame: false }), "webp")).toBeNull();
    const badStart = makeWebpVp8(320, 240);
    badStart[23] = 0x00;
    expect(parseImageDimensions(badStart, "webp")).toBeNull();
  });
});

describe("validateEvidenceShape — bounds checked before any decode", () => {
  it("accepts the documented example shape and treats null fields as absent", () => {
    expect(shapeError({ bundleHash: "sha256:" + "a".repeat(64), events: [ev()], deviceHealth: { status: "idle", model: "M" } })).toBeNull();
    expect(shapeError({ bundleHash: null, events: null, deviceHealth: null, photoBase64: null, ipfsCid: null })).toBeNull();
  });

  it("rejects a non-object evidence value", () => {
    expect(shapeError("nope")).toEqual({ status: 400, error: "invalid_evidence" });
    expect(shapeError([ev()])).toEqual({ status: 400, error: "invalid_evidence" });
  });

  it("bounds bundleHash and ipfsCid at 256 characters and requires strings", () => {
    expect(shapeError({ bundleHash: "sha256:" + "a".repeat(249) })).toBeNull(); // 256
    expect(shapeError({ bundleHash: "sha256:" + "a".repeat(250) })).toEqual({ status: 400, error: "invalid_bundle_hash" });
    expect(shapeError({ bundleHash: 123 })).toEqual({ status: 400, error: "invalid_bundle_hash" });
    expect(shapeError({ ipfsCid: "b".repeat(256) })).toBeNull();
    expect(shapeError({ ipfsCid: "b".repeat(257) })).toEqual({ status: 400, error: "invalid_ipfs_cid" });
    expect(shapeError({ ipfsCid: {} })).toEqual({ status: 400, error: "invalid_ipfs_cid" });
  });

  it("bounds the event count, serialized size, nesting and per-event shape", () => {
    expect(shapeError({ events: {} })).toEqual({ status: 400, error: "invalid_events" });
    expect(shapeError({ events: Array.from({ length: EVENTS_MAX_COUNT }, () => ev()) })).toBeNull();
    expect(shapeError({ events: Array.from({ length: EVENTS_MAX_COUNT + 1 }, () => ev()) })).toEqual({ status: 413, error: "too_many_events" });
    expect(shapeError({ events: [ev({ payload: { blob: "x".repeat(EVENTS_MAX_SERIALIZED_BYTES) } })] })).toEqual({ status: 413, error: "events_too_large" });
    let deep: unknown = {};
    for (let i = 0; i < EVIDENCE_MAX_DEPTH + 1; i++) deep = { d: deep };
    expect(shapeError({ events: [ev({ payload: deep })] })).toEqual({ status: 400, error: "invalid_events" });
    expect(shapeError({ events: ["execution_completed"] })).toEqual({ status: 400, error: "invalid_event" });
    expect(shapeError({ events: [ev({ type: "t".repeat(64) })] })).toBeNull();
    expect(shapeError({ events: [ev({ type: "t".repeat(65) })] })).toEqual({ status: 400, error: "invalid_event" });
    expect(shapeError({ events: [ev({ type: 7 })] })).toEqual({ status: 400, error: "invalid_event" });
    expect(shapeError({ events: [ev({ timestamp: 1700000000000 })] })).toEqual({ status: 400, error: "invalid_event_timestamp" });
    expect(shapeError({ events: [ev({ payload: [1, 2] })] })).toEqual({ status: 400, error: "invalid_event" });
    expect(shapeError({ events: [ev({ source: "sim" })] })).toEqual({ status: 400, error: "invalid_event" });
  });

  it("rejects fabrication flags that are present but not booleans (ambiguous)", () => {
    expect(shapeError({ events: [ev({ payload: { mock: "true" } })] })).toEqual({ status: 422, error: "ambiguous_fabrication_flag" });
    expect(shapeError({ events: [ev({ source: { simulated: 1 } })] })).toEqual({ status: 422, error: "ambiguous_fabrication_flag" });
    expect(shapeError({ events: [ev({ payload: { mock: false }, source: { simulated: false } })] })).toBeNull();
  });

  it("bounds deviceHealth at 16 KiB and status/model at 128 characters", () => {
    expect(shapeError({ deviceHealth: "idle" })).toEqual({ status: 400, error: "invalid_device_health" });
    expect(shapeError({ deviceHealth: { status: "idle", model: "m", notes: "n".repeat(17 * 1024) } })).toEqual({ status: 413, error: "device_health_too_large" });
    expect(shapeError({ deviceHealth: { status: "s".repeat(128), model: "m".repeat(128) } })).toBeNull();
    expect(shapeError({ deviceHealth: { status: "s".repeat(129), model: "m" } })).toEqual({ status: 400, error: "invalid_device_health" });
    expect(shapeError({ deviceHealth: { status: "idle", model: 9000 } })).toEqual({ status: 400, error: "invalid_device_health" });
  });

  it("bounds the encoded photo before decoding and requires strict base64", () => {
    expect(shapeError({ photoBase64: 42 })).toEqual({ status: 400, error: "invalid_photo_encoding" });
    expect(shapeError({ photoBase64: "" })).toEqual({ status: 400, error: "invalid_photo_encoding" });
    expect(shapeError({ photoBase64: "A".repeat(PHOTO_MAX_ENCODED_CHARS + 4) })).toEqual({ status: 413, error: "photo_too_large" });
    // A bad character past the size bound still gets the size error: size is checked first.
    expect(shapeError({ photoBase64: "A".repeat(PHOTO_MAX_ENCODED_CHARS) + "!!!!" })).toEqual({ status: 413, error: "photo_too_large" });
    expect(shapeError({ photoBase64: "AAA" })).toEqual({ status: 400, error: "invalid_photo_encoding" });
    expect(shapeError({ photoBase64: "AA-_" })).toEqual({ status: 400, error: "invalid_photo_encoding" });
    expect(shapeError({ photoBase64: "AA==AAAA" })).toEqual({ status: 400, error: "invalid_photo_encoding" });
    expect(shapeError({ photoBase64: "data:image/gif;base64,AAAA" })).toEqual({ status: 400, error: "invalid_photo_encoding" });
    // Decoded-size bound: 6,990,508 chars (one pad) decode to exactly 5 MiB; 4 more chars exceed it.
    expect(shapeError({ photoBase64: "A".repeat(6_990_507) + "=" })).toBeNull();
    expect(shapeError({ photoBase64: "A".repeat(6_990_512) })).toEqual({ status: 413, error: "photo_decoded_too_large" });
    expect((6_990_508 / 4) * 3 - 1).toBe(PHOTO_MAX_DECODED_BYTES);
  });

  it("strips a data:image prefix and remembers the declared type", () => {
    const r = validateEvidenceShape({ photoBase64: "data:image/png;base64," + b64(makePng(16, 16)) });
    expect(r.ok && r.value.photo?.declaredFormat).toBe("png");
  });
});

describe("inspectPhoto — magic bytes and header dimensions", () => {
  const code = (buf: Buffer, prefix = "") => {
    const r = inspectPhoto(validatedPhoto(buf, prefix));
    return r.ok ? "ok" : r.rejection.error;
  };

  it("accepts in-range PNG, JPEG and WebP images and digests the decoded bytes", () => {
    const png = makePng(32, 24);
    const r = inspectPhoto(validatedPhoto(png));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toMatchObject({ format: "png", width: 32, height: 24 });
      expect(r.value.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(r.value.bytes.equals(png)).toBe(true);
    }
    expect(code(makeJpeg(1920, 1080))).toBe("ok");
    expect(code(makeWebpVp8l(16, 16))).toBe("ok");
    expect(code(makePng(16, 16), "data:image/png;base64,")).toBe("ok");
  });

  it("rejects non-image bytes, a declared/actual type mismatch and unparseable headers", () => {
    expect(code(Buffer.alloc(2048, 0x41))).toBe("unsupported_photo_format");
    expect(code(makeJpeg(64, 64), "data:image/png;base64,")).toBe("photo_type_mismatch");
    expect(code(makePng(64, 64, { corruptIhdrCrc: true }))).toBe("unparseable_photo");
  });

  it("rejects out-of-range sides and a pixel count over the decompression-bomb bound", () => {
    expect(code(makePng(60000, 60000))).toBe("photo_dimensions_out_of_range");
    expect(code(makePng(12001, 100))).toBe("photo_dimensions_out_of_range");
    expect(code(makePng(15, 16))).toBe("photo_dimensions_out_of_range");
    expect(code(makeWebpVp8x(16000, 16000))).toBe("photo_dimensions_out_of_range");
    expect(code(makePng(7072, 7072))).toBe("photo_too_many_pixels"); // 50,013,184 px, both sides <= 12,000
    expect(code(makePng(7071, 7071))).toBe("ok"); // 49,999,041 px
  });
});

describe("fabrication screen — /prove events adapted to isFabricated", () => {
  it("passes source and payload through so the canonical predicate sees both flags", () => {
    const mock = { type: "execution_completed", timestamp: NOW, payload: { mock: true } };
    const simulated = { type: "camera_snapshot", timestamp: NOW, payload: {}, source: { simulated: true } };
    const real = { type: "execution_completed", timestamp: NOW, payload: { mock: false }, source: { simulated: false } };
    const bare = { type: "execution_completed", timestamp: NOW };
    expect(isFabricated(toFabricationScreenInput(mock))).toBe(true);
    expect(isFabricated(toFabricationScreenInput(simulated))).toBe(true);
    expect(isFabricated(toFabricationScreenInput(real))).toBe(false);
    expect(isFabricated(toFabricationScreenInput(bare))).toBe(false);
    expect(toFabricationScreenInput(simulated).source).toBe(simulated.source);
    expect(toFabricationScreenInput(mock).payload).toBe(mock.payload);
  });

  it("reports the index of every fabricated event, not just the first", () => {
    const events = [
      { type: "a", timestamp: NOW, payload: {} },
      { type: "b", timestamp: NOW, payload: { mock: true } },
      { type: "c", timestamp: NOW, payload: {} },
      { type: "d", timestamp: NOW, payload: {}, source: { simulated: true } },
    ];
    expect(fabricatedEventIndices(events)).toEqual([1, 3]);
    expect(fabricatedEventIndices([])).toEqual([]);
  });
});

describe("evidence-tier claim and the canonical evidence record", () => {
  const base = (over: Partial<ValidatedEvidence>): ValidatedEvidence => ({ events: [], ...over });

  it("derives the 0-2 claim from which evidence is present", () => {
    expect(summarizeEvidence(base({ deviceHealth: { status: "idle", model: "M" } }), undefined).evidenceTierClaim).toBe(0);
    expect(summarizeEvidence(base({ bundleHash: "sha256:" + "a".repeat(40), events: [ev()] }), undefined).evidenceTierClaim).toBe(1);
    const photo = inspectPhoto(validatedPhoto(makePng(16, 16)));
    if (!photo.ok) throw new Error("fixture");
    expect(summarizeEvidence(base({ deviceHealth: { status: "idle", model: "M" }, events: [ev()] }), photo.value).evidenceTierClaim).toBe(2);
  });

  it("digests events and records canonically (key order does not matter)", () => {
    const a = [{ type: "t", timestamp: NOW, payload: { x: 1, y: [1, { b: 2, a: 1 }] } }];
    const b = [{ payload: { y: [1, { a: 1, b: 2 }], x: 1 }, timestamp: NOW, type: "t" }];
    expect(eventsDigest(a)).toBe(eventsDigest(b));
    const record = (events: typeof a) =>
      buildEvidenceRecord({
        registrationId: "reg-1",
        submitterOperatorId: "op@example.com",
        submittedAt: NOW,
        evidence: { events, deviceHealth: { status: "idle", model: "M" } },
        photo: undefined,
        photoCid: null,
        evidenceTierClaim: 0,
      });
    expect(evidenceRecordDigest(record(a))).toBe(evidenceRecordDigest(record(b)));
    expect(evidenceRecordDigest(record(a))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record(a).events).toEqual({ sha256: eventsDigest(a), count: 1 });
  });

  it("reserves the server record prefixes", () => {
    expect(isReservedDescription("PROOF SUBMITTED: {}")).toBe(true);
    expect(isReservedDescription("  proof submitted: {}")).toBe(true);
    expect(isReservedDescription("PROVED: {}")).toBe(true);
    expect(isReservedDescription("A 3D printer in my garage")).toBe(false);
    expect(isReservedDescription(undefined)).toBe(false);
  });

  // L1: what a reviewer would read as the reserved prefix is reserved.
  it.each([
    ["a zero-width space first (review probe P3)", "​PROOF SUBMITTED: {}"],
    ["a no-break space inside (review probe P3)", "PROOF SUBMITTED: {}"],
    ["Cyrillic O look-alikes (review probe P3)", "PRООF SUBMITTED: {}"],
    ["a right-to-left override first", "‮PROOF SUBMITTED: {}"],
    ["a combining grapheme joiner inside", "P͏ROOF SUBMITTED: {}"],
    ["a combining accent", "ṔROOF SUBMITTED: {}"],
    ["a blank braille pattern first", "⠀PROOF SUBMITTED: {}"],
    ["a Hangul filler first", "ㅤPROOF SUBMITTED: {}"],
    ["full-width letters and colon", "ＰＲＯＯＦ SUBMITTED： {}"],
    ["no spaces at all", "PROOFSUBMITTED:{}"],
    ["an em space and a space before the colon", "PROOF SUBMITTED : {}"],
    ["digit zeros for O", "PR00F SUBMITTED: {}"],
    ["a lower-case L for I", "PROOF SUBMlTTED: {}"],
    ["Greek and Cyrillic capitals", "ΡRОΟF ЅUBMITTED: {}"],
    ["a Cyrillic ER for P in PROVED", "РROVED: {}"],
    ["Cherokee capitals", "ᏢᎡOOF SUBMIᎢTEᎠ: {}"],
    ["a Devanagari visarga for the colon", "PROOF SUBMITTEDः {}"],
    ["more than the scanned length of invisible characters first", "​".repeat(2000) + "PROOF SUBMITTED: {}"],
  ])("refuses a reserved prefix with %s", (_label, description) => {
    expect(isReservedDescription(description)).toBe(true);
  });

  it.each([
    "Proved reliable over 10,000 hours of printing",
    "Proof submitted to the city in 2024",
    "My PROOF SUBMITTED: note",
    "Робот-манипулятор for pick and place",
    "Προϊόν: a Greek description",
    "x".repeat(5000),
    "",
  ])("does not reserve ordinary text: %s", (description) => {
    expect(isReservedDescription(description)).toBe(false);
  });
});
