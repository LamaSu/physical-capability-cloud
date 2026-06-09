// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Clones
 * @notice Minimal EIP-1167 minimal-proxy ("clone") deployment helpers.
 *
 * Inlined here to avoid pulling in OpenZeppelin as a dependency — the same
 * convention this repo already uses for IERC721Receiver (see ContributorNFT.sol)
 * and SafeERC20 (see libraries/SafeERC20.sol).
 *
 * A minimal proxy is a ~45-byte runtime contract that `delegatecall`s ALL calls
 * to a fixed implementation address. Each clone has its OWN address, OWN storage,
 * and OWN token balances, but shares the implementation's CODE (including
 * `immutable` values, which are baked into that shared code at impl-deploy time).
 *
 * This is the fault-isolation primitive for MilestoneEscrowV2: an exploit that
 * drains or bricks clone A operates only on A's storage/balance and physically
 * cannot reach clone B.
 *
 * Reference bytecode (EIP-1167):
 *   3d602d80600a3d3981f3                                  // creation (copies runtime, returns it)
 *   363d3d373d3d3d363d73 <impl(20)> 5af43d82803e903d91602b57fd5bf3  // runtime (delegatecall to impl)
 *
 * Adapted from the canonical OpenZeppelin Clones implementation (MIT).
 */
library Clones {
    error CloneCreationFailed();

    /**
     * @notice Deploy an EIP-1167 minimal proxy of `implementation` via CREATE.
     * @param implementation The logic contract every call is delegated to.
     * @return instance The address of the freshly deployed clone.
     */
    function clone(address implementation) internal returns (address instance) {
        assembly {
            // Load the 32-byte free memory pointer scratch region.
            let ptr := mload(0x40)
            // Store the 10-byte creation code + first 10 bytes of runtime prefix.
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            // Store the 20-byte implementation address (shifted into place).
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            // Store the 15-byte runtime suffix.
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            // CREATE with 55 (0x37) bytes of init code.
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) {
            revert CloneCreationFailed();
        }
    }

    /**
     * @notice Deploy an EIP-1167 minimal proxy via CREATE2 at a deterministic address.
     * @dev The address is a pure function of (this factory, salt, implementation),
     *      so it can be precomputed off-chain with `predictDeterministicAddress`.
     *      Reverts if a clone already exists at the derived address (CREATE2 collision).
     * @param implementation The logic contract every call is delegated to.
     * @param salt           Caller-chosen salt (e.g. the escrow's cwmId).
     * @return instance The address of the freshly deployed clone.
     */
    function cloneDeterministic(address implementation, bytes32 salt) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create2(0, ptr, 0x37, salt)
        }
        if (instance == address(0)) {
            revert CloneCreationFailed();
        }
    }

    /**
     * @notice Compute the deterministic clone address for a given salt, without deploying.
     * @param implementation The logic contract.
     * @param salt           The CREATE2 salt.
     * @param deployer       The factory that will (or did) call cloneDeterministic.
     * @return predicted The address the clone will live at.
     */
    function predictDeterministicAddress(
        address implementation,
        bytes32 salt,
        address deployer
    ) internal pure returns (address predicted) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf3ff00000000000000000000000000000000)
            // keccak256 of the init code → 0x37 (55) bytes starting at ptr.
            mstore(add(ptr, 0x38), shl(0x60, deployer))
            mstore(add(ptr, 0x4c), salt)
            mstore(add(ptr, 0x6c), keccak256(ptr, 0x37))
            predicted := keccak256(add(ptr, 0x37), 0x55)
        }
    }
}
