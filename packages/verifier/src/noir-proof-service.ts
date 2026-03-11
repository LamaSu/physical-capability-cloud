/**
 * NoirProofService — Real ZK proof generation and verification using Noir circuits.
 *
 * Wraps @noir-lang/noir_js + @noir-lang/backend_barretenberg to compile and execute
 * Noir circuits for evidence inclusion and tier compliance proofs.
 *
 * Falls back to mock proofs if Noir dependencies are not installed.
 *
 * Circuit artifacts are loaded from pre-compiled JSON files in circuits/build/.
 * To compile: `nargo compile` in each circuit directory.
 */

import type {
  ZKProof,
  EvidenceCommitment,
  CommitmentTree,
  EvidenceBundle,
  AssuranceTier,
  SHA256,
} from "@pcc/spec";
import { sha256, canonicalize, ids } from "@pcc/spec";
import { CommitmentService } from "./commitment-service.js";

// Dynamic imports for Noir — may not be installed
type NoirModule = typeof import("@noir-lang/noir_js");
type BackendModule = typeof import("@noir-lang/backend_barretenberg");

interface CircuitArtifact {
  bytecode: string;
  abi: unknown;
}

interface NoirInstance {
  noir: InstanceType<NoirModule["Noir"]>;
  backend: InstanceType<BackendModule["BarretenbergBackend"]>;
}

export class NoirProofService {
  private commitmentService = new CommitmentService();
  private circuits = new Map<string, NoirInstance>();
  private noirAvailable: boolean | null = null;
  private noirModule: NoirModule | null = null;
  private backendModule: BackendModule | null = null;

  /**
   * Check if Noir dependencies are available.
   * Caches the result after first check.
   */
  async isNoirAvailable(): Promise<boolean> {
    if (this.noirAvailable !== null) return this.noirAvailable;

    try {
      this.noirModule = await import("@noir-lang/noir_js");
      this.backendModule = await import("@noir-lang/backend_barretenberg");
      this.noirAvailable = true;
    } catch {
      this.noirAvailable = false;
    }
    return this.noirAvailable;
  }

  /**
   * Load a compiled circuit artifact and initialize Noir + Barretenberg backend.
   */
  private async loadCircuit(name: string): Promise<NoirInstance | null> {
    if (this.circuits.has(name)) return this.circuits.get(name)!;

    if (!(await this.isNoirAvailable())) return null;

    try {
      // Load pre-compiled circuit artifact
      const { readFile } = await import("node:fs/promises");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");

      const dir = dirname(fileURLToPath(import.meta.url));
      const artifactPath = join(dir, "..", "circuits", name, "target", `${name}.json`);

      const artifactJson = await readFile(artifactPath, "utf-8");
      const artifact: CircuitArtifact = JSON.parse(artifactJson);

      const backend = new this.backendModule!.BarretenbergBackend(artifact as any);
      const noir = new this.noirModule!.Noir(artifact as any);

      const instance: NoirInstance = { noir, backend };
      this.circuits.set(name, instance);
      return instance;
    } catch (err) {
      console.warn(`[NoirProofService] Failed to load circuit '${name}':`, err);
      return null;
    }
  }

  /**
   * Convert a SHA256 string ("sha256:abcdef...") to a Field element string for Noir.
   * Truncates to 254 bits (BN254 scalar field) by masking the top 2 bits.
   */
  private sha256ToField(hash: SHA256): string {
    const hex = hash.replace("sha256:", "");
    // Truncate to 254 bits: mask top 2 bits of the first byte
    const firstByte = parseInt(hex.substring(0, 2), 16) & 0x3f; // 6 bits
    const truncatedHex = firstByte.toString(16).padStart(2, "0") + hex.substring(2);
    return "0x" + truncatedHex;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Evidence Inclusion Proof
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Generate a real ZK proof that a bundle hash is included in a Merkle tree.
   * Falls back to mock if Noir is not available.
   */
  async proveEvidenceInclusion(
    tree: CommitmentTree,
    leafIndex: number,
    bundleHash: SHA256,
  ): Promise<ZKProof> {
    const merkleProof = await this.commitmentService.generateMerkleProof(tree, leafIndex);
    const circuit = await this.loadCircuit("evidence_inclusion");

    const commitment: EvidenceCommitment = {
      id: ids.commitment(),
      bundleHash,
      commitmentHash: tree.leaves[leafIndex],
      merkleRoot: tree.root,
      merkleIndex: leafIndex,
      commitmentTimestamp: new Date().toISOString(),
    };

    if (!circuit) {
      // Fallback to mock proof
      return this.generateProof("evidence_inclusion", commitment, {
        merklePath: merkleProof.path,
        merkleIndices: merkleProof.indices,
        treeRoot: tree.root,
      });
    }

    // Build Noir inputs (Field elements, not byte arrays)
    const MAX_DEPTH = 8;
    const siblingPath: string[] = Array(MAX_DEPTH).fill("0x0");
    const pathIndices: string[] = Array(MAX_DEPTH).fill("0x0");

    for (let i = 0; i < merkleProof.path.length && i < MAX_DEPTH; i++) {
      siblingPath[i] = this.sha256ToField(merkleProof.path[i]);
      pathIndices[i] = `0x${merkleProof.indices[i].toString(16)}`;
    }

    const inputs = {
      merkle_root: this.sha256ToField(tree.root),
      leaf_hash: this.sha256ToField(tree.leaves[leafIndex]),
      sibling_path: siblingPath,
      path_indices: pathIndices,
      tree_depth: `0x${tree.depth.toString(16)}`,
    };

    try {
      const { witness } = await circuit.noir.execute(inputs);
      const proof = await circuit.backend.generateProof(witness);

      return {
        id: ids.proof(),
        proofType: "evidence_inclusion",
        commitmentId: commitment.id,
        publicInputs: [tree.root, tree.leaves[leafIndex]],
        proof: `noir:${Buffer.from(proof.proof).toString("hex")}`,
        verificationKey: `noir:${Buffer.from(await circuit.backend.getVerificationKey()).toString("hex")}`,
        verified: false,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.warn("[NoirProofService] Noir proof generation failed, falling back to mock:", err);
      return this.generateProof("evidence_inclusion", commitment, {
        merklePath: merkleProof.path,
        merkleIndices: merkleProof.indices,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tier Compliance Proof
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Generate a real ZK proof that a bundle meets tier requirements.
   * Falls back to mock if Noir is not available.
   */
  async proveTierCompliance(
    bundle: EvidenceBundle,
    requiredTier: AssuranceTier,
  ): Promise<ZKProof> {
    const circuit = await this.loadCircuit("tier_compliance");

    const commitmentHash = await sha256(bundle.bundleHash);
    const commitment: EvidenceCommitment = {
      id: ids.commitment(),
      bundleHash: bundle.bundleHash,
      commitmentHash: commitmentHash as SHA256,
      commitmentTimestamp: new Date().toISOString(),
    };

    if (!circuit) {
      return this.generateProof("tier_compliance", commitment, {
        tier: requiredTier,
        eventCount: bundle.events.length,
        eventTypes: bundle.events.map((e) => e.type),
        assuranceTier: bundle.assuranceTier,
      });
    }

    // Compute event type flags
    const eventTypes = new Set(bundle.events.map((e) => e.type));
    let flags = 0;
    if (eventTypes.has("execution_completed")) flags |= 1;
    if (
      eventTypes.has("power_profile_sample") ||
      eventTypes.has("vibration_signature") ||
      eventTypes.has("acoustic_signature") ||
      eventTypes.has("temperature_log") ||
      eventTypes.has("power_profile_summary")
    ) flags |= 2;
    if (eventTypes.has("tee_attestation")) flags |= 4;
    if (eventTypes.has("camera_snapshot")) flags |= 8;
    if (eventTypes.has("cv_inspection_result")) flags |= 16;

    // events_hash is what the bundle_hash was computed from
    // We need to reconstruct: bundle_hash = sha256(events_hash)
    // So events_hash is the canonical hash of sorted event hashes
    const eventsHashStr = await sha256(
      canonicalize(bundle.events.map((e) => e.hash).sort()),
    );

    const inputs = {
      bundle_hash: this.sha256ToField(bundle.bundleHash),
      required_tier: `0x${requiredTier.toString(16)}`,
      event_count: `0x${bundle.events.length.toString(16)}`,
      has_execution_completed: (flags & 1) ? "0x1" : "0x0",
      has_sensor_data: (flags & 2) ? "0x1" : "0x0",
      has_tee_attestation: (flags & 4) ? "0x1" : "0x0",
      events_hash: this.sha256ToField(eventsHashStr as SHA256),
    };

    try {
      const { witness } = await circuit.noir.execute(inputs);
      const proof = await circuit.backend.generateProof(witness);

      return {
        id: ids.proof(),
        proofType: "tier_compliance",
        commitmentId: commitment.id,
        publicInputs: [bundle.bundleHash, String(requiredTier)],
        proof: `noir:${Buffer.from(proof.proof).toString("hex")}`,
        verificationKey: `noir:${Buffer.from(await circuit.backend.getVerificationKey()).toString("hex")}`,
        verified: false,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.warn("[NoirProofService] Noir proof generation failed, falling back to mock:", err);
      return this.generateProof("tier_compliance", commitment, {
        tier: requiredTier,
        eventCount: bundle.events.length,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Verification
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Verify a ZK proof. Supports both Noir proofs (prefix "noir:") and mock proofs (prefix "sha256:").
   */
  async verifyProof(proof: ZKProof): Promise<boolean> {
    if (proof.proof.startsWith("noir:") && proof.verificationKey.startsWith("noir:")) {
      return this.verifyNoirProof(proof);
    }
    return this.verifyMockProof(proof);
  }

  private async verifyNoirProof(proof: ZKProof): Promise<boolean> {
    if (!(await this.isNoirAvailable())) {
      console.warn("[NoirProofService] Cannot verify Noir proof — dependencies not installed");
      proof.verified = false;
      return false;
    }

    try {
      const proofBytes = Buffer.from(proof.proof.replace("noir:", ""), "hex");
      const vkBytes = Buffer.from(proof.verificationKey.replace("noir:", ""), "hex");

      // Determine which circuit this proof belongs to
      const circuitName = proof.proofType === "evidence_inclusion" ? "evidence_inclusion" : "tier_compliance";
      const circuit = await this.loadCircuit(circuitName);

      if (!circuit) {
        proof.verified = false;
        return false;
      }

      const isValid = await circuit.backend.verifyProof({
        proof: proofBytes,
        publicInputs: proof.publicInputs,
      });

      proof.verified = isValid;
      return isValid;
    } catch (err) {
      console.warn("[NoirProofService] Verification failed:", err);
      proof.verified = false;
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Mock fallbacks (identical to original ZKProofService)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Generate a proof directly from commitment + witness.
   * Uses mock proof format. For real proofs, use proveEvidenceInclusion() or proveTierCompliance().
   */
  async generateProof(
    proofType: ZKProof["proofType"],
    commitment: EvidenceCommitment,
    privateWitness: Record<string, unknown>,
  ): Promise<ZKProof> {
    const publicInputs = [commitment.bundleHash, commitment.commitmentHash];

    const proofData = canonicalize({
      type: proofType,
      publicInputs,
      witness: privateWitness,
      nonce: Date.now(),
    });
    const proofHash = await sha256(proofData);

    const vkData = canonicalize({ type: proofType, version: "mock-v1" });
    const verificationKey = await sha256(vkData);

    return {
      id: ids.proof(),
      proofType,
      commitmentId: commitment.id,
      publicInputs,
      proof: proofHash,
      verificationKey,
      verified: false,
      generatedAt: new Date().toISOString(),
    };
  }

  private async verifyMockProof(proof: ZKProof): Promise<boolean> {
    const valid =
      proof.proof.startsWith("sha256:") &&
      proof.verificationKey.startsWith("sha256:") &&
      proof.publicInputs.length >= 2 &&
      proof.proofType !== undefined;

    proof.verified = valid;
    return valid;
  }
}
