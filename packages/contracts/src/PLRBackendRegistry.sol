// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleTags} from "./RoleTags.sol";

/// @dev Minimal view-only interface to ContributorNFT. Registry queries
///      `ownerOf(tokenId)` and `dataOf(tokenId)` to bind authorship to the
///      backend-author NFT. We never write to ContributorNFT.
interface IContributorNFT {
    struct ContribTokenData {
        bytes32 role;
        bytes32 scheduleHash;
        bytes32 ipId;
        string metadataUri;
        uint64 mintedAt;
    }

    function ownerOf(uint256 tokenId) external view returns (address);
    function dataOf(uint256 tokenId)
        external
        view
        returns (
            bytes32 role,
            bytes32 scheduleHash,
            bytes32 ipId,
            string memory metadataUri,
            uint64 mintedAt
        );
}

/// @dev Minimal view-only interface to RateScheduleRegistry. The schedule
///      MUST be published BEFORE the backend can be registered.
interface IRateScheduleRegistry {
    function exists(bytes32 scheduleHash) external view returns (bool);
}

/**
 * @title  PLRBackendRegistry
 * @notice On-chain authorship registry for PyLabRobot backends executed
 *         through @pcc/adapter-pylabrobot.
 *
 *         Each entry maps a UTF-8 PLR module path (e.g.
 *         "pylabrobot.liquid_handling.backends.hamilton.STAR") to a
 *         BackendRecord describing the backing ContributorNFT, the
 *         published rate schedule (sha256 hash), an optional delegated
 *         agent id, the off-chain manifest CID, and the current enabled
 *         state.
 *
 *         Authorship resolution lives in ContributorNFT.ownerOf(tokenId).
 *         This contract holds NO `authorAddress` field of its own — the
 *         author IS whoever currently owns the BACKEND_AUTHOR NFT. This
 *         makes transferring the NFT (via ERC-721 transferFrom) the
 *         canonical way to "transfer authorship" for routine handoffs;
 *         the on-chain helpers below provide TIMELOCKED transfers (14
 *         days) for the explicit "I am intentionally handing off
 *         maintainership of this module" flow that needs a
 *         compromise-recovery window.
 *
 *         Architecture (per ai/scoping/plr-backend-author-economics-2026-05-25.md
 *         + ai/scoping/plr-answers-validation-2026-05-25.md):
 *
 *         - 14-day authorship transfer timelock (Q5 override)
 *         - 30-day governance recovery attestation window (Q6)
 *         - Forward-only kill switch (Q7) — assertEnabled() reverts when
 *           enabled is false; in-flight escrow continues
 *         - Public events with full author address (Q8)
 *         - 60-second min toggle interval to prevent grief loops
 *
 *         Out of scope for Phase 1:
 *         - ContributorNFT minting flow (callers mint separately, then
 *           pass the resulting tokenId to register())
 *         - Subgraph indexing (Phase 1 uses RPC eth_getLogs)
 *         - Per-author earnings dashboard (Phase 2)
 */
contract PLRBackendRegistry {
    // ── Types ────────────────────────────────────────────────────────────

    /**
     * @notice On-chain state for one registered PLR backend.
     *
     * @param scheduleHash        sha256 of the off-chain canonical-JSON
     *                            RateSchedule. Must exist in
     *                            RateScheduleRegistry at register-time.
     * @param delegatedAgentId    Phase 1: bytes32(uint256(uint160(address)))
     *                            of an EVM address authorized to flip
     *                            enabled on the author's behalf. Phase 2
     *                            (Q3 2026): ERC-8004 tokenId, same field
     *                            shape. bytes32(0) = no delegated agent.
     * @param manifestCid         CIDv1 raw multihash of the IPFS-pinned
     *                            signed BackendManifest. Mutable by author
     *                            via setManifestCid().
     * @param contributorTokenId  ContributorNFT tokenId minted with
     *                            role=BACKEND_AUTHOR. The registry queries
     *                            ContributorNFT.ownerOf(tokenId) to resolve
     *                            the current author address.
     * @param registeredAt        block.timestamp at register().
     * @param lastEnabledChange   block.timestamp of most recent
     *                            setEnabled() call.
     * @param enabled             True iff assertEnabled() succeeds.
     */
    struct BackendRecord {
        bytes32 scheduleHash;
        bytes32 delegatedAgentId;
        bytes32 manifestCid;
        uint256 contributorTokenId;
        uint64 registeredAt;
        uint64 lastEnabledChange;
        bool enabled;
    }

    /**
     * @notice Pending timelocked authorship transfer. The current author
     *         proposes a new tokenId-owner pair; the new owner can accept
     *         after AUTHORSHIP_TRANSFER_TIMELOCK_SECONDS elapses.
     *
     * @param newTokenId       Replacement ContributorNFT tokenId. The new
     *                         owner is whoever calls ownerOf(newTokenId)
     *                         at acceptance time.
     * @param effectiveAfter   Earliest block.timestamp at which
     *                         executeAuthorshipTransfer() may succeed.
     */
    struct PendingTransfer {
        uint256 newTokenId;
        uint64 effectiveAfter;
    }

    /**
     * @notice Pending governance recovery for a lost-wallet case. The
     *         governanceMultisig calls proposeRecovery() with a new
     *         tokenId; the recovery becomes claimable after
     *         RECOVERY_ATTESTATION_WINDOW_SECONDS to give the original
     *         author maximum time to surface if alive.
     *
     * @param newTokenId       Replacement ContributorNFT tokenId.
     * @param effectiveAfter   Earliest block.timestamp for claimRecovery().
     */
    struct PendingRecovery {
        uint256 newTokenId;
        uint64 effectiveAfter;
    }

    // ── Constants ────────────────────────────────────────────────────────

    /**
     * @notice 14-day timelock between proposeAuthorshipTransfer() and
     *         executeAuthorshipTransfer(). Per validated answer Q5 — the
     *         orchestrator originally proposed 7 days; the validator
     *         override picked 14 because authorship transfer is a
     *         unilateral non-quorum operation and the cost of waiting
     *         an extra week for a legitimate transfer is trivial vs. the
     *         cost of letting a stolen key complete a transfer in 7.
     */
    uint64 public constant AUTHORSHIP_TRANSFER_TIMELOCK_SECONDS =
        14 * 24 * 3600;

    /**
     * @notice 30-day attestation window between recoverAuthorship() and
     *         claimRecovery(). Per validated answer Q6 — gives the
     *         original author maximum time to surface if alive. Phase 1
     *         scope: just the contract hook (governance multisig
     *         deployment + attestation collection flow documented for
     *         later).
     */
    uint64 public constant RECOVERY_ATTESTATION_WINDOW_SECONDS =
        30 * 24 * 3600;

    /**
     * @notice Min seconds between setEnabled() flips per backend.
     *         Prevents an attacker who briefly controls the author wallet
     *         from oscillating enabled to grief operators.
     */
    uint64 public constant MIN_TOGGLE_INTERVAL = 60;

    /// @notice Max view-list pagination page size. Bounded to keep gas predictable.
    uint256 public constant MAX_LIST_PAGE = 256;

    // ── Immutable dependencies ──────────────────────────────────────────

    /// @notice Address of the deployed ContributorNFT. Immutable.
    address public immutable contributorNFT;

    /// @notice Address of the deployed RateScheduleRegistry. Immutable.
    address public immutable scheduleRegistry;

    /**
     * @notice Governance multisig allowed to call recoverAuthorship().
     *         Per Q6 — Phase 1 ships just the hook; multisig deployment +
     *         attestation flow are documented in PLR_BACKEND_AUTHORS.md
     *         for later. Address(0) disables recovery entirely.
     */
    address public immutable governanceMultisig;

    // ── State ───────────────────────────────────────────────────────────

    /// @notice keccak256(modulePath) → BackendRecord
    mapping(bytes32 => BackendRecord) public records;

    /// @notice keccak256(modulePath) → true iff a record exists. O(1) check.
    mapping(bytes32 => bool) public claimed;

    /// @notice All ever-claimed module path keys, for paginated enumeration.
    bytes32[] private _allModulePathKeys;

    /// @notice keccak256(modulePath) → PendingTransfer (or zero if none).
    mapping(bytes32 => PendingTransfer) public pendingTransfers;

    /// @notice keccak256(modulePath) → PendingRecovery (or zero if none).
    mapping(bytes32 => PendingRecovery) public pendingRecoveries;

    // ── Events ──────────────────────────────────────────────────────────

    /**
     * @notice Emitted at every successful register(). Public author address
     *         + module path are included verbatim per validated answer Q8
     *         (earnings privacy = public on-chain).
     */
    event BackendRegistered(
        bytes32 indexed modulePathKey,
        string modulePath,
        address indexed author,
        uint256 contributorTokenId,
        bytes32 scheduleHash,
        bytes32 delegatedAgentId,
        bytes32 manifestCid
    );

    /**
     * @notice Emitted at every successful setEnabled(). actor is msg.sender;
     *         distinct from the NFT owner if a delegated agent flipped.
     */
    event BackendEnabledChanged(
        bytes32 indexed modulePathKey,
        address indexed actor,
        bool enabled,
        uint64 changedAt
    );

    event ManifestCidUpdated(
        bytes32 indexed modulePathKey,
        bytes32 oldCid,
        bytes32 newCid
    );

    event ScheduleHashUpdated(
        bytes32 indexed modulePathKey,
        bytes32 oldScheduleHash,
        bytes32 newScheduleHash
    );

    event DelegatedAgentUpdated(
        bytes32 indexed modulePathKey,
        bytes32 oldAgentId,
        bytes32 newAgentId
    );

    event AuthorshipTransferProposed(
        bytes32 indexed modulePathKey,
        address indexed proposer,
        uint256 newTokenId,
        uint64 effectiveAfter
    );

    event AuthorshipTransferred(
        bytes32 indexed modulePathKey,
        address indexed oldAuthor,
        address indexed newAuthor,
        uint256 oldTokenId,
        uint256 newTokenId
    );

    event RecoveryProposed(
        bytes32 indexed modulePathKey,
        uint256 newTokenId,
        uint64 effectiveAfter
    );

    event RecoveryClaimed(
        bytes32 indexed modulePathKey,
        address indexed newAuthor,
        uint256 oldTokenId,
        uint256 newTokenId
    );

    // ── Errors ──────────────────────────────────────────────────────────

    error AlreadyClaimed();
    error NotClaimed();
    error EmptyModulePath();
    error ScheduleNotRegistered();
    error TokenIdRoleMismatch();
    error UnauthorizedActor();
    error TogglingTooFast();
    error BackendDisabled();
    error TransferAlreadyPending();
    error TransferNotReady();
    error NoPendingTransfer();
    error NotGovernance();
    error RecoveryAlreadyPending();
    error RecoveryNotReady();
    error NoPendingRecovery();
    error InvalidPageSize();

    // ── Constructor ─────────────────────────────────────────────────────

    /**
     * @param _contributorNFT      Deployed ContributorNFT address.
     * @param _scheduleRegistry    Deployed RateScheduleRegistry address.
     * @param _governanceMultisig  Governance address allowed to call
     *                             recoverAuthorship(). Address(0) disables
     *                             the recovery path entirely.
     */
    constructor(
        address _contributorNFT,
        address _scheduleRegistry,
        address _governanceMultisig
    ) {
        require(_contributorNFT != address(0), "Zero ContributorNFT");
        require(_scheduleRegistry != address(0), "Zero ScheduleRegistry");
        contributorNFT = _contributorNFT;
        scheduleRegistry = _scheduleRegistry;
        governanceMultisig = _governanceMultisig;
    }

    // ── Registration ────────────────────────────────────────────────────

    /**
     * @notice Claim attribution for a PLR module path.
     * @dev    Permissionless. First-mover wins. The caller MUST:
     *           - Own (or be approved on) ContributorNFT.ownerOf(tokenId)
     *           - Have minted that tokenId with role=BACKEND_AUTHOR
     *           - Have already published `scheduleHash` to
     *             RateScheduleRegistry
     *
     *         The dashboard onboarding flow verifies the module path
     *         resolves to a real Backend subclass in pylabrobot.* via the
     *         GitHub API — this contract has no oracle and trusts the
     *         caller for that claim. CID tampering is benign because the
     *         on-chain author identity is derived from
     *         ContributorNFT.ownerOf(), not from the off-chain manifest.
     */
    function register(
        string calldata modulePath,
        uint256 contributorTokenId,
        bytes32 scheduleHash,
        bytes32 delegatedAgentId,
        bytes32 manifestCid
    ) external returns (bytes32 modulePathKey) {
        bytes memory pathBytes = bytes(modulePath);
        if (pathBytes.length == 0) revert EmptyModulePath();
        modulePathKey = keccak256(pathBytes);
        if (claimed[modulePathKey]) revert AlreadyClaimed();

        // The schedule must be published before any backend can reference it.
        if (!IRateScheduleRegistry(scheduleRegistry).exists(scheduleHash)) {
            revert ScheduleNotRegistered();
        }

        // The caller must hold the BACKEND_AUTHOR token they're claiming with.
        address author = IContributorNFT(contributorNFT).ownerOf(
            contributorTokenId
        );
        if (msg.sender != author) revert UnauthorizedActor();

        // The token MUST carry the BACKEND_AUTHOR role tag. Reading dataOf()
        // here ensures the registry can't be back-doored by mis-roled NFTs.
        (bytes32 tokenRole, , , , ) = IContributorNFT(contributorNFT).dataOf(
            contributorTokenId
        );
        if (tokenRole != RoleTags.BACKEND_AUTHOR) revert TokenIdRoleMismatch();

        records[modulePathKey] = BackendRecord({
            scheduleHash: scheduleHash,
            delegatedAgentId: delegatedAgentId,
            manifestCid: manifestCid,
            contributorTokenId: contributorTokenId,
            registeredAt: uint64(block.timestamp),
            lastEnabledChange: uint64(block.timestamp),
            enabled: true
        });
        claimed[modulePathKey] = true;
        _allModulePathKeys.push(modulePathKey);

        emit BackendRegistered(
            modulePathKey,
            modulePath,
            author,
            contributorTokenId,
            scheduleHash,
            delegatedAgentId,
            manifestCid
        );
    }

    // ── Kill-switch ─────────────────────────────────────────────────────

    /**
     * @notice Flip the enabled flag. Forward-only per validated answer Q7:
     *         setEnabled(false) blocks NEW assertEnabled() calls but does
     *         NOT cancel in-flight escrow. Operators should handle
     *         "backend disabled" as a graceful error and complete any
     *         in-flight job under existing rules.
     *
     *         Authorization: the current NFT owner (author) OR the
     *         delegated agent address (if set).
     */
    function setEnabled(bytes32 modulePathKey, bool enabled) external {
        if (!claimed[modulePathKey]) revert NotClaimed();
        BackendRecord storage r = records[modulePathKey];
        if (block.timestamp < r.lastEnabledChange + MIN_TOGGLE_INTERVAL) {
            revert TogglingTooFast();
        }
        _requireAuthorOrAgent(r);

        r.enabled = enabled;
        r.lastEnabledChange = uint64(block.timestamp);
        emit BackendEnabledChanged(
            modulePathKey,
            msg.sender,
            enabled,
            uint64(block.timestamp)
        );
    }

    /**
     * @notice Update the IPFS manifest CID. NFT owner or delegated agent.
     *         The scheduleHash and authorship are NOT touched by this call.
     */
    function setManifestCid(bytes32 modulePathKey, bytes32 newCid) external {
        if (!claimed[modulePathKey]) revert NotClaimed();
        BackendRecord storage r = records[modulePathKey];
        _requireAuthorOrAgent(r);
        bytes32 oldCid = r.manifestCid;
        r.manifestCid = newCid;
        emit ManifestCidUpdated(modulePathKey, oldCid, newCid);
    }

    /**
     * @notice Update the scheduleHash. NFT OWNER ONLY (NOT the agent) —
     *         changing the payout curve is a higher-trust operation than
     *         flipping enabled. New scheduleHash must already be published
     *         in RateScheduleRegistry.
     */
    function setScheduleHash(bytes32 modulePathKey, bytes32 newScheduleHash)
        external
    {
        if (!claimed[modulePathKey]) revert NotClaimed();
        BackendRecord storage r = records[modulePathKey];
        if (msg.sender != _currentAuthor(r)) revert UnauthorizedActor();
        if (!IRateScheduleRegistry(scheduleRegistry).exists(newScheduleHash)) {
            revert ScheduleNotRegistered();
        }
        bytes32 oldScheduleHash = r.scheduleHash;
        r.scheduleHash = newScheduleHash;
        emit ScheduleHashUpdated(modulePathKey, oldScheduleHash, newScheduleHash);
    }

    /**
     * @notice Update the delegated agent. NFT owner only.
     *         Pass bytes32(0) to clear the delegation.
     */
    function setDelegatedAgent(bytes32 modulePathKey, bytes32 newAgentId)
        external
    {
        if (!claimed[modulePathKey]) revert NotClaimed();
        BackendRecord storage r = records[modulePathKey];
        if (msg.sender != _currentAuthor(r)) revert UnauthorizedActor();
        bytes32 oldAgentId = r.delegatedAgentId;
        r.delegatedAgentId = newAgentId;
        emit DelegatedAgentUpdated(modulePathKey, oldAgentId, newAgentId);
    }

    // ── Authorship transfer (timelocked) ────────────────────────────────

    /**
     * @notice Propose an authorship transfer to a new ContributorNFT.
     *         Initiates the 14-day timelock (per Q5). The current NFT
     *         owner can cancel by passing newTokenId == 0.
     */
    function proposeAuthorshipTransfer(
        bytes32 modulePathKey,
        uint256 newTokenId
    ) external {
        if (!claimed[modulePathKey]) revert NotClaimed();
        BackendRecord storage r = records[modulePathKey];
        address currentAuthor = _currentAuthor(r);
        if (msg.sender != currentAuthor) revert UnauthorizedActor();

        PendingTransfer storage p = pendingTransfers[modulePathKey];
        if (newTokenId == 0) {
            // Cancellation.
            delete pendingTransfers[modulePathKey];
            emit AuthorshipTransferProposed(
                modulePathKey,
                currentAuthor,
                0,
                0
            );
            return;
        }
        if (p.newTokenId != 0) revert TransferAlreadyPending();

        // Validate newTokenId carries BACKEND_AUTHOR role too.
        (bytes32 newTokenRole, , , , ) = IContributorNFT(contributorNFT)
            .dataOf(newTokenId);
        if (newTokenRole != RoleTags.BACKEND_AUTHOR) revert TokenIdRoleMismatch();

        p.newTokenId = newTokenId;
        p.effectiveAfter =
            uint64(block.timestamp) +
            AUTHORSHIP_TRANSFER_TIMELOCK_SECONDS;
        emit AuthorshipTransferProposed(
            modulePathKey,
            currentAuthor,
            newTokenId,
            p.effectiveAfter
        );
    }

    /**
     * @notice Execute the pending authorship transfer after the 14-day
     *         timelock. The new author MUST own the proposed tokenId at
     *         execution time (so callers can pre-mint and transfer the
     *         NFT to the receiving address before the timelock elapses).
     */
    function executeAuthorshipTransfer(bytes32 modulePathKey) external {
        if (!claimed[modulePathKey]) revert NotClaimed();
        PendingTransfer storage p = pendingTransfers[modulePathKey];
        if (p.newTokenId == 0) revert NoPendingTransfer();
        if (block.timestamp < p.effectiveAfter) revert TransferNotReady();

        BackendRecord storage r = records[modulePathKey];
        uint256 oldTokenId = r.contributorTokenId;
        address oldAuthor = _currentAuthor(r);
        address newAuthor = IContributorNFT(contributorNFT).ownerOf(p.newTokenId);

        // Anyone can crank the transfer once the timelock matures — we
        // gate on the timelock + the NFT ownership at execute time, not
        // on msg.sender. This avoids the new owner being stuck if they
        // forget to call execute themselves.

        r.contributorTokenId = p.newTokenId;
        // Schedule + manifest survive the transfer; agent delegation
        // resets to none (the new owner can re-establish it).
        r.delegatedAgentId = bytes32(0);
        delete pendingTransfers[modulePathKey];

        emit AuthorshipTransferred(
            modulePathKey,
            oldAuthor,
            newAuthor,
            oldTokenId,
            p.newTokenId
        );
    }

    // ── Lost-wallet recovery (governance-gated, 30-day window) ──────────

    /**
     * @notice Governance proposes a recovery to a new ContributorNFT.
     *         Initiates the 30-day attestation window per Q6. The actual
     *         multisig deployment and off-chain attestation collection
     *         flow are documented in PLR_BACKEND_AUTHORS.md; this contract
     *         just exposes the hook.
     */
    function recoverAuthorship(bytes32 modulePathKey, uint256 newTokenId)
        external
    {
        if (msg.sender != governanceMultisig) revert NotGovernance();
        if (!claimed[modulePathKey]) revert NotClaimed();
        if (newTokenId == 0) {
            // Cancellation.
            delete pendingRecoveries[modulePathKey];
            emit RecoveryProposed(modulePathKey, 0, 0);
            return;
        }
        if (pendingRecoveries[modulePathKey].newTokenId != 0) {
            revert RecoveryAlreadyPending();
        }

        // Validate newTokenId carries BACKEND_AUTHOR role.
        (bytes32 newTokenRole, , , , ) = IContributorNFT(contributorNFT)
            .dataOf(newTokenId);
        if (newTokenRole != RoleTags.BACKEND_AUTHOR) revert TokenIdRoleMismatch();

        pendingRecoveries[modulePathKey] = PendingRecovery({
            newTokenId: newTokenId,
            effectiveAfter: uint64(block.timestamp) +
                RECOVERY_ATTESTATION_WINDOW_SECONDS
        });
        emit RecoveryProposed(
            modulePathKey,
            newTokenId,
            uint64(block.timestamp) + RECOVERY_ATTESTATION_WINDOW_SECONDS
        );
    }

    /**
     * @notice Claim the pending recovery after the 30-day window. Anyone
     *         can crank — same logic as executeAuthorshipTransfer().
     */
    function claimRecovery(bytes32 modulePathKey) external {
        if (!claimed[modulePathKey]) revert NotClaimed();
        PendingRecovery storage p = pendingRecoveries[modulePathKey];
        if (p.newTokenId == 0) revert NoPendingRecovery();
        if (block.timestamp < p.effectiveAfter) revert RecoveryNotReady();

        BackendRecord storage r = records[modulePathKey];
        uint256 oldTokenId = r.contributorTokenId;
        address newAuthor = IContributorNFT(contributorNFT).ownerOf(p.newTokenId);

        r.contributorTokenId = p.newTokenId;
        r.delegatedAgentId = bytes32(0);
        delete pendingRecoveries[modulePathKey];

        emit RecoveryClaimed(modulePathKey, newAuthor, oldTokenId, p.newTokenId);
    }

    // ── Views ───────────────────────────────────────────────────────────

    /**
     * @notice Reverts with BackendDisabled if the backend is registered
     *         and enabled=false. Used by the aggregator before forwarding
     *         a job to the PLR sidecar. Unregistered backends pass through
     *         (this lets the aggregator default-allow when the registry is
     *         empty during the rollout window).
     */
    function assertEnabled(string calldata modulePath) external view {
        bytes32 key = keccak256(bytes(modulePath));
        if (!claimed[key]) return;
        if (!records[key].enabled) revert BackendDisabled();
    }

    /**
     * @notice Read-only convenience: true iff the module is registered AND
     *         enabled. False for unregistered OR explicitly disabled.
     */
    function isEnabled(string calldata modulePath) external view returns (bool) {
        bytes32 key = keccak256(bytes(modulePath));
        return claimed[key] && records[key].enabled;
    }

    /**
     * @notice Full record by module path string. Returns zero-valued
     *         struct if the module isn't registered (caller should pair
     *         with `claimed[keccak256(bytes(path))]` to disambiguate).
     */
    function getRecord(string calldata modulePath)
        external
        view
        returns (BackendRecord memory)
    {
        return records[keccak256(bytes(modulePath))];
    }

    /**
     * @notice Resolve the current author address by reading
     *         ContributorNFT.ownerOf(record.contributorTokenId). Reverts
     *         if the module isn't registered.
     */
    function authorOf(string calldata modulePath)
        external
        view
        returns (address)
    {
        bytes32 key = keccak256(bytes(modulePath));
        if (!claimed[key]) revert NotClaimed();
        return IContributorNFT(contributorNFT).ownerOf(
            records[key].contributorTokenId
        );
    }

    /// @notice Total number of ever-claimed backends.
    function totalBackends() external view returns (uint256) {
        return _allModulePathKeys.length;
    }

    /**
     * @notice Paginated enumeration of all module-path keys, including
     *         disabled ones. Off-chain indexers reconstruct the full
     *         path string from the BackendRegistered event log. Bounded
     *         by MAX_LIST_PAGE per call.
     */
    function listAllModulePathKeys(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page)
    {
        if (limit == 0 || limit > MAX_LIST_PAGE) revert InvalidPageSize();
        uint256 total = _allModulePathKeys.length;
        if (offset >= total) {
            return new bytes32[](0);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 size = end - offset;
        page = new bytes32[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = _allModulePathKeys[offset + i];
        }
    }

    /**
     * @notice Filtered enumeration: only currently-enabled backends.
     *         Walks `listAllModulePathKeys(offset, limit)` and skips
     *         disabled entries. Gas-bounded by MAX_LIST_PAGE.
     */
    function listEnabled(uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory keys)
    {
        if (limit == 0 || limit > MAX_LIST_PAGE) revert InvalidPageSize();
        uint256 total = _allModulePathKeys.length;
        if (offset >= total) {
            return new bytes32[](0);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 windowSize = end - offset;

        // First pass: count enabled entries in the window.
        uint256 count = 0;
        for (uint256 i = 0; i < windowSize; ++i) {
            bytes32 k = _allModulePathKeys[offset + i];
            if (records[k].enabled) ++count;
        }

        // Second pass: fill the result array.
        keys = new bytes32[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < windowSize; ++i) {
            bytes32 k = _allModulePathKeys[offset + i];
            if (records[k].enabled) {
                keys[j++] = k;
            }
        }
    }

    /**
     * @notice Compute the deterministic ipId for a PLR backend per the
     *         validated-answer Q10 rule:
     *           ipId = keccak256(abi.encodePacked("pylabrobot:", modulePath, ":", majorVersion))
     *
     *         Pure helper — does not touch storage. Authors (or the
     *         dashboard onboarding flow) call this once before minting
     *         the ContributorNFT to stamp `ipId` consistently across
     *         on-chain + off-chain references.
     */
    function deriveIpId(string calldata modulePath, uint8 majorVersion)
        external
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encodePacked(
                    "pylabrobot:",
                    modulePath,
                    ":",
                    majorVersion
                )
            );
    }

    // ── Internals ───────────────────────────────────────────────────────

    /**
     * @dev Resolves the current author address from
     *      ContributorNFT.ownerOf(record.contributorTokenId).
     */
    function _currentAuthor(BackendRecord storage r) internal view returns (address) {
        return IContributorNFT(contributorNFT).ownerOf(r.contributorTokenId);
    }

    /**
     * @dev Reverts UnauthorizedActor unless msg.sender is either the
     *      current NFT owner (canonical author) or the delegated agent
     *      address (Phase 1: address cast into bytes32).
     *
     *      Phase 2 (Q3 2026) will need to swap this comparison: when
     *      delegatedAgentId becomes an ERC-8004 tokenId, this helper
     *      must call AgentRegistry.ownerOf(tokenId) instead of comparing
     *      the cast address directly. The swap is gated by config + a
     *      future contract upgrade per the migration note in the type spec.
     */
    function _requireAuthorOrAgent(BackendRecord storage r) internal view {
        if (msg.sender == _currentAuthor(r)) return;
        // Phase 1: delegatedAgentId stores bytes32(uint256(uint160(address))).
        // Compare msg.sender directly.
        if (r.delegatedAgentId != bytes32(0)) {
            address agent = address(uint160(uint256(r.delegatedAgentId)));
            if (msg.sender == agent) return;
        }
        revert UnauthorizedActor();
    }
}
