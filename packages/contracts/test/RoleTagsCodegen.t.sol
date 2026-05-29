// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {RoleTags} from "../src/RoleTags.sol";

// RoleTagsCodegenTest
// Asserts each RoleTags constant equals its expected keccak256 hash.
//
// If the codegen at packages/contracts/script/codegen/gen-role-tags.ts
// drifts from the @pcc/spec/payouts source of truth (CONTRIBUTOR_ROLES +
// keccak256), this test fails — the on-chain mirror has fallen out of
// sync with the off-chain TS side.
//
// The 10 tests below cover the entire ContributorRole enum (ADR-12 §2.1).
//
// Drift causes:
//   - Hand-edited RoleTags.sol (the file says DO NOT EDIT)
//   - Renaming CONTRIBUTOR_ROLES strings in @pcc/spec without
//     re-running `pnpm --filter @pcc/contracts gen:role-tags`
//   - Adding a new role to @pcc/spec but skipping codegen
//
// Repair: re-run codegen and commit the regenerated file.
contract RoleTagsCodegenTest is Test {
    function test_operator() public pure {
        assertEq(RoleTags.OPERATOR, keccak256("operator"));
    }

    function test_verifier() public pure {
        assertEq(RoleTags.VERIFIER, keccak256("verifier"));
    }

    function test_insurer() public pure {
        assertEq(RoleTags.INSURER, keccak256("insurer"));
    }

    function test_integrator() public pure {
        assertEq(RoleTags.INTEGRATOR, keccak256("integrator"));
    }

    function test_protocolAuthor() public pure {
        assertEq(RoleTags.PROTOCOL_AUTHOR, keccak256("protocol-author"));
    }

    function test_modelAuthor() public pure {
        assertEq(RoleTags.MODEL_AUTHOR, keccak256("model-author"));
    }

    function test_datasetContributor() public pure {
        assertEq(RoleTags.DATASET_CONTRIBUTOR, keccak256("dataset-contributor"));
    }

    function test_backendAuthor() public pure {
        assertEq(RoleTags.BACKEND_AUTHOR, keccak256("backend-author"));
    }

    function test_curator() public pure {
        assertEq(RoleTags.CURATOR, keccak256("curator"));
    }

    function test_assembler() public pure {
        assertEq(RoleTags.ASSEMBLER, keccak256("assembler"));
    }

    function test_networkTreasury() public pure {
        assertEq(RoleTags.NETWORK_TREASURY, keccak256("network-treasury"));
    }
}
