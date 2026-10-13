// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// TESTNET ONLY: never deploy on chain 8453 (Base mainnet).
// Selected only by the testnet profile; a different schedule is a different implementation.
uint256 constant SCHEDULE_CHALLENGE_WINDOW = 10 minutes;
uint256 constant SCHEDULE_APPEAL_WINDOW = 10 minutes;
uint256 constant SCHEDULE_BACKUP_WINDOW = 10 minutes;
uint256 constant SCHEDULE_EMERGENCY_REVIEW_WINDOW = 10 minutes;
uint256 constant SCHEDULE_WORK_MARGIN = 30 minutes;
bool constant SCHEDULE_IS_TESTNET = true;
bytes32 constant SCHEDULE_ID = bytes32("vnext-testnet-short-v1");
