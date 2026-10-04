/**
 * FC-8 round 4 (astra pack 61c) — the steward's generic test fixture (bus
 * #6482): one canary-everywhere mock per TS script, instead of a hand-picked
 * canary per field. `allEncodings` returns the raw value plus its URI,
 * base64, and hex encodings — finding 1's exact gap was a test that checked
 * only the unencoded form while the script logged `encodeURIComponent(id)`.
 */
import { fakeResponse, makeFakeChain } from "./fc8-round3-fakes.js";

export { fakeResponse, makeFakeChain };

/** The raw value and every encoding astra's verdict named. Assert all four are absent. */
export function allEncodings(canary: string): string[] {
  return [
    canary,
    encodeURIComponent(canary),
    Buffer.from(canary, "utf8").toString("base64"),
    Buffer.from(canary, "utf8").toString("hex"),
  ];
}

/**
 * A mock fetch for real-e2e-verbose.ts that sets EVERY field the script
 * reads from EVERY endpoint to `canary` (or `[canary]` for array fields) —
 * not a hand-picked subset. Recording the request body of every call lets
 * the test also inspect exactly what would have been sent to the printer.
 */
export function makeAllFieldsCanaryFetchVerbose(canary: string, sentBodies: unknown[]): typeof fetch {
  return (async (url: string | URL, opts?: any) => {
    const u = String(url);
    if (opts?.body !== undefined) sentBodies.push(opts.body);

    if (u.includes("/api/ot2/camera/latest")) {
      return fakeResponse(200, "", { "content-type": canary, "content-length": "99" });
    }
    if (u.endsWith("/verify") && opts?.method === "POST") {
      return fakeResponse(200, { headers: { "x-oracle-key": canary }, verified: canary, attestation: { signature: canary } });
    }
    if (u.includes("/api/jobs/") && u.includes("/status")) {
      return fakeResponse(200, { status: canary, progress: canary });
    }
    if (u.includes("/api/jobs/submit")) {
      return fakeResponse(200, { jobId: canary, status: canary });
    }
    if (u.includes("/api/evidence/archive")) {
      return fakeResponse(200, { archived: canary, cid: canary, metadataCid: canary });
    }
    if (u.includes("/api/evidence/lit-status")) {
      return fakeResponse(200, { lit: { connected: canary, mode: canary, network: canary } });
    }
    if (u.includes("/api/lit/provision")) {
      return fakeResponse(200, { usageKey: canary, error: canary });
    }
    if (u.includes("/api/zk/commit")) {
      return fakeResponse(200, { commitment: { id: canary, commitmentHash: canary } });
    }
    if (u.includes("/api/zk/prove/tier")) {
      return fakeResponse(200, { proof: { id: canary, proofType: canary, verified: canary } });
    }
    if (u.includes("/api/zk/anchor-starknet/")) {
      return fakeResponse(200, { status: canary });
    }
    if (u.includes("/api/zk/anchor-starknet")) {
      return fakeResponse(200, { anchor: { txHash: canary, blockNumber: canary }, mode: canary });
    }
    if (u.includes("/api/near/status")) {
      return fakeResponse(200, { integration: canary, network: canary, mock: canary, supportedChains: [canary] });
    }
    if (u.includes("/api/near/intent/")) {
      return fakeResponse(200, { status: canary, txHash: canary });
    }
    if (u.includes("/api/near/quote")) {
      return fakeResponse(200, { quote: { quoteId: canary, estimatedOutput: canary, fee: canary, route: canary } });
    }
    if (u.includes("/api/near/intent")) {
      return fakeResponse(200, { intent: { intentId: canary, status: canary } });
    }
    // kernel state, dht peers/metrics, heartbeat, capabilities, telemetry audit, escrow chain state
    return fakeResponse(200, { note: canary });
  }) as unknown as typeof fetch;
}

/** Same idea for real-e2e.ts's (smaller) endpoint set. */
export function makeAllFieldsCanaryFetchRealE2e(canary: string, sentBodies: unknown[]): typeof fetch {
  return (async (url: string | URL, opts?: any) => {
    const u = String(url);
    if (opts?.body !== undefined) sentBodies.push(opts.body);

    if (u.includes("/api/ot2/camera/latest")) {
      return fakeResponse(200, "", { "content-type": canary, "content-length": "99" });
    }
    if (u.endsWith("/verify") && opts?.method === "POST") {
      return fakeResponse(200, { verified: canary, transactionHash: canary });
    }
    if (u.includes("/api/jobs/") && u.includes("/status")) {
      return fakeResponse(200, { status: canary });
    }
    if (u.includes("/api/jobs/submit")) {
      return fakeResponse(200, { jobId: canary, status: canary });
    }
    return fakeResponse(200, { note: canary });
  }) as unknown as typeof fetch;
}

/** Same idea for hp-full-chain-e2e.ts's endpoint set. */
export function makeAllFieldsCanaryFetchHpFullChain(canary: string, sentBodies: unknown[]): typeof fetch {
  return (async (url: string | URL, opts?: any) => {
    const u = String(url);
    if (opts?.body !== undefined) sentBodies.push(opts.body);

    if (u.endsWith("/verify") && opts?.method === "POST") {
      return fakeResponse(200, {
        headers: { "x-oracle-key": canary },
        verified: canary,
        attestation: { signature: canary },
      });
    }
    if (u.includes("/api/relay/") && u.endsWith("/scope")) {
      return fakeResponse(200, { id: canary });
    }
    if (u.includes("/api/relay/") && u.endsWith("/tool-call")) {
      return fakeResponse(200, { id: canary, status: canary });
    }
    return fakeResponse(200, { note: canary });
  }) as unknown as typeof fetch;
}
