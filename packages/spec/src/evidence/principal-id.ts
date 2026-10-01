/**
 * Principal ids for FinalMilestonePackageV2 (`pcc.evidence.principal-id.v1`).
 *
 * The package names who stands behind a milestone with two ids, and each id is
 * bound to a signature the verifier already checks, so a principal id is never
 * a free-text claim:
 *
 *   operatorPrincipalId = "eip155:<chainId>:0x<40 lowercase hex>"   (CAIP-10)
 *       The D1 (secp256k1 EIP-712) signer's address on the unit's chain. Its
 *       address part must equal the D1 signature entry's signer.
 *   devicePrincipalId   = "ed25519:0x<64 lowercase hex>"
 *       The Ed25519 key of the device or node that signs the evidence. Its key
 *       part must equal the D2 signature entry's signer, and the kernel
 *       registry row for the producing kernel must hold that key.
 *
 * Both forms are lowercase-pinned, so the package digest never drifts on hex
 * case. The registry stores Ed25519 keys as 0x + lowercase hex (matching the
 * device form byte for byte) but secp256k1 addresses EIP-55 checksummed, so
 * compare a registry signer only through `principalFromRegistry`, never raw.
 * The same CAIP-10 form is the owner-address form key bindings use (N2): there
 * is one form, not two.
 *
 * Only the ids are pinned. A signer or key handed in as input (the D1 or D2
 * signer, a key to format, a key to look up in the denylist) is read by the
 * registry's own `normalizeRegisteredSigner`, so exactly the spellings the
 * registry accepts (0x, 0X or no prefix, any hex case, exact length) are
 * accepted here, and `principalFromRegistry` and the bindings cannot disagree
 * about a spelling. An id never contains 0X.
 *
 * An Ed25519 key whose secret half was published is never a device principal:
 * anyone can sign as it (N35). `COMPROMISED_DEVICE_PUBLIC_KEYS` lists them.
 *
 * In a funded `authorizedTuples` triple (operator, kernel, device), each
 * bytes32 word is keccak256 of the UTF-8 of the id string (`principalTupleWord`);
 * the kind is not part of the preimage. The strings themselves keep the kinds
 * apart: an operator id starts `eip155:`, a device id starts `ed25519:`, and a
 * kernel id is printable ASCII that may not start with either, in any ASCII case
 * (`isValidKernelId`). Every id is ASCII, so its UTF-8 bytes are unique to it, and
 * no kernel string can equal an operator or device string, so two different
 * principals never share a word. The device principal's key is the kernel's
 * registered Ed25519 key: it signs the LO-EV-1 delegation (`parentSignature`) and D2.
 */

import { keccak_256 } from "@noble/hashes/sha3";

import { normalizeRegisteredSigner } from "./verifiers/registered-signer.js";

export const PRINCIPAL_ID_CONTRACT = "pcc.evidence.principal-id.v1";

export const OPERATOR_PRINCIPAL_ID_PATTERN = /^eip155:([1-9][0-9]*):0x([0-9a-f]{40})$/;
export const DEVICE_PRINCIPAL_ID_PATTERN = /^ed25519:0x([0-9a-f]{64})$/;

/**
 * A kernel id in a funded `authorizedTuples` triple: 1-128 printable ASCII
 * characters, no space. This is the id rule of the accepted deal's parser
 * (`ID_PATTERN` in csd/composition-commitment.ts), so every id a deal names can be
 * hashed. ASCII-only keeps UTF-8 injective: non-ASCII ids, and the lone UTF-16
 * surrogates that `TextEncoder` silently rewrites to U+FFFD, are refused.
 */
export const KERNEL_ID_PATTERN = /^[\x21-\x7E]{1,128}$/;

/**
 * The operator and device principals own these id namespaces, so a kernel id may
 * not start with either, compared ASCII case-insensitively. Reserving them is
 * what keeps a kernel id string from ever equalling an operator or device id
 * string, and so their `principalTupleWord`s apart, without changing the hash
 * preimage (every existing word stays byte for byte the same).
 */
export const RESERVED_KERNEL_ID_PREFIXES: readonly string[] = ["eip155:", "ed25519:"];

/** True when `id` is a kernel id that `principalTupleWord("kernel", id)` hashes. */
export function isValidKernelId(id: unknown): id is string {
  if (typeof id !== "string" || !KERNEL_ID_PATTERN.test(id)) return false;
  const lower = id.toLowerCase(); // printable ASCII by now, so this folds A-Z and nothing else
  return !RESERVED_KERNEL_ID_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Ed25519 public keys (0x + lowercase hex) whose secret halves are public, so
 * no signature by them proves anything:
 *   - the pcc-node key pair committed to the public repository (N35).
 */
export const COMPROMISED_DEVICE_PUBLIC_KEYS: ReadonlySet<string> = new Set([
  "0x4145722275a24983ebda639a0cc0bcda8072eed3a6cf38b56135859a56c51d36",
]);

export class PrincipalIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrincipalIdError";
  }
}

/**
 * The one reader of a secp256k1 address (D1 signer) in this module: the kernel
 * registry's own `normalizeRegisteredSigner`, so it accepts exactly the registry's
 * spellings and nothing else. Returns the pinned lowercase `0x` + 40 hex, or null.
 */
function canonicalAddress(input: unknown): `0x${string}` | null {
  const signer = normalizeRegisteredSigner({ algorithm: "secp256k1", address: input });
  return signer?.algorithm === "secp256k1" ? (signer.address.toLowerCase() as `0x${string}`) : null;
}

/**
 * The one reader of an Ed25519 key (D2 signer, denylist lookup, device principal)
 * in this module: the registry's own `normalizeRegisteredSigner`, so it accepts
 * exactly the registry's spellings. Returns the pinned lowercase `0x` + 64 hex, or null.
 */
function canonicalEd25519Key(input: unknown): `0x${string}` | null {
  const signer = normalizeRegisteredSigner({ algorithm: "ed25519", publicKey: input });
  return signer?.algorithm === "ed25519" ? (signer.publicKey as `0x${string}`) : null;
}

/**
 * True when the key is one whose secret was published. The key is read the way
 * the registry reads an Ed25519 key (0x, 0X or no prefix, any hex case), so no
 * spelling the registry accepts slips past the denylist. Anything that is not
 * such a key is not a published key (false); the parse, format and bind
 * functions are what refuse it.
 */
export function isCompromisedDevicePublicKey(publicKey: unknown): boolean {
  const key = canonicalEd25519Key(publicKey);
  return key !== null && COMPROMISED_DEVICE_PUBLIC_KEYS.has(key);
}

/** `eip155:<chainId>:0x<address, lowercased>`. Throws on a malformed chain or address. */
export function formatOperatorPrincipalId(chainId: number, address: string): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new PrincipalIdError(`chainId must be a positive integer, got ${String(chainId)}`);
  }
  const canonical = canonicalAddress(address);
  if (!canonical) {
    throw new PrincipalIdError("address must be 40 hex characters, 0x optional");
  }
  return `eip155:${chainId}:${canonical}`;
}

/** `ed25519:0x<key, lowercased>`. Throws on a malformed or compromised key. */
export function formatDevicePrincipalId(publicKey: string): string {
  const canonical = canonicalEd25519Key(publicKey);
  if (!canonical) {
    throw new PrincipalIdError("publicKey must be 64 hex characters, 0x optional");
  }
  if (isCompromisedDevicePublicKey(canonical)) {
    throw new PrincipalIdError("this Ed25519 key's secret half is public; it cannot be a device principal");
  }
  return `ed25519:${canonical}`;
}

/** The parts of an operator principal id, or null unless it is exactly the pinned form. */
export function parseOperatorPrincipalId(id: unknown): { chainId: number; address: `0x${string}` } | null {
  if (typeof id !== "string") return null;
  const m = OPERATOR_PRINCIPAL_ID_PATTERN.exec(id);
  if (!m) return null;
  const chainId = Number(m[1]);
  if (!Number.isSafeInteger(chainId)) return null;
  return { chainId, address: `0x${m[2]}` };
}

/** The key of a device principal id, or null unless it is exactly the pinned form. */
export function parseDevicePrincipalId(id: unknown): { publicKey: `0x${string}` } | null {
  if (typeof id !== "string") return null;
  const m = DEVICE_PRINCIPAL_ID_PATTERN.exec(id);
  return m ? { publicKey: `0x${m[1]}` } : null;
}

/**
 * D1 binding: the operator principal id is well formed, on `chainId` when one
 * is given, and its address is the D1 signer's. The signer is read the way the
 * registry reads an address (0x, 0X or no prefix, any hex case).
 */
export function operatorPrincipalMatchesSigner(id: unknown, d1Signer: unknown, chainId?: number): boolean {
  const parsed = parseOperatorPrincipalId(id);
  const signer = canonicalAddress(d1Signer);
  if (!parsed || !signer) return false;
  if (chainId !== undefined && parsed.chainId !== chainId) return false;
  return parsed.address === signer;
}

/**
 * D2 binding: the device principal id is well formed, its key is the D2 signer,
 * and that key is not compromised. The signer is read the way the registry reads
 * an Ed25519 key (0x, 0X or no prefix, any hex case).
 */
export function devicePrincipalMatchesSigner(id: unknown, d2Signer: unknown): boolean {
  const parsed = parseDevicePrincipalId(id);
  const signer = canonicalEd25519Key(d2Signer);
  if (!parsed || !signer) return false;
  if (isCompromisedDevicePublicKey(parsed.publicKey)) return false;
  return parsed.publicKey === signer;
}

/**
 * The principal id a kernel registry signer stands for, or null: an Ed25519
 * key gives its device principal (null when compromised), and a secp256k1
 * address gives its operator principal on `chainId`, with the registry's
 * EIP-55 checksum lowercased. Compare registry signers through this, never raw.
 */
export function principalFromRegistry(signer: unknown, chainId: number): string | null {
  const normalized = normalizeRegisteredSigner(signer);
  if (!normalized) return null;
  try {
    return normalized.algorithm === "ed25519"
      ? formatDevicePrincipalId(normalized.publicKey)
      : formatOperatorPrincipalId(chainId, normalized.address);
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The bytes32 word a principal occupies in a funded `authorizedTuples` triple:
 * keccak256 of the UTF-8 of its id string; the kind is not in the preimage.
 * Operator and device ids must be the pinned forms (a device key whose secret is
 * public is refused). A kernel id must satisfy `isValidKernelId`: 1-128 printable
 * ASCII characters, no space, not starting `eip155:` or `ed25519:` in any ASCII
 * case, which is what keeps the three kinds' words from colliding. Throws
 * PrincipalIdError otherwise.
 *
 * This only hashes. It does not know which kernels exist, so the funding caller
 * must authenticate the exact kernel registry row the id names before it funds.
 */
export function principalTupleWord(kind: "operator" | "kernel" | "device", id: string): `0x${string}` {
  if (kind === "operator" && !parseOperatorPrincipalId(id)) {
    throw new PrincipalIdError("operator tuple word needs a pinned eip155:<chainId>:0x<address> id");
  }
  if (kind === "device") {
    const parsed = parseDevicePrincipalId(id);
    if (!parsed) throw new PrincipalIdError("device tuple word needs a pinned ed25519:0x<key> id");
    if (isCompromisedDevicePublicKey(parsed.publicKey)) {
      throw new PrincipalIdError("this Ed25519 key's secret half is public; it cannot be authorized");
    }
  }
  if (kind === "kernel" && !isValidKernelId(id)) {
    throw new PrincipalIdError(
      "kernel tuple word needs a kernel id of 1-128 printable ASCII characters (no space) that does not start with eip155: or ed25519:",
    );
  }
  return `0x${toHex(keccak_256(new TextEncoder().encode(id)))}`;
}

/** The (operator, kernel, device) bytes32 triple for one authorization. */
export function authorizedTuple(
  operatorPrincipalId: string,
  kernelId: string,
  devicePrincipalId: string,
): readonly [`0x${string}`, `0x${string}`, `0x${string}`] {
  return [
    principalTupleWord("operator", operatorPrincipalId),
    principalTupleWord("kernel", kernelId),
    principalTupleWord("device", devicePrincipalId),
  ] as const;
}
