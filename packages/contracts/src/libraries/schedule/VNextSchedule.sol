// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Mainnet schedule. Selected at build time through the vnext-schedule/ remapping.
// A different schedule is a different implementation, authenticated by the payer's signature.
uint256 constant SCHEDULE_CHALLENGE_WINDOW = 2 days;
uint256 constant SCHEDULE_APPEAL_WINDOW = 5 days;
uint256 constant SCHEDULE_BACKUP_WINDOW = 2 days;
uint256 constant SCHEDULE_EMERGENCY_REVIEW_WINDOW = 5 days;
uint256 constant SCHEDULE_WORK_MARGIN = 1 days;
bool constant SCHEDULE_IS_TESTNET = false;
bytes32 constant SCHEDULE_ID = bytes32("vnext-mainnet-v1");
