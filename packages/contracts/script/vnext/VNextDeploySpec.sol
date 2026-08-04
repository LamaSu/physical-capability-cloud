// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VNextDeploySpec
 * @notice The deterministic-deployment SPEC shared by both V-next deploy phases: salt derivation,
 *         mode namespacing, the provisional cohort band, and CREATE2 address math.
 *
 * @dev    DELIBERATELY IMPORTS NOTHING FROM `src/`.
 *
 *         This file is `internal`-only and references neither {VNextSettlementEscrow} nor
 *         {VNextSettlementEscrowFactory}. That is load-bearing, not tidiness: the factory's CREATION
 *         code carries three unresolved {VNextSettlementLib} placeholders (measured: 4 in the factory's
 *         initcode, 3 in the escrow's runtime), so ANY contract that references the factory inherits an
 *         unlinked creation code. `forge script` resolves that by auto-deploying the library as a real
 *         transaction — which is precisely the non-deterministic library deployment phase 1 exists to
 *         prevent. Keeping this file src-free lets phase 1 compile and run with no link requirement.
 *
 *         WHY CREATE2 AT ALL. `forge script` is not transactional across transactions: a four-contract
 *         deploy is four txs, and a failure at tx 3 strands two contracts. Routing every deployment
 *         through the canonical deterministic-deployment proxy makes each contract's address a pure
 *         function of `(salt, initcode)` — where the initcode includes the constructor arguments. Three
 *         properties follow, and they are the whole reason for the design:
 *           1. RESUMABLE — a re-run recomputes the same addresses, finds the already-deployed prefix,
 *              and skips it. A partial run is completed, never duplicated.
 *           2. NO SECOND VALID-LOOKING DEPLOYMENT — identical inputs can only ever produce the identical
 *              address. Different inputs produce a DIFFERENT address, which the artifact guard in phase 2
 *              refuses rather than silently publishing as a rival deployment.
 *           3. KEY-INDEPENDENT — the proxy is the CREATE2 sender, so the resulting addresses do not
 *              depend on which key ran the script. The tuple can therefore be reviewed and agreed BEFORE
 *              anyone holds the deploying key.
 */
library VNextDeploySpec {
    // ── The canonical deterministic-deployment proxy ────────────────────────────────────────────────
    /// @notice `0x4e59b44847b379578588920cA78FbF26c0B4956C` — the proxy `forge` routes `new X{salt: s}()`
    ///         through while broadcasting, and the CREATE2 sender every address here is computed against.
    /// @dev    VERIFY IT EXISTS ON THE TARGET CHAIN BEFORE DEPLOYING. Both scripts assert
    ///         `CREATE2_DEPLOYER.code.length > 0` and abort otherwise, because a missing proxy silently
    ///         changes the CREATE2 sender and therefore every address in the published tuple.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    // ── Spec identity ───────────────────────────────────────────────────────────────────────────────
    /// @notice Namespace for every salt this spec derives. Changing it re-addresses the whole stack.
    string internal constant NAMESPACE = "pcc.vnext.settlement";
    /// @notice Deploy-spec revision. Bump ONLY to deliberately re-address a cohort; it is inside every
    ///         salt, so a bump is the sanctioned way to publish a second, non-conflicting deployment.
    uint256 internal constant SPEC_VERSION = 1;

    // ── Modes ───────────────────────────────────────────────────────────────────────────────────────
    /// @notice The canonical, pinnable deployment. One per (chainId, SPEC_VERSION).
    string internal constant MODE_CANONICAL = "CANONICAL";
    /// @notice A throwaway deployment for downstream plumbing. Never pinned, never money-bearing.
    string internal constant MODE_PROVISIONAL = "PROVISIONAL";

    // ── The provisional band (the tag that survives reading ONLY the artifact) ───────────────────────
    /// @notice Every PROVISIONAL cohort id has its top nibble set: `cohortId >= 0xF000_0000_0000_0000`.
    /// @dev    This is the tag of record, and it is deliberately NOT a filename or a JSON field.
    ///         `cohortId` is a `uint64 public immutable` on {O5AttesterBase} (line 88), so it is readable
    ///         on-chain forever with `cast call <attester> "cohortId()(uint64)"` from nothing but an
    ///         address. It is also structural rather than decorative: the escrow pins the cohort id at
    ///         `fund()` and {O5AttesterBase.attestO5} rejects a verdict whose `oracleAuthEpoch != cohortId`
    ///         (line 276), so an O5 signature produced for a provisional cohort can never be replayed
    ///         against a canonical one, or the reverse. A provisional deployment is therefore not merely
    ///         labelled non-canonical — it is cryptographically disjoint from the canonical cohort.
    uint64 internal constant PROVISIONAL_COHORT_FLOOR = 0xF000000000000000;
    /// @notice Canonical cohort ids must stay below the band so the two can never overlap.
    uint64 internal constant CANONICAL_COHORT_CEILING = PROVISIONAL_COHORT_FLOOR - 1;

    // ── Chain ids ───────────────────────────────────────────────────────────────────────────────────
    uint256 internal constant CHAIN_BASE = 8453;
    uint256 internal constant CHAIN_BASE_SEPOLIA = 84532;

    // ── Contract tags (one per deployed artifact) ───────────────────────────────────────────────────
    string internal constant TAG_LIBRARY = "VNextSettlementLib";
    string internal constant TAG_PRIMARY_ATTESTER = "PrimaryO5Attester";
    string internal constant TAG_ESCALATION_ATTESTER = "EscalationO5Attester";
    string internal constant TAG_FACTORY = "VNextSettlementEscrowFactory";
    string internal constant TAG_PROVISIONAL_USDC = "ProvisionalMockUSDC";

    /// @notice The library's salt is deliberately CHAIN-INDEPENDENT.
    /// @dev    {VNextSettlementLib} carries no constructor arguments and no configuration — it is the same
    ///         audited artifact on Base and Base Sepolia, and its own initcode contains no address (its
    ///         constructor splices `ADDRESS` into the call-protection prologue at deploy time; verified by
    ///         disassembling the 53-byte deploy prefix). So one salt puts it at the SAME address on both
    ///         networks, and — because the only address-dependent bytes in its runtime are its own — at the
    ///         same runtime codehash on both. That equality is a directly checkable, one-command expression
    ///         of "the same audited bytecode backs both networks": compare the two `EXTCODEHASH`es.
    ///         Contrast {contractSalt}: the factory and attesters carry NETWORK-SPECIFIC configuration
    ///         (settlement asset, signer set, cohort), so their addresses are chain-scoped on purpose —
    ///         a Base Sepolia factory must never be confusable with a Base one by address alone.
    function librarySalt(string memory mode) internal pure returns (bytes32) {
        return keccak256(abi.encode(NAMESPACE, SPEC_VERSION, mode, TAG_LIBRARY));
    }

    /// @notice Chain-scoped salt for a configured contract.
    /// @param mode   {MODE_CANONICAL} or {MODE_PROVISIONAL} — different namespaces, disjoint addresses.
    /// @param tag    the contract tag (see TAG_* above).
    /// @param label  free-form discriminator. Empty for canonical; the run label for provisional, so two
    ///               provisional runs can coexist without either pretending to be the other.
    function contractSalt(string memory mode, uint256 chainId, string memory tag, string memory label)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(NAMESPACE, SPEC_VERSION, mode, chainId, tag, label));
    }

    /// @notice CREATE2 address for `initCodeHash` under `salt`, deployed by {CREATE2_DEPLOYER}.
    function create2Address(bytes32 salt, bytes32 initCodeHash) internal pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash))))
        );
    }

    /// @notice True iff `cohortId` sits in the provisional band.
    function isProvisionalCohort(uint64 cohortId) internal pure returns (bool) {
        return cohortId >= PROVISIONAL_COHORT_FLOOR;
    }

    /// @notice Human-readable network slug used for the artifact path. Unknown chains stringify their id
    ///         rather than silently landing in a known network's directory.
    function networkSlug(uint256 chainId) internal pure returns (string memory) {
        if (chainId == CHAIN_BASE) return "base";
        if (chainId == CHAIN_BASE_SEPOLIA) return "base-sepolia";
        if (chainId == 31337) return "anvil";
        return string.concat("chain-", _toString(chainId));
    }

    function _toString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n != 0) {
            len++;
            n /= 10;
        }
        bytes memory buf = new bytes(len);
        while (v != 0) {
            buf[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
