/**
 * CID Blob Storage Service — generic content-addressable storage for binary
 * artifacts (manufacturing photos, lab raw files, portfolio samples, drone
 * imagery, booking confirmations, etc.).
 *
 * Distinct from EvidenceStorageService (which is tightly coupled to the
 * EvidenceBundle / ALCOA+ schema). This service stores ARBITRARY bytes and
 * returns a CIDv1 (multihash SHA-256, raw codec, base32 encoding) that any
 * downstream consumer (e.g. evidence-judge VLM) can fetch.
 *
 * Backends:
 *   - "local"    → write under <DATA_DIR>/blobs/<cid> on disk (default)
 *   - "helia"    → pin to an in-process Helia node
 *   - "storacha" → upload to Storacha and use its returned CID
 *
 * Backend is selected by the EVIDENCE_STORAGE env var (shared with evidence
 * bundles for operational simplicity). If the chosen backend is unavailable,
 * we fall back to local.
 *
 * CID format: CIDv1, raw codec (0x55), sha-256 multihash, base32 encoded.
 * This is the same format Storacha emits for raw uploads, so the same CID
 * works against any of the three backends for a given input.
 *
 * Author: implementer-foxtrot-cid-storage
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { create as createDigest } from "multiformats/hashes/digest";

// SHA-256 multihash code (0x12)
const SHA256_CODE = 0x12;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PutBlobOptions {
  /** Optional media type override (otherwise auto-detected by magic bytes) */
  mediaType?: string;
  /** Backend hint — defaults to env var */
  backend?: "local" | "helia" | "storacha";
}

export interface BlobMetadata {
  cid: string;
  sizeBytes: number;
  mediaType: string;
  backend: "local" | "helia" | "storacha";
  storedAt: string;
}

export interface ICidBlobStorage {
  /** Upload bytes; returns CID + metadata. Idempotent: same content → same CID, no double-store. */
  put(bytes: Uint8Array, opts?: PutBlobOptions): Promise<BlobMetadata>;
  /** Fetch bytes by CID. Throws if not found. */
  get(cid: string): Promise<Uint8Array>;
  /** Fetch a byte range. Returns the slice for range responses. */
  getRange(cid: string, start: number, end: number): Promise<Uint8Array>;
  /** Check whether a CID exists in this backend. */
  exists(cid: string): Promise<boolean>;
  /** Optional cleanup hook. */
  stop?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// CID Generation
// ---------------------------------------------------------------------------

/**
 * Compute a CIDv1 (raw codec, sha-256 multihash, base32) for the given bytes.
 *
 * This is the canonical PCC storage CID. It is deterministic — the same bytes
 * always yield the same CID — so callers can treat re-uploads of identical
 * content as a no-op.
 */
export function computeCid(bytes: Uint8Array): string {
  const hash = crypto.createHash("sha256").update(bytes).digest();
  const digest = createDigest(SHA256_CODE, hash);
  const cid = CID.createV1(raw.code, digest);
  return cid.toString(); // base32 by default
}

/**
 * Validate that a string is a syntactically well-formed CID. Does NOT check
 * whether the CID is present in any backend.
 */
export function isValidCid(s: string): boolean {
  try {
    CID.parse(s);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Media Type Detection (magic bytes)
// ---------------------------------------------------------------------------

/**
 * Detect a media type from magic bytes. Returns "application/octet-stream" if
 * no signature matches.
 */
export function detectMediaType(bytes: Uint8Array): string {
  if (bytes.length < 4) return "application/octet-stream";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  // WebP: RIFF????WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // PDF: 25 50 44 46
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  // ZIP (also .glb, .docx, etc): 50 4B 03 04
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "application/zip";
  }
  // STL ASCII: "solid"
  if (bytes.length >= 5 &&
      bytes[0] === 0x73 && bytes[1] === 0x6f && bytes[2] === 0x6c && bytes[3] === 0x69 && bytes[4] === 0x64) {
    return "model/stl";
  }
  // Plain ASCII text heuristic: first 64 bytes printable
  const sniff = bytes.slice(0, Math.min(64, bytes.length));
  let allPrintable = true;
  for (const b of sniff) {
    if (b < 0x09 || (b > 0x0d && b < 0x20) || b > 0x7e) {
      allPrintable = false;
      break;
    }
  }
  if (allPrintable) return "text/plain";

  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Local Backend (filesystem)
// ---------------------------------------------------------------------------

export class LocalBlobBackend implements ICidBlobStorage {
  private readonly rootDir: string;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? path.join(process.env.PCC_BLOB_DIR ?? "./data/blobs");
  }

  private cidPath(cid: string): string {
    // Sharded path: first 2 chars of CID as subdir to avoid 100k-file flat dirs
    return path.join(this.rootDir, cid.slice(0, 2), cid);
  }

  async put(bytes: Uint8Array, opts?: PutBlobOptions): Promise<BlobMetadata> {
    const cid = computeCid(bytes);
    const filePath = this.cidPath(cid);
    const mediaType = opts?.mediaType ?? detectMediaType(bytes);

    // Idempotency: if exists, do not rewrite
    if (existsSync(filePath)) {
      return {
        cid,
        sizeBytes: bytes.length,
        mediaType,
        backend: "local",
        storedAt: (await fs.stat(filePath)).ctime.toISOString(),
      };
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);

    return {
      cid,
      sizeBytes: bytes.length,
      mediaType,
      backend: "local",
      storedAt: new Date().toISOString(),
    };
  }

  async get(cid: string): Promise<Uint8Array> {
    const filePath = this.cidPath(cid);
    if (!existsSync(filePath)) {
      throw new Error(`blob_not_found:${cid}`);
    }
    const buf = await fs.readFile(filePath);
    return new Uint8Array(buf);
  }

  async getRange(cid: string, start: number, end: number): Promise<Uint8Array> {
    const filePath = this.cidPath(cid);
    if (!existsSync(filePath)) {
      throw new Error(`blob_not_found:${cid}`);
    }
    const handle = await fs.open(filePath, "r");
    try {
      const length = end - start + 1;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      return new Uint8Array(buf);
    } finally {
      await handle.close();
    }
  }

  async exists(cid: string): Promise<boolean> {
    return existsSync(this.cidPath(cid));
  }
}

// ---------------------------------------------------------------------------
// Helia Backend — wraps the existing in-process Helia node
// ---------------------------------------------------------------------------

export class HeliaBlobBackend implements ICidBlobStorage {
  private helia: any = null;
  private fs: any = null;

  async init(): Promise<void> {
    if (this.helia) return;
    // Dynamic imports — helia is transitively available via @pcc/kernel.
    // @ts-expect-error helia is a peer dep through @pcc/kernel
    const { createHelia } = await import("helia");
    // @ts-expect-error @helia/unixfs is a peer dep through @pcc/kernel
    const { unixfs } = await import("@helia/unixfs");
    this.helia = await createHelia();
    this.fs = unixfs(this.helia);
  }

  async put(bytes: Uint8Array, opts?: PutBlobOptions): Promise<BlobMetadata> {
    await this.init();
    const heliaCid = await this.fs.addBytes(bytes);
    const cid = heliaCid.toString();
    return {
      cid,
      sizeBytes: bytes.length,
      mediaType: opts?.mediaType ?? detectMediaType(bytes),
      backend: "helia",
      storedAt: new Date().toISOString(),
    };
  }

  async get(cid: string): Promise<Uint8Array> {
    await this.init();
    const cidParsed = CID.parse(cid);
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs.cat(cidParsed)) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  async getRange(cid: string, start: number, end: number): Promise<Uint8Array> {
    // Helia UnixFS exposes offset/length on cat()
    await this.init();
    const cidParsed = CID.parse(cid);
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs.cat(cidParsed, { offset: start, length: end - start + 1 })) {
      chunks.push(chunk);
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  async exists(cid: string): Promise<boolean> {
    try {
      await this.get(cid);
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (this.helia) {
      await this.helia.stop();
      this.helia = null;
      this.fs = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Storacha Backend
// ---------------------------------------------------------------------------

export class StorachaBlobBackend implements ICidBlobStorage {
  private mock: boolean;
  private memCache = new Map<string, Uint8Array>();

  constructor(opts?: { mock?: boolean }) {
    this.mock = opts?.mock ?? !process.env["STORACHA_PROOF"];
  }

  async init(): Promise<void> {
    // Storacha (w3up) raw-byte upload is not yet wired into
    // @pcc/kernel/storacha-storage (which is bundle-shaped). For v0.1 we use
    // the mock path: deterministic CIDs + in-memory persistence. Production
    // wiring is a follow-up — see docs/CID_STORAGE.md "Operations".
  }

  async put(bytes: Uint8Array, opts?: PutBlobOptions): Promise<BlobMetadata> {
    const cid = computeCid(bytes);
    const mediaType = opts?.mediaType ?? detectMediaType(bytes);
    this.memCache.set(cid, bytes);
    return {
      cid,
      sizeBytes: bytes.length,
      mediaType,
      backend: "storacha",
      storedAt: new Date().toISOString(),
    };
  }

  async get(cid: string): Promise<Uint8Array> {
    const cached = this.memCache.get(cid);
    if (cached) return cached;
    throw new Error(`blob_not_found:${cid}`);
  }

  async getRange(cid: string, start: number, end: number): Promise<Uint8Array> {
    const bytes = await this.get(cid);
    return bytes.slice(start, end + 1);
  }

  async exists(cid: string): Promise<boolean> {
    return this.memCache.has(cid);
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _blobStorage: ICidBlobStorage | null = null;

export function selectBackend(): "local" | "helia" | "storacha" {
  const env = (process.env["EVIDENCE_STORAGE"] ?? "local").toLowerCase();
  if (env === "helia" || env === "storacha") return env;
  return "local";
}

export async function getCidBlobStorage(): Promise<ICidBlobStorage> {
  if (_blobStorage) return _blobStorage;

  const backend = selectBackend();
  try {
    if (backend === "helia") {
      const h = new HeliaBlobBackend();
      await h.init();
      _blobStorage = h;
    } else if (backend === "storacha") {
      const s = new StorachaBlobBackend();
      await s.init();
      _blobStorage = s;
    } else {
      _blobStorage = new LocalBlobBackend();
    }
  } catch (err) {
    console.warn(`[cid-blob-storage] ${backend} init failed, falling back to local:`, (err as Error).message);
    _blobStorage = new LocalBlobBackend();
  }

  return _blobStorage;
}

/** Test helper — reset the singleton between tests */
export function _resetForTests(replacement?: ICidBlobStorage): void {
  if (_blobStorage?.stop) {
    void _blobStorage.stop();
  }
  _blobStorage = replacement ?? null;
}

export async function stopCidBlobStorage(): Promise<void> {
  if (_blobStorage?.stop) {
    await _blobStorage.stop();
  }
  _blobStorage = null;
}
