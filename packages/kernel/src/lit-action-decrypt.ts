/**
 * Generates Lit Action code for access-controlled evidence decryption.
 *
 * The generated JS runs inside Lit's TEE (Chipotle v3).
 * It checks MilestoneEscrow on Base Sepolia before releasing the key.
 */

/** Parameters for generating a decrypt Lit Action */
export interface DecryptActionParams {
  escrowAddress: string;
  jobId: string;
  chain: string;
  encryptedKeyB64: string; // AES key encrypted to the PKP
}

/** Result from executing a decrypt action */
export interface DecryptActionResult {
  authorized: boolean;
  key?: string;
  role?: string;
  reason?: string;
}

/** Generate the Lit Action code for a specific evidence bundle. */
export function generateDecryptAction(params: DecryptActionParams): string {
  // Escape user-provided strings to prevent injection into the generated code
  const safeEscrowAddress = params.escrowAddress.replace(/[^0-9a-fA-Fx]/g, "");
  const safeJobId = params.jobId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeChain = params.chain.replace(/[^a-zA-Z0-9]/g, "");
  const safeKeyB64 = params.encryptedKeyB64.replace(/[^A-Za-z0-9+/=]/g, "");

  return `
async function main() {
  // Check on-chain access conditions
  const escrowAddress = "${safeEscrowAddress}";
  const jobId = "${safeJobId}";
  const callerAddress = params.userAddress; // passed from the caller

  // Check 1: Is caller the buyer?
  const buyerCheck = await Lit.Actions.callContract({
    chain: "${safeChain}",
    contractAddress: escrowAddress,
    functionName: "getBuyer",
    functionParams: [jobId],
    functionAbi: {
      name: "getBuyer",
      inputs: [{ name: "jobId", type: "string" }],
      outputs: [{ name: "", type: "address" }],
      stateMutability: "view",
      type: "function",
    },
  });

  const isBuyer = buyerCheck.toLowerCase() === callerAddress.toLowerCase();

  // Check 2: Is caller a verifier with rep >= 100?
  let isVerifier = false;
  try {
    const repCheck = await Lit.Actions.callContract({
      chain: "${safeChain}",
      contractAddress: escrowAddress,
      functionName: "getVerifierReputation",
      functionParams: [callerAddress],
      functionAbi: {
        name: "getVerifierReputation",
        inputs: [{ name: "verifier", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    });
    isVerifier = parseInt(repCheck) >= 100;
  } catch (e) {
    // Contract may not have this function - that is OK
  }

  if (!isBuyer && !isVerifier) {
    return JSON.stringify({
      authorized: false,
      reason: "Caller is neither the escrow buyer nor a qualified verifier",
    });
  }

  // Authorized - return the decryption key
  return JSON.stringify({
    authorized: true,
    role: isBuyer ? "buyer" : "verifier",
    key: "${safeKeyB64}",
  });
}
`;
}

/**
 * Execute a decrypt action via Lit Chipotle REST API.
 * Returns the decryption key if access conditions are met.
 */
export async function executeDecryptAction(params: {
  apiUrl: string;
  apiKey: string;
  actionCode: string;
  userAddress: string;
}): Promise<DecryptActionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    console.log(
      `[LIT] executing decrypt action for user=${params.userAddress}`,
    );

    const res = await fetch(`${params.apiUrl}/lit_action`, {
      method: "POST",
      headers: {
        "X-Api-Key": params.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: params.actionCode,
        js_params: { userAddress: params.userAddress },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      console.log(`[LIT] decrypt action failed: ${res.status} ${text}`);
      return { authorized: false, reason: `Lit API error: ${res.status}` };
    }

    const data = (await res.json()) as {
      has_error?: boolean;
      logs?: string;
      response?: string;
    };
    if (data.has_error) {
      return {
        authorized: false,
        reason: `Lit Action error: ${data.logs}`,
      };
    }

    return JSON.parse(data.response ?? "{}") as DecryptActionResult;
  } catch (e: any) {
    clearTimeout(timeout);
    console.log(`[LIT] decrypt action network error: ${e.message}`);
    return { authorized: false, reason: `Network error: ${e.message}` };
  }
}
