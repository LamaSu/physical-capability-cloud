// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Anchor
 * @notice Daily Merkle-root anchor for the PCC centralized transparency log.
 *
 * Once per period (default daily), an authorized anchorer submits the current
 * Merkle root of the off-chain receipt log along with the batch size at the
 * time of composition. The contract stores the (timestamp, root, batchSize,
 * anchorer) tuple under a monotonically increasing index.
 *
 * Reference: Certificate Transparency (RFC 6962) — anchor entry replaces the
 * "STH (Signed Tree Head)" role for tamper-evidence.
 *
 * Access:
 *  - Only the configured `anchorer` address may call `anchor(...)`.
 *  - The owner may rotate the anchorer.
 *
 * Cost: one SSTORE per record + one event emit. ~25-50k gas on Base.
 *
 * Non-goals:
 *  - The contract does not validate the off-chain log itself; that is the
 *    monitor/witness's job.
 *  - It does not authenticate the Merkle root cryptographically; trust is
 *    rooted in the anchorer's signing key off-chain.
 */
contract Anchor {
    // ── Types ────────────────────────────────────────────────────────────

    /// @notice Lifecycle event identifiers (currently only one — reserved for forward compat).
    enum AnchorEvent {
        LogRootAnchored
    }

    struct AnchorRecord {
        uint256 timestamp;
        bytes32 merkleRoot;
        uint256 batchSize;
        address anchorer;
    }

    // ── State ────────────────────────────────────────────────────────────

    /// @notice Contract owner — can rotate the anchorer address.
    address public owner;
    /// @notice Address authorized to call `anchor(...)`.
    address public anchorer;
    /// @notice Auto-incrementing index for the next anchor record.
    uint256 public nextAnchorIndex;
    /// @notice index → record
    mapping(uint256 => AnchorRecord) public anchors;

    // ── Events ───────────────────────────────────────────────────────────

    event LogRootAnchored(
        uint256 indexed index,
        bytes32 indexed merkleRoot,
        uint256 batchSize,
        address indexed anchorer,
        uint256 timestamp
    );

    event AnchorerRotated(address indexed previousAnchorer, address indexed newAnchorer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ── Errors ───────────────────────────────────────────────────────────

    error NotOwner();
    error NotAnchorer();
    error ZeroAddress();
    error AnchorIndexOutOfRange(uint256 requested, uint256 total);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAnchorer() {
        if (msg.sender != anchorer) revert NotAnchorer();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(address _owner, address _anchorer) {
        if (_owner == address(0) || _anchorer == address(0)) revert ZeroAddress();
        owner = _owner;
        anchorer = _anchorer;
    }

    // ── Anchor ───────────────────────────────────────────────────────────

    /**
     * @notice Append a new Merkle-root anchor record.
     * @param merkleRoot The 32-byte SHA-256 Merkle root of the receipt log
     *                   at the moment of composition.
     * @param batchSize  The number of leaves in the tree at composition time.
     * @return index     The 0-based index assigned to this record.
     */
    function anchor(bytes32 merkleRoot, uint256 batchSize)
        external
        onlyAnchorer
        returns (uint256 index)
    {
        index = nextAnchorIndex;
        unchecked {
            nextAnchorIndex = index + 1;
        }

        anchors[index] = AnchorRecord({
            timestamp: block.timestamp,
            merkleRoot: merkleRoot,
            batchSize: batchSize,
            anchorer: msg.sender
        });

        emit LogRootAnchored(index, merkleRoot, batchSize, msg.sender, block.timestamp);
    }

    // ── Admin ────────────────────────────────────────────────────────────

    /**
     * @notice Rotate the anchorer to a new address (owner-only).
     */
    function rotateAnchorer(address newAnchorer) external onlyOwner {
        if (newAnchorer == address(0)) revert ZeroAddress();
        emit AnchorerRotated(anchorer, newAnchorer);
        anchorer = newAnchorer;
    }

    /**
     * @notice Transfer ownership (owner-only). Pass address(0) intentionally to
     *         renounce — no zero-check on this path so renunciation is allowed.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── Views ────────────────────────────────────────────────────────────

    /**
     * @notice Read a record by index. Reverts if `index >= nextAnchorIndex`.
     */
    function getAnchor(uint256 index) external view returns (AnchorRecord memory) {
        if (index >= nextAnchorIndex) {
            revert AnchorIndexOutOfRange(index, nextAnchorIndex);
        }
        return anchors[index];
    }

    /**
     * @notice Total number of anchors stored.
     */
    function totalAnchors() external view returns (uint256) {
        return nextAnchorIndex;
    }
}
