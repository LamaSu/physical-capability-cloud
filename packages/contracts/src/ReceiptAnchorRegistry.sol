// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ReceiptAnchorRegistry
 * @notice On-chain anchor for every Phase-2+ InvocationReceipt emitted by the
 *         PCC aggregator gateway. Bridges off-chain InvocationReceipts
 *         (packages/spec/src/types/invocation-receipt.ts) to immutable on-chain
 *         witness records.
 *
 * Design doc: ai/scoping/onchain-receipt-anchoring-2026-05-23.md
 *
 * Architectural sibling of {CaptureClassRegistry}: same gateway-oracle write
 * gate, same content-addressed key, same `exists[hash]` replay map, same
 * separate dispute event. Differs in two ways:
 *
 *   1. Two write modes — `anchorOne` for single receipts (DCC3+/high-stakes,
 *      ~$0.025/receipt on Base L2) and `anchorBatch` for Merkle-rooted batches
 *      of up to 4096 receipts (~$0.000005/receipt amortized — six orders of
 *      magnitude cheaper).
 *   2. Three indexed event topics maxed out (cidHash, toolIdHash, callerHash)
 *      — hits the EVM 3-topic cap exactly. This is the maximum filterable
 *      surface a subgraph can index without secondary lookups.
 *
 * Permission model:
 *   - `anchorOne` / `anchorBatch` — gateway oracle EOA only (single immutable
 *     slot, mirrors CaptureClassRegistry.gatewayOracle).
 *   - `dispute` — permissionless. Anyone can raise an on-chain dispute event;
 *     resolution lives off-chain (or in MilestoneEscrow for funded jobs).
 *   - `verifyInBatch` — pure view, anyone can call to check a Merkle proof.
 *
 * Privacy: the on-chain events leak `cidHash`, `toolIdHash`, `callerHash`,
 * `upstreamKeyHash` — all sha256 hashes. The tool/caller IDs themselves are in
 * PCC's public registries, so the hashes are reversible by lookup. This is
 * INTENTIONAL: auditors must be able to ask "which tools is this caller
 * invoking" against the chain. Callers who want unlinkable usage should use
 * ephemeral callerAgentIds (see digital-verifier.ephemeralIdentity).
 *
 * Replay prevention: `exists[cidHash]` rejects duplicate single anchors;
 * `batchExists[merkleRoot]` rejects duplicate batch anchors. cidHash is
 * sha256(canonicalReceiptJSON), already binding caller + tool + timestamp +
 * body + dccClass, so no nonce is needed.
 */
contract ReceiptAnchorRegistry {
    // ── Types ──────────────────────────────────────────────────────────────

    /// @notice Packed single-receipt anchor record. 2 storage slots.
    /// @dev Slot 0 packs anchor metadata (block + receipt timestamp + class).
    ///      Slot 1 holds toolCID for drift detection across calls.
    struct ReceiptAnchor {
        // Slot 0 (32 bytes):
        uint64 anchoredAtBlock; // 8 bytes — block.number at anchor time
        uint64 receiptTimestamp; // 8 bytes — client-attested seconds (truncated from ms)
        uint8 dccClass; // 1 byte — 0..5
        uint8 _pad0; // 1 byte — reserved
        uint16 _pad1; // 2 bytes — reserved
        // 12-byte gap remaining in slot 0 (no further packed fields planned)
        // Slot 1 (32 bytes):
        bytes32 toolCID; // 32 bytes — content-addressed tool version
    }

    /// @notice Packed batch-anchor record. 2 storage slots.
    /// @dev Slot 0: anchor metadata + count + class range.
    ///      Slot 1: IPFS CID of the batch manifest (leaf list + tree).
    struct BatchAnchor {
        // Slot 0:
        uint64 anchoredAtBlock;
        uint32 count; // 4 bytes — receipts under this root (≤4096)
        uint8 minDccClass; // 1 byte
        uint8 maxDccClass; // 1 byte
        uint16 _pad; // 2 bytes
        // Slot 1:
        bytes32 batchMetadataCID;
    }

    // ── State ──────────────────────────────────────────────────────────────

    /// @notice cidHash -> single-receipt anchor record (sparse — only single anchors).
    mapping(bytes32 => ReceiptAnchor) public anchors;

    /// @notice cidHash -> true once anchored via anchorOne (replay prevention).
    /// @dev For batch-anchored receipts, this map is NOT set — membership is
    ///      proved via Merkle verification against `batchExists[root]` instead.
    mapping(bytes32 => bool) public exists;

    /// @notice merkleRoot -> batch anchor record.
    mapping(bytes32 => BatchAnchor) public batches;

    /// @notice merkleRoot -> true once anchored (batch replay prevention).
    mapping(bytes32 => bool) public batchExists;

    /// @notice Per-(caller, toolId) monotonically increasing sequence counter.
    /// @dev Optional defense-in-depth: anchorOne callers can pass a sequence
    ///      number that must equal `sequences[callerHash][toolIdHash] + 1`,
    ///      preventing out-of-order or replay-of-old-sequence attacks even
    ///      across cidHash collisions (which are computationally infeasible
    ///      but this is the audit-trail cheap belt-and-suspenders). Sequences
    ///      start at 1; sequence==0 means "skip the check".
    mapping(bytes32 => mapping(bytes32 => uint64)) public sequences;

    /// @notice Single immutable gateway oracle EOA (only writer for anchors).
    /// @dev Held by the gateway process. Mirrors CaptureClassRegistry.gatewayOracle.
    address public immutable gatewayOracle;

    // ── Events ─────────────────────────────────────────────────────────────

    /// @notice Emitted when a single receipt is anchored on-chain.
    /// @dev Three indexed topics — the EVM cap. The subgraph (see
    ///      packages/subgraph) filters by any of these axes cheaply.
    /// @param cidHash sha256 of the canonical receipt JSON (== receiptCID bytes).
    /// @param toolIdHash sha256(IndexedTool.id).
    /// @param callerHash sha256(callerAgentId).
    /// @param dccClass 0..5; matches DigitalCaptureClass enum.
    /// @param receiptTimestamp Client-attested seconds; when the call HAPPENED.
    /// @param toolCID Content-addressed tool version.
    /// @param upstreamKeyHash sha256(upstreamKeyId) iff DCC2+, else bytes32(0).
    event AnchorEmitted(
        bytes32 indexed cidHash,
        bytes32 indexed toolIdHash,
        bytes32 indexed callerHash,
        uint8 dccClass,
        uint64 receiptTimestamp,
        bytes32 toolCID,
        bytes32 upstreamKeyHash
    );

    /// @notice Emitted when a Merkle-rooted batch of receipts is anchored.
    /// @dev Per-receipt linkability requires fetching `batchMetadataCID` from
    ///      IPFS/Storacha. Casual on-chain observers see only aggregate stats.
    /// @param merkleRoot OZ-style sorted-pair keccak Merkle root over leaf cidHashes.
    /// @param count Number of receipts in the batch (1..4096).
    /// @param minDccClass Tightest DCC class in the batch.
    /// @param maxDccClass Loosest DCC class in the batch.
    /// @param batchMetadataCID IPFS CID of the batch manifest JSON.
    event BatchAnchorEmitted(
        bytes32 indexed merkleRoot,
        uint32 count,
        uint8 minDccClass,
        uint8 maxDccClass,
        bytes32 batchMetadataCID
    );

    /// @notice Emitted when anyone raises a dispute against an anchored receipt.
    /// @dev Permissionless. Resolution happens off-chain (or in MilestoneEscrow).
    /// @param cidHash sha256 of the disputed receipt.
    /// @param disputer Address raising the dispute.
    /// @param reason Free-form human-readable dispute reason.
    event DisputeRaised(bytes32 indexed cidHash, address indexed disputer, string reason);

    // ── Constructor ────────────────────────────────────────────────────────

    /// @notice Deploy with the gateway oracle EOA address.
    /// @param _gatewayOracle EOA controlled by the gateway process.
    constructor(address _gatewayOracle) {
        require(_gatewayOracle != address(0), "zero gateway");
        gatewayOracle = _gatewayOracle;
    }

    // ── External: anchorOne (DCC3+ / single-receipt path) ─────────────────

    /// @notice Anchor a single InvocationReceipt on-chain.
    /// @dev Costs ~70k L2 gas + ~840 L1 calldata gas = ~$0.025/receipt on Base
    ///      mainnet (May 2026 gas model). Use for DCC3+ where the per-receipt
    ///      premium is justified by audit-grade synchronous proof.
    ///
    ///      Invariants enforced:
    ///        - caller is the gateway oracle
    ///        - cidHash not previously anchored (replay prevention)
    ///        - dccClass in [0, 5]
    ///        - sequence (if non-zero) is strictly monotonic per (caller, tool)
    /// @param cidHash sha256 of the canonical receipt JSON.
    /// @param toolIdHash sha256 of the IndexedTool.id.
    /// @param callerHash sha256 of the callerAgentId.
    /// @param dccClass 0..5.
    /// @param receiptTimestamp Client-attested seconds (truncated from ms).
    /// @param toolCID Content-addressed tool version.
    /// @param upstreamKeyHash sha256(upstreamKeyId) for DCC2+, or bytes32(0).
    /// @param sequence 0 to skip the per-(caller,tool) monotonic check;
    ///                 otherwise must equal `sequences[callerHash][toolIdHash] + 1`.
    function anchorOne(
        bytes32 cidHash,
        bytes32 toolIdHash,
        bytes32 callerHash,
        uint8 dccClass,
        uint64 receiptTimestamp,
        bytes32 toolCID,
        bytes32 upstreamKeyHash,
        uint64 sequence
    ) external {
        require(msg.sender == gatewayOracle, "only gateway");
        require(!exists[cidHash], "replay");
        require(dccClass <= 5, "invalid class");

        if (sequence != 0) {
            uint64 expected = sequences[callerHash][toolIdHash] + 1;
            require(sequence == expected, "bad sequence");
            sequences[callerHash][toolIdHash] = sequence;
        }

        exists[cidHash] = true;
        anchors[cidHash] = ReceiptAnchor({
            anchoredAtBlock: uint64(block.number),
            receiptTimestamp: receiptTimestamp,
            dccClass: dccClass,
            _pad0: 0,
            _pad1: 0,
            toolCID: toolCID
        });

        emit AnchorEmitted(
            cidHash, toolIdHash, callerHash, dccClass, receiptTimestamp, toolCID, upstreamKeyHash
        );
    }

    // ── External: anchorBatch (DCC0..DCC2 / amortized-cost path) ──────────

    /// @notice Anchor a Merkle-rooted batch of up to 4096 receipts.
    /// @dev Costs ~70k L2 gas + ~600 L1 calldata gas = ~$0.020/batch =
    ///      ~$0.000005/receipt amortized at 4096 leaves. Use for DCC0..DCC2
    ///      bulk traffic. Per-receipt linkability requires fetching the
    ///      `batchMetadataCID` manifest off-chain and proving membership via
    ///      `verifyInBatch`.
    ///
    ///      Invariants enforced:
    ///        - caller is the gateway oracle
    ///        - merkleRoot not previously anchored (batch replay)
    ///        - count in (0, 4096]
    ///        - minDccClass <= maxDccClass <= 5
    /// @param merkleRoot OZ-style sorted-pair keccak Merkle root over leaf cidHashes.
    /// @param count Number of receipts in the batch.
    /// @param minDccClass Tightest DCC class included.
    /// @param maxDccClass Loosest DCC class included.
    /// @param batchMetadataCID IPFS CID of the manifest JSON containing leaves + tree.
    function anchorBatch(
        bytes32 merkleRoot,
        uint32 count,
        uint8 minDccClass,
        uint8 maxDccClass,
        bytes32 batchMetadataCID
    ) external {
        require(msg.sender == gatewayOracle, "only gateway");
        require(!batchExists[merkleRoot], "batch replay");
        require(count > 0 && count <= 4096, "bad count");
        require(maxDccClass <= 5 && minDccClass <= maxDccClass, "bad classes");

        batchExists[merkleRoot] = true;
        batches[merkleRoot] = BatchAnchor({
            anchoredAtBlock: uint64(block.number),
            count: count,
            minDccClass: minDccClass,
            maxDccClass: maxDccClass,
            _pad: 0,
            batchMetadataCID: batchMetadataCID
        });

        emit BatchAnchorEmitted(merkleRoot, count, minDccClass, maxDccClass, batchMetadataCID);
    }

    // ── External: dispute (permissionless) ────────────────────────────────

    /// @notice Raise a permissionless dispute against an anchored receipt.
    /// @dev Emits an event only. The receipt may have been anchored singly
    ///      (exists[cidHash] == true) or via batch (membership proved via
    ///      verifyInBatch). For batch-anchored disputes, the disputer should
    ///      pass the Merkle proof out-of-band when filing.
    /// @param cidHash sha256 of the disputed receipt.
    /// @param reason Free-form human-readable dispute reason.
    function dispute(bytes32 cidHash, string calldata reason) external {
        emit DisputeRaised(cidHash, msg.sender, reason);
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /// @notice Return the full ReceiptAnchor struct for a cidHash.
    /// @dev Returns zero-value struct if the receipt was anchored via batch
    ///      (in which case use `verifyInBatch` to prove membership) or never
    ///      anchored.
    /// @param cidHash sha256 of a receipt.
    /// @return The stored ReceiptAnchor; zero-valued if not single-anchored.
    function getAnchor(bytes32 cidHash) external view returns (ReceiptAnchor memory) {
        return anchors[cidHash];
    }

    /// @notice Return the full BatchAnchor struct for a merkleRoot.
    /// @param merkleRoot Sorted-pair keccak Merkle root.
    /// @return The stored BatchAnchor; zero-valued if no such batch.
    function getBatch(bytes32 merkleRoot) external view returns (BatchAnchor memory) {
        return batches[merkleRoot];
    }

    /// @notice Get the next expected sequence number for a (caller, tool) pair.
    /// @dev Returns 0 if no anchors with sequence checking have been recorded
    ///      for this pair. The next valid sequence to pass is `getSequence(...) + 1`.
    /// @param callerHash sha256 of the callerAgentId.
    /// @param toolIdHash sha256 of the IndexedTool.id.
    /// @return The current sequence (last accepted); next valid is this + 1.
    function getSequence(bytes32 callerHash, bytes32 toolIdHash) external view returns (uint64) {
        return sequences[callerHash][toolIdHash];
    }

    /// @notice Verify that `cidHash` is a leaf under an anchored `merkleRoot`.
    /// @dev Stateless OpenZeppelin-style sorted-pair keccak proof check.
    ///      Reverts if `merkleRoot` has not been anchored (forces the verifier
    ///      to call with a known root, not a guessed one).
    /// @param cidHash The leaf to verify.
    /// @param merkleRoot The anchored batch root.
    /// @param proof The Merkle proof (array of sibling hashes).
    /// @return True iff the proof reconstructs the root.
    function verifyInBatch(bytes32 cidHash, bytes32 merkleRoot, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        require(batchExists[merkleRoot], "no such batch");
        bytes32 computed = cidHash;
        uint256 len = proof.length;
        for (uint256 i = 0; i < len; ++i) {
            bytes32 p = proof[i];
            computed = computed < p
                ? keccak256(abi.encodePacked(computed, p))
                : keccak256(abi.encodePacked(p, computed));
        }
        return computed == merkleRoot;
    }
}
