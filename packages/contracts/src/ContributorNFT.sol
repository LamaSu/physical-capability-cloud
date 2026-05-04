// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Minimal ERC-721 receiver interface for safeTransferFrom hand-off detection.
 *      Inlined here to avoid pulling in OpenZeppelin/Solmate as a dependency —
 *      the codebase deliberately stays vendor-light (foundry.toml libs = [forge-std]).
 */
interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

/**
 * @dev Slim view-only interface to RateScheduleRegistry. We only need {exists}
 *      to gate mints; the full registry surface is not required here.
 */
interface IRateScheduleRegistry {
    function exists(bytes32 scheduleHash) external view returns (bool);
}

/**
 * @title ContributorNFT
 * @notice ERC-721 + ERC-2981 token representing one contributor identity bound
 *         to one role and one immutable RateSchedule.
 *
 *         Each minted token sealed-encodes:
 *           - role         (bytes32) keccak256 of the canonical role string
 *                          (must match packages/contracts/ts/payouts.ts ROLE_TAGS)
 *           - scheduleHash (bytes32) sha256 of the off-chain RateSchedule canonical JSON
 *                          (must already exist in the RateScheduleRegistry at mint)
 *           - ipId         (bytes32) Story Protocol IP Asset address (zero allowed)
 *           - metadataUri  (string)  content-addressed URI for adapter docs/repo
 *           - mintedAt     (uint64)  block.timestamp at mint
 *
 *         Sealed metadata: all five fields are written EXACTLY ONCE at mint.
 *         No setter. No upgrade. To change any field a contributor mints a NEW
 *         token (and probably publishes a new schedule into the registry).
 *         This is the on-chain anchor for the off-chain attribution chain
 *         documented in ai/research/contributor-economics/01-royalty-nft-standards.md
 *         (the ERC-3569 sealed-metadata pattern).
 *
 *         ERC-2981 royaltyInfo() returns a CONSTANT FALLBACK (5%) addressed to
 *         the registry-recorded publisher of the scheduleHash. The actual
 *         payout split is computed off-chain by walking the RateSchedule and
 *         applied via MilestoneEscrow.setPayoutMap(). royaltyInfo() exists
 *         purely for marketplace-UI hints; it is NOT load-bearing for
 *         settlement. Spec rationale: the schedule DSL is too rich (six segment
 *         kinds, value/time-dependent) to evaluate cheaply on-chain.
 *
 *         Standards conformance:
 *           - ERC-721 (transferFrom, safeTransferFrom, approve, setApprovalForAll, ownerOf, balanceOf)
 *           - ERC-721 Metadata (tokenURI returns metadataUri)
 *           - ERC-165 supportsInterface
 *           - ERC-2981 royaltyInfo (constant 5% fallback)
 */
contract ContributorNFT {
    // ── ERC-721 Metadata ─────────────────────────────────────────────────

    string public constant name = "PCC Contributor";
    string public constant symbol = "PCC-CONTRIB";

    // ── Sealed token data ────────────────────────────────────────────────

    /// @notice Sealed-at-mint payload for one contributor identity.
    /// @param role         keccak256(role string), must match ROLE_TAGS.
    /// @param scheduleHash sha256 of off-chain canonical-JSON RateSchedule.
    /// @param ipId         Story Protocol IP Asset; bytes32(0) if none.
    /// @param metadataUri  URI to off-chain docs/repo (e.g. "ipfs://...").
    /// @param mintedAt     block.timestamp at mint.
    struct ContribTokenData {
        bytes32 role;
        bytes32 scheduleHash;
        bytes32 ipId;
        string metadataUri;
        uint64 mintedAt;
    }

    // ── External dependencies ────────────────────────────────────────────

    /// @notice Address of the RateScheduleRegistry whose schedules can be
    ///         referenced by tokens minted here. Immutable — re-pointing
    ///         the registry would break the sealed-mint invariant.
    address public immutable scheduleRegistry;

    // ── ERC-721 storage ──────────────────────────────────────────────────

    mapping(uint256 => address) private _ownerOf;
    mapping(address => uint256) private _balanceOf;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    /// @notice Per-token sealed metadata. Public so off-chain indexers can
    ///         read (role, scheduleHash, ipId, metadataUri, mintedAt) cheaply.
    mapping(uint256 => ContribTokenData) public dataOf;

    /// @notice Monotonically increasing token id. The first mint produces id=1.
    uint256 public nextTokenId;

    // ── Constants ────────────────────────────────────────────────────────

    /// @notice Constant marketplace-UI fallback for ERC-2981 royaltyInfo().
    /// @dev The actual per-job payout is governed by the off-chain RateSchedule
    ///      and the on-chain MilestoneEscrow.setPayoutMap() machinery, NOT by
    ///      this nominal display value.
    uint96 public constant ROYALTY_FALLBACK_BPS = 500; // 5%

    // ERC-165 interface ids
    bytes4 private constant _INTERFACE_ID_ERC165 = 0x01ffc9a7;
    bytes4 private constant _INTERFACE_ID_ERC721 = 0x80ac58cd;
    bytes4 private constant _INTERFACE_ID_ERC721_METADATA = 0x5b5e139f;
    bytes4 private constant _INTERFACE_ID_ERC2981 = 0x2a55205a;

    // ── Events ───────────────────────────────────────────────────────────

    // ERC-721 mandatory events
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// @notice Emitted exactly once per token at mint. Distinct from Transfer
    ///         (mint) so off-chain indexers can subscribe to contributor-specific
    ///         events without filtering on Transfer.from == address(0).
    event ContributorMinted(
        uint256 indexed tokenId,
        address indexed owner,
        bytes32 indexed role,
        bytes32 scheduleHash,
        bytes32 ipId,
        string metadataUri
    );

    // ── Constructor ──────────────────────────────────────────────────────

    /**
     * @param _scheduleRegistry Address of a deployed RateScheduleRegistry.
     *                          Reverts on zero — this contract has no useful
     *                          mode without a registry to gate scheduleHash.
     */
    constructor(address _scheduleRegistry) {
        require(_scheduleRegistry != address(0), "Zero registry");
        scheduleRegistry = _scheduleRegistry;
    }

    // ── Mint ─────────────────────────────────────────────────────────────

    /**
     * @notice Mint a new contributor identity NFT. Permissionless: anyone can
     *         mint to any address — the act of minting is just sealing
     *         identity-claim onto an immutable record. Downstream systems
     *         (LicensingEngine, MilestoneEscrow.setPayoutMap()) decide which
     *         tokens they trust for which jobs.
     *
     *         Sealed at mint:
     *           - role, scheduleHash, ipId, metadataUri, mintedAt
     *         No setter exists for any of these fields; the only way to update
     *         them is to mint a new token and route off-chain references to
     *         the new id.
     *
     *         Reverts if:
     *           - to == address(0)         (ERC-721 zero-address mint)
     *           - role == bytes32(0)       (sentinel: a real role tag is required)
     *           - scheduleHash == bytes32(0) (sentinel: empty hash forbidden)
     *           - registry.exists(scheduleHash) is false
     *             (the schedule must be published BEFORE any NFT can reference it)
     *
     *         CEI: state mutated, then events emitted, no external calls except
     *         the `exists()` view at the top — which is a registered registry,
     *         not user-controlled, so no reentrancy surface.
     *
     * @param to            Receiver of the freshly-minted token.
     * @param role          keccak256(role string); see ROLE_TAGS in ts/payouts.ts.
     * @param scheduleHash  sha256 of canonical-JSON RateSchedule; must exist in registry.
     * @param ipId          Story Protocol IP Asset address; bytes32(0) if none.
     * @param metadataUri   Content-addressed URI for adapter docs/repo.
     * @return tokenId      Newly assigned token id (starts at 1).
     */
    function mint(
        address to,
        bytes32 role,
        bytes32 scheduleHash,
        bytes32 ipId,
        string calldata metadataUri
    ) external returns (uint256 tokenId) {
        require(to != address(0), "Zero address");
        require(role != bytes32(0), "Zero role");
        require(scheduleHash != bytes32(0), "Zero scheduleHash");
        require(
            IRateScheduleRegistry(scheduleRegistry).exists(scheduleHash),
            "Schedule not registered"
        );

        unchecked {
            tokenId = ++nextTokenId;
        }

        _ownerOf[tokenId] = to;
        unchecked {
            _balanceOf[to] += 1;
        }
        dataOf[tokenId] = ContribTokenData({
            role: role,
            scheduleHash: scheduleHash,
            ipId: ipId,
            metadataUri: metadataUri,
            mintedAt: uint64(block.timestamp)
        });

        emit Transfer(address(0), to, tokenId);
        emit ContributorMinted(tokenId, to, role, scheduleHash, ipId, metadataUri);
    }

    // ── ERC-721 reads ────────────────────────────────────────────────────

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = _ownerOf[tokenId];
        require(owner != address(0), "Token does not exist");
    }

    function balanceOf(address owner) external view returns (uint256) {
        require(owner != address(0), "Zero address");
        return _balanceOf[owner];
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        require(_ownerOf[tokenId] != address(0), "Token does not exist");
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    /// @notice ERC-721 Metadata: returns the URI stored at mint.
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_ownerOf[tokenId] != address(0), "Token does not exist");
        return dataOf[tokenId].metadataUri;
    }

    // ── ERC-721 writes ───────────────────────────────────────────────────

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        require(
            msg.sender == owner || isApprovedForAll(owner, msg.sender),
            "Not authorized"
        );
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "Approve to caller");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public {
        _transfer(from, to, tokenId);
        require(_checkOnERC721Received(from, to, tokenId, data), "Receiver rejected");
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        require(to != address(0), "Zero address");
        address owner = _ownerOf[tokenId];
        require(owner == from, "From not owner");
        require(
            msg.sender == owner ||
                _tokenApprovals[tokenId] == msg.sender ||
                _operatorApprovals[owner][msg.sender],
            "Not authorized"
        );

        // Clear approval
        delete _tokenApprovals[tokenId];

        unchecked {
            _balanceOf[from] -= 1;
            _balanceOf[to] += 1;
        }
        _ownerOf[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }

    /**
     * @dev Calls onERC721Received on `to` if it is a contract. EOAs return true.
     *      Mirrors OpenZeppelin's _checkOnERC721Received implementation but
     *      without the reflective error decoding (we surface a flat revert).
     */
    function _checkOnERC721Received(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) internal returns (bool) {
        if (to.code.length == 0) {
            return true; // EOA — no callback expected.
        }
        try IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
            return ret == IERC721Receiver.onERC721Received.selector;
        } catch {
            return false;
        }
    }

    // ── ERC-2981 ─────────────────────────────────────────────────────────

    /**
     * @notice ERC-2981 royaltyInfo — constant 5% fallback addressed to the
     *         token's current owner.
     *
     * @dev Why owner and not registry-publisher?
     *      Marketplace UIs route royalties to the address returned here. The
     *      contributor's NFT owner is the most semantically-correct payout
     *      target for secondary-market royalties — they are the active holder
     *      of the contributor identity. The schedule's registry-publisher may
     *      have transferred the NFT or assigned it to a delegate.
     *
     *      The actual primary-flow per-job payouts come from the off-chain
     *      RateSchedule evaluation and the on-chain setPayoutMap() distribution
     *      — this royaltyInfo is purely a hint for ERC-2981-aware marketplaces.
     *
     * @param tokenId   Token under sale.
     * @param salePrice Sale price in marketplace-quoted units.
     * @return receiver Royalty recipient (owner of token).
     * @return amount   Royalty amount = salePrice * 500 / 10000.
     */
    function royaltyInfo(uint256 tokenId, uint256 salePrice)
        external
        view
        returns (address receiver, uint256 amount)
    {
        require(_ownerOf[tokenId] != address(0), "Token does not exist");
        receiver = _ownerOf[tokenId];
        amount = (salePrice * ROYALTY_FALLBACK_BPS) / 10000;
    }

    // ── ERC-165 ──────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == _INTERFACE_ID_ERC165 ||
            interfaceId == _INTERFACE_ID_ERC721 ||
            interfaceId == _INTERFACE_ID_ERC721_METADATA ||
            interfaceId == _INTERFACE_ID_ERC2981;
    }
}
