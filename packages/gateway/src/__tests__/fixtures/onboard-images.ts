/**
 * Image fixtures for the onboarding /prove tests: minimal PNG, JPEG and WebP
 * byte streams with chosen header dimensions.
 *
 * Only headers matter to the gateway (it never decodes pixels), so large
 * claimed dimensions are built with a tiny placeholder body. The PNG CRC here
 * is a bitwise implementation, independent of the table-driven one under test.
 */

import { deflateSync } from "node:zlib";

/** Bitwise CRC-32 (IEEE), deliberately not table-driven. */
export function referenceCrc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(referenceCrc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

export interface PngOptions {
  bitDepth?: number;
  colorType?: number;
  /** Flip one CRC bit of IHDR. */
  corruptIhdrCrc?: boolean;
}

/**
 * An RGB PNG whose IHDR claims width x height. Real (decodable) pixel rows are
 * written when the image is small; otherwise IDAT is a tiny placeholder.
 */
export function makePng(width: number, height: number, opts: PngOptions = {}): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = opts.bitDepth ?? 8;
  ihdr[9] = opts.colorType ?? 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  let ihdrChunk = pngChunk("IHDR", ihdr);
  if (opts.corruptIhdrCrc) {
    ihdrChunk = Buffer.from(ihdrChunk);
    ihdrChunk[ihdrChunk.length - 1] ^= 0x01;
  }
  let raw: Buffer;
  if (width * height <= 1_000_000) {
    const row = Buffer.alloc(1 + width * 3, 0x7f);
    row[0] = 0; // filter: none
    raw = Buffer.concat(Array.from({ length: height }, () => row));
  } else {
    raw = Buffer.from([0, 0, 0, 0]);
  }
  return Buffer.concat([signature, ihdrChunk, pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A baseline (or other SOFn) JPEG header stream: SOI, APP0 JFIF, optional extra APPn, SOFn, SOS stub, EOI. */
export function makeJpeg(width: number, height: number, opts: { sofMarker?: number; extraApp1Segments?: number; sosBeforeSof?: boolean } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
  for (let i = 0; i < (opts.extraApp1Segments ?? 0); i++) {
    parts.push(Buffer.from([0xff, 0xe1, 0x00, 0x04, 0x00, 0x00]));
  }
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  if (opts.sosBeforeSof) parts.push(sos);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = opts.sofMarker ?? 0xc0;
  sof.writeUInt16BE(17, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  sof.set([0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 10);
  parts.push(sof);
  if (!opts.sosBeforeSof) parts.push(sos);
  parts.push(Buffer.from([0x00, 0x00, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

function riff(chunkType: string, chunkData: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + 8 + chunkData.length, 4);
  header.write("WEBP", 8, "latin1");
  header.write(chunkType, 12, "latin1");
  header.writeUInt32LE(chunkData.length, 16);
  return Buffer.concat([header, chunkData]);
}

/** Extended-format WebP (VP8X) with a canvas of width x height. */
export function makeWebpVp8x(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", data);
}

/** Lossless WebP (VP8L) header for width x height (each 1..16384). */
export function makeWebpVp8l(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  data.writeUInt32LE(bits >>> 0, 1);
  return riff("VP8L", data);
}

/** Lossy WebP (VP8) key-frame header for width x height (each 1..16383). */
export function makeWebpVp8(width: number, height: number, opts: { keyFrame?: boolean } = {}): Buffer {
  const data = Buffer.alloc(16);
  data[0] = opts.keyFrame === false ? 0x01 : 0x00; // frame tag bit 0: 0 = key frame
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(width & 0x3fff, 6);
  data.writeUInt16LE(height & 0x3fff, 8);
  return riff("VP8 ", data);
}

export const b64 = (buf: Buffer): string => buf.toString("base64");
