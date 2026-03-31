  /**
   * PCC ProofRegistry deployed on Starknet Sepolia.
   * Deploy TX: 0x7622c6180cd92eb466f9d31a7512e6e52024dfdf44f780f777e7a1d2ac34619
   * Class hash: 0x5aceff2217c8dd931eb1d6027b6c96217d3c09e19ec832b33e8a12a3672bbaf
   * Deployed: 2026-03-31T02:59:19.436Z
   */
  private static readonly PROOF_REGISTRY_ADDRESS =
    "0x80aba6939deb83d0aaef4c1796cfa4a6cd7d4aba128d0b5e9315ee1951418a";

  constructor(config: StarknetProofServiceConfig = {}) {
    this.mock = config.mock !== false; // default true
    this.nodeUrl =
      config.nodeUrl ??
      "https://starknet-sepolia.public.blastapi.io/rpc/v0_7";
    this.accountAddress = config.accountAddress;
    this.privateKey = config.privateKey;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Anchor a ZK proof on Starknet.
   *
   * Computes a canonical proof hash (SHA-256 of proof id + type + proof bytes)
   * and submits it as a transaction. Returns the anchor with the tx hash.
   */
  async anchorProof(proof: ZKProof): Promise<StarknetAnchor> {
    const proofHash = await this.computeProofHash(proof);

    if (this.mock) {
      return this.mockAnchor(proofHash);
    }
    return this.realAnchor(proofHash, "anchor_proof");
  }

  /**
   * Anchor a Merkle root on Starknet.
   *
   * Useful for committing a batch of evidence commitments with a single tx.
   */
  async anchorMerkleRoot(root: string, treeDepth: number): Promise<StarknetAnchor> {
    // Canonical hash: sha256 of root + depth for uniqueness
    const rootHash = await sha256(`${root}:depth=${treeDepth}`);
    const proofHash = rootHash;

    if (this.mock) {
      return this.mockAnchor(proofHash);
    }
    return this.realAnchor(proofHash, "anchor_merkle_root");
  }

  /**
   * Verify that an anchor exists and was accepted on-chain.
   *
   * In mock mode: checks that the anchor is stored and its status is "accepted".
   * In real mode: fetches the transaction receipt from the Starknet node.
   */
  async verifyAnchor(anchor: StarknetAnchor): Promise<boolean> {
    const status = await this.getAnchorStatus(anchor.txHash);
    return status === "accepted";
  }

  /**
   * Poll the status of a Starknet anchor transaction.
   *
   * Returns "pending" | "accepted" | "rejected".
   *
   * Mock mode simulates block progression: after 2 status polls the tx is accepted.
   */
  async getAnchorStatus(txHash: string): Promise<AnchorStatus> {
    if (this.mock) {
      return this.mockGetStatus(txHash);
    }
    return this.realGetStatus(txHash);
  }

  // ─── Mock implementation ───────────────────────────────────────────────────

  private async mockAnchor(proofHash: string): Promise<StarknetAnchor> {
    // Generate a realistic-looking Starknet tx hash (0x prefix + 63 hex chars)
    const rawTxHash = await sha256(`mock-tx:${proofHash}:${Date.now()}`);
    const txHash = "0x0" + rawTxHash.replace("sha256:", "").slice(0, 62);

    const anchor: StarknetAnchor = {
      txHash,
      blockNumber: 100_000 + Math.floor(Math.random() * 50_000),
      proofHash,
      anchoredAt: new Date().toISOString(),
      chain: "starknet-sepolia",
    };

    this.anchors.set(txHash, anchor);
    this.statusChecks.set(txHash, 0);
    return anchor;
  }

  private mockGetStatus(txHash: string): AnchorStatus {
    if (!this.anchors.has(txHash)) {
      return "rejected";
    }

    const checks = (this.statusChecks.get(txHash) ?? 0) + 1;
    this.statusChecks.set(txHash, checks);

    // Simulate block finality: accepted after 2 status polls
    if (checks >= 2) {
      return "accepted";
    }
    return "pending";
  }

  // ─── Real Starknet implementation ──────────────────────────────────────────

  private async getProvider(): Promise<StarknetProvider> {
    if (this._provider) return this._provider;

    const starknet = await import("starknet");
    this._provider = new starknet.RpcProvider({ nodeUrl: this.nodeUrl }) as unknown as StarknetProvider;
    return this._provider;
  }

  private async getAccount(): Promise<StarknetAccount> {
    if (this._account) return this._account;

    if (!this.accountAddress || !this.privateKey) {
      throw new Error(
        "[StarknetProofAnchoringService] accountAddress and privateKey are required for real mode",
      );
    }

    const { Account, RpcProvider } = await import("starknet");
    // Use a fresh RpcProvider instance typed for the Account constructor
    const rpcProvider = new RpcProvider({ nodeUrl: this.nodeUrl });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._account = new (Account as any)(
      rpcProvider,
      this.accountAddress,
      this.privateKey,
    ) as StarknetAccount;
    return this._account;
  }

  private async realAnchor(proofHash: string, entrypoint: string): Promise<StarknetAnchor> {
    const account = await this.getAccount();

    // The proof hash is submitted as a felt252 (truncated to 31 bytes / 248 bits)
    const hashHex = proofHash.replace("sha256:", "");
    const felt = "0x" + hashHex.slice(0, 62); // 31 bytes = 248 bits ≤ BN254 field

    const result = await account.execute([
      {
        contractAddress: StarknetProofAnchoringService.PROOF_REGISTRY_ADDRESS,
        entrypoint,
        calldata: [felt],
      },
    ]);

    // Fetch initial receipt to get block number
    const provider = await this.getProvider();
    let blockNumber = 0;
    try {
      const receipt = await provider.getTransactionReceipt(result.transaction_hash);
      blockNumber = receipt.block_number ?? 0;
    } catch {
      // Block not confirmed yet — that's fine, status will be polled
    }

    const anchor: StarknetAnchor = {
      txHash: result.transaction_hash,
      blockNumber,
      proofHash,
      anchoredAt: new Date().toISOString(),
      chain: "starknet-sepolia",
    };

    this.anchors.set(result.transaction_hash, anchor);
    return anchor;
  }

  private async realGetStatus(txHash: string): Promise<AnchorStatus> {
    try {
      const provider = await this.getProvider();
      const receipt = await provider.getTransactionReceipt(txHash);

      switch (receipt.execution_status) {
        case "SUCCEEDED":
          return "accepted";
        case "REVERTED":
          return "rejected";
        default:
          return "pending";
      }
    } catch {
      // Transaction not found or network error — treat as pending
      return "pending";
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async computeProofHash(proof: ZKProof): Promise<string> {
    const canonical = `${proof.id}:${proof.proofType}:${proof.proof}`;
    return sha256(canonical);
  }

  /** Expose anchor store for testing / introspection */
  getStoredAnchor(txHash: string): StarknetAnchor | undefined {
    return this.anchors.get(txHash);
  }

  /** Check if this instance is in mock mode */
  isMock(): boolean {
    return this.mock;
  }
}
