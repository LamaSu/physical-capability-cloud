/**
 * ContributorNFT ABI — generated from ContributorNFT.sol
 *
 * ERC-721 + ERC-2981 NFT representing one contributor identity bound to one
 * role and one immutable RateSchedule. Sealed-at-mint metadata
 * (role, scheduleHash, ipId, metadataUri, mintedAt). No setters.
 */
export const ContributorNFTABI = [
  // Constructor
  {
    type: "constructor",
    inputs: [{ name: "_scheduleRegistry", type: "address" }],
    stateMutability: "nonpayable",
  },

  // ── ERC-721 Metadata ───────────────────────────────────────────────

  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  /**
   * tokenURI(tokenId) → string
   * Returns the sealed metadataUri for the token. Reverts if token doesn't exist.
   */
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },

  // ── Constants & immutables ────────────────────────────────────────

  /**
   * scheduleRegistry → address
   * Immutable RateScheduleRegistry address. Mints are gated on
   * registry.exists(scheduleHash) being true.
   */
  {
    name: "scheduleRegistry",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },

  /**
   * ROYALTY_FALLBACK_BPS → uint96
   * Constant 500 bps (5%) — the marketplace-UI fallback for ERC-2981.
   */
  {
    name: "ROYALTY_FALLBACK_BPS",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint96" }],
  },

  /**
   * nextTokenId → uint256
   * Monotonically increasing id; first mint produces id=1.
   */
  {
    name: "nextTokenId",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },

  // ── Sealed token data ─────────────────────────────────────────────

  /**
   * dataOf(tokenId) → (role, scheduleHash, ipId, metadataUri, mintedAt)
   * Sealed payload from mint. No setter; immutable across the token's lifetime.
   */
  {
    name: "dataOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "role", type: "bytes32" },
      { name: "scheduleHash", type: "bytes32" },
      { name: "ipId", type: "bytes32" },
      { name: "metadataUri", type: "string" },
      { name: "mintedAt", type: "uint64" },
    ],
  },

  // ── ERC-721 reads ─────────────────────────────────────────────────

  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getApproved",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── Mint ──────────────────────────────────────────────────────────

  /**
   * mint(to, role, scheduleHash, ipId, metadataUri) → tokenId
   * Sealed-mint: all five fields are written exactly once.
   * Reverts on: zero `to`, zero `role`, zero `scheduleHash`, or
   *             scheduleHash not present in scheduleRegistry.
   */
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "role", type: "bytes32" },
      { name: "scheduleHash", type: "bytes32" },
      { name: "ipId", type: "bytes32" },
      { name: "metadataUri", type: "string" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },

  // ── ERC-721 writes ────────────────────────────────────────────────

  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setApprovalForAll",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "transferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "safeTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "safeTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },

  // ── ERC-2981 ──────────────────────────────────────────────────────

  /**
   * royaltyInfo(tokenId, salePrice) → (receiver, amount)
   * Constant 5% fallback addressed to the token's current owner.
   * Marketplace-UI hint only — actual primary-flow payouts are governed
   * by the off-chain RateSchedule + on-chain MilestoneEscrow.setPayoutMap.
   */
  {
    name: "royaltyInfo",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "salePrice", type: "uint256" },
    ],
    outputs: [
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },

  // ── ERC-165 ───────────────────────────────────────────────────────

  {
    name: "supportsInterface",
    type: "function",
    stateMutability: "pure",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── Events ────────────────────────────────────────────────────────

  // ERC-721 mandatory events
  {
    name: "Transfer",
    type: "event",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
  {
    name: "Approval",
    type: "event",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "approved", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
  {
    name: "ApprovalForAll",
    type: "event",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "approved", type: "bool", indexed: false },
    ],
  },

  /**
   * ContributorMinted(tokenId, owner, role, scheduleHash, ipId, metadataUri)
   * Emitted exactly once per token at mint, alongside Transfer(from=0).
   * Distinct event so off-chain indexers can subscribe to contributor-specific
   * events without filtering Transfer.from == address(0).
   */
  {
    name: "ContributorMinted",
    type: "event",
    inputs: [
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "role", type: "bytes32", indexed: true },
      { name: "scheduleHash", type: "bytes32", indexed: false },
      { name: "ipId", type: "bytes32", indexed: false },
      { name: "metadataUri", type: "string", indexed: false },
    ],
  },
] as const;
