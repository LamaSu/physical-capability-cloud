// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {VNextDeploySpec} from "./vnext/VNextDeploySpec.sol";

/**
 * @title DeployVNextSettlementLib
 * @notice PHASE 1 of 2 — deploys {VNextSettlementLib} deterministically, and NOTHING else.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ GATED on-chain action. SCRIPT-ONLY — DO NOT BROADCAST without explicit authorization.        │
 * │ Deploying publishes a permanent, immutable contract and spends gas. No automated pipeline    │
 * │ runs this with `--broadcast` (same posture as DeployProtocolV2/V3.s.sol).                    │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * @dev WHY THIS IS A SEPARATE FILE FROM PHASE 2 — the toolchain forces it, it is not a style choice.
 *
 *      {VNextSettlementLib} is an EXTERNAL linked library: three of its functions are `delegatecall`ed on
 *      the funding path, so `VNextSettlementEscrow.deployedBytecode` carries 3 unresolved placeholders and
 *      `VNextSettlementEscrowFactory.bytecode` carries 4 (the factory's CONSTRUCTOR builds the escrow, so
 *      the link lands one step earlier than a reader expects — the factory's RUNTIME has zero link
 *      references, measured). Any script contract that so much as names the factory therefore compiles to
 *      unlinked creation code, and `forge script` resolves that by DEPLOYING THE LIBRARY ITSELF as an
 *      extra transaction. That auto-deployment is the thing this phase exists to replace with something
 *      deterministic, so phase 1 must not be able to trigger it: this file imports nothing from `src/` and
 *      reaches the artifact through `vm.getCode` / `vm.getDeployedCode` instead.
 *
 *      The same constraint rules out `libraries = [...]` in `foundry.toml`: that would link the TEST build
 *      against a codeless address and break every funding test (30 suites / 918 tests). Phase 2 is linked
 *      per-invocation with `--libraries` instead, and asserts the address it got.
 *
 * WHAT IS ATOMIC / WHAT IS RESUMABLE
 *   - ATOMIC:    the single CREATE2 deployment. It either exists at the predicted address or it does not.
 *   - RESUMABLE: re-running is a no-op once deployed — same salt + same initcode ⇒ same address, and the
 *                script skips a non-empty address instead of deploying a rival library.
 *   - The library's initcode contains NO address (its constructor splices `ADDRESS` into the
 *     call-protection prologue at deploy time), so this address is identical on Base and Base Sepolia.
 *
 * USAGE
 *   Predict only (no RPC, no key, no gas):
 *     forge script script/DeployVNextSettlementLib.s.sol:DeployVNextSettlementLib --sig "predict()"
 *
 *   Simulate against a live chain (no `--broadcast` ⇒ nothing is sent):
 *     forge script script/DeployVNextSettlementLib.s.sol:DeployVNextSettlementLib \
 *       --sig "run()" --rpc-url base_sepolia
 *
 *   Deploy (ONLY when explicitly authorized):
 *     forge script script/DeployVNextSettlementLib.s.sol:DeployVNextSettlementLib \
 *       --sig "run()" --rpc-url base_sepolia --broadcast --verify -vvvv
 *
 * ENV
 *   DEPLOYER_PRIVATE_KEY  — required for `run()`; irrelevant to the resulting ADDRESS (CREATE2 is sent by
 *                           the deterministic proxy, not by this key), which is why the tuple can be
 *                           reviewed and agreed before anyone holds the key.
 *   VNEXT_MODE            — "CANONICAL" (default) or "PROVISIONAL".
 */
contract DeployVNextSettlementLib is Script {
    /// @dev Forge artifact identifier. Resolved from `out/`, so this script deploys exactly what was built.
    string internal constant LIB_ARTIFACT = "VNextSettlementLib.sol:VNextSettlementLib";

    /// @notice Predicted address + the codehash the escrow's constructor gate will demand. No RPC, no key,
    ///         no deployment — safe to run anywhere, and the cheapest possible review of phase 1's output.
    function predict() external view {
        (address predicted, bytes32 salt, bytes32 expectedCodehash) = _predict(_mode());
        console2.log("== VNextSettlementLib (phase 1) : PREDICT ==");
        console2.log("mode:                 ", _mode());
        console2.log("salt:");
        console2.logBytes32(salt);
        console2.log("predicted address:    ", predicted);
        console2.log("expected runtime codehash (post-splice):");
        console2.logBytes32(expectedCodehash);
        console2.log("note: address + codehash are chain-independent for this library.");
    }

    /// @notice Deploy the library deterministically, or confirm the existing one. Idempotent.
    function run() external returns (address lib) {
        string memory mode = _mode();
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        require(
            VNextDeploySpec.CREATE2_DEPLOYER.code.length > 0,
            "CREATE2 deployer absent on this chain - every predicted address would be wrong"
        );

        (address predicted, bytes32 salt, bytes32 expectedCodehash) = _predict(mode);
        console2.log("== VNextSettlementLib (phase 1) ==");
        console2.log("deployer (key only pays gas):", vm.addr(deployerKey));
        console2.log("chainId:                     ", block.chainid);
        console2.log("mode:                        ", mode);
        console2.log("predicted address:           ", predicted);

        if (predicted.code.length > 0) {
            // RESUME PATH. Not "assume it is fine" — re-prove it, because a mismatch here would mean the
            // address is occupied by something that is not this build's library, and every downstream
            // codehash pin would be wrong.
            console2.log("already deployed - skipping (idempotent re-run)");
            lib = predicted;
        } else {
            bytes memory initCode = vm.getCode(LIB_ARTIFACT);
            vm.startBroadcast(deployerKey);
            // A library cannot be instantiated with `new` in Solidity, so the deterministic proxy is
            // called directly with `salt ++ initcode` — the proxy's documented calldata layout.
            (bool ok,) = VNextDeploySpec.CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
            vm.stopBroadcast();
            require(ok, "CREATE2 library deployment reverted");
            lib = predicted;
        }

        // ── Post-deploy assertions: "exited 0" must mean "correct and pinnable" ─────────────────────
        require(lib.code.length > 0, "library address has no code after deployment");
        // The gate the escrow's constructor will run, reproduced here independently. If this fails, the
        // factory deployment in phase 2 would revert `LinkedLibraryMismatch` — catching it now costs
        // nothing and turns a confusing phase-2 revert into a phase-1 diagnosis.
        require(lib.codehash == expectedCodehash, "library codehash != escrow constructor expectation");

        console2.log("VNextSettlementLib:          ", lib);
        console2.log("runtime codehash (PIN THIS):");
        console2.logBytes32(lib.codehash);
        console2.log("");
        console2.log("--- phase 2 requires this address on the CLI ---");
        console2.log("--libraries src/libraries/VNextSettlementLib.sol:VNextSettlementLib:");
        console2.logAddress(lib);
    }

    /// @dev The predicted address, its salt, and the runtime codehash the escrow constructor will demand.
    ///      The codehash is derived exactly the way {VNextSettlementEscrow}'s constructor derives it
    ///      (`VNextSettlementEscrow.sol:594-600`): take this build's library runtime template — which ships
    ///      20 ZERO bytes as the PUSH20 operand of the call-protection prologue (`73 00..00 30 14`,
    ///      verified) — and splice the deployed address into offsets 1..20. Deriving it from the artifact
    ///      rather than from a recorded constant is deliberate: the library's runtime CONTAINS ITS OWN
    ///      ADDRESS, so there is no build-invariant "library codehash" to hardcode.
    function _predict(string memory mode)
        internal
        view
        returns (address predicted, bytes32 salt, bytes32 expectedCodehash)
    {
        salt = VNextDeploySpec.librarySalt(mode);
        predicted = VNextDeploySpec.create2Address(salt, keccak256(vm.getCode(LIB_ARTIFACT)));
        expectedCodehash = keccak256(spliceLibraryAddress(vm.getDeployedCode(LIB_ARTIFACT), predicted));
    }

    /// @notice The library runtime as it will exist on-chain once deployed at `lib`.
    /// @dev    Public so phase 2 and any reviewer can reproduce the expectation from the artifact alone.
    function spliceLibraryAddress(bytes memory template, address lib) public pure returns (bytes memory) {
        require(template.length > 21, "library runtime too short for a call-protection prologue");
        require(uint8(template[0]) == 0x73, "library prologue is not PUSH20 - splice model is stale");
        require(uint8(template[21]) == 0x30, "library prologue byte 21 is not ADDRESS - splice model stale");
        assembly ("memory-safe") {
            let p := add(template, 0x21) // 0x20 length word + the 1-byte PUSH20 opcode
            mstore(p, or(shl(96, lib), and(mload(p), shr(160, not(0)))))
        }
        return template;
    }

    function _mode() internal view returns (string memory mode) {
        mode = vm.envOr("VNEXT_MODE", VNextDeploySpec.MODE_CANONICAL);
        bytes32 h = keccak256(bytes(mode));
        require(
            h == keccak256(bytes(VNextDeploySpec.MODE_CANONICAL))
                || h == keccak256(bytes(VNextDeploySpec.MODE_PROVISIONAL)),
            "VNEXT_MODE must be CANONICAL or PROVISIONAL"
        );
    }
}
