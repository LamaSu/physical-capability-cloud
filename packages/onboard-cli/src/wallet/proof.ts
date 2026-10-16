import { getAddress } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { WalletError } from "./errors.js";
import type { WalletRecord } from "./keystore.js";

function mismatch(field: string): never {
  throw new WalletError(`refusing to sign: ${field} mismatch`);
}

function validUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** RFC 8785 for this ceremony's flat objects of strings and safe integers. */
export function canonicalizeFlat(value: unknown): string {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) mismatch("canonical JSON");
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) mismatch("canonical JSON");
    if (Object.getOwnPropertySymbols(value).length > 0) mismatch("canonical JSON");
    const properties = Object.getOwnPropertyDescriptors(value);
    const entries = Object.keys(properties).sort().map((key) => {
      const property = properties[key];
      if (!validUnicode(key) || !property || !("value" in property) || !property.enumerable) mismatch("canonical JSON");
      const item: unknown = property.value;
      if (typeof item === "string") {
        if (!validUnicode(item)) mismatch("canonical JSON");
      } else if (typeof item !== "number" || !Number.isSafeInteger(item)) {
        mismatch("canonical JSON");
      }
      // JSON.stringify provides RFC 8785 escaping and turns negative zero into zero.
      return `${JSON.stringify(key)}:${JSON.stringify(item)}`;
    });
    return `{${entries.join(",")}}`;
  } catch {
    return mismatch("canonical JSON");
  }
}

function canonicalTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string") mismatch(field);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) mismatch(field);
  return timestamp;
}

function checkTimes(issuedAt: unknown, expirationTime: unknown, nowMs: number): number {
  const issuedMs = canonicalTimestamp(issuedAt, "issuedAt");
  const expirationMs = canonicalTimestamp(expirationTime, "expirationTime");
  if (!Number.isFinite(issuedMs) || issuedMs < nowMs - 600_000 || issuedMs > nowMs + 300_000) mismatch("issuedAt");
  // W1 requests last ten minutes; retain five minutes of allowed clock skew.
  if (expirationMs <= nowMs || expirationMs <= issuedMs || expirationMs - issuedMs > 900_000) mismatch("expirationTime");
  return expirationMs;
}

function gatewayHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return mismatch("domain");
  }
}

function validateSecpMessage(message: string, wallet: WalletRecord, requestId: string, nowMs: number, publicOrigin: string): number {
  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    return mismatch("message");
  }
  if (parsed.domain !== gatewayHost(publicOrigin)) mismatch("domain");
  if (parsed.uri !== `${publicOrigin}/link`) mismatch("uri");
  if (parsed.chainId !== wallet.chainId || parsed.chainId !== 84532) mismatch("chainId");
  if (parsed.address !== wallet.address) mismatch("address");
  try {
    if (!parsed.address || getAddress(parsed.address) !== parsed.address) mismatch("address");
  } catch {
    return mismatch("address");
  }
  if (parsed.requestId !== requestId) mismatch("requestId");
  if (parsed.version !== "1") mismatch("version");
  const expectedStatement = `Link this key to PCC as an ${wallet.role} ("${wallet.label}"). PCC never holds this key. Consent: wallet-link v1.`;
  if (parsed.statement !== expectedStatement) mismatch("statement");
  const resources = parsed.resources ?? [];
  if (!resources.includes(`urn:pcc:link-request:${requestId}`) || !resources.includes(`urn:pcc:role:${wallet.role}`)) mismatch("resources");
  const consents = resources.filter((resource) => resource.startsWith("urn:pcc:consent:"));
  if (consents.length !== 1 || !/^urn:pcc:consent:wallet-link-v1:sha256:[a-f0-9]{64}$/.test(consents[0] ?? "")) mismatch("consent");
  const environment = resources[1];
  if (typeof environment !== "string" || !/^urn:pcc:env:[a-z0-9-]{1,32}$/.test(environment)) mismatch("env");
  const expectedResources = [
    `urn:pcc:link-request:${requestId}`, environment, `urn:pcc:role:${wallet.role}`, consents[0],
  ];
  if (resources.length !== expectedResources.length || resources.some((resource, index) => resource !== expectedResources[index])) mismatch("resources");
  // Read the timestamp bytes too: parseSiweMessage converts them to Dates and
  // would otherwise hide a non-ISO representation before the template rebuild.
  const expirationMs = checkTimes(/^Issued At: (.*)$/m.exec(message)?.[1], /^Expiration Time: (.*)$/m.exec(message)?.[1], nowMs);
  if (typeof parsed.nonce !== "string" || !/^[A-Za-z0-9]{16,64}$/.test(parsed.nonce)) mismatch("nonce");
  // The SIWE parser ignores lines outside its known fields. Rebuilding W1's
  // exact template prevents signing any extra content hidden from these checks.
  if (parsed.scheme !== undefined || parsed.notBefore !== undefined) mismatch("message");
  try {
    const rebuilt = createSiweMessage({
      domain: parsed.domain!, address: parsed.address!, statement: parsed.statement!,
      uri: parsed.uri!, version: "1", chainId: parsed.chainId!, nonce: parsed.nonce,
      issuedAt: parsed.issuedAt!, expirationTime: parsed.expirationTime!,
      requestId: parsed.requestId!, resources,
    });
    if (rebuilt !== message) mismatch("message");
  } catch {
    mismatch("message");
  }
  return expirationMs;
}

function validateEdMessage(message: string, wallet: WalletRecord, requestId: string, nowMs: number, expectedKernelId: string | undefined, publicOrigin: string): number {
  const prefix = "PCC-LINK-V1\n";
  if (!message.startsWith(prefix)) mismatch("prefix");
  const json = message.slice(prefix.length);
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(json);
    if (canonicalizeFlat(value) !== json) mismatch("canonical JSON");
    parsed = value as Record<string, unknown>;
  } catch {
    return mismatch("canonical JSON");
  }
  const stringFields = [
    "consent", "domain", "env", "expirationTime", "issuedAt", "label", "nonce", "publicKey", "requestId", "role", "uri",
    ...(expectedKernelId === undefined ? [] : ["kernelId"]),
  ];
  const expectedKeys = ["chainId", ...stringFields].sort();
  const keys = Object.keys(parsed).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])
    || !Number.isSafeInteger(parsed.chainId) || stringFields.some((field) => typeof parsed[field] !== "string")) mismatch("fields");
  if (expectedKernelId !== undefined && (wallet.role !== "device" || parsed.kernelId !== expectedKernelId)) mismatch("kernelId");
  if (parsed.domain !== gatewayHost(publicOrigin)) mismatch("domain");
  if (parsed.uri !== `${publicOrigin}/link`) mismatch("uri");
  if (parsed.chainId !== wallet.chainId || parsed.chainId !== 84532) mismatch("chainId");
  if (parsed.publicKey !== wallet.publicKey) mismatch("publicKey");
  if (parsed.requestId !== requestId) mismatch("requestId");
  if (parsed.role !== wallet.role) mismatch("role");
  if (parsed.label !== wallet.label) mismatch("label");
  if (typeof parsed.consent !== "string" || !/^wallet-link-v1:sha256:[a-f0-9]{64}$/.test(parsed.consent)) mismatch("consent");
  if (typeof parsed.env !== "string" || !/^[a-z0-9-]{1,32}$/.test(parsed.env)) mismatch("env");
  if (typeof parsed.nonce !== "string" || !/^[A-Za-z0-9]{16,64}$/.test(parsed.nonce)) mismatch("nonce");
  return checkTimes(parsed.issuedAt, parsed.expirationTime, nowMs);
}

/** Check the gateway's message before either key type signs any bytes. */
export function validateProofMessage(message: string, wallet: WalletRecord, requestId: string, nowMs: number, expectedKernelId?: string, publicOrigin = wallet.gatewayOrigin): number {
  try {
    if (wallet.keyType === "secp256k1") return validateSecpMessage(message, wallet, requestId, nowMs, publicOrigin);
    return validateEdMessage(message, wallet, requestId, nowMs, expectedKernelId, publicOrigin);
  } catch (error) {
    if (error instanceof WalletError) throw error;
    mismatch("message");
  }
}
