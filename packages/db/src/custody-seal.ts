/**
 * Custodial key sealing (N1, Gate A): seal an operator wallet's private key at
 * rest so a database file, a backup or a `SELECT *` never exposes it.
 *
 * Blob format (every part base64url, no padding, joined by ":"):
 *
 *     pcc-seal:v1:<kekId>:<iv>:<tag>:<ciphertext>
 *
 *   - AES-256-GCM, a fresh random 96-bit IV per seal, a 128-bit tag.
 *   - The plaintext is the key's hex string exactly as given (UTF-8), so an
 *     unseal returns the identical string.
 *   - AAD = "api_keys:<rowId>:<lowercased address>". The blob is therefore bound
 *     to ONE api_keys row and ONE wallet address: copied onto another row, or
 *     paired with another address, it does not authenticate and is refused.
 *   - <kekId> names the KEK that sealed it (rotation room). Unsealing under a
 *     different configured id is refused before any decryption is attempted.
 *
 * The KEK comes from the environment, re-read on every call (no import-time
 * freeze, so a deploy can change it without a rebuild):
 *
 *   PCC_CUSTODY_KEK     standard base64 of exactly 32 bytes (44 chars ending in =)
 *   PCC_CUSTODY_KEK_ID  1-32 chars of A-Z a-z 0-9 _ -  (e.g. "k1")
 *
 * Validation is strict: an unset, blank, malformed or wrong-length value counts
 * as ABSENT, and with no valid KEK nothing is sealed (fail closed, every
 * environment). The KEK is never logged and never echoed: errors and problem
 * lists carry static text only, and a CustodyKek object holds its bytes in a
 * module-private WeakMap, so JSON.stringify / util.inspect / String() of one
 * show only its id.
 *
 * Only node:crypto is used. The AEAD makes these refusals indistinguishable
 * from one another by construction (wrong KEK under the same id, a different
 * row, a different address, an altered iv, tag or ciphertext all fail the same
 * authentication), so they share one typed error, CustodyUnsealError. A wrong
 * kek id, a malformed blob and an unconfigured KEK each have their own.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Env var holding the key-encryption key: standard base64 of exactly 32 bytes. */
export const CUSTODY_KEK_ENV = "PCC_CUSTODY_KEK";
/** Env var holding the short id of that KEK; written into every blob it seals. */
export const CUSTODY_KEK_ID_ENV = "PCC_CUSTODY_KEK_ID";

const SEAL_PREFIX = "pcc-seal";
const SEAL_VERSION = "v1";
const KEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A sealed 32-byte key is ~180 chars; anything near this cap is not one. */
const MAX_BLOB_CHARS = 1024;
const MAX_CIPHERTEXT_BYTES = 256;

const KEK_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KEK_B64_RE = /^[A-Za-z0-9+/]{43}=$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const PRIVATE_KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ── Typed errors ───────────────────────────────────────────────────────

export type CustodySealErrorCode =
  | "KEK_UNAVAILABLE"
  | "KEK_ID_MISMATCH"
  | "BLOB_MALFORMED"
  | "UNSEAL_FAILED"
  | "INVALID_INPUT";

/** Base class of every refusal this module raises. Messages are static text. */
export class CustodySealError extends Error {
  readonly code: CustodySealErrorCode;
  constructor(code: CustodySealErrorCode, message: string) {
    super(message);
    this.name = "CustodySealError";
    this.code = code;
  }
}

/** No valid KEK is configured. Fail closed: nothing is sealed, nothing is stored. */
export class CustodyKekUnavailableError extends CustodySealError {
  /** What is wrong with the configuration: static text, never a value. */
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super("KEK_UNAVAILABLE", `custody KEK is not configured: ${problems.join("; ")}`);
    this.name = "CustodyKekUnavailableError";
    this.problems = problems;
  }
}

/** The blob names a different KEK id than the configured one. */
export class CustodyKekIdMismatchError extends CustodySealError {
  readonly blobKekId: string;
  readonly configuredKekId: string;
  constructor(blobKekId: string, configuredKekId: string) {
    // Both ids passed KEK_ID_RE already, so echoing them is safe (and useful).
    super(
      "KEK_ID_MISMATCH",
      `blob was sealed under kek id "${blobKekId}" but the configured kek id is "${configuredKekId}"`,
    );
    this.name = "CustodyKekIdMismatchError";
    this.blobKekId = blobKekId;
    this.configuredKekId = configuredKekId;
  }
}

/** The value is not a well-formed pcc-seal:v1 blob. `reason` is a static label. */
export class CustodyBlobMalformedError extends CustodySealError {
  readonly reason: string;
  constructor(reason: string) {
    super("BLOB_MALFORMED", `malformed custody seal blob: ${reason}`);
    this.name = "CustodyBlobMalformedError";
    this.reason = reason;
  }
}

/**
 * GCM authentication failed: the wrong KEK (same id), a different row or
 * address (AAD), or an altered iv, tag or ciphertext. These cannot be told
 * apart, and are not meant to be.
 */
export class CustodyUnsealError extends CustodySealError {
  constructor() {
    super(
      "UNSEAL_FAILED",
      "unseal failed: authentication failed (wrong KEK, a different row or address, or an altered blob)",
    );
    this.name = "CustodyUnsealError";
  }
}

/** The key, row id or address handed to seal/unseal is not usable. */
export class CustodyInputError extends CustodySealError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
    this.name = "CustodyInputError";
  }
}

// ── The KEK ────────────────────────────────────────────────────────────

/** Key bytes live here, not on the instance, so no serializer can reach them. */
const kekBytes = new WeakMap<CustodyKek, Buffer>();

/** A validated key-encryption key: a short id plus 32 secret bytes. */
export class CustodyKek {
  readonly id: string;

  constructor(id: string, key: Uint8Array) {
    if (typeof id !== "string" || !KEK_ID_RE.test(id)) {
      throw new CustodyInputError("kek id must be 1-32 characters of A-Z a-z 0-9 _ -");
    }
    if (!(key instanceof Uint8Array) || key.length !== KEK_BYTES) {
      throw new CustodyInputError(`kek must be exactly ${KEK_BYTES} bytes`);
    }
    this.id = id;
    kekBytes.set(this, Buffer.from(key));
  }

  toString(): string {
    return `CustodyKek(${this.id})`;
  }
}

function keyOf(kek: CustodyKek): Buffer {
  const key = kekBytes.get(kek);
  if (!key) throw new CustodyInputError("not a CustodyKek");
  return key;
}

export type CustodyKekResolution =
  | { readonly ok: true; readonly kek: CustodyKek }
  | { readonly ok: false; readonly problems: readonly string[] };

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Strict decode: standard base64, exactly 32 bytes, canonical (no stray bits). */
function decodeKek(raw: string): Buffer | null {
  if (!KEK_B64_RE.test(raw)) return null;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEK_BYTES) return null;
  if (buf.toString("base64") !== raw) return null;
  return buf;
}

/**
 * Read and validate the KEK from the environment. Never throws and never
 * returns a value in `problems`: those strings are static and safe to log.
 */
export function resolveCustodyKek(env: EnvLike = process.env): CustodyKekResolution {
  const problems: string[] = [];
  const rawKek = typeof env[CUSTODY_KEK_ENV] === "string" ? env[CUSTODY_KEK_ENV]!.trim() : "";
  const rawId = typeof env[CUSTODY_KEK_ID_ENV] === "string" ? env[CUSTODY_KEK_ID_ENV]!.trim() : "";

  let key: Buffer | null = null;
  if (rawKek === "") {
    problems.push(`${CUSTODY_KEK_ENV} is unset or blank`);
  } else {
    key = decodeKek(rawKek);
    if (!key) {
      problems.push(
        `${CUSTODY_KEK_ENV} is not standard base64 of exactly 32 bytes (44 characters ending in =)`,
      );
    }
  }
  if (rawId === "") {
    problems.push(`${CUSTODY_KEK_ID_ENV} is unset or blank`);
  } else if (!KEK_ID_RE.test(rawId)) {
    problems.push(`${CUSTODY_KEK_ID_ENV} must be 1-32 characters of A-Z a-z 0-9 _ -`);
  }

  if (problems.length > 0 || !key) return { ok: false, problems };
  return { ok: true, kek: new CustodyKek(rawId, key) };
}

/** The configured KEK, or CustodyKekUnavailableError (fail closed). */
export function requireCustodyKek(env: EnvLike = process.env): CustodyKek {
  const resolved = resolveCustodyKek(env);
  if (!resolved.ok) throw new CustodyKekUnavailableError(resolved.problems);
  return resolved.kek;
}

// ── Seal / unseal ──────────────────────────────────────────────────────

/** Where a blob lives: it only authenticates for exactly this row and address. */
export interface SealContext {
  /** api_keys.id of the row the blob is stored on. */
  rowId: string;
  /** The wallet's EVM address (any casing; it is lowercased into the AAD). */
  address: string;
}

function aadFor(ctx: SealContext): Buffer {
  if (!ctx || typeof ctx.rowId !== "string" || ctx.rowId.length === 0) {
    throw new CustodyInputError("rowId must be a non-empty string");
  }
  // An address never contains ":", so "api_keys:<rowId>:<address>" parses
  // unambiguously even when a row id does.
  if (typeof ctx.address !== "string" || !ADDRESS_RE.test(ctx.address)) {
    throw new CustodyInputError("address must be an EVM address (0x plus 40 hex characters)");
  }
  return Buffer.from(`api_keys:${ctx.rowId}:${ctx.address.toLowerCase()}`, "utf8");
}

/**
 * Seal a custodial private key (hex, optional 0x prefix). The default KEK is
 * the configured one: with none, this throws CustodyKekUnavailableError and
 * produces nothing.
 */
export function sealCustodialKey(
  privateKeyHex: string,
  ctx: SealContext,
  kek: CustodyKek = requireCustodyKek(),
): string {
  if (typeof privateKeyHex !== "string" || !PRIVATE_KEY_RE.test(privateKeyHex)) {
    throw new CustodyInputError("private key must be 32 bytes of hex (0x prefix optional)");
  }
  const aad = aadFor(ctx);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyOf(kek), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(privateKeyHex, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SEAL_PREFIX,
    SEAL_VERSION,
    kek.id,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

interface ParsedBlob {
  kekId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

/** Strict base64url: the alphabet only, and canonical (re-encodes to the same text). */
function decodeB64url(part: string): Buffer | null {
  if (part.length === 0 || !B64URL_RE.test(part)) return null;
  const buf = Buffer.from(part, "base64url");
  return buf.toString("base64url") === part ? buf : null;
}

function parseBlob(blob: unknown): ParsedBlob {
  if (typeof blob !== "string") throw new CustodyBlobMalformedError("not a string");
  if (blob.length === 0) throw new CustodyBlobMalformedError("empty");
  if (blob.length > MAX_BLOB_CHARS) throw new CustodyBlobMalformedError("too long");
  const parts = blob.split(":");
  if (parts.length !== 6) throw new CustodyBlobMalformedError("expected 6 parts");
  const [prefix, version, kekId, ivText, tagText, ciphertextText] = parts;
  if (prefix !== SEAL_PREFIX) throw new CustodyBlobMalformedError("not a pcc-seal blob");
  if (version !== SEAL_VERSION) throw new CustodyBlobMalformedError("unsupported version");
  if (!KEK_ID_RE.test(kekId)) throw new CustodyBlobMalformedError("bad kek id");
  const iv = decodeB64url(ivText);
  if (!iv || iv.length !== IV_BYTES) throw new CustodyBlobMalformedError("bad iv");
  const tag = decodeB64url(tagText);
  if (!tag || tag.length !== TAG_BYTES) throw new CustodyBlobMalformedError("bad tag");
  // decodeB64url already refuses the empty string, so no empty Buffer can come back here.
  const ciphertext = decodeB64url(ciphertextText);
  if (!ciphertext || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new CustodyBlobMalformedError("bad ciphertext");
  }
  return { kekId, iv, tag, ciphertext };
}

/**
 * Unseal a blob for the row and address it was sealed for. Refuses, each with
 * its typed error: a malformed blob (CustodyBlobMalformedError), a different
 * kek id (CustodyKekIdMismatchError), and anything GCM cannot authenticate
 * (CustodyUnsealError): the wrong KEK, another row, another address, or an
 * altered iv, tag or ciphertext.
 */
export function unsealCustodialKey(
  blob: string,
  ctx: SealContext,
  kek: CustodyKek = requireCustodyKek(),
): string {
  const parsed = parseBlob(blob);
  if (parsed.kekId !== kek.id) throw new CustodyKekIdMismatchError(parsed.kekId, kek.id);
  const aad = aadFor(ctx);
  const decipher = createDecipheriv("aes-256-gcm", keyOf(kek), parsed.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(parsed.tag);
  try {
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CustodyUnsealError();
  }
}
