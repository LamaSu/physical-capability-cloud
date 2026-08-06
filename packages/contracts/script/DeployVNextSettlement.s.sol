// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {VNextDeploySpec} from "./vnext/VNextDeploySpec.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {VNextSettlementLib, PolicyIdentity} from "../src/libraries/VNextSettlementLib.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {SingleSignerO5Attester} from "../src/attesters/SingleSignerO5Attester.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/**
 * @title DeployVNextSettlement
 * @notice Deploys the V-next settlement cohort — {VNextSettlementLib}, the primary attester, the
 *         escalation attester, and the factory (whose constructor builds the escrow implementation) —
 *         and publishes the pinnable tuple `{factory, implementation, library, codehash}` per network.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ GATED on-chain action. SCRIPT-ONLY — DO NOT BROADCAST without explicit authorization.        │
 * │ Deploying publishes permanent, immutable contracts and spends gas. No automated pipeline     │
 * │ runs this with `--broadcast` (same posture as DeployProtocolV2/V3.s.sol).                    │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ══ THE DEPLOY ORDER IS FORCED, NOT CHOSEN ══════════════════════════════════════════════════════
 *   1. {VNextSettlementLib} — deployed BY FORGE, automatically, before this script's body runs.
 *   2. attesters — primary + escalation, two SEPARATE deployments with DISJOINT revokers.
 *   3. factory — its CONSTRUCTOR builds the implementation and runs five deploy-time gates.
 *
 *   Why the link lands one step earlier than a reader expects: the escrow's RUNTIME carries 3 unresolved
 *   library placeholders (measured), and the factory's CONSTRUCTOR embeds the escrow's initcode — so the
 *   factory's CREATION code carries them (4 of them; the factory's RUNTIME has none). Linking is therefore
 *   a COMPILE-time act for the factory.
 *
 *   ══ DO NOT PASS `--libraries`. DO NOT ADD `libraries = [...]` TO `foundry.toml`. ══
 *   Both are load-bearing prohibitions, and the second is not the obvious one.
 *     - `libraries = [...]` in `foundry.toml` would link the TEST build against an address holding no
 *       code and break every funding test (30 suites / 918 tests).
 *     - `--libraries <addr>` looks like the safe per-invocation alternative. It is not. solc records the
 *       `libraries` setting in every contract's METADATA, and the metadata hash is appended to its
 *       bytecode — so the flag changes the library's OWN bytecode, and therefore its address. Measured on
 *       this build, three different `--libraries` values give three different library runtimes. Since the
 *       escrow's gate hashes `type(VNextSettlementLib).runtimeCode` from its own compilation and compares
 *       it to the deployed library's `EXTCODEHASH`, a library deployed from any OTHER compilation makes
 *       the factory's construction revert `LinkedLibraryMismatch`. Pinning an address up front cannot fix
 *       it either: that needs `ADDR == create2(salt, keccak(initcode(metadata(ADDR))))`, a fixed point
 *       inside a hash.
 *   Letting `forge` deploy and link the library keeps ONE compilation, which is self-consistent by
 *   construction — and, measured, it is also deterministic (CREATE2 via the canonical proxy at salt 0)
 *   and idempotent (a second broadcast reports "No transactions to broadcast"). {_assertToolchain}
 *   re-derives the address forge should have chosen and aborts if it disagrees, so a stray `--libraries`
 *   is caught before anything is broadcast rather than at the factory's revert.
 *
 * ══ THE TWO GATES NO CONSTRUCTOR CAN ENFORCE ════════════════════════════════════════════════════
 *   Both are DEPLOYMENT INVARIANTS, both abort BEFORE any broadcast, and both exist here because the
 *   escrow structurally cannot check them (see the block comments above {_assertInputRouteDiversity} and
 *   {_assertCohortsBeforeBroadcast} for the full reasoning).
 *     GATE 1 — ROUTE DIVERSITY (§2.5). The escrow enforces `escalation != oracle` and distinct revokers;
 *       neither implies independent DECISION ROUTES, because two different attester ADDRESSES can hold
 *       the same immutable signer set. Rule: abort if the two cohorts' signer sets intersect in
 *       `min(thresholdPrimary, thresholdEscalation)` or more members — i.e. if any group large enough to
 *       reach quorum on one route also sits on the other. Launch policy is FULLY DISJOINT sets;
 *       sub-quorum overlap needs `VNEXT_ALLOW_SIGNER_OVERLAP=1`, and no flag ever permits a shared quorum.
 *       Enforced from the inputs in `predict()`/`_assertPreflight`, from chain state in `verify()`.
 *     GATE 2 — BOTH COHORTS ALIVE. A cohort that was already `disable()`d passes the factory constructor
 *       and leaves the whole stack unfundable forever. Asserted (`enabled()` and `disabledAt() == 0`)
 *       against every predicted cohort address that already holds code, before the first transaction.
 *   Both results are written into the artifact — `signerSetIntersection`, `quorumFloor`,
 *   `primaryEnabled`, `escalationEnabled` — so a reviewer reads the numbers instead of trusting a claim.
 *
 * ══ WHAT IS ATOMIC / WHAT IS RESUMABLE ══════════════════════════════════════════════════════════
 *   IDEMPOTENT-BY-FORGE:
 *     - the library. Deployed via CREATE2 at salt 0 from this compilation's initcode, and skipped
 *       entirely on a re-run.
 *   ATOMIC (single transaction, all-or-nothing):
 *     - factory + implementation + every deploy-time gate. `new VNextSettlementEscrowFactory{salt}(...)`
 *       is ONE transaction: its constructor CREATEs the implementation, whose own constructor runs the
 *       linked-library codehash gate (`VNextSettlementEscrow.sol:576-600`), the `escalation != oracle`
 *       check (`:574`), the H-02 disjoint-revoker check (`:609`), and the M-02/L-02 schema/type-hash pins
 *       (`:614`, `:619`). A failure of ANY of them reverts the whole transaction, so a factory that
 *       exists at all necessarily passed all five. There is no half-built factory.
 *   RESUMABLE (idempotent per contract):
 *     - every CREATE2 deployment this script performs (both attesters, the factory, and the throwaway
 *       token in provisional mode). Each predicted address is checked for code first and skipped if
 *       occupied, so a run interrupted after the attesters resumes into the factory instead of deploying
 *       rival attesters. Verified: a second broadcast logs "already deployed - skipping" for each and
 *       ends with "No transactions to broadcast".
 *   THE ONE WAY TO GET A SECOND VALID-LOOKING DEPLOYMENT, and its guard:
 *     - re-running with DIFFERENT constructor inputs yields a DIFFERENT address (the args are inside the
 *       initcode hash). {_guardAgainstRivalDeployment} refuses that: if an artifact already exists for
 *       this (mode, chainId, label) and records a different factory, the script aborts and tells the
 *       operator to bump `VNextDeploySpec.SPEC_VERSION` — a deliberate, reviewable act — instead of
 *       quietly publishing a rival.
 *
 * ══ USAGE (never with `--libraries`) ════════════════════════════════════════════════════════════
 *   Predict the addresses with no RPC, no key, no gas. CREATE2 is sent by the deterministic proxy, so
 *   the addresses do not depend on the deploying key — this is the real tuple minus the implementation
 *   codehash, reviewable before anyone holds the key:
 *     forge script script/DeployVNextSettlement.s.sol:DeployVNextSettlement --sig "predict()"
 *
 *   DRY RUN — full simulation against a live chain, nothing sent (omitting `--broadcast` is what makes it
 *   a dry run). Produces the COMPLETE tuple including the implementation codehash, so the tuple can be
 *   reviewed before anything is spent:
 *     forge script script/DeployVNextSettlement.s.sol:DeployVNextSettlement --sig "run()" \
 *       --rpc-url base_sepolia --sender <DEPLOYER>
 *
 *   Deploy (ONLY when explicitly authorized): add `--broadcast --private-key $DEPLOYER_PRIVATE_KEY
 *   --verify -vvvv`. The CLI key is needed because forge deploys the library BEFORE the script body runs,
 *   i.e. before `vm.startBroadcast` has told it who is signing.
 *
 *   Provisional/throwaway (never mainnet, never pinnable):
 *     ... --sig "provisional()" ...      with VNEXT_LABEL=<run-label>
 *
 *   Re-derive and re-check a published tuple from the factory address ALONE (read-only, no key):
 *     forge script script/DeployVNextSettlement.s.sol:DeployVNextSettlement \
 *       --sig "verify(address)" <FACTORY> --rpc-url base_sepolia
 *
 * ══ ENV ═════════════════════════════════════════════════════════════════════════════════════════
 *   DEPLOYER_PRIVATE_KEY      required for run()/provisional(); pays gas only. CREATE2 is sent by the
 *                             deterministic proxy, so this key does NOT affect any published address.
 *   VNEXT_EXPECT_CHAIN_ID     required. Asserted against `block.chainid`. An RPC typo aborts instead of
 *                             deploying a "Base Sepolia" cohort onto Base.
 *   VNEXT_USDC                required for run(). The settlement asset. provisional() ignores it and
 *                             deploys its own MockUSDC.
 *                             Known values, VERIFY BEFORE USE (this script only asserts the address has
 *                             code, it cannot know which token you meant):
 *                               Base mainnet  USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *                               Base Sepolia  USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e
 *   VNEXT_EAS                 required. EAS address for the attesters' async provenance mirror.
 *                             (The escrow reads no attestation registry — P0-6. This is attester-only.)
 *   VNEXT_O5_SCHEMA_UID       required, bytes32. Pinned on the primary cohort AND republished by the
 *                             factory; the escrow constructor rejects a mismatch (`:614`).
 *   VNEXT_PRIMARY_COHORT_ID   required, uint64. CANONICAL must be < 0xF000000000000000.
 *   VNEXT_ESCALATION_COHORT_ID required, uint64, and different from the primary's.
 *   VNEXT_PRIMARY_SIGNER_0..2 signer set. Only _0 is read for a SINGLE_SIGNER cohort.
 *   VNEXT_PRIMARY_REVOKER     kill-switch holder. Must not be a signer (attester ctor enforces).
 *   VNEXT_ESCALATION_SIGNER_0..2 / VNEXT_ESCALATION_REVOKER  same, for the escalation cohort. The revoker
 *                             MUST differ from the primary's — H-02 (`VNextSettlementEscrow.sol:609`).
 *   VNEXT_ALLOW_SIGNER_OVERLAP  optional, default 0. GATE 1's opt-in. `1` permits SUB-QUORUM overlap
 *                             between the two cohorts' signer sets; the quorum rule
 *                             (`|intersection| < min(thresholds)`) is NOT overridable by it. Recorded in
 *                             the artifact as `signerOverlapExplicitlyAllowed`.
 *   VNEXT_ATTESTER_TYPE       "FIXED_2OF3" | "SINGLE_SIGNER". Forced to FIXED_2OF3 on Base mainnet.
 *   VNEXT_LABEL               provisional() only. Names the throwaway run.
 *   VNEXT_ALLOW_UNKNOWN_CHAIN set to 1 to permit a chain that is neither Base nor Base Sepolia (anvil).
 */
contract DeployVNextSettlement is Script {
    string internal constant ESCROW_ARTIFACT = "VNextSettlementEscrow.sol:VNextSettlementEscrow";
    string internal constant LIB_ARTIFACT = "VNextSettlementLib.sol:VNextSettlementLib";

    /// @dev EIP-3860 initcode ceiling and EIP-170 runtime ceiling, asserted rather than assumed.
    uint256 internal constant MAX_INITCODE = 49_152;
    uint256 internal constant MAX_RUNTIME = 24_576;

    /// @dev This build's escrow RUNTIME carries exactly this many unresolved {VNextSettlementLib} link
    ///      sites (the 3 `delegatecall`s on the funding path; measured from
    ///      `out/VNextSettlementEscrow.sol/VNextSettlementEscrow.json`).
    ///      {_assertImplementationLinkedTo} requires the deployed runtime to hold exactly this many
    ///      `PUSH20 <library>` sites, so a refactor that adds or removes an external library call fails
    ///      loudly here instead of quietly weakening the check.
    uint256 internal constant LINK_SITES = 3;

    /// @dev Supply minted by the throwaway settlement asset a provisional deployment uses.
    uint256 internal constant PROVISIONAL_USDC_SUPPLY = 1_000_000e6;

    /// @dev The quorum size of each concrete attester, restated. Neither is readable on chain: the 2-of-3
    ///      rule is a `private constant` (`Fixed2of3O5Attester.sol:16`) and the single-signer rule is a
    ///      literal inside `_verifySignatures` (`SingleSignerO5Attester.sol:29-31`) — there is no getter to
    ///      probe, so a restatement here is unavoidable if the script is to reason about quorums at all.
    ///      The restatement is NOT unverified: the existing suite pins both numbers empirically —
    ///      `test/Fixed2of3O5Attester.t.sol:302` (2 sigs assert), `:338` (1 sig reverts), `:346` (3 sigs
    ///      revert); `:479` (1 sig asserts), `:495` (2 sigs revert). A change to either quorum turns those
    ///      tests red, which is the drift alarm these constants would otherwise lack.
    uint256 internal constant FIXED_2OF3_THRESHOLD = 2;
    uint256 internal constant SINGLE_SIGNER_THRESHOLD = 1;

    enum AttesterType {
        FIXED_2OF3,
        SINGLE_SIGNER
    }

    /// @notice A cohort's DECISION ROUTE: who can sign, and how many of them a verdict needs.
    /// @dev    `signers[0..size-1]` are the live members; `threshold` is the quorum. Two cohorts at
    ///         different ADDRESSES can still share a route, which is the whole point of {_routeDiversity}.
    struct Route {
        address[3] signers;
        uint256 size;
        uint256 threshold;
    }

    struct CohortInput {
        address signer0;
        address signer1;
        address signer2;
        address revoker;
        uint64 cohortId;
    }

    struct Inputs {
        string mode;
        string label;
        AttesterType attesterType;
        address usdc;
        address eas;
        bytes32 schemaUid;
        CohortInput primary;
        CohortInput escalation;
    }

    struct Tuple {
        address factory;
        address implementation;
        address settlementLib;
        bytes32 implementationCodehash;
        bytes32 libraryCodehash;
        address primaryAttester;
        address escalationAttester;
        address usdc;
        bytes32 schemaUid;
        bytes32 typeHash;
        uint64 primaryCohortId;
        uint64 escalationCohortId;
        // ── Deploy-gate results. Diagnostics, deliberately OUTSIDE {_digest}'s fifteen-word preimage. ──
        //    They are not signed into the digest because they do not need to be: {verify} RE-DERIVES and
        //    RE-ENFORCES both gates from chain state, so a doctored artifact field is contradicted by the
        //    next `--sig 'verify(address)'` run rather than merely mismatching a hash. Adding them to the
        //    preimage would also silently re-address every previously published digest.
        uint256 signerOverlap;
        uint256 quorumFloor;
        bool primaryEnabled;
        bool escalationEnabled;
        uint64 primaryDisabledAt;
        uint64 escalationDisabledAt;
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                        ENTRY POINTS
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice CANONICAL deploy. Idempotent, resumable, refuses to publish a rival deployment.
    function run() external {
        Inputs memory i = _readInputs(VNextDeploySpec.MODE_CANONICAL, "");
        i.usdc = vm.envAddress("VNEXT_USDC");
        _deploy(i);
    }

    /// @notice PROVISIONAL deploy — throwaway plumbing for downstream lanes, never pinnable.
    /// @dev    Non-canonicity is made STRUCTURAL, not decorative, in four independent ways:
    ///           1. cohort ids are forced into the provisional band (`>= 0xF000000000000000`), which is a
    ///              `uint64 public immutable` on the attester and therefore readable on-chain forever
    ///              from nothing but an address — the tag survives losing every off-chain artifact. It is
    ///              also enforced INSIDE the O5 verdict struct (`O5AttesterBase.sol:276` rejects
    ///              `oracleAuthEpoch != cohortId`), so provisional and canonical signatures are
    ///              cryptographically disjoint rather than merely labelled.
    ///           2. the settlement asset is a freshly deployed {MockUSDC}, so the deployment is
    ///              structurally incapable of moving the real settlement asset. `escrow.USDC()` is public.
    ///           3. a distinct salt namespace ⇒ addresses that can never collide with canonical ones.
    ///           4. mainnet is refused outright.
    ///         The artifact adds `"canonical": false` and `"doNotPin": true` and lands under a
    ///         `PROVISIONAL-<label>.json` filename — belt and braces on top of the on-chain tag.
    function provisional() external {
        string memory label = vm.envString("VNEXT_LABEL");
        require(bytes(label).length > 0, "VNEXT_LABEL is required for a provisional deployment");
        require(block.chainid != VNextDeploySpec.CHAIN_BASE, "provisional deployments are forbidden on Base mainnet");
        Inputs memory i = _readInputs(VNextDeploySpec.MODE_PROVISIONAL, label);
        // Toolchain guards run BEFORE the throwaway token is deployed, so a misconfigured invocation
        // (unlinked build, missing CREATE2 proxy, wrong RPC) costs nothing at all.
        _assertToolchain();
        i.usdc = _deployProvisionalUsdc(label);
        _deploy(i);
    }

    /// @notice Addresses only — no RPC, no key, no gas, nothing broadcast. CREATE2 makes every address a
    ///         pure function of `(salt, initcode)`, so this is the real tuple minus the implementation
    ///         codehash (which requires executing the constructor; use the `run()` simulation for that).
    /// @dev    Not `view`: it instantiates one throwaway attester in the script's LOCAL EVM to read this
    ///         build's O5 type hash (see {_o5TypeHashOfThisBuild}). Created outside any broadcast, so it is
    ///         never a transaction.
    function predict() external {
        string memory mode = vm.envOr("VNEXT_MODE", VNextDeploySpec.MODE_CANONICAL);
        string memory label = vm.envOr("VNEXT_LABEL", string(""));
        Inputs memory i = _readInputs(mode, label);
        i.usdc = keccak256(bytes(mode)) == keccak256(bytes(VNextDeploySpec.MODE_PROVISIONAL))
            ? _predictProvisionalUsdc(label)
            : vm.envAddress("VNEXT_USDC");
        // GATE 1 at the input level, here too: predicting and circulating addresses for a cohort pair that
        // could ratify its own appeal is precisely the review artifact that should never exist.
        _assertInputRouteDiversity(i);
        (address primary, address escalation, address factory) = _predictAll(i);
        console2.log("== V-next settlement stack : PREDICT ==");
        console2.log("mode:                ", i.mode);
        console2.log("chainId:             ", block.chainid);
        console2.log("library (linked):    ", address(VNextSettlementLib));
        console2.log("primary attester:    ", primary);
        console2.log("escalation attester: ", escalation);
        console2.log("factory:             ", factory);
        console2.log("implementation:      ", vm.computeCreateAddress(factory, 1));
        console2.log("implementation codehash: requires execution - run `--sig run()` WITHOUT --broadcast");
    }

    /// @notice Re-derive the whole tuple from the FACTORY ADDRESS ALONE and re-run every assertion.
    /// @dev    This is what makes the published artifact tamper-EVIDENT rather than merely trusted. The
    ///         artifact is not an authority — it is a claim, and every field of it is re-derivable here
    ///         from one address plus this git commit's build:
    ///           - implementation: derived independently as `CREATE(factory, nonce 1)` AND read back from
    ///             `factory.implementation()`; both must agree.
    ///           - library: recovered from the implementation's ON-CHAIN runtime by locating this build's
    ///             three `PUSH20 <placeholder>` sites in the artifact template and reading the linked
    ///             bytes at the same offsets, then re-proving the codehash relation.
    ///           - codehashes: read with EXTCODEHASH.
    ///         A reviewer runs this against the recorded factory and gets a revert if any recorded field
    ///         was altered. No trusted store, no signature infrastructure required.
    function verify(address factory) external view returns (Tuple memory t) {
        t = _verify(factory);
        console2.log("== V-next settlement stack : VERIFY (read-only) ==");
        _printTuple(t);
        console2.log("tuple digest:");
        console2.logBytes32(_digest(t));
        console2.log("VERIFIED - every assertion re-ran against chain state.");
    }

    /// @dev The re-derivation itself. Internal so {_deploy} can reuse it without `this.verify(...)`, which
    ///      forge rejects (`address(this)` in a script contract).
    function _verify(address factory) internal view returns (Tuple memory t) {
        require(factory.code.length > 0, "verify: no code at the factory address");
        VNextSettlementEscrowFactory f = VNextSettlementEscrowFactory(factory);

        t.factory = factory;
        t.implementation = f.implementation();
        require(
            t.implementation == vm.computeCreateAddress(factory, 1),
            "verify: implementation is not CREATE(factory, 1) - not this factory's own constructor output"
        );
        require(t.implementation.code.length > 0, "verify: implementation has no code");

        VNextSettlementEscrow impl = VNextSettlementEscrow(t.implementation);
        require(impl.factory() == factory, "verify: implementation.factory() != factory");
        require(impl.initialized(), "verify: implementation is not initializer-locked");

        t.settlementLib = address(VNextSettlementLib);
        _assertImplementationLinkedTo(t.implementation, t.settlementLib);
        t.implementationCodehash = t.implementation.codehash;
        t.libraryCodehash = t.settlementLib.codehash;
        t.primaryAttester = impl.authorizedOracle();
        t.escalationAttester = impl.escalationAttester();
        t.usdc = impl.USDC();
        t.schemaUid = f.o5SchemaUid();
        t.typeHash = f.o5TypeHash();
        t.primaryCohortId = IAttesterView(t.primaryAttester).cohortId();
        t.escalationCohortId = IAttesterView(t.escalationAttester).cohortId();

        _assertLinkedLibrary(t.settlementLib);
        _assertCohortSeparation(t.primaryAttester, t.escalationAttester);
        // GATE 1, re-derived from chain state alone. This is what makes route diversity checkable by a
        // reviewer who holds only the factory address and this build — no artifact, no env, no trust.
        (t.signerOverlap, t.quorumFloor) = _assertOnChainRouteDiversity(t.primaryAttester, t.escalationAttester);
        // GATE 2's readings, recorded so the artifact can state them rather than imply them.
        t.primaryEnabled = IAttesterView(t.primaryAttester).enabled();
        t.escalationEnabled = IAttesterView(t.escalationAttester).enabled();
        t.primaryDisabledAt = IAttesterView(t.primaryAttester).disabledAt();
        t.escalationDisabledAt = IAttesterView(t.escalationAttester).disabledAt();
        _assertPins(f, t.primaryAttester, t.schemaUid);
        _assertNetworkPolicy(t.primaryAttester, t.escalationAttester);
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                       DEPLOY PIPELINE
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    function _deploy(Inputs memory i) internal {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        // ── Pre-flight. Everything here runs BEFORE any broadcast, so a failure sends nothing. ───────
        _assertPreflight(i);

        (address predPrimary, address predEscalation, address predFactory) = _predictAll(i);
        // GATE 1 + GATE 2 against whatever is ALREADY on chain at the predicted addresses. Still
        // pre-broadcast: the first `vm.startBroadcast` is inside `_deployAttester`, below.
        _assertCohortsBeforeBroadcast(predPrimary, predEscalation);
        _guardAgainstRivalDeployment(i, predFactory);

        console2.log("== V-next settlement stack : DEPLOY ==");
        console2.log("mode:                ", i.mode);
        console2.log("chainId:             ", block.chainid);
        console2.log("deployer (gas only): ", vm.addr(deployerKey));
        console2.log("library (linked):    ", address(VNextSettlementLib));

        // ── 2. attesters — two separate deployments, disjoint revokers (H-02) ───────────────────────
        //      (step 1, the library, was already deployed by forge before this function ran.)
        address primary = _deployAttester(deployerKey, i, i.primary, VNextDeploySpec.TAG_PRIMARY_ATTESTER, predPrimary);
        address escalation =
            _deployAttester(deployerKey, i, i.escalation, VNextDeploySpec.TAG_ESCALATION_ATTESTER, predEscalation);

        // ── 3. factory — ONE transaction that also builds the implementation and runs all five gates ─
        if (predFactory.code.length == 0) {
            vm.startBroadcast(deployerKey);
            new VNextSettlementEscrowFactory{salt: _factorySalt(i)}(
                i.usdc, primary, escalation, i.schemaUid, IAttesterView(primary).o5TypeHash()
            );
            vm.stopBroadcast();
        } else {
            console2.log("factory already deployed - skipping (idempotent re-run)");
        }
        require(predFactory.code.length > 0, "factory not present at the predicted address after deployment");

        Tuple memory t = _verify(predFactory);
        // `verify` re-derives from chain; cross-check it against what THIS run intended to deploy, so a
        // resumed run that finds pre-existing contracts cannot silently adopt someone else's cohort.
        require(t.primaryAttester == primary, "resumed factory is bound to a different primary attester");
        require(t.escalationAttester == escalation, "resumed factory is bound to a different escalation cohort");
        require(t.usdc == i.usdc, "resumed factory is bound to a different settlement asset");

        _writeArtifact(i, t);
        _printHandoff(i, t);
    }

    function _deployAttester(
        uint256 deployerKey,
        Inputs memory i,
        CohortInput memory c,
        string memory tag,
        address predicted
    ) internal returns (address) {
        if (predicted.code.length > 0) {
            console2.log("already deployed - skipping (idempotent re-run):", tag, predicted);
            return predicted;
        }
        bytes32 salt = VNextDeploySpec.contractSalt(i.mode, block.chainid, tag, i.label);
        vm.startBroadcast(deployerKey);
        if (i.attesterType == AttesterType.FIXED_2OF3) {
            new Fixed2of3O5Attester{salt: salt}(
                c.signer0, c.signer1, c.signer2, i.eas, i.schemaUid, c.cohortId, c.revoker
            );
        } else {
            new SingleSignerO5Attester{salt: salt}(c.signer0, i.eas, i.schemaUid, c.cohortId, c.revoker);
        }
        vm.stopBroadcast();
        require(predicted.code.length > 0, "attester not present at the predicted address after deployment");
        console2.log("deployed:", tag, predicted);
        return predicted;
    }

    /// @dev A provisional deployment settles in a THROWAWAY token it deploys itself, so it is structurally
    ///      incapable of moving the real settlement asset even if someone mistakes it for canonical.
    ///      `escrow.USDC()` is public, so this is checkable on-chain from the escrow alone.
    function _deployProvisionalUsdc(string memory label) internal returns (address predicted) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        bytes32 salt = _provisionalUsdcSalt(label);
        predicted = _predictProvisionalUsdc(label);
        if (predicted.code.length == 0) {
            vm.startBroadcast(deployerKey);
            new MockUSDC{salt: salt}(PROVISIONAL_USDC_SUPPLY);
            vm.stopBroadcast();
        }
        require(predicted.code.length > 0, "provisional MockUSDC missing after deployment");
        console2.log("provisional MockUSDC (NOT a real settlement asset):", predicted);
    }

    function _provisionalUsdcSalt(string memory label) internal view returns (bytes32) {
        return VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_PROVISIONAL, block.chainid, VNextDeploySpec.TAG_PROVISIONAL_USDC, label
        );
    }

    function _predictProvisionalUsdc(string memory label) internal view returns (address) {
        return VNextDeploySpec.create2Address(
            _provisionalUsdcSalt(label),
            keccak256(abi.encodePacked(type(MockUSDC).creationCode, abi.encode(PROVISIONAL_USDC_SUPPLY)))
        );
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                        ASSERTIONS
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The guards that depend on nothing but the toolchain and the RPC. Run FIRST, and separately, so
    ///      a misconfigured invocation cannot spend gas before it is caught.
    function _assertToolchain() internal view {
        // THE `--libraries` GUARD, and the most important assertion in this file.
        //
        // Forge links this script against a library it deploys itself at
        // `create2(CREATE2_DEPLOYER, 0, keccak(libInitCode))`, taking the initcode from THIS compilation.
        // Re-deriving that address from the artifact and requiring a match proves two things at once:
        //   1. the build is linked at all;
        //   2. it is linked to a library built from THIS compilation — not one supplied via
        //      `--libraries`, whose value would have altered the metadata inside `libInitCode` and so
        //      moved this computed address away from the supplied one. A stray flag therefore fails
        //      HERE, before any broadcast, instead of surfacing as a `LinkedLibraryMismatch` revert
        //      inside the factory's constructor with no explanation attached.
        require(address(VNextSettlementLib) != address(0), "unlinked build");
        require(
            address(VNextSettlementLib) == VNextDeploySpec.forgeLibraryAddress(keccak256(vm.getCode(LIB_ARTIFACT))),
            "linked library is not the one forge builds from this compilation - do NOT pass --libraries"
        );
        // Independent confirmation for the case where the deployed code is not what the artifact says.
        _assertLinkedLibrary(address(VNextSettlementLib));

        require(
            VNextDeploySpec.CREATE2_DEPLOYER.code.length > 0,
            "CREATE2 deployer absent on this chain - every predicted address would be wrong"
        );
        require(
            block.chainid == vm.envUint("VNEXT_EXPECT_CHAIN_ID"),
            "block.chainid != VNEXT_EXPECT_CHAIN_ID - wrong RPC for the intended network"
        );
    }

    /// @dev Everything else that must hold BEFORE a single transaction is broadcast.
    function _assertPreflight(Inputs memory i) internal view {
        _assertToolchain();
        require(i.usdc.code.length > 0, "settlement asset has no code on this chain");
        require(i.eas != address(0), "VNEXT_EAS is zero - the attester constructor rejects it");

        // Cohort inputs, checked before they can waste a deployment.
        require(i.primary.cohortId != i.escalation.cohortId, "primary and escalation share a cohort id");
        require(i.primary.revoker != i.escalation.revoker, "H-02: the two cohorts share a kill-switch holder");
        // GATE 1 at the input level — the only level available before either cohort exists. Additional to
        // the distinct-revoker check above, never a replacement for it: a shared revoker and a shared
        // quorum are different failures.
        _assertInputRouteDiversity(i);

        // Mode <-> cohort band. This is the tag that survives reading only the artifact, so it is enforced
        // rather than documented.
        bool provisionalMode = keccak256(bytes(i.mode)) == keccak256(bytes(VNextDeploySpec.MODE_PROVISIONAL));
        if (provisionalMode) {
            require(
                VNextDeploySpec.isProvisionalCohort(i.primary.cohortId)
                    && VNextDeploySpec.isProvisionalCohort(i.escalation.cohortId),
                "provisional cohorts must sit in the provisional band (>= 0xF000000000000000)"
            );
        } else {
            require(
                !VNextDeploySpec.isProvisionalCohort(i.primary.cohortId)
                    && !VNextDeploySpec.isProvisionalCohort(i.escalation.cohortId),
                "canonical cohorts must NOT use a provisional-band cohort id"
            );
        }

        // Network policy.
        if (block.chainid == VNextDeploySpec.CHAIN_BASE) {
            require(!provisionalMode, "provisional deployments are forbidden on Base mainnet");
            require(
                i.attesterType == AttesterType.FIXED_2OF3,
                "Base mainnet requires Fixed2of3O5Attester - SingleSignerO5Attester is testnet-only"
            );
        } else if (block.chainid != VNextDeploySpec.CHAIN_BASE_SEPOLIA) {
            require(
                vm.envOr("VNEXT_ALLOW_UNKNOWN_CHAIN", uint256(0)) == 1,
                "unknown chain - set VNEXT_ALLOW_UNKNOWN_CHAIN=1 to proceed deliberately"
            );
        }

        // Size ceilings, asserted rather than assumed. The transaction actually sent carries the FACTORY's
        // initcode (its constructor CREATEs the escrow), so that is the number EIP-3860 bounds here.
        require(
            type(VNextSettlementEscrowFactory).creationCode.length <= MAX_INITCODE,
            "factory initcode exceeds the EIP-3860 ceiling"
        );
        require(vm.getDeployedCode(ESCROW_ARTIFACT).length <= MAX_RUNTIME, "escrow runtime exceeds EIP-170");
    }

    /// @dev Reproduce the escrow constructor's linked-library gate independently
    ///      (`VNextSettlementEscrow.sol:594-600`). The factory's existence already proves the gate passed
    ///      — its construction reverts `LinkedLibraryMismatch` otherwise — but reproducing it here means a
    ///      future refactor that removes the on-chain gate cannot silently remove the check too.
    function _assertLinkedLibrary(address lib) internal view {
        require(lib.code.length > 0, "linked library has no code");
        bytes memory template = vm.getDeployedCode(LIB_ARTIFACT);
        require(template.length > 21, "library runtime too short for a call-protection prologue");
        require(uint8(template[0]) == 0x73, "library prologue is not PUSH20 - splice model is stale");
        require(uint8(template[21]) == 0x30, "library prologue byte 21 is not ADDRESS - splice model stale");
        _spliceLibraryAddress(template, lib);
        require(keccak256(template) == lib.codehash, "linked library codehash != this build's library");
    }

    /// @dev The escrow constructor's splice (`VNextSettlementEscrow.sol:596-599`), restated without
    ///      assembly: overwrite the 20-byte `PUSH20` operand at offsets 1..20 with the library address and
    ///      leave every other byte alone. The constructor does the same thing with one `mstore`; a
    ///      divergence between the two cannot go unnoticed, because the caller compares the result against
    ///      the library's live `EXTCODEHASH`.
    function _spliceLibraryAddress(bytes memory template, address lib) private pure {
        uint160 v = uint160(lib);
        for (uint256 k; k < 20; ++k) {
            template[1 + k] = bytes1(uint8(v >> (8 * (19 - k))));
        }
    }

    /// @dev The 20-byte address stored at `b[at .. at+19]`.
    function _readAddress20(bytes memory b, uint256 at) private pure returns (address) {
        uint160 v;
        for (uint256 k; k < 20; ++k) {
            v = (v << 8) | uint160(uint8(b[at + k]));
        }
        return address(v);
    }

    /// @dev H-02 (`VNextSettlementEscrow.sol:609`) plus the two properties the constructor does NOT check.
    function _assertCohortSeparation(address primary, address escalation) internal view {
        require(primary != escalation, "escalation cohort == primary cohort");
        IAttesterView p = IAttesterView(primary);
        IAttesterView e = IAttesterView(escalation);
        require(p.revoker() != e.revoker(), "H-02: the two cohorts share a kill-switch holder");
        require(p.cohortId() != e.cohortId(), "the two cohorts share a cohort id");
        // NOT enforced by any constructor: a cohort that was already `disable()`d deploys fine and leaves
        // the whole deployment refund-only from block one. Fail here instead of discovering it at the
        // first release.
        require(p.enabled(), "primary cohort is already disabled - the deployment would be refund-only");
        require(e.enabled(), "escalation cohort is already disabled - no emergency verdict could be written");
        require(p.disabledAt() == 0 && e.disabledAt() == 0, "a cohort carries a disable timestamp");
    }

    /// @dev M-02 / L-02 (`VNextSettlementEscrow.sol:614`, `:619`) — the escrow constructor pins these
    ///      against the PRIMARY cohort's live getters, and the factory republishes them (Wave 4c).
    function _assertPins(VNextSettlementEscrowFactory f, address primary, bytes32 schemaUid) internal view {
        require(schemaUid != bytes32(0), "O5 schema UID is zero - the deploy-time pin would be skipped");
        require(f.o5SchemaUid() == schemaUid, "factory republished a different schema UID");
        require(IAttesterView(primary).o5SchemaUid() == schemaUid, "primary cohort schema UID != the pin");
        require(f.o5TypeHash() == IAttesterView(primary).o5TypeHash(), "factory type-hash pin != cohort's live value");
        require(f.o5TypeHash() != bytes32(0), "type-hash pin is zero - the deploy-time pin would be skipped");
    }

    /// @dev The attester TYPE wired must be the one this network is allowed to use. Probed by selector
    ///      rather than trusted from configuration, so `verify()` can establish it from chain state alone:
    ///      `signer0()` exists only on {Fixed2of3O5Attester}, `signer()` only on {SingleSignerO5Attester}.
    function _assertNetworkPolicy(address primary, address escalation) internal view {
        if (block.chainid != VNextDeploySpec.CHAIN_BASE) return;
        require(_isFixed2of3(primary), "Base mainnet: primary cohort is not a Fixed2of3O5Attester");
        require(_isFixed2of3(escalation), "Base mainnet: escalation cohort is not a Fixed2of3O5Attester");
        require(
            !VNextDeploySpec.isProvisionalCohort(IAttesterView(primary).cohortId()),
            "Base mainnet: primary cohort id sits in the provisional band"
        );
    }

    function _isFixed2of3(address attester) internal view returns (bool) {
        (bool ok, bytes memory ret) = attester.staticcall(abi.encodeWithSignature("signer0()"));
        return ok && ret.length == 32;
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                     GATE 1 — ROUTE DIVERSITY (§2.5). A DEPLOYMENT INVARIANT.
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //
    // WHY THIS CANNOT LIVE IN THE ESCROW, and therefore MUST live here.
    //   `VNextSettlementEscrow`'s constructor enforces `escalation != oracle` (`:574`) and distinct
    //   revokers (`:609`). Neither implies route diversity: two DIFFERENT attester ADDRESSES can hold the
    //   SAME signer set, and both sets are immutable, so address inequality proves nothing about who
    //   actually decides. If the sets overlap enough to form a quorum on both routes, the "appeal" is the
    //   primary reviewing itself and §2.5 is silently unsatisfied while every on-chain check still passes.
    //   The escrow deliberately cannot close this: the signer getters belong to the CONCRETE attester
    //   (`Fixed2of3O5Attester.signer0/1/2`, `SingleSignerO5Attester.signer`), not to `IOracleAttester`, and
    //   requiring them would forbid every other quorum shape the interface is meant to admit. So the
    //   invariant is mechanical HERE or nowhere — and "nowhere" is what the audit found.
    //
    // THE RULE: no quorum-sized group can control both routes.
    //   abort if  |primary.signers ∩ escalation.signers|  >=  min(primary.threshold, escalation.threshold)
    //   Taking the MINIMUM is the load-bearing choice: a 2-of-3 primary appealed to a 1-of-1 escalation is
    //   captured by ONE shared key, so the floor must be that route's 1, not the primary's 2.
    //
    // THE LAUNCH POLICY: fully disjoint by default.
    //   Any overlap at all — even a sub-quorum one — needs an explicit `VNEXT_ALLOW_SIGNER_OVERLAP=1`.
    //   The threshold rule above still applies with the flag set; the flag buys sub-quorum overlap, never
    //   a shared quorum. One shared key in a 2-of-3 pair is one compromise away from being a shared
    //   quorum, so it is a deliberate act with a name on it, not a default.

    /// @dev Enforce {GATE 1} against the CONFIGURED INPUTS, before any cohort exists. Returns the measured
    ///      `(overlap, quorumFloor)` so callers can surface them.
    function _assertInputRouteDiversity(Inputs memory i) internal view returns (uint256, uint256) {
        return _routeDiversity(
            _routeOfInput(i.primary, i.attesterType), _routeOfInput(i.escalation, i.attesterType), "configured inputs"
        );
    }

    /// @dev Enforce {GATE 1} against two DEPLOYED cohorts, reading each signer set from the concrete
    ///      attester type. This is the form `verify(address)` uses, so a reviewer holding nothing but a
    ///      factory address re-runs the invariant against chain state.
    function _assertOnChainRouteDiversity(address primary, address escalation)
        internal
        view
        returns (uint256, uint256)
    {
        return _routeDiversity(_routeOf(primary), _routeOf(escalation), "deployed cohorts");
    }

    /// @dev The one implementation of the rule. Both entry points above funnel here so the pre-deploy check
    ///      and the post-deploy re-derivation can never drift apart.
    function _routeDiversity(Route memory p, Route memory e, string memory source)
        internal
        view
        returns (uint256 overlap, uint256 quorumFloor)
    {
        overlap = _routeOverlap(p, e);
        quorumFloor = p.threshold < e.threshold ? p.threshold : e.threshold;
        require(quorumFloor > 0, "route diversity: a cohort reports a zero quorum - refusing to reason about it");

        console2.log("route diversity:", source);
        console2.log("  signer-set intersection:", overlap);
        console2.log("  quorum floor min(thresholds):", quorumFloor);

        // THE RULE. A group this large is a quorum on at least one route while also sitting on the other,
        // so it can decide the primary verdict AND its own appeal. Not overridable by any flag.
        require(
            overlap < quorumFloor,
            "GATE 1 route diversity: a quorum-sized group of signers sits on BOTH routes - the escalation "
            "cohort could ratify its own primary verdict. Give the escalation cohort independent keys."
        );

        // THE LAUNCH POLICY. Sub-quorum overlap is survivable but is never the default.
        if (overlap != 0) {
            require(
                _signerOverlapAllowed(),
                "GATE 1 route diversity: the two cohorts share a signer. Launch policy is FULLY DISJOINT "
                "signer sets. To accept sub-quorum overlap deliberately, set VNEXT_ALLOW_SIGNER_OVERLAP=1."
            );
            console2.log("  WARNING: VNEXT_ALLOW_SIGNER_OVERLAP=1 - shipping a cohort pair with shared signers.");
        }
    }

    /// @dev `|a ∩ b|`. Each DISTINCT member of `a` is counted at most once. Both attester constructors
    ///      already reject duplicates (`Fixed2of3O5Attester.sol:32`), but an intersection count has to be
    ///      correct on its own terms rather than by borrowing another contract's invariant.
    function _routeOverlap(Route memory a, Route memory b) internal pure returns (uint256 n) {
        for (uint256 x; x < a.size; ++x) {
            bool alreadyCounted;
            for (uint256 k; k < x; ++k) {
                if (a.signers[k] == a.signers[x]) alreadyCounted = true;
            }
            if (alreadyCounted) continue;
            for (uint256 y; y < b.size; ++y) {
                if (a.signers[x] == b.signers[y]) {
                    n++;
                    break;
                }
            }
        }
    }

    /// @dev The route a DEPLOYED cohort actually implements, probed by selector rather than trusted from
    ///      configuration — the same technique {_assertNetworkPolicy} uses, for the same reason: it must
    ///      work in `verify()`, where the only input is an address.
    /// @dev    An UNRECOGNISED shape ABORTS. That is the point: a quorum this script cannot read is a
    ///         quorum it cannot prove diverse, and silently passing an unreadable cohort would make the
    ///         whole gate vacuous exactly when a new attester type is introduced.
    function _routeOf(address attester) internal view returns (Route memory r) {
        require(attester.code.length > 0, "route diversity: no code at the cohort address");
        if (_isFixed2of3(attester)) {
            Fixed2of3O5Attester a = Fixed2of3O5Attester(attester);
            r.signers = [a.signer0(), a.signer1(), a.signer2()];
            r.size = 3;
            r.threshold = FIXED_2OF3_THRESHOLD;
            return r;
        }
        if (_isSingleSigner(attester)) {
            r.signers[0] = SingleSignerO5Attester(attester).signer();
            r.size = 1;
            r.threshold = SINGLE_SIGNER_THRESHOLD;
            return r;
        }
        revert(
            "route diversity: unrecognised attester shape - neither signer0() nor signer(). Teach _routeOf "
            "how to read this cohort's signer set before deploying it; an unreadable quorum cannot be proven diverse."
        );
    }

    /// @dev The route the CONFIGURED INPUTS describe, for the pre-deploy check where no cohort exists yet.
    function _routeOfInput(CohortInput memory c, AttesterType t) internal pure returns (Route memory r) {
        if (t == AttesterType.FIXED_2OF3) {
            r.signers = [c.signer0, c.signer1, c.signer2];
            r.size = 3;
            r.threshold = FIXED_2OF3_THRESHOLD;
        } else {
            r.signers[0] = c.signer0;
            r.size = 1;
            r.threshold = SINGLE_SIGNER_THRESHOLD;
        }
    }

    function _isSingleSigner(address attester) internal view returns (bool) {
        (bool ok, bytes memory ret) = attester.staticcall(abi.encodeWithSignature("signer()"));
        return ok && ret.length == 32;
    }

    function _signerOverlapAllowed() internal view returns (bool) {
        return vm.envOr("VNEXT_ALLOW_SIGNER_OVERLAP", uint256(0)) == 1;
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                  GATE 2 — BOTH COHORTS ALIVE, ASSERTED BEFORE ANY BROADCAST
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //
    // A cohort that was already `disable()`d passes the factory constructor without complaint — nothing in
    // `VNextSettlementEscrow`'s constructor reads `enabled` — so a stack can be deployed, permanently,
    // bound to a dead cohort that `fund()` will reject forever. The deployment cannot be undone and the
    // gas is spent. {_verify} has always caught it (`_assertCohortSeparation`), but {_verify} runs AFTER
    // the factory is broadcast, which is one transaction too late. This runs BEFORE.

    /// @dev Everything that must hold about the cohorts themselves before the first transaction is sent.
    ///      A predicted address with NO code is a cohort this run is about to create: it is `enabled` by
    ///      construction (`O5AttesterBase.sol:225`) and has no signer set to read yet, so it is checked at
    ///      the INPUT level in {_assertPreflight} instead. A predicted address WITH code is a cohort this
    ///      run is about to ADOPT — that is the case that can be dead, or a rival shape, and it is read
    ///      here from chain state.
    function _assertCohortsBeforeBroadcast(address primary, address escalation) internal view {
        bool haveP = primary.code.length > 0;
        bool haveE = escalation.code.length > 0;
        if (haveP) _assertCohortAlive(primary, "primary");
        if (haveE) _assertCohortAlive(escalation, "escalation");
        // Both already on chain ⇒ read the REAL signer sets rather than trusting the inputs that predicted
        // them. Belt and braces: CREATE2 already ties the code at a predicted address to these inputs.
        if (haveP && haveE) _assertOnChainRouteDiversity(primary, escalation);
    }

    /// @dev GATE 2, one cohort. `enabled` and `disabledAt` are checked TOGETHER because they are one
    ///      one-way move written to the same slot (`O5AttesterBase.sol:235-239`); disagreement between
    ///      them would itself be evidence the cohort is not what it claims.
    function _assertCohortAlive(address attester, string memory which) internal view {
        IAttesterView a = IAttesterView(attester);
        require(
            a.enabled(),
            string.concat(
                "GATE 2 dead cohort: the ",
                which,
                " cohort is already disabled. A factory bound to it would "
                "deploy fine and then reject every fund() forever. Deploy a fresh cohort."
            )
        );
        require(
            a.disabledAt() == 0, string.concat("GATE 2 dead cohort: the ", which, " cohort carries a disable timestamp")
        );
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                    PREDICTION + ARTIFACT
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    function _predictAll(Inputs memory i) internal returns (address primary, address escalation, address factory) {
        primary = _predictAttester(i, i.primary, VNextDeploySpec.TAG_PRIMARY_ATTESTER);
        escalation = _predictAttester(i, i.escalation, VNextDeploySpec.TAG_ESCALATION_ATTESTER);
        // The factory's initcode embeds its constructor args, INCLUDING the two attester addresses — so a
        // different cohort is a different factory address, never a silent re-binding of the same one.
        factory = VNextDeploySpec.create2Address(
            _factorySalt(i),
            keccak256(
                abi.encodePacked(
                    type(VNextSettlementEscrowFactory).creationCode,
                    abi.encode(i.usdc, primary, escalation, i.schemaUid, _typeHashFor(primary))
                )
            )
        );
    }

    function _predictAttester(Inputs memory i, CohortInput memory c, string memory tag)
        internal
        view
        returns (address)
    {
        bytes32 salt = VNextDeploySpec.contractSalt(i.mode, block.chainid, tag, i.label);
        bytes memory initCode = i.attesterType == AttesterType.FIXED_2OF3
            ? abi.encodePacked(
                type(Fixed2of3O5Attester).creationCode,
                abi.encode(c.signer0, c.signer1, c.signer2, i.eas, i.schemaUid, c.cohortId, c.revoker)
            )
            : abi.encodePacked(
                type(SingleSignerO5Attester).creationCode,
                abi.encode(c.signer0, i.eas, i.schemaUid, c.cohortId, c.revoker)
            );
        return VNextDeploySpec.create2Address(salt, keccak256(initCode));
    }

    /// @dev `o5TypeHash()` is `external pure` on {O5AttesterBase} (line 253) — a compile-time constant of
    ///      this build, so it is knowable before the cohort exists. Read from the LIVE cohort once it does
    ///      (which is what catches a cohort built from a different revision), and from this build itself
    ///      beforehand.
    function _typeHashFor(address primary) internal returns (bytes32) {
        if (primary.code.length > 0) return IAttesterView(primary).o5TypeHash();
        return _o5TypeHashOfThisBuild();
    }

    /// @dev The O5 EIP-712 type hash this build's attesters return. The constant behind `o5TypeHash()` is
    ///      `private` on {O5AttesterBase} (line 132), so the honest way to obtain it without restating the
    ///      type string is to instantiate a throwaway cohort in the script's LOCAL EVM and ask it — a
    ///      restated literal here is exactly the drift the L-02 pin exists to catch. Created OUTSIDE any
    ///      broadcast, so it is never a transaction and never leaves this process. Constructor arguments
    ///      are the smallest values its own guards accept (non-zero signer / eas / revoker, revoker !=
    ///      signer); none of them influence a `pure` return.
    function _o5TypeHashOfThisBuild() internal returns (bytes32) {
        return new SingleSignerO5Attester(address(1), address(2), bytes32(0), 0, address(3)).o5TypeHash();
    }

    function _factorySalt(Inputs memory i) internal view returns (bytes32) {
        return VNextDeploySpec.contractSalt(i.mode, block.chainid, VNextDeploySpec.TAG_FACTORY, i.label);
    }

    /// @notice Prove the ON-CHAIN implementation delegates to `lib`, and to nothing else, at every one of
    ///         this build's library call sites.
    /// @dev    WHAT THIS DOES AND DOES NOT CLAIM. `vm.getDeployedCode` hands back an ALREADY-LINKED
    ///         template (forge resolves the placeholders before returning it), so there are no zero-filled
    ///         placeholders left to scan for and "recover the library address from the bytecode" is not
    ///         available. What IS available, and is stronger where it matters, is a direct count: scan the
    ///         deployed runtime for `PUSH20 <lib>` and require exactly {LINK_SITES} occurrences — the 3
    ///         `delegatecall` targets on the funding path. An implementation linked to a DIFFERENT library
    ///         yields zero hits and aborts.
    ///         So the honest statement of {verify}'s guarantee is: "this on-chain factory and
    ///         implementation match THIS BUILD, including its library" — not "the tuple was reconstructed
    ///         from an address with no other input". The build is an input, which is why the artifact
    ///         records the solc version and optimizer settings alongside the addresses.
    function _assertImplementationLinkedTo(address implementation, address lib) internal view {
        bytes memory template = vm.getDeployedCode(ESCROW_ARTIFACT);
        bytes memory onchain = implementation.code;
        require(template.length == onchain.length, "implementation runtime length != this build's escrow");
        uint256 hits;
        for (uint256 p; p + 21 <= onchain.length; ++p) {
            if (uint8(onchain[p]) != 0x73) continue;
            if (_readAddress20(onchain, p + 1) == lib) hits++;
        }
        console2.log("library call sites found in the deployed implementation:", hits);
        require(hits == LINK_SITES, "implementation does not delegate to this build's library at every site");
    }

    function _guardAgainstRivalDeployment(Inputs memory i, address predictedFactory) internal view {
        string memory path = _artifactPath(i);
        if (!vm.exists(path)) return;
        address recorded = vm.parseJsonAddress(vm.readFile(path), ".factory");
        require(
            recorded == predictedFactory,
            "an artifact already records a DIFFERENT factory for this mode/chain/label - inputs changed. "
            "Bump VNextDeploySpec.SPEC_VERSION (or use a new VNEXT_LABEL) to publish deliberately."
        );
    }

    /// @dev A DRY RUN writes to a `DRYRUN-` path, never to the deployment record.
    ///      Forge executes the script body in full whether or not `--broadcast` is passed, so without this
    ///      split a simulation would leave a file asserting a deployment that does not exist — and would
    ///      poison {_guardAgainstRivalDeployment}, whose whole job is to refuse a second deployment. The
    ///      dry-run tuple is still written, because producing a reviewable tuple before anything is spent
    ///      is the point of the dry run; it is just kept where it cannot be mistaken for the real record.
    function _artifactPath(Inputs memory i) internal view returns (string memory) {
        string memory dir = string.concat("deployments/vnext/", VNextDeploySpec.networkSlug(block.chainid), "/");
        string memory prefix = _isBroadcasting() ? "" : "DRYRUN-";
        if (keccak256(bytes(i.mode)) == keccak256(bytes(VNextDeploySpec.MODE_PROVISIONAL))) {
            return string.concat(dir, prefix, "PROVISIONAL-", i.label, ".json");
        }
        return string.concat(dir, prefix, "CANONICAL.json");
    }

    function _isBroadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    function _writeArtifact(Inputs memory i, Tuple memory t) internal {
        bool canonical = keccak256(bytes(i.mode)) == keccak256(bytes(VNextDeploySpec.MODE_CANONICAL));
        string memory j = "vnext";
        // Non-canonicity is the FIRST thing a reader sees, and it is restated three ways.
        vm.serializeBool(j, "canonical", canonical);
        vm.serializeBool(j, "doNotPin", !canonical);
        vm.serializeString(j, "mode", i.mode);
        vm.serializeString(j, "label", i.label);
        // A simulated tuple is REAL data about what a deploy would produce, and NOT evidence that anything
        // exists on chain. Both facts belong in the file.
        vm.serializeBool(j, "broadcast", _isBroadcasting());
        vm.serializeString(
            j,
            "provisionalTagOnChain",
            canonical
                ? "n/a"
                : "cohortId >= 0xF000000000000000 - read it with: cast call <primaryAttester> 'cohortId()(uint64)'"
        );
        // The four fields the oracle lane pins.
        vm.serializeAddress(j, "factory", t.factory);
        vm.serializeAddress(j, "implementation", t.implementation);
        vm.serializeAddress(j, "library", t.settlementLib);
        vm.serializeBytes32(j, "implementationCodehash", t.implementationCodehash);
        // What VCR asked for explicitly.
        vm.serializeBytes32(j, "libraryCodehash", t.libraryCodehash);
        // Everything needed to re-derive the above.
        vm.serializeAddress(j, "primaryAttester", t.primaryAttester);
        vm.serializeAddress(j, "escalationAttester", t.escalationAttester);
        vm.serializeAddress(j, "usdc", t.usdc);
        vm.serializeBytes32(j, "o5SchemaUid", t.schemaUid);
        vm.serializeBytes32(j, "o5TypeHash", t.typeHash);
        vm.serializeUint(j, "primaryCohortId", t.primaryCohortId);
        vm.serializeUint(j, "escalationCohortId", t.escalationCohortId);
        // ── The two deploy gates, stated as numbers a human can check by eye. ──────────────────────────
        // GATE 1: `signerSetIntersection < quorumFloor` is the invariant; `== 0` is the launch policy.
        vm.serializeUint(j, "signerSetIntersection", t.signerOverlap);
        vm.serializeUint(j, "quorumFloor", t.quorumFloor);
        vm.serializeBool(j, "signerSetsFullyDisjoint", t.signerOverlap == 0);
        vm.serializeBool(j, "signerOverlapExplicitlyAllowed", _signerOverlapAllowed());
        // GATE 2: both cohorts alive at deploy time.
        vm.serializeBool(j, "primaryEnabled", t.primaryEnabled);
        vm.serializeBool(j, "escalationEnabled", t.escalationEnabled);
        vm.serializeUint(j, "primaryDisabledAt", t.primaryDisabledAt);
        vm.serializeUint(j, "escalationDisabledAt", t.escalationDisabledAt);
        vm.serializeString(
            j,
            "routeDiversityRule",
            "GATE 1: signerSetIntersection < quorumFloor = min(primaryThreshold, escalationThreshold). "
            "Re-derivable from chain state with --sig 'verify(address)'; these fields are NOT in `digest`."
        );
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeUint(j, "specVersion", VNextDeploySpec.SPEC_VERSION);
        vm.serializeUint(j, "blockNumber", block.number);
        // A codehash is only meaningful relative to a build, so the build is part of the record.
        vm.serializeString(j, "solc", "0.8.24");
        vm.serializeString(j, "optimizer", "enabled, runs=200");
        vm.serializeString(
            j, "reverify", "forge script script/DeployVNextSettlement.s.sol --sig 'verify(address)' <factory>"
        );
        string memory finalJson = vm.serializeBytes32(j, "digest", _digest(t));
        string memory path = _artifactPath(i);
        // `vm.writeJson` does not create intermediate directories, and a deploy that succeeded on-chain
        // but failed to record its tuple is the worst outcome available here.
        vm.createDir(string.concat("deployments/vnext/", VNextDeploySpec.networkSlug(block.chainid)), true);
        vm.writeJson(finalJson, path);
        console2.log("wrote artifact:", path);
    }

    /// @notice Self-digest over the tuple. Cheap integrity for the FILE; the real tamper-evidence is
    ///         {verify}, which re-derives every field from chain state and needs no digest at all.
    /// @dev    PREIMAGE, so an off-chain consumer can reproduce it: fifteen 32-byte STATIC words, in this
    ///         order, ABI-encoded and hashed —
    ///           keccak256(NAMESPACE), SPEC_VERSION, chainId, factory, implementation, library,
    ///           implementationCodehash, libraryCodehash, primaryAttester, escalationAttester, usdc,
    ///           o5SchemaUid, o5TypeHash, primaryCohortId, escalationCohortId.
    ///         The namespace is HASHED rather than embedded so every word is static — which is what lets
    ///         the encoding be split across two `abi.encode` calls without changing the result. The split
    ///         itself is the stack-too-deep remedy the factory already uses for the same reason
    ///         (`VNextSettlementEscrowFactory.sol:293-319`): with all-static members,
    ///         `bytes.concat(abi.encode(a..h), abi.encode(i..o))` is byte-identical to `abi.encode(a..o)`.
    function _digest(Tuple memory t) internal view returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    keccak256(bytes(VNextDeploySpec.NAMESPACE)),
                    VNextDeploySpec.SPEC_VERSION,
                    block.chainid,
                    t.factory,
                    t.implementation,
                    t.settlementLib,
                    t.implementationCodehash,
                    t.libraryCodehash
                ),
                abi.encode(
                    t.primaryAttester,
                    t.escalationAttester,
                    t.usdc,
                    t.schemaUid,
                    t.typeHash,
                    t.primaryCohortId,
                    t.escalationCohortId
                )
            )
        );
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                          INPUT / OUTPUT
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    function _readInputs(string memory mode, string memory label) internal view returns (Inputs memory i) {
        bytes32 h = keccak256(bytes(mode));
        require(
            h == keccak256(bytes(VNextDeploySpec.MODE_CANONICAL))
                || h == keccak256(bytes(VNextDeploySpec.MODE_PROVISIONAL)),
            "mode must be CANONICAL or PROVISIONAL"
        );
        i.mode = mode;
        i.label = label;
        i.eas = vm.envAddress("VNEXT_EAS");
        i.schemaUid = vm.envBytes32("VNEXT_O5_SCHEMA_UID");
        i.attesterType = block.chainid == VNextDeploySpec.CHAIN_BASE
            ? AttesterType.FIXED_2OF3
            : (keccak256(bytes(vm.envOr("VNEXT_ATTESTER_TYPE", string("SINGLE_SIGNER"))))
                    == keccak256(bytes("FIXED_2OF3"))
                    ? AttesterType.FIXED_2OF3
                    : AttesterType.SINGLE_SIGNER);
        i.primary = _readCohort("VNEXT_PRIMARY_", i.attesterType);
        i.escalation = _readCohort("VNEXT_ESCALATION_", i.attesterType);
    }

    function _readCohort(string memory prefix, AttesterType t) internal view returns (CohortInput memory c) {
        c.signer0 = vm.envAddress(string.concat(prefix, "SIGNER_0"));
        if (t == AttesterType.FIXED_2OF3) {
            c.signer1 = vm.envAddress(string.concat(prefix, "SIGNER_1"));
            c.signer2 = vm.envAddress(string.concat(prefix, "SIGNER_2"));
        }
        c.revoker = vm.envAddress(string.concat(prefix, "REVOKER"));
        uint256 id = vm.envUint(string.concat(prefix, "COHORT_ID"));
        require(id <= type(uint64).max, "cohort id does not fit uint64");
        c.cohortId = uint64(id);
    }

    function _printTuple(Tuple memory t) internal pure {
        console2.log("factory:             ", t.factory);
        console2.log("implementation:      ", t.implementation);
        console2.log("library:             ", t.settlementLib);
        console2.log("implementation codehash:");
        console2.logBytes32(t.implementationCodehash);
        console2.log("library codehash:");
        console2.logBytes32(t.libraryCodehash);
        console2.log("primary attester:    ", t.primaryAttester);
        console2.log("escalation attester: ", t.escalationAttester);
        console2.log("settlement asset:    ", t.usdc);
        console2.log("GATE 1 signer-set intersection:", t.signerOverlap, "of quorum floor", t.quorumFloor);
        console2.log("GATE 2 primary enabled / escalation enabled:", t.primaryEnabled, t.escalationEnabled);
    }

    function _printHandoff(Inputs memory i, Tuple memory t) internal view {
        console2.log("");
        console2.log("--- PIN TUPLE (oracle lane c158bf91) ---");
        _printTuple(t);
        console2.log("");
        console2.log("--- VCR (9ff57f28) ---");
        console2.log("(D) escrow factory address:", t.factory);
        console2.log("(E) VNextSettlementLib runtime codehash:");
        console2.logBytes32(t.libraryCodehash);
        console2.log("");
        console2.log("mode:", i.mode);
        console2.log("artifact:", _artifactPath(i));
        console2.log("re-derive from the factory alone: --sig 'verify(address)'");
    }
}

/// @dev The read-only slice of {IOracleAttester} + {O5AttesterBase} this script needs. Declared locally so
///      `verify()` can interrogate any deployed cohort without importing the attester implementations.
interface IAttesterView {
    function revoker() external view returns (address);
    function cohortId() external view returns (uint64);
    function enabled() external view returns (bool);
    function disabledAt() external view returns (uint64);
    function o5SchemaUid() external view returns (bytes32);
    function o5TypeHash() external view returns (bytes32);
}
