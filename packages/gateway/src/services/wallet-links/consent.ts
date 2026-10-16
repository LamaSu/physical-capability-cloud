import { createHash } from "node:crypto";

export const CONSENT_VERSION = "wallet-link-v1";
export const NETWORK_NAME = "Base Sepolia (test network, chain 84532)";
export const TESTNET_FUNDING = Object.freeze({
  agent: Object.freeze({ eth: "0.0005", usdc: "1" }),
  device: Object.freeze({ eth: "0.0005", usdc: null }),
});

const BASE_TEMPLATE = `Link a wallet to your PCC account
Code {userCode}. Check that your terminal shows the same code. If you didn't start this, choose Deny.

Who is asking: {who}. Requested {requestedAt} from {requesterIpClass}.
Wallet: {key} on Base Sepolia (test network, chain 84532).
Who holds the key: the key was created on that computer and has not been sent to PCC. PCC cannot see, use or recover it. If it is lost, so is anything it holds.
What linking lets it do for your account {accountName}: {permissions}
Spending limit: {spendingLimit}
What jobs cost: every job is priced all-in before anything is funded. The operator's price, PCC's fee and the pass-through costs PCC pays vendors for you (postage, printing services, carriers) each get their own line. A pass-through amount goes to PCC only when the vendor's work is evidenced (for postage, the carrier's acceptance scan); unused amounts are refunded.
Funding: {funding} Test funds have no value. On mainnet PCC never funds wallets; you add funds yourself (Onramp or transfer).
How long: {duration}
Undo: Wallets → {label} → Unlink. PCC then refuses this key's signatures for your account at once. Unlinking doesn't move funds; on mainnet, revoke its spending permission in your wallet too (we show you how).
What PCC stores: the address or public key, the label, these terms (wallet-link v1, sha256 {consentSha256}), the proof signature, the account owner's approval receipt and the times. No keys.
Approve and link. Deny.`;

const AGENT_PERMISSIONS = "sign in as your agent; ask for quotes; approve and fund jobs from this wallet's own balance; read the status of its own jobs. It cannot spend from your other wallets, change your account, or approve its own link.";
const AGENT_FUNDING = "after you approve, PCC will ask Coinbase's test faucet to send this wallet {testEth} test ETH (for fees) and {testUsdc} test USDC. If the faucet's daily test-USDC allowance is used up, it sends the test ETH only.";
const AGENT_DURATION = "30 days after approval, or until you unlink it.";

export const CONSENT_TEMPLATES = Object.freeze({
  agent: BASE_TEMPLATE
    .replace("{who}", "{label} (an agent, on the computer where the command ran{client})")
    .replace("{permissions}", AGENT_PERMISSIONS)
    .replace("{spendingLimit}", "on this test network, whatever this wallet holds.")
    .replace("{funding}", AGENT_FUNDING)
    .replace("{duration}", AGENT_DURATION),
  device: BASE_TEMPLATE
    .replace("{who}", "{label} (a device{client}). Device {kernel} will sign evidence for jobs on this kernel. It cannot spend")
    .replace("{permissions}", "sign evidence for jobs on this kernel. It cannot spend from this wallet or your other wallets, change your account, or approve its own link.")
    .replace("{spendingLimit}", "this device cannot spend.")
    .replace("{funding}", "after you approve, PCC will ask Coinbase's test faucet to send this wallet {testEth} test ETH (for fees) if it is an EVM (secp256k1) key. Ed25519 device keys get no test funds.")
    .replace("{duration}", "until unlinked."),
  hosted: BASE_TEMPLATE
    .replace("{who}", "{label} (an agent{client}). Runs in {partner}'s sandbox. {partner} operates the machine that holds the key and could use it up to the limit below")
    .replace("{permissions}", AGENT_PERMISSIONS)
    .replace("{spendingLimit}", "on this test network, whatever this wallet holds.")
    .replace("{funding}", AGENT_FUNDING)
    .replace("{duration}", AGENT_DURATION),
});

/** The single receipt hash binds the exact UTF-8 bytes of every consent variant. */
export const CONSENT_TEMPLATE = Object.values(CONSENT_TEMPLATES).join("\n\n");
export const CONSENT_SHA256 = createHash("sha256").update(CONSENT_TEMPLATE, "utf8").digest("hex");

/** Internal persisted request projection; validated by the create route. */
export interface ConsentRequest {
  user_code: string;
  address_or_pubkey: string;
  role: "agent" | "device";
  label: string;
  client_info: string | { name: string; version: string } | null;
  kernel_id?: string | null;
  chain_id: number;
  created_at: string;
  requester_ip_class: string;
}

export function renderConsent(request: ConsentRequest, accountName: string): string {
  const clientInfo = typeof request.client_info === "string"
    ? JSON.parse(request.client_info) as { name: string; version: string }
    : request.client_info;
  const funding = TESTNET_FUNDING[request.role];
  const code = request.user_code.replace(/[- ]/g, "").toUpperCase();
  const replacements: Record<string, string> = {
    userCode: `${code.slice(0, 4)}-${code.slice(4)}`,
    label: request.label,
    client: clientInfo ? `; client ${clientInfo.name} ${clientInfo.version}` : "",
    requestedAt: request.created_at,
    requesterIpClass: request.requester_ip_class,
    key: request.address_or_pubkey,
    accountName,
    kernel: request.kernel_id || request.label,
    testEth: funding.eth,
    testUsdc: funding.usdc || "",
    consentSha256: CONSENT_SHA256,
  };
  // W1 has no hosted-partner metadata. Its hosted template is hash-bound for a
  // later trusted selector; callers cannot infer hosting from a client label.
  return CONSENT_TEMPLATES[request.role].replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_match, key: string) => replacements[key] ?? "");
}
