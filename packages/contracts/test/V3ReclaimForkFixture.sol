// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/MilestoneEscrowV3.sol";
import "../src/MockUSDC.sol";
import {MockEAS} from "./mocks/MockEAS.sol";
import {Clones} from "../src/libraries/Clones.sol";

/**
 * @title V3ReclaimForkFixture
 * @notice DEPLOYABLE fixture for the gateway's escrow-reclaim fork test (N79). It deploys the REAL MilestoneEscrowV3 as
 *         an EIP-1167 clone whose PAYER (and arbiter) is the given address, as paid-job-flow's Mode-A flow creates it
 *         with the gateway signer. It mints that payer MockUSDC. The TypeScript test then adds milestones, funds, and
 *         reclaims AS the payer, through the gateway's own code. Setup only: this contract never holds the escrow's
 *         roles, so it cannot stand in for the payer.
 */
contract V3ReclaimForkFixture {
    MilestoneEscrowV3 public escrow;
    MockUSDC public usdc;

    constructor(address payer, uint256 mintAmount) {
        usdc = new MockUSDC(0);
        MockEAS eas = new MockEAS();
        MilestoneEscrowV3 impl = new MilestoneEscrowV3(address(eas), bytes32(uint256(0xBEEF)), address(0xA0));
        escrow = MilestoneEscrowV3(Clones.clone(address(impl)));
        escrow.initialize(payer, payer, address(usdc), keccak256("cwm-v3-reclaim-fork"), address(0));
        usdc.mint(payer, mintAmount);
    }
}
