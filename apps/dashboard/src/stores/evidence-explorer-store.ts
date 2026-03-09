import { create } from "zustand";
import type { EncryptedEvidenceBundle, EvidenceBundle, EvidenceCommitment, ZKProof } from "@pcc/spec";

interface EvidenceExplorerState {
  bundles: EncryptedEvidenceBundle[];
  selectedBundleId: string | null;
  decryptedBundle: EvidenceBundle | null;
  commitments: Record<string, EvidenceCommitment>;
  proofs: Record<string, ZKProof>;
  isDecrypting: boolean;

  setBundles: (bundles: EncryptedEvidenceBundle[]) => void;
  selectBundle: (id: string | null) => void;
  setDecrypted: (bundle: EvidenceBundle | null) => void;
  addCommitment: (c: EvidenceCommitment) => void;
  addProof: (p: ZKProof) => void;
  setDecrypting: (v: boolean) => void;
}

export const useEvidenceExplorerStore = create<EvidenceExplorerState>((set) => ({
  bundles: [],
  selectedBundleId: null,
  decryptedBundle: null,
  commitments: {},
  proofs: {},
  isDecrypting: false,

  setBundles: (bundles) => set({ bundles }),

  selectBundle: (id) => set({ selectedBundleId: id, decryptedBundle: null }),

  setDecrypted: (bundle) => set({ decryptedBundle: bundle, isDecrypting: false }),

  addCommitment: (c) =>
    set((s) => ({ commitments: { ...s.commitments, [c.bundleHash]: c } })),

  addProof: (p) =>
    set((s) => ({ proofs: { ...s.proofs, [p.id]: p } })),

  setDecrypting: (v) => set({ isDecrypting: v }),
}));
