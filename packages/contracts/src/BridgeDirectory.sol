// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title BridgeDirectory
 * @notice Authoritative on-chain registry of bridge implementations consumable
 *         by the PCC agent network. Maps a kebab-case bridge namespace (hashed
 *         to bytes32) to a {BridgeEntry} record describing how to use it.
 *
 *         Companion off-chain package: pcc/bridge-directory.
 *         Design doc: ai/research/bridge-directory-contract-spec-2026-05-26.md.
 *
 * Write access:
 *   - {addBridge}            — owner only
 *   - {updateBridge}         — maintainer-or-owner
 *   - {deprecateBridge}      — maintainer-or-owner
 *   - {suspendBridge}        — maintainer-or-owner
 *   - {reactivateBridge}     — owner only
 *   - {transferMaintainer}   — current maintainer only
 *
 * Storage / enumeration:
 *   - `_bridges`     — primary mapping (hot path)
 *   - `_exists`      — existence flag (distinguishes zero-default from missing)
 *   - `_namespaces`  — insertion-order array for enumeration (never shrinks)
 *
 * Error policy: custom errors throughout (no require-strings) for
 * gas efficiency and typed off-chain decoding.
 */
contract BridgeDirectory is Ownable2Step {
    // ── Types ────────────────────────────────────────────────────────────

    /// @notice Lifecycle status of a bridge entry.
    /// @dev    Active is the default for new adds.
    ///         Suspended ↔ Active is reversible (security incident handling).
    ///         Deprecated is terminal (entry preserved for history; never returns).
    enum Status {
        Active,
        Deprecated,
        Suspended
    }

    /// @notice Single bridge directory record.
    /// @dev Field order is intentional for storage-slot packing.
    ///      Slot 0: namespace             (bytes32)
    ///      Slot 1: maintainerAddress(20) + status(1) + addedAt(5) + updatedAt(5) — 1 byte free
    ///      Slot 2: repoUrl               (string header)
    ///      Slot 3: docsUrl               (string header)
    ///      Slot 4: contractAddress(20)   + chainId(8) — 4 bytes free
    ///      Slot 5: version               (bytes32 — semver as right-padded ASCII)
    ///      Slot 6: metadataURI           (string header)
    ///      Slot 7: notes                 (string header)
    struct BridgeEntry {
        bytes32 namespace; // SLOT 0
        address maintainerAddress; // SLOT 1 (20 bytes)
        Status status; // SLOT 1 (1 byte)
        uint40 addedAt; // SLOT 1 (5 bytes)
        uint40 updatedAt; // SLOT 1 (5 bytes) — 1 byte free
        string repoUrl; // SLOT 2
        string docsUrl; // SLOT 3
        address contractAddress; // SLOT 4 (20 bytes)
        uint64 chainId; // SLOT 4 (8 bytes) — 4 bytes free
        bytes32 version; // SLOT 5
        string metadataURI; // SLOT 6
        string notes; // SLOT 7
    }

    // ── Errors ───────────────────────────────────────────────────────────

    error BridgeNotFound(bytes32 namespace);
    error BridgeAlreadyExists(bytes32 namespace);
    error NotMaintainerOrOwner(address caller, bytes32 namespace);
    error NotMaintainer(address caller, bytes32 namespace);
    error ZeroNamespace();
    error ZeroAddress();
    error EmptyRepoUrl();
    error MustAddAsActive();
    error AlreadyInStatus(Status current);
    error InvalidStatusTransition(Status from, Status to);
    error SameMaintainer();
    error TooManyForFullReturn(uint256 count, uint256 max);

    // ── Events ───────────────────────────────────────────────────────────

    event BridgeAdded(bytes32 indexed namespace, address indexed maintainer, string repoUrl);
    event BridgeUpdated(bytes32 indexed namespace, address indexed updater);
    event BridgeDeprecated(bytes32 indexed namespace);
    event BridgeSuspended(bytes32 indexed namespace);
    event BridgeReactivated(bytes32 indexed namespace);
    event MaintainerTransferred(
        bytes32 indexed namespace, address indexed oldMaintainer, address indexed newMaintainer
    );

    // ── Constants ────────────────────────────────────────────────────────

    /// @notice Maximum entries returnable by {getAllBridges} in one call.
    uint256 public constant MAX_FULL_RETURN = 25;

    /// @notice Maximum page size accepted by paginated views.
    uint256 public constant MAX_PAGE_SIZE = 50;

    // ── Storage ──────────────────────────────────────────────────────────

    mapping(bytes32 => BridgeEntry) private _bridges;
    mapping(bytes32 => bool) private _exists;
    bytes32[] private _namespaces;

    // ── Constructor ──────────────────────────────────────────────────────

    /// @param initialOwner Address that will own the directory at deploy time.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ── Modifiers ────────────────────────────────────────────────────────

    /// @notice Restricts to either the entry's current maintainer or the contract owner.
    modifier onlyMaintainerOrOwner(bytes32 namespace) {
        if (!_exists[namespace]) revert BridgeNotFound(namespace);
        if (msg.sender != _bridges[namespace].maintainerAddress && msg.sender != owner()) {
            revert NotMaintainerOrOwner(msg.sender, namespace);
        }
        _;
    }

    /// @notice Restricts to the entry's current maintainer ONLY (owner excluded).
    /// @dev    Used by {transferMaintainer} — owner has a separate forced path via {updateBridge}.
    modifier onlyMaintainerOf(bytes32 namespace) {
        if (!_exists[namespace]) revert BridgeNotFound(namespace);
        if (msg.sender != _bridges[namespace].maintainerAddress) {
            revert NotMaintainer(msg.sender, namespace);
        }
        _;
    }

    // ── Write API ────────────────────────────────────────────────────────

    /// @notice Add a new bridge entry. Owner only.
    /// @dev    `addedAt` and `updatedAt` are set to `block.timestamp` regardless of input.
    ///         New entries MUST be added in {Status.Active}.
    /// @param entry Fully-populated BridgeEntry. `namespace` is the primary key and must be non-zero.
    function addBridge(BridgeEntry calldata entry) external onlyOwner {
        if (entry.namespace == bytes32(0)) revert ZeroNamespace();
        if (entry.maintainerAddress == address(0)) revert ZeroAddress();
        if (bytes(entry.repoUrl).length == 0) revert EmptyRepoUrl();
        if (entry.status != Status.Active) revert MustAddAsActive();
        if (_exists[entry.namespace]) revert BridgeAlreadyExists(entry.namespace);

        BridgeEntry storage e = _bridges[entry.namespace];
        e.namespace = entry.namespace;
        e.maintainerAddress = entry.maintainerAddress;
        e.status = Status.Active;
        e.addedAt = uint40(block.timestamp);
        e.updatedAt = uint40(block.timestamp);
        e.repoUrl = entry.repoUrl;
        e.docsUrl = entry.docsUrl;
        e.contractAddress = entry.contractAddress;
        e.chainId = entry.chainId;
        e.version = entry.version;
        e.metadataURI = entry.metadataURI;
        e.notes = entry.notes;

        _exists[entry.namespace] = true;
        _namespaces.push(entry.namespace);

        emit BridgeAdded(entry.namespace, entry.maintainerAddress, entry.repoUrl);
    }

    /// @notice Update an existing bridge entry. Maintainer-or-owner only.
    /// @dev    `namespace` and `addedAt` are immutable. All other fields are overwritten.
    ///         A maintainer change here (vs. {transferMaintainer}) still emits
    ///         {MaintainerTransferred} so off-chain indexers see the lineage.
    /// @param namespace The bytes32 key.
    /// @param updates   Partial-replacement entry. The `namespace` and `addedAt` fields are ignored.
    function updateBridge(bytes32 namespace, BridgeEntry calldata updates)
        external
        onlyMaintainerOrOwner(namespace)
    {
        if (updates.maintainerAddress == address(0)) revert ZeroAddress();
        if (bytes(updates.repoUrl).length == 0) revert EmptyRepoUrl();

        BridgeEntry storage e = _bridges[namespace];
        address oldMaintainer = e.maintainerAddress;

        e.maintainerAddress = updates.maintainerAddress;
        e.status = updates.status;
        e.repoUrl = updates.repoUrl;
        e.docsUrl = updates.docsUrl;
        e.contractAddress = updates.contractAddress;
        e.chainId = updates.chainId;
        e.version = updates.version;
        e.metadataURI = updates.metadataURI;
        e.notes = updates.notes;
        e.updatedAt = uint40(block.timestamp);
        // namespace and addedAt are intentionally NOT overwritten

        emit BridgeUpdated(namespace, msg.sender);

        if (updates.maintainerAddress != oldMaintainer) {
            emit MaintainerTransferred(namespace, oldMaintainer, updates.maintainerAddress);
        }
    }

    /// @notice Mark an entry as {Status.Deprecated}. Maintainer-or-owner only.
    /// @dev    Deprecate is terminal: a deprecated entry is preserved for history
    ///         but cannot be reactivated via {reactivateBridge}.
    /// @param namespace The bytes32 key.
    function deprecateBridge(bytes32 namespace) external onlyMaintainerOrOwner(namespace) {
        BridgeEntry storage e = _bridges[namespace];
        if (e.status == Status.Deprecated) revert AlreadyInStatus(Status.Deprecated);
        e.status = Status.Deprecated;
        e.updatedAt = uint40(block.timestamp);
        emit BridgeDeprecated(namespace);
    }

    /// @notice Mark an entry as {Status.Suspended}. Maintainer-or-owner only.
    /// @dev    Only Active entries may be suspended. Suspend is reversible via
    ///         owner-only {reactivateBridge}.
    /// @param namespace The bytes32 key.
    function suspendBridge(bytes32 namespace) external onlyMaintainerOrOwner(namespace) {
        BridgeEntry storage e = _bridges[namespace];
        if (e.status != Status.Active) revert InvalidStatusTransition(e.status, Status.Suspended);
        e.status = Status.Suspended;
        e.updatedAt = uint40(block.timestamp);
        emit BridgeSuspended(namespace);
    }

    /// @notice Reactivate a Suspended entry. Owner only.
    /// @dev    Asymmetry is intentional: suspension is typically a security
    ///         incident, so resumption requires the deployer/governance authority.
    /// @param namespace The bytes32 key.
    function reactivateBridge(bytes32 namespace) external onlyOwner {
        if (!_exists[namespace]) revert BridgeNotFound(namespace);
        BridgeEntry storage e = _bridges[namespace];
        if (e.status != Status.Suspended) revert InvalidStatusTransition(e.status, Status.Active);
        e.status = Status.Active;
        e.updatedAt = uint40(block.timestamp);
        emit BridgeReactivated(namespace);
    }

    /// @notice Transfer maintainership of one entry. Current maintainer ONLY.
    /// @dev    Owner CANNOT call this — owner uses {updateBridge} to force a
    ///         maintainer change. This split keeps voluntary hand-offs clearly
    ///         distinct from owner-forced takeovers in the event log.
    /// @param namespace      The bytes32 key.
    /// @param newMaintainer  Non-zero address to become the new maintainer.
    function transferMaintainer(bytes32 namespace, address newMaintainer)
        external
        onlyMaintainerOf(namespace)
    {
        if (newMaintainer == address(0)) revert ZeroAddress();
        BridgeEntry storage e = _bridges[namespace];
        address oldMaintainer = e.maintainerAddress;
        if (newMaintainer == oldMaintainer) revert SameMaintainer();
        e.maintainerAddress = newMaintainer;
        e.updatedAt = uint40(block.timestamp);
        emit MaintainerTransferred(namespace, oldMaintainer, newMaintainer);
    }

    // ── Read API ─────────────────────────────────────────────────────────

    /// @notice Get the full BridgeEntry for a namespace.
    /// @dev    Returns a zero-initialized struct if the namespace was never added.
    ///         Callers should use {exists} (or check `entry.namespace == bytes32(0)`)
    ///         to distinguish "missing" from "zero-default value".
    /// @param namespace The bytes32 key.
    /// @return The BridgeEntry (zero-initialized if not present).
    function getBridge(bytes32 namespace) external view returns (BridgeEntry memory) {
        return _bridges[namespace];
    }

    /// @notice Has this namespace been added?
    function exists(bytes32 namespace) external view returns (bool) {
        return _exists[namespace];
    }

    /// @notice Total entries ever added (includes Deprecated and Suspended).
    function getBridgeCount() external view returns (uint256) {
        return _namespaces.length;
    }

    /// @notice Return ALL entries in one call. Bounded by {MAX_FULL_RETURN}.
    /// @dev    Reverts with {TooManyForFullReturn} when count exceeds the cap.
    ///         Use {getBridgesPaginated} for larger sets.
    function getAllBridges() external view returns (BridgeEntry[] memory out) {
        uint256 n = _namespaces.length;
        if (n > MAX_FULL_RETURN) revert TooManyForFullReturn(n, MAX_FULL_RETURN);
        out = new BridgeEntry[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _bridges[_namespaces[i]];
        }
    }

    /// @notice Cursor-paginated entry read.
    /// @dev    `limit` is clamped at {MAX_PAGE_SIZE}. If `offset >= count` returns
    ///         an empty slice with `nextOffset = count` (consumers loop until
    ///         `entries.length == 0`).
    /// @param offset Starting index in insertion order.
    /// @param limit  Maximum number of entries to return (clamped to MAX_PAGE_SIZE).
    /// @return entries     Slice of entries.
    /// @return nextOffset  Next cursor (either `offset + entries.length` or `count` when exhausted).
    function getBridgesPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (BridgeEntry[] memory entries, uint256 nextOffset)
    {
        uint256 n = _namespaces.length;
        if (offset >= n) {
            return (new BridgeEntry[](0), n);
        }
        uint256 capped = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + capped;
        if (end > n) end = n;
        uint256 len = end - offset;
        entries = new BridgeEntry[](len);
        for (uint256 i; i < len; ++i) {
            entries[i] = _bridges[_namespaces[offset + i]];
        }
        nextOffset = end;
    }

    /// @notice List namespaces with cursor pagination (lightweight enumeration).
    /// @dev    Returns only the bytes32 keys, not full entries — useful when the
    ///         consumer plans to lazy-load specific entries via {getBridge}.
    function getNamespacesPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory namespaces, uint256 nextOffset)
    {
        uint256 n = _namespaces.length;
        if (offset >= n) {
            return (new bytes32[](0), n);
        }
        uint256 capped = limit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : limit;
        uint256 end = offset + capped;
        if (end > n) end = n;
        uint256 len = end - offset;
        namespaces = new bytes32[](len);
        for (uint256 i; i < len; ++i) {
            namespaces[i] = _namespaces[offset + i];
        }
        nextOffset = end;
    }

    /// @notice Return only entries with {Status.Active}.
    /// @dev    Iterates `_namespaces` — O(n). Off-chain consumers should prefer
    ///         indexer-side filtering for large directories.
    function getActiveBridges() external view returns (BridgeEntry[] memory out) {
        uint256 n = _namespaces.length;
        // First pass: count active entries
        uint256 active;
        for (uint256 i; i < n; ++i) {
            if (_bridges[_namespaces[i]].status == Status.Active) {
                unchecked {
                    active += 1;
                }
            }
        }
        out = new BridgeEntry[](active);
        // Second pass: populate
        uint256 idx;
        for (uint256 i; i < n; ++i) {
            BridgeEntry storage e = _bridges[_namespaces[i]];
            if (e.status == Status.Active) {
                out[idx] = e;
                unchecked {
                    idx += 1;
                }
            }
        }
    }
}
