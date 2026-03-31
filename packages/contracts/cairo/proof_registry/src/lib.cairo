/// ProofRegistry — anchors ZK proof hashes and Merkle roots on Starknet.
///
/// Physical Capability Cloud (PCC) uses this contract to commit evidence
/// hashes on-chain for permanent verifiability without storing raw data.
///
/// Storage layout:
///   - proofs: Map<felt252, (bool, u64)> — hash -> (anchored, block_timestamp)
///   - merkle_roots: Map<felt252, (bool, u64)> — root_hash -> (anchored, block_timestamp)
///
/// Entrypoints:
///   - anchor_proof(proof_hash: felt252)       — store a proof hash
///   - anchor_merkle_root(root_hash: felt252)  — store a merkle root hash
///
/// View:
///   - get_proof(proof_hash: felt252) -> (bool, u64)
///   - get_merkle_root(root_hash: felt252) -> (bool, u64)

#[starknet::contract]
mod ProofRegistry {
    use starknet::get_block_timestamp;
    use starknet::storage::{
        StoragePointerReadAccess, StoragePointerWriteAccess, Map, StorageMapReadAccess,
        StorageMapWriteAccess,
    };

    // ── Storage ──────────────────────────────────────────────────────────────

    #[storage]
    struct Storage {
        /// Map from proof_hash -> anchored_at_timestamp (0 = not anchored)
        proofs: Map<felt252, u64>,
        /// Map from root_hash -> anchored_at_timestamp (0 = not anchored)
        merkle_roots: Map<felt252, u64>,
    }

    // ── Events ───────────────────────────────────────────────────────────────

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        ProofAnchored: ProofAnchored,
        MerkleRootAnchored: MerkleRootAnchored,
    }

    #[derive(Drop, starknet::Event)]
    struct ProofAnchored {
        #[key]
        proof_hash: felt252,
        timestamp: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct MerkleRootAnchored {
        #[key]
        root_hash: felt252,
        timestamp: u64,
    }

    // ── External (write) entrypoints ─────────────────────────────────────────

    #[abi(embed_v0)]
    impl ProofRegistryImpl of super::IProofRegistry<ContractState> {
        /// Anchor a ZK proof hash on-chain.
        ///
        /// Stores the current block timestamp keyed by proof_hash.
        /// Idempotent: re-anchoring the same hash is a no-op (first timestamp kept).
        fn anchor_proof(ref self: ContractState, proof_hash: felt252) {
            let existing = self.proofs.read(proof_hash);
            if existing == 0 {
                let ts = get_block_timestamp();
                self.proofs.write(proof_hash, ts);
                self.emit(ProofAnchored { proof_hash, timestamp: ts });
            }
        }

        /// Anchor a Merkle root hash on-chain.
        ///
        /// Stores the current block timestamp keyed by root_hash.
        /// Idempotent: re-anchoring the same root is a no-op.
        fn anchor_merkle_root(ref self: ContractState, root_hash: felt252) {
            let existing = self.merkle_roots.read(root_hash);
            if existing == 0 {
                let ts = get_block_timestamp();
                self.merkle_roots.write(root_hash, ts);
                self.emit(MerkleRootAnchored { root_hash, timestamp: ts });
            }
        }

        /// Get proof anchor status.
        ///
        /// Returns (anchored: bool, timestamp: u64).
        /// timestamp is 0 if not anchored.
        fn get_proof(self: @ContractState, proof_hash: felt252) -> (bool, u64) {
            let ts = self.proofs.read(proof_hash);
            (ts != 0, ts)
        }

        /// Get merkle root anchor status.
        fn get_merkle_root(self: @ContractState, root_hash: felt252) -> (bool, u64) {
            let ts = self.merkle_roots.read(root_hash);
            (ts != 0, ts)
        }
    }
}

// ── Interface ────────────────────────────────────────────────────────────────

#[starknet::interface]
trait IProofRegistry<TContractState> {
    fn anchor_proof(ref self: TContractState, proof_hash: felt252);
    fn anchor_merkle_root(ref self: TContractState, root_hash: felt252);
    fn get_proof(self: @TContractState, proof_hash: felt252) -> (bool, u64);
    fn get_merkle_root(self: @TContractState, root_hash: felt252) -> (bool, u64);
}
