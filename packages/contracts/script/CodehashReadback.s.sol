// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

/// @notice Reads codehashes with the EVM's own EXTCODEHASH opcode against a LIVE chain.
/// @dev    Deliberately NOT `forge inspect deployedBytecode`: that returns the UNLINKED template, whose
///         library placeholders are 20 zero bytes, so its hash is not the hash of anything deployed. This
///         is the escrow lane's standing rule after the #622 retraction -- a codehash is only publishable
///         once it has been read back from a real deployment.
contract CodehashReadback is Script {
    function run() external view {
        address factory = vm.envAddress("RB_FACTORY");
        address impl = vm.envAddress("RB_IMPL");
        address lib = vm.envAddress("RB_LIB");
        console.log("chainid", block.chainid);
        console.log("factory       ", factory);
        console.logBytes32(factory.codehash);
        console.log("implementation", impl);
        console.logBytes32(impl.codehash);
        console.log("library       ", lib);
        console.logBytes32(lib.codehash);
        console.log("impl code size", impl.code.length);
        console.log("lib  code size", lib.code.length);
    }
}
