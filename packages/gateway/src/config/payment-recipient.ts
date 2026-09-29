/**
 * Payment recipient resolution — FAILS CLOSED (WP-A fold F1, aeo #2352).
 *
 * The payment gate used to default the recipient to
 * `0x0000000000000000000000000000000000000001` when PCC_TREASURY_ADDRESS /
 * TEMPO_RECIPIENT were unset, and /.well-known/agent-card.json advertised the
 * same placeholder. A client that paid a priced route on such a deployment sent
 * real USDC to an address nobody controls, and the discovery document told
 * every agent to do exactly that.
 *
 * Now there is no default. A recipient is "configured" only when the env var
 * holds a well-formed EVM address that is not a placeholder; otherwise it
 * resolves to `null`, and callers must refuse to require, accept or advertise
 * payment (the gate answers priced routes with 503 `payments_not_configured`;
 * the agent card omits the payment scheme and its recipient).
 *
 * "Placeholder" = the zero address and every other address whose first 36 hex
 * digits are zero (value < 0x10000): the precompile/sentinel range that
 * contains the old `…0001` default and `…dEaD`-style burn stand-ins. No real
 * treasury lives there. Since WP-A round 5 it also covers repeated-digit
 * addresses and a short list of known burn / public-key test accounts, and a
 * mixed-case address must pass its EIP-55 checksum.
 *
 * Env is read on every call (no import-time freeze), so a deployment — or a
 * test — sets it before registering the gate.
 */

import { isAddress } from "viem";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PLACEHOLDER_RE = /^0x0{36}[0-9a-fA-F]{4}$/;
/** One hex digit repeated 40 times: 0x1111…1111, 0xffff…ffff, 0xaaaa…aaaa (sol #2963). */
const REPEATED_DIGIT_RE = /^0x([0-9a-fA-F])\1{39}$/;
/**
 * Known stand-ins that are not a treasury (WP-A round 5, sol #2963). The first is
 * a common "dead" burn address. The rest are the Hardhat / Anvil default accounts
 * #0-#4. Their private keys are PUBLIC (the "test test ... junk" mnemonic), so
 * anything paid to them can be taken by anyone.
 */
const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set(
  [
    "0xdead000000000000000042069420694206942069",
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  ].map((a) => a.toLowerCase()),
);

/**
 * True for the zero address and the rest of the sub-0x10000 sentinel range, a
 * repeated-digit address, and the known burn / public-key test accounts.
 */
export function isPlaceholderAddress(address: string): boolean {
  // Case never changes the destination, so classify the lowercase form (round 8, astra
  // FC-2): the backreference in REPEATED_DIGIT_RE is case-sensitive, so the correctly
  // CHECKSUMMED form of 0xaaaa…aaaa (mixed case) used to pass as a real treasury.
  const a = address.toLowerCase();
  return PLACEHOLDER_RE.test(a) || REPEATED_DIGIT_RE.test(a) || KNOWN_PLACEHOLDERS.has(a);
}

/**
 * A well-formed, non-placeholder EVM address from `raw`, else null. A MIXED-case
 * address must carry a valid EIP-55 checksum: a mistyped treasury fails it, so the
 * gateway refuses rather than asking agents to pay a near-miss. All-lowercase (or
 * all-uppercase) addresses carry no checksum and pass on shape alone.
 */
export function configuredAddress(raw: string | undefined): `0x${string}` | null {
  const value = (raw ?? "").trim();
  if (!EVM_ADDRESS_RE.test(value)) return null;
  if (!isAddress(value, { strict: true })) return null;
  if (isPlaceholderAddress(value)) return null;
  return value as `0x${string}`;
}

/** The legacy x402 `payTo`: PCC_TREASURY_ADDRESS, or null when unconfigured. */
export function x402Recipient(): `0x${string}` | null {
  return configuredAddress(process.env.PCC_TREASURY_ADDRESS);
}

/**
 * The MPP/Tempo recipient: TEMPO_RECIPIENT when it is set, else
 * PCC_TREASURY_ADDRESS; null when unconfigured.
 *
 * A TEMPO_RECIPIENT that is SET but malformed or a placeholder resolves to null
 * — it does NOT fall back to the treasury: an explicit recipient the operator
 * got wrong is a misconfiguration to surface, not a hint to pay someone else.
 */
export function mppRecipient(): `0x${string}` | null {
  const tempo = process.env.TEMPO_RECIPIENT;
  if (tempo !== undefined && tempo.trim() !== "") return configuredAddress(tempo);
  return configuredAddress(process.env.PCC_TREASURY_ADDRESS);
}

/** The recipient for whichever protocol the gateway speaks (MPP unless legacy x402). */
export function paymentRecipient(protocol: "mpp" | "x402"): `0x${string}` | null {
  return protocol === "mpp" ? mppRecipient() : x402Recipient();
}

/** The refusal a priced route returns while no recipient is configured. */
export const PAYMENTS_NOT_CONFIGURED = {
  error: "payments_not_configured",
  message:
    "This route is priced, but this gateway has no payment recipient configured " +
    "(PCC_TREASURY_ADDRESS / TEMPO_RECIPIENT). It refuses rather than request " +
    "payment to a placeholder address.",
} as const;
