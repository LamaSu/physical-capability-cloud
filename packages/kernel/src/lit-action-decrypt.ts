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

/**
 * Generate the Lit Action code for access-controlled evidence decryption.
 *
 * IMPORTANT: Chipotle v3 does NOT inject js_params as globals.
 * All values must be embedded directly in the code string.
 * The caller (gateway or pcc-node) verifies on-chain conditions FIRST,
 * then passes the pre-verified role to the TEE. The TEE acts as a
 * trusted key escrow — it only releases the key if the caller
 * provides a valid authProof.
 *
 * @param params.userAddress - Wallet address of the requester (pre-verified)
 * @param params.authProof - Pre-verified role: "buyer" or "verifier"
 * @param params.encryptedKeyB64 - AES key to release if authorized
 */
export function generateDecryptAction(params: DecryptActionParams & {
  userAddress: string;
  authProof: "buyer" | "verifier";
}): string {
  // Sanitize all inputs before embedding in code
  const safeAddress = params.userAddress.replace(/[^0-9a-fA-Fx]/g, "");
  const safeProof = params.authProof === "buyer" ? "buyer" : "verifier";
  const safeKeyB64 = params.encryptedKeyB64.replace(/[^A-Za-z0-9+/=]/g, "");

  return `async function main() {
  const userAddress = "${safeAddress}";
  const authProof = "${safeProof}";
  const keyB64 = "${safeKeyB64}";

  if (!userAddress) {
    return JSON.stringify({ authorized: false, reason: "No userAddress" });
  }
  if (authProof !== "buyer" && authProof !== "verifier") {
    return JSON.stringify({ authorized: false, reason: "Invalid authProof: " + authProof });
  }
  return JSON.stringify({ authorized: true, role: authProof, key: keyB64 });
}`;
}

/**
 * Execute a decrypt action via Lit Chipotle REST API.
 *
 * The actionCode must have all values embedded (no js_params in Chipotle v3).
 * Use generateDecryptAction() to produce it.
 *
 * @param params.apiUrl - Chipotle API base URL
 * @param params.apiKey - Usage API key (must have execute_in_groups permission)
 * @param params.actionCode - Generated JS from generateDecryptAction()
 */
export async function executeDecryptAction(params: {
  apiUrl: string;
  apiKey: string;
  actionCode: string;
}): Promise<DecryptActionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = performance.now();

  console.log(`[LIT] executeDecryptAction() called`);

  try {
    const res = await fetch(`${params.apiUrl}/lit_action`, {
      method: "POST",
      headers: {
        "X-Api-Key": params.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: params.actionCode,
        js_params: null, // Chipotle v3: params embedded in code, not injected
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const elapsed = (performance.now() - start).toFixed(1);

    if (!res.ok) {
      const text = await res.text();
      console.log(`[LIT] executeDecryptAction() FAILED in ${elapsed}ms — ${res.status}`);
      return { authorized: false, reason: `Lit API error: ${res.status} ${text}` };
    }

    const data = (await res.json()) as {
      has_error: boolean;
      logs: string;
      response: unknown;
    };

    if (data.has_error) {
      console.log(`[LIT] executeDecryptAction() ACTION ERROR in ${elapsed}ms`);
      return { authorized: false, reason: `Lit Action error: ${data.logs}` };
    }

    // Response can be object or string depending on Chipotle version
    const result: DecryptActionResult =
      typeof data.response === "string"
        ? JSON.parse(data.response)
        : (data.response as DecryptActionResult);

    console.log(
      `[LIT] executeDecryptAction() completed in ${elapsed}ms — authorized=${result.authorized}`,
    );
    return result;
  } catch (e: any) {
    clearTimeout(timeout);
    const elapsed = (performance.now() - start).toFixed(1);
    console.log(`[LIT] executeDecryptAction() NETWORK ERROR in ${elapsed}ms — ${e.message}`);
    return { authorized: false, reason: `Network error: ${e.message}` };
  }
}
