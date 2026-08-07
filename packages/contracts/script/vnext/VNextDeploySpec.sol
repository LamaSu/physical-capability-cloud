// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VNextDeploySpec
 * @notice The deterministic-deployment SPEC for the V-next settlement stack: salt derivation, mode
 *         namespacing, the provisional cohort band, and CREATE2 address math.
 *
 * @dev    DELIBERATELY IMPORTS NOTHING FROM `src/`, so this spec can be read, reviewed and reused without
 *         dragging in the escrow's link requirement.
 *
 *         WHY CREATE2 AT ALL. `forge script` is not transactional across transactions: a four-contract
 *         deploy is four txs, and a failure at tx 3 strands two contracts. Routing every deployment
 *         through the canonical deterministic-deployment proxy makes each contract's address a pure
 *         function of `(salt, initcode)` — where the initcode includes the constructor arguments. Three
 *         properties follow, and they are the whole reason for the design:
 *           1. RESUMABLE — a re-run recomputes the same addresses, finds the already-deployed prefix,
 *              and skips it. A partial run is completed, never duplicated.
 *           2. NO SECOND VALID-LOOKING DEPLOYMENT — identical inputs can only ever produce the identical
 *              address. Different inputs produce a DIFFERENT address, which the deploy script's guard
 *              refuses rather than silently publishing as a rival deployment.
 *           3. KEY-INDEPENDENT — the proxy is the CREATE2 sender, so the resulting addresses do not
 *              depend on which key ran the script. The tuple can therefore be reviewed and agreed BEFORE
 *              anyone holds the deploying key.
 */
library VNextDeploySpec {
    // ── The canonical deterministic-deployment proxy ────────────────────────────────────────────────
    /// @notice `0x4e59b44847b379578588920cA78FbF26c0B4956C` — the proxy `forge` routes `new X{salt: s}()`
    ///         through while broadcasting, and the CREATE2 sender every address here is computed against.
    /// @dev    VERIFY IT EXISTS ON THE TARGET CHAIN BEFORE DEPLOYING. The deploy script asserts
    ///         `CREATE2_DEPLOYER.code.length > 0` and aborts otherwise, because a missing proxy silently
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

    // ── DEP-01. The canonical SETTLEMENT ASSET, per chain. ───────────────────────────────────────────
    //
    // WHY AN ADDRESS PIN AND NOT A CODE CHECK. Every escrow invariant — funding, freezing, the fee
    // split, release — is expressed in terms of `USDC.transferFrom` / `USDC.transfer` and holds against
    // ANY conforming ERC-20. So a stale, fumbled or substituted `VNEXT_USDC` does not break the money
    // path; it makes the money path work perfectly against a token nobody can redeem. The failure is
    // silent by construction, it is only detectable by comparing the address to the one Circle issues,
    // and it is unrecoverable once the factory is broadcast (the settlement asset is fixed at
    // construction — `VNextSettlementEscrow.USDC()` is immutable). Hence a hard equality, chain-scoped,
    // enforced at every point that can still refuse.
    /// @notice Circle-issued USDC on Base mainnet.
    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    /// @notice Circle-issued USDC on Base Sepolia.
    address internal constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // ── PROV-01. The canonical PROVENANCE registries. ────────────────────────────────────────────────
    //
    // NOT a money-path pin, and the distinction is worth stating so nobody over- or under-reacts to it.
    // The escrow reads NO attestation registry (P0-6): release reads `assertionOf` out of the attester's
    // own storage, and EAS is written by `mirrorToEAS`, an ASYNC mirror reachable from no money path
    // (`O5AttesterBase.sol:84-86`, `:52-58`). A counterfeit EAS-shaped contract therefore cannot release
    // a single cent — but it CAN return an arbitrary non-zero uid, which `mirrorToEAS` records as
    // `mirroredUid` and announces as `O5Mirrored`. Downstream UI and indexers read that as "mirrored into
    // EAS". So the harm is a corrupted provenance CLAIM, and the fix is an address pin at the same three
    // points as DEP-01.
    /// @notice EAS. An OP-Stack predeploy, hence the same address on Base and Base Sepolia.
    address internal constant EAS = 0x4200000000000000000000000000000000000021;
    /// @notice The EAS SchemaRegistry predeploy, alongside {EAS}.
    address internal constant EAS_SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;

    /// @notice True iff this chain has a pinned settlement asset and pinned provenance registries — i.e.
    ///         iff {canonicalUsdc} can answer for it.
    /// @dev    Deliberately the SAME predicate the deploy script's unknown-chain opt-in keys off, so
    ///         "which chains are pinned" is one fact with one definition rather than two lists that drift.
    function isPinnedChain(uint256 chainId) internal pure returns (bool) {
        return chainId == CHAIN_BASE || chainId == CHAIN_BASE_SEPOLIA;
    }

    /// @notice The canonical settlement asset for a PINNED chain.
    /// @dev    REVERTS on any other chain rather than returning `address(0)`. A zero return would make
    ///         `usdc == canonicalUsdc(chainid)` a check that silently passes for a token at the zero
    ///         address and silently fails for every real one — the two worst answers available. Callers
    ///         must decide the unknown-chain policy explicitly before asking this question.
    function canonicalUsdc(uint256 chainId) internal pure returns (address) {
        if (chainId == CHAIN_BASE) return USDC_BASE;
        if (chainId == CHAIN_BASE_SEPOLIA) return USDC_BASE_SEPOLIA;
        revert("no canonical settlement asset is pinned for this chain - guard with isPinnedChain first");
    }

    // ── Contract tags (one per deployed artifact) ───────────────────────────────────────────────────
    string internal constant TAG_LIBRARY = "VNextSettlementLib";
    string internal constant TAG_PRIMARY_ATTESTER = "PrimaryO5Attester";
    string internal constant TAG_ESCALATION_ATTESTER = "EscalationO5Attester";
    string internal constant TAG_FACTORY = "VNextSettlementEscrowFactory";
    string internal constant TAG_PROVISIONAL_USDC = "ProvisionalMockUSDC";

    // ── The library is deployed BY FORGE, not by us. This is not a convenience — it is required. ─────
    /// @notice The salt `forge script` uses when it auto-deploys an unlinked library: `bytes32(0)`.
    /// @dev    MEASURED, not assumed (forge 1.5.1): a dry run emits one `transactionType: "CREATE2"` to
    ///         {CREATE2_DEPLOYER}, and `create2(CREATE2_DEPLOYER, 0, keccak(libInitCode))` reproduces the
    ///         address forge chose, exactly.
    ///
    ///         WHY WE MUST NOT DEPLOY THE LIBRARY OURSELVES, AND MUST NEVER PASS `--libraries`.
    ///         solc records the `libraries` compiler setting in every contract's METADATA, and the
    ///         metadata hash is appended to that contract's bytecode. Measured on this build: the
    ///         library's own runtime tail changes with the `--libraries` value —
    ///           no flag          -> ...398fa92d67af5be5da557fa0903a20b847dc74c370019dbc...
    ///           --libraries 0x11 -> ...0bebbe8e3b0d27a778fb2a395af603159311640cb102f98a...
    ///           --libraries 0x22 -> ...ba5008a089fa370dce2328c19607f42cfd05b28d87a6701a...
    ///         The escrow's constructor gate hashes `type(VNextSettlementLib).runtimeCode` — the template
    ///         from ITS OWN compilation, metadata included — and compares it to the deployed library's
    ///         `EXTCODEHASH` (`VNextSettlementEscrow.sol:594-600`). So the library and the factory must
    ///         come from the SAME compilation, or the factory's deployment reverts `LinkedLibraryMismatch`.
    ///         Passing `--libraries ADDR` makes that impossible: it would require
    ///         `ADDR == create2(salt, keccak(initcode(metadata(ADDR))))`, a fixed point inside a hash.
    ///
    ///         Letting forge do it keeps ONE compilation and is therefore self-consistent by
    ///         construction — which is exactly why the 918-test suite links libraries this way today. It
    ///         also happens to be deterministic (CREATE2, salt 0) and idempotent (a second broadcast
    ///         reports "No transactions to broadcast"), so nothing is lost.
    ///
    ///         Consequences worth stating plainly:
    ///           1. the library address is CHAIN- and MODE-independent — one address, one codehash, for
    ///              canonical and provisional, Base and Base Sepolia. "The same audited bytecode backs
    ///              both networks" becomes a one-command check: compare the two chains' `EXTCODEHASH`.
    ///           2. a consumer that pins the library codehash off a PROVISIONAL stack does not have to
    ///              re-pin when the canonical stack lands.
    ///         Contrast {contractSalt}: the factory and attesters carry NETWORK-SPECIFIC configuration
    ///         (settlement asset, signer set, cohort), so their addresses are chain- AND mode-scoped on
    ///         purpose — a Base Sepolia factory must never be confusable with a Base one by address alone.
    bytes32 internal constant FORGE_LIBRARY_SALT = bytes32(0);

    /// @notice Where `forge script` will place (or has placed) an auto-deployed library with this initcode.
    function forgeLibraryAddress(bytes32 initCodeHash) internal pure returns (address) {
        return create2Address(FORGE_LIBRARY_SALT, initCodeHash);
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
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash)))));
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
