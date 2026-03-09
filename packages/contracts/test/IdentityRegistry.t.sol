// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/IdentityRegistry.sol";
import "../src/ReputationRegistry.sol";
import "../src/ValidationRegistry.sol";

contract IdentityRegistryTest is Test {
    IdentityRegistry identity;
    ReputationRegistry reputation;
    ValidationRegistry validation;

    address admin = address(this);
    address alice = address(0x1);
    address bob = address(0x2);
    address validator = address(0x3);
    address attester = address(0x4);

    function setUp() public {
        identity = new IdentityRegistry();
        reputation = new ReputationRegistry(address(identity));
        validation = new ValidationRegistry(address(identity));

        // Authorize attester and validator
        reputation.authorizeAttester(attester);
        validation.authorizeValidator(validator);
    }

    // ── Identity Registry ───────────────────────────────────────────

    function test_register() public {
        vm.prank(alice);
        uint256 id = identity.register(
            IdentityRegistry.EntityType.Agent,
            keccak256("alice-agent-metadata")
        );

        assertEq(id, 1);
        IdentityRegistry.Entity memory e = identity.getEntity(1);
        assertEq(e.id, 1);
        assertEq(uint8(e.entityType), 0); // Agent
        assertEq(e.owner, alice);
        assertEq(uint8(e.status), 0); // Active
    }

    function test_registerMultiple() public {
        vm.prank(alice);
        identity.register(IdentityRegistry.EntityType.Agent, keccak256("a1"));

        vm.prank(bob);
        identity.register(IdentityRegistry.EntityType.Machine, keccak256("m1"));

        vm.prank(alice);
        identity.register(IdentityRegistry.EntityType.Operator, keccak256("o1"));

        assertEq(identity.getEntityCount(), 3);
        assertEq(identity.getOwnerEntityCount(alice), 2);
        assertEq(identity.getOwnerEntityCount(bob), 1);
    }

    function test_updateMetadata() public {
        vm.prank(alice);
        identity.register(IdentityRegistry.EntityType.Agent, keccak256("v1"));

        vm.prank(alice);
        identity.updateMetadata(1, keccak256("v2"));

        assertEq(identity.getEntity(1).metadataHash, keccak256("v2"));
    }

    function test_updateMetadata_onlyOwner() public {
        vm.prank(alice);
        identity.register(IdentityRegistry.EntityType.Agent, keccak256("v1"));

        vm.prank(bob);
        vm.expectRevert("Not entity owner");
        identity.updateMetadata(1, keccak256("v2"));
    }

    function test_setStatus() public {
        vm.prank(alice);
        identity.register(IdentityRegistry.EntityType.Agent, keccak256("v1"));

        identity.setStatus(1, IdentityRegistry.EntityStatus.Suspended);
        assertEq(uint8(identity.getEntity(1).status), 1); // Suspended

        identity.setStatus(1, IdentityRegistry.EntityStatus.Deregistered);
        assertEq(uint8(identity.getEntity(1).status), 2); // Deregistered
    }

    function test_setStatus_onlyAdmin() public {
        vm.prank(alice);
        identity.register(IdentityRegistry.EntityType.Agent, keccak256("v1"));

        vm.prank(alice);
        vm.expectRevert("Only admin");
        identity.setStatus(1, IdentityRegistry.EntityStatus.Suspended);
    }

    function test_transferAdmin() public {
        identity.transferAdmin(alice);
        assertEq(identity.admin(), alice);
    }

    function test_getOwnerEntityIds() public {
        vm.startPrank(alice);
        identity.register(IdentityRegistry.EntityType.Agent, keccak256("a1"));
        identity.register(IdentityRegistry.EntityType.Operator, keccak256("o1"));
        vm.stopPrank();

        uint256[] memory ids = identity.getOwnerEntityIds(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
    }

    // ── Reputation Registry ─────────────────────────────────────────

    function test_initialReputation() public {
        vm.prank(attester);
        reputation.recordJobCompletion(1, 0);

        ReputationRegistry.ReputationRecord memory rep = reputation.getReputation(1);
        // Score should be 500 (init) + 10 (min job bonus) = 510
        assertEq(rep.score, 510);
        assertEq(rep.totalJobs, 1);
        assertEq(rep.successfulJobs, 1);
    }

    function test_reputationJobCompletion() public {
        vm.startPrank(attester);
        reputation.recordJobCompletion(1, 20);
        reputation.recordJobCompletion(1, 40);
        reputation.recordJobCompletion(1, 100); // capped at 40 bonus
        vm.stopPrank();

        ReputationRegistry.ReputationRecord memory rep = reputation.getReputation(1);
        // 500 + 30 + 50 + 50 = 630
        assertEq(rep.score, 630);
        assertEq(rep.totalJobs, 3);
    }

    function test_reputationDisputeWon() public {
        vm.startPrank(attester);
        reputation.recordJobCompletion(1, 0); // init + job
        reputation.recordDisputeOutcome(1, true);
        vm.stopPrank();

        ReputationRegistry.ReputationRecord memory rep = reputation.getReputation(1);
        assertEq(rep.score, 530); // 500 + 10 + 20
        assertEq(rep.disputesWon, 1);
    }

    function test_reputationDisputeLost() public {
        vm.startPrank(attester);
        reputation.recordJobCompletion(1, 0); // init to 510
        reputation.recordDisputeOutcome(1, false);
        vm.stopPrank();

        ReputationRegistry.ReputationRecord memory rep = reputation.getReputation(1);
        assertEq(rep.score, 460); // 510 - 50
        assertEq(rep.disputesLost, 1);
    }

    function test_reputationSlash() public {
        vm.startPrank(attester);
        reputation.recordJobCompletion(1, 0); // 510
        reputation.recordSlash(1, 200);
        vm.stopPrank();

        assertEq(reputation.getScore(1), 310); // 510 - 200
    }

    function test_reputationClamped() public {
        reputation.setReputation(1, 990);
        vm.prank(attester);
        reputation.recordJobCompletion(1, 40); // +50
        assertEq(reputation.getScore(1), 1000); // capped
    }

    function test_reputationOnlyAttester() public {
        vm.prank(alice);
        vm.expectRevert("Not authorized attester");
        reputation.recordJobCompletion(1, 10);
    }

    // ── Validation Registry ─────────────────────────────────────────

    function test_attest() public {
        vm.prank(validator);
        uint256 attId = validation.attest(
            1,
            keccak256("fdm-capability-spec"),
            "capability",
            365 days
        );

        assertEq(attId, 1);
        ValidationRegistry.Attestation memory a = validation.getAttestation(1);
        assertEq(a.subjectId, 1);
        assertEq(a.validator, validator);
        assertEq(keccak256(bytes(a.claimType)), keccak256("capability"));
        assertEq(a.revoked, false);
    }

    function test_attestMultiple() public {
        vm.startPrank(validator);
        validation.attest(1, keccak256("cap1"), "capability", 365 days);
        validation.attest(1, keccak256("cert1"), "certification", 180 days);
        validation.attest(2, keccak256("cap2"), "capability", 365 days);
        vm.stopPrank();

        assertEq(validation.getAttestationCount(), 3);
        uint256[] memory ids = validation.getEntityAttestationIds(1);
        assertEq(ids.length, 2);
    }

    function test_hasValidAttestation() public {
        vm.prank(validator);
        validation.attest(1, keccak256("cap1"), "capability", 365 days);

        assertTrue(validation.hasValidAttestation(1, "capability"));
        assertFalse(validation.hasValidAttestation(1, "certification"));
        assertFalse(validation.hasValidAttestation(2, "capability"));
    }

    function test_revokeAttestation() public {
        vm.prank(validator);
        validation.attest(1, keccak256("cap1"), "capability", 365 days);

        vm.prank(validator);
        validation.revokeAttestation(1);

        assertTrue(validation.getAttestation(1).revoked);
        assertFalse(validation.hasValidAttestation(1, "capability"));
    }

    function test_revokeAttestation_onlyValidatorOrAdmin() public {
        vm.prank(validator);
        validation.attest(1, keccak256("cap1"), "capability", 365 days);

        vm.prank(alice);
        vm.expectRevert("Not authorized to revoke");
        validation.revokeAttestation(1);
    }

    function test_attestExpiry() public {
        vm.prank(validator);
        validation.attest(1, keccak256("cap1"), "capability", 100); // 100 seconds

        assertTrue(validation.hasValidAttestation(1, "capability"));

        vm.warp(block.timestamp + 101);
        assertFalse(validation.hasValidAttestation(1, "capability"));
    }

    function test_onlyValidator() public {
        vm.prank(alice);
        vm.expectRevert("Not authorized validator");
        validation.attest(1, keccak256("fake"), "capability", 365 days);
    }
}
