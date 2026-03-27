// Type declarations for Noir packages (production dependencies).
//
// @noir-lang/noir_js@1.0.0-beta.19 — witness generation from compiled circuit JSON
// @noir-lang/backend_barretenberg@0.36.0 — UltraPlonk/UltraHonk proof generation & verification
//
// The NoirProofService falls back to mock proofs if WASM initialization fails at runtime.

declare module "@noir-lang/noir_js" {
  export interface InputMap {
    [key: string]: string | string[] | InputMap | InputMap[];
  }

  export class Noir {
    constructor(circuit: { bytecode: string; abi: unknown });
    /** Initialize the WASM backend. Called automatically by execute(). */
    init(): Promise<void>;
    /** Execute the circuit with the given inputs, producing a witness. */
    execute(
      inputs: InputMap,
      foreignCallHandler?: unknown,
    ): Promise<{ witness: Uint8Array; returnValue: unknown }>;
  }
}

declare module "@noir-lang/backend_barretenberg" {
  export interface BackendOptions {
    /** Number of threads for WASM execution. Set to 1 to reduce memory usage. */
    threads?: number;
  }

  export interface ProofData {
    /** The serialized proof bytes. */
    proof: Uint8Array;
    /** Public input values as hex strings. */
    publicInputs: string[];
  }

  export class BarretenbergBackend {
    constructor(
      circuit: { bytecode: string; abi: unknown },
      options?: BackendOptions,
    );
    /** Generate a proof from a compressed witness. */
    generateProof(witness: Uint8Array): Promise<ProofData>;
    /** Verify a proof against the circuit. */
    verifyProof(proof: ProofData): Promise<boolean>;
    /** Get the verification key for this circuit. */
    getVerificationKey(): Promise<Uint8Array>;
    /** Generate recursive proof artifacts for use in another circuit. */
    generateRecursiveProofArtifacts(
      proofData: ProofData,
      numOfPublicInputs?: number,
    ): Promise<{
      proofAsFields: string[];
      vkAsFields: string[];
      vkHash: string;
    }>;
    /** Destroy the WASM backend and free memory. MUST be called after use. */
    destroy(): Promise<void>;
  }

  export class UltraHonkBackend {
    constructor(
      circuit: { bytecode: string; abi: unknown },
      options?: BackendOptions,
    );
    generateProof(witness: Uint8Array): Promise<ProofData>;
    verifyProof(proof: ProofData): Promise<boolean>;
    getVerificationKey(): Promise<Uint8Array>;
    generateRecursiveProofArtifacts(
      proofData: ProofData,
      numOfPublicInputs: number,
    ): Promise<{
      proofAsFields: string[];
      vkAsFields: string[];
      vkHash: string;
    }>;
    destroy(): Promise<void>;
  }
}
