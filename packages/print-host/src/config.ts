import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { loadDeviceKey, loadOperatorKey } from "./keys.js";
import { readSecretFile } from "./secret-file.js";

export type HostConfigErrorCode =
  | "not_absolute" | "not_found" | "not_regular_file" | "symlink"
  | "bad_mode" | "bad_owner" | "too_large" | "changed_during_open"
  | "read_failed" | "bad_json" | "bad_schema" | "testnet_only"
  | "bad_rpc_url" | "bad_api_key" | "bad_data_dir";

/** Deliberately excludes input values and underlying exception messages. */
export class HostConfigError extends Error {
  readonly code: HostConfigErrorCode;
  readonly path: string;
  readonly field?: string;

  constructor(code: HostConfigErrorCode, path: string, field?: string) {
    super(`${code}: ${path}${code === "bad_schema" && field ? ` (${field})` : ""}${code === "testnet_only" ? "; the print host is testnet-only" : ""}`);
    this.name = "HostConfigError";
    this.code = code;
    this.path = path;
    this.field = field;
  }
}

function parseUrl(value: string): URL | undefined {
  // WHATWG URL otherwise silently trims leading/trailing whitespace.
  if (/\s/.test(value)) return undefined;
  try { return new URL(value); } catch { return undefined; }
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname.toLowerCase());
}

function hasUserInfo(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(value);
}

function hasCanonicalHttpAuthority(value: string): boolean {
  // Special WHATWG schemes otherwise normalize missing/extra slashes and
  // backslashes, potentially hiding credentials from a raw-authority check.
  return /^https?:\/\/[^/\\?#]/i.test(value) && !value.includes("\\");
}

/** Shared gateway URL policy for configuration and the operator relay client. */
export function isGatewayBaseUrl(value: string): boolean {
  const url = parseUrl(value);
  return !!url?.hostname && hasCanonicalHttpAuthority(value) && !url.username && !url.password
    && !hasUserInfo(value) && !value.includes("?") && !value.includes("#")
    && (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url)));
}

const absolutePath = z.string().refine(isAbsolute, "must be an absolute path");
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
// JSON-safe quantities in wei (fees) or gas units. Omission keeps legacy
// read-only configurations valid, but the broadcaster treats omitted caps as zero.
const cap = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => value.length <= 78 && /^(0|[1-9][0-9]*)$/.test(value)
    && BigInt(value) <= (1n << 256n) - 1n, "must fit uint256");
const chainConfigSchema = z.object({
  chainId: z.union([z.literal(84532), z.literal(31337)]),
  rpcUrlFile: absolutePath,
  maxFeePerGasCap: cap.optional(),
  maxPriorityFeePerGasCap: cap.optional(),
  gasCap: cap.optional(),
  confirmations: z.number().int().min(1).max(64).optional(),
  rpcTimeoutMs: z.number().int().min(1).max(60_000).optional(),
  receiptTimeoutMs: z.number().int().min(1).max(3_600_000).optional(),
  pollingIntervalMs: z.number().int().min(1).max(60_000).optional(),
}).strict().refine((value) => value.maxFeePerGasCap === undefined || value.maxPriorityFeePerGasCap === undefined
  || !/^(0|[1-9][0-9]*)$/.test(value.maxFeePerGasCap) || !/^(0|[1-9][0-9]*)$/.test(value.maxPriorityFeePerGasCap)
  || BigInt(value.maxPriorityFeePerGasCap) <= BigInt(value.maxFeePerGasCap), "priority fee cap must not exceed total fee cap");
const hostConfigSchema = z.object({
  kernelId: id,
  deviceId: id,
  printer: z.object({
    uri: z.string().refine((value) => {
      const url = parseUrl(value);
      return !!url?.hostname && !url.username && !url.password && !hasUserInfo(value)
        && (url.protocol === "ipp:" || url.protocol === "ipps:");
    }, "must be an IPP URL with a host"),
  }).strict(),
  chain: chainConfigSchema,
  gateway: z.object({
    baseUrl: z.string().refine(isGatewayBaseUrl, "must be HTTPS or loopback HTTP without credentials, query, or fragment"),
    apiKeyFile: absolutePath,
  }).strict(),
  keys: z.object({
    deviceKeyFile: absolutePath,
    operatorKeyFile: absolutePath,
  }).strict(),
  dataDir: absolutePath,
}).strict();

export type HostConfig = Readonly<{
  kernelId: string;
  deviceId: string;
  printer: Readonly<{ uri: string }>;
  chain: Readonly<{
    chainId: 84532 | 31337;
    rpcUrlFile: string;
    maxFeePerGasCap?: string;
    maxPriorityFeePerGasCap?: string;
    gasCap?: string;
    confirmations?: number;
    rpcTimeoutMs?: number;
    receiptTimeoutMs?: number;
    pollingIntervalMs?: number;
  }>;
  gateway: Readonly<{ baseUrl: string; apiKeyFile: string }>;
  keys: Readonly<{ deviceKeyFile: string; operatorKeyFile: string }>;
  dataDir: string;
}>;

export interface HostConfigOptions {
  expectedUid?: number;
  now?: Date;
}

export interface HostPublicIdentity {
  kernelId: string;
  deviceId: string;
  chainId: 84532 | 31337;
  devicePublicKey: string;
  operatorAddress: string;
  printerUri: string;
  gatewayBaseUrl: string;
}

const knownFields = new Set([
  "kernelId", "deviceId", "printer", "uri", "chain", "chainId", "rpcUrlFile",
  "maxFeePerGasCap", "maxPriorityFeePerGasCap", "gasCap", "confirmations",
  "rpcTimeoutMs", "receiptTimeoutMs", "pollingIntervalMs",
  "gateway", "baseUrl", "apiKeyFile", "keys", "deviceKeyFile", "operatorKeyFile", "dataDir",
]);

/** Snapshot and validate manually constructed chain config as well as file config. */
export function validateHostChainConfig(input: unknown): HostConfig["chain"] {
  try {
    const parsed = chainConfigSchema.safeParse(input);
    if (!parsed.success) throw new HostConfigError("bad_schema", "config", "chain");
    return Object.freeze(parsed.data);
  } catch { throw new HostConfigError("bad_schema", "config", "chain"); }
}

function validateConfig(value: unknown, path: string): HostConfig {
  if (typeof value === "object" && value !== null && "chain" in value) {
    const chain = (value as Record<string, unknown>).chain;
    if (typeof chain === "object" && chain !== null && "chainId" in chain) {
      const chainId = (chain as Record<string, unknown>).chainId;
      if (typeof chainId === "number" && chainId !== 84532 && chainId !== 31337) {
        throw new HostConfigError("testnet_only", path);
      }
    }
  }
  const parsed = hostConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Never retain the ZodError, its issues, or an untrusted field name.
    const field = issue.path.filter((part): part is string => typeof part === "string" && knownFields.has(part)).join(".");
    throw new HostConfigError("bad_schema", path, field || "config");
  }
  for (const child of [parsed.data.printer, parsed.data.chain, parsed.data.gateway, parsed.data.keys]) Object.freeze(child);
  return Object.freeze(parsed.data);
}

function uid(options: HostConfigOptions): number {
  const expected = options.expectedUid ?? process.getuid?.();
  if (expected === undefined || !Number.isSafeInteger(expected) || expected < 0) {
    throw new HostConfigError("bad_owner", "config");
  }
  return expected;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** The config names credentials and endpoints; only its owner may change it. */
export async function loadHostConfig(path: string, options: HostConfigOptions = {}): Promise<HostConfig> {
  if (!isAbsolute(path)) throw new HostConfigError("not_absolute", path);
  const expectedUid = uid(options);
  let before;
  try { before = await lstat(path); } catch (error) {
    throw new HostConfigError(isNotFound(error) ? "not_found" : "read_failed", path);
  }
  if (before.isSymbolicLink()) throw new HostConfigError("symlink", path);
  if (!before.isFile()) throw new HostConfigError("not_regular_file", path);
  if (before.uid !== expectedUid) throw new HostConfigError("bad_owner", path);
  if ((before.mode & 0o022) !== 0) throw new HostConfigError("bad_mode", path);
  const maxBytes = 64 * 1024;
  if (before.size > maxBytes) throw new HostConfigError("too_large", path);
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NOCTTY | constants.O_NONBLOCK); }
  catch { throw new HostConfigError("read_failed", path); }
  const bytes = Buffer.alloc(maxBytes + 1);
  try {
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new HostConfigError("changed_during_open", path);
    if (!opened.isFile()) throw new HostConfigError("not_regular_file", path);
    if (opened.uid !== expectedUid) throw new HostConfigError("bad_owner", path);
    if ((opened.mode & 0o022) !== 0) throw new HostConfigError("bad_mode", path);
    if (opened.size > maxBytes) throw new HostConfigError("too_large", path);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new HostConfigError("too_large", path);
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw new HostConfigError("bad_json", path); }
    return validateConfig(value, path);
  } catch (error) {
    if (error instanceof HostConfigError) throw error;
    throw new HostConfigError("read_failed", path);
  } finally {
    bytes.fill(0);
    await file.close().catch(() => undefined);
  }
}

/** Accept one line with an optional conventional LF or CRLF terminator. */
function singleLine(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  const line = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text;
  return line && !/[\r\n]/.test(line) ? line : undefined;
}

/**
 * Validate credential files, returning public identifiers only.
 * @throws {HostConfigError} If the configuration or its credential values are invalid.
 * @throws {KeyFileError} If a device or operator key cannot be loaded.
 * @throws {SecretFileError} If a credential file cannot be read securely.
 */
export async function checkHostConfig(config: HostConfig, options: HostConfigOptions = {}): Promise<HostPublicIdentity> {
  const checked = validateConfig(config, "config");
  const expectedUid = uid(options);
  const keyOptions = { expectedUid, now: options.now };
  const device = await loadDeviceKey(checked.keys.deviceKeyFile, keyOptions);
  const operator = await loadOperatorKey(checked.keys.operatorKeyFile, checked.chain.chainId, keyOptions);
  const rpcBytes = await readSecretFile(checked.chain.rpcUrlFile, { expectedUid });
  try {
    const line = singleLine(rpcBytes);
    const url = line === undefined ? undefined : parseUrl(line);
    if (!url?.hostname || !(url.protocol === "https:" || (checked.chain.chainId === 31337 && url.protocol === "http:" && isLoopback(url)))) {
      throw new HostConfigError("bad_rpc_url", checked.chain.rpcUrlFile);
    }
  } finally { rpcBytes.fill(0); }
  const apiBytes = await readSecretFile(checked.gateway.apiKeyFile, { expectedUid });
  try {
    const token = singleLine(apiBytes);
    if (token === undefined || /\s/.test(token)) throw new HostConfigError("bad_api_key", checked.gateway.apiKeyFile);
  } finally { apiBytes.fill(0); }
  let data;
  try { data = await lstat(checked.dataDir); }
  catch { throw new HostConfigError("bad_data_dir", checked.dataDir); }
  if (!data.isDirectory() || data.isSymbolicLink() || data.uid !== expectedUid || (data.mode & 0o077) !== 0) {
    throw new HostConfigError("bad_data_dir", checked.dataDir);
  }
  return Object.freeze({
    kernelId: checked.kernelId,
    deviceId: checked.deviceId,
    chainId: checked.chain.chainId,
    devicePublicKey: device.signingPublicKey,
    operatorAddress: operator.address,
    printerUri: checked.printer.uri,
    gatewayBaseUrl: checked.gateway.baseUrl,
  });
}
