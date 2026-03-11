// Type declarations for Noir packages (optional dependencies)
// These are only needed when Noir circuits are compiled and ready to use.
// The NoirProofService falls back to mock proofs if these are not installed.

declare module "@noir-lang/noir_js" {
  export class Noir {
    constructor(circuit: unknown);
    execute(inputs: Record<string, unknown>): Promise<{ witness: Uint8Array }>;
  }
}

declare module "@noir-lang/backend_barretenberg" {
  export class BarretenbergBackend {
    constructor(circuit: unknown);
    generateProof(witness: Uint8Array): Promise<{ proof: Uint8Array; publicInputs: string[] }>;
    verifyProof(proof: { proof: Uint8Array; publicInputs: string[] }): Promise<boolean>;
    getVerificationKey(): Promise<Uint8Array>;
  }
}
