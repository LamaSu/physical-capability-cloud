/**
 * RateScheduleRegistry ABI — generated from RateScheduleRegistry.sol
 *
 * Content-addressed immutable storage of off-chain RateSchedule canonical-JSON.
 * Schedules are keyed by their sha256 hash (matching the off-chain
 * `computeScheduleHash` algorithm in @pcc/spec). Once published, an entry
 * never mutates.
 */
export const RateScheduleRegistryABI = [
  // Constructor — no arguments
  { type: "constructor", inputs: [], stateMutability: "nonpayable" },

  // ── Views ──────────────────────────────────────────────────────────

  /**
   * publisher(scheduleHash) → address
   * Address that first published the schedule under this hash.
   */
  {
    name: "publisher",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },

  /**
   * publishedAt(scheduleHash) → uint64
   * block.timestamp at the moment the schedule was published. uint64
   * (sufficient until year 2554; matches Milestone.challengeWindowEnd).
   */
  {
    name: "publishedAt",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },

  /**
   * get(scheduleHash) → bytes
   * Returns the raw canonical-JSON bytes for the schedule, or empty bytes
   * if the hash has never been published.
   */
  {
    name: "get",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "scheduleHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bytes" }],
  },

  /**
   * exists(scheduleHash) → bool
   * Cheap O(1) presence check used by ContributorNFT.mint() to gate
   * scheduleHash references.
   */
  {
    name: "exists",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "scheduleHash", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },

  // ── Mutations ──────────────────────────────────────────────────────

  /**
   * publish(scheduleBytes, expectedHash) → bytes32
   * Publish a schedule. Reverts if `sha256(scheduleBytes) != expectedHash`,
   * if `scheduleBytes.length == 0`, or if the hash has already been
   * published. Returns the verified hash on success.
   */
  {
    name: "publish",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "scheduleBytes", type: "bytes" },
      { name: "expectedHash", type: "bytes32" },
    ],
    outputs: [{ name: "scheduleHash", type: "bytes32" }],
  },

  // ── Events ─────────────────────────────────────────────────────────

  /**
   * SchedulePublished(scheduleHash, publisher, size)
   * Emitted exactly once per unique scheduleHash on first publish.
   */
  {
    name: "SchedulePublished",
    type: "event",
    inputs: [
      { name: "scheduleHash", type: "bytes32", indexed: true },
      { name: "publisher", type: "address", indexed: true },
      { name: "size", type: "uint256", indexed: false },
    ],
  },
] as const;
