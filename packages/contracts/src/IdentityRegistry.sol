// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IdentityRegistry
 * @notice ERC-8004 Identity Registry for PCC agents, machines, and operators.
 *
 * Each entity gets a unique on-chain ID. The registry stores:
 *   - Entity type (agent, machine, operator, verifier)
 *   - Owner address
 *   - Metadata hash (IPFS CID or SHA-256 of off-chain profile)
 *   - Status (active, suspended, deregistered)
 *
 * Only the owner can update their entity. Admin can suspend/deregister.
 */
contract IdentityRegistry {
    // ── Types ────────────────────────────────────────────────────────────

    enum EntityType {
        Agent,      // 0
        Machine,    // 1
        Operator,   // 2
        Verifier    // 3
    }

    enum EntityStatus {
        Active,       // 0
        Suspended,    // 1
        Deregistered  // 2
    }

    struct Entity {
        uint256 id;
        EntityType entityType;
        address owner;
        bytes32 metadataHash;     // SHA-256 of off-chain profile JSON
        EntityStatus status;
        uint256 registeredAt;
        uint256 updatedAt;
    }

    // ── State ────────────────────────────────────────────────────────────

    address public admin;
    uint256 public nextId = 1;

    mapping(uint256 => Entity) public entities;
    mapping(address => uint256[]) public ownerEntities; // owner -> entity IDs

    // ── Events ───────────────────────────────────────────────────────────

    event EntityRegistered(uint256 indexed id, EntityType entityType, address indexed owner, bytes32 metadataHash);
    event EntityUpdated(uint256 indexed id, bytes32 newMetadataHash);
    event EntityStatusChanged(uint256 indexed id, EntityStatus newStatus);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier onlyEntityOwner(uint256 id) {
        require(entities[id].owner == msg.sender, "Not entity owner");
        _;
    }

    modifier entityExists(uint256 id) {
        require(id > 0 && id < nextId, "Entity does not exist");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor() {
        admin = msg.sender;
    }

    // ── Registration ─────────────────────────────────────────────────────

    /**
     * @notice Register a new entity. Anyone can register.
     * @return The newly assigned entity ID.
     */
    function register(
        EntityType _entityType,
        bytes32 _metadataHash
    ) external returns (uint256) {
        uint256 id = nextId++;

        entities[id] = Entity({
            id: id,
            entityType: _entityType,
            owner: msg.sender,
            metadataHash: _metadataHash,
            status: EntityStatus.Active,
            registeredAt: block.timestamp,
            updatedAt: block.timestamp
        });

        ownerEntities[msg.sender].push(id);

        emit EntityRegistered(id, _entityType, msg.sender, _metadataHash);
        return id;
    }

    // ── Updates ──────────────────────────────────────────────────────────

    /**
     * @notice Update metadata hash. Only entity owner.
     */
    function updateMetadata(uint256 id, bytes32 _newMetadataHash)
        external
        entityExists(id)
        onlyEntityOwner(id)
    {
        entities[id].metadataHash = _newMetadataHash;
        entities[id].updatedAt = block.timestamp;
        emit EntityUpdated(id, _newMetadataHash);
    }

    /**
     * @notice Admin can suspend or deregister an entity.
     */
    function setStatus(uint256 id, EntityStatus _status)
        external
        onlyAdmin
        entityExists(id)
    {
        entities[id].status = _status;
        entities[id].updatedAt = block.timestamp;
        emit EntityStatusChanged(id, _status);
    }

    /**
     * @notice Transfer admin role.
     */
    function transferAdmin(address _newAdmin) external onlyAdmin {
        emit AdminTransferred(admin, _newAdmin);
        admin = _newAdmin;
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getEntity(uint256 id) external view returns (Entity memory) {
        return entities[id];
    }

    function getOwnerEntityCount(address owner) external view returns (uint256) {
        return ownerEntities[owner].length;
    }

    function getOwnerEntityIds(address owner) external view returns (uint256[] memory) {
        return ownerEntities[owner];
    }

    function getEntityCount() external view returns (uint256) {
        return nextId - 1;
    }
}
