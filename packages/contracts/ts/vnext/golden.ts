/**
 * The V-next golden vectors: one fixed job, and every value the contracts commit to for it.
 *
 * The OUTPUTS were computed by an independent clean-room implementation (pure Python standard
 * library, its own Keccak-256 and ABI encoder) that read ONLY `docs/VNEXT_SETTLEMENT_ABI.md`. It
 * never read the Solidity or this TypeScript. It first reproduced 26 anchors: the repo's cast-computed
 * evidence-commitment golden, CREATE(0xD0, 0), the EIP-712 "Ether Mail" example, the Solidity
 * ABI-spec calldata examples (nested dynamic offsets included), and SHA3-256 against Python's
 * hashlib as a check on its permutation.
 *
 * The same literals are asserted in two places:
 *   - `test/VNextAbiFreeze.t.sol`, against the REAL contracts end to end. The factory is deployed at
 *     the pinned address; the test predicts, creates, then funds with payer and operator signatures
 *     over `outputs.digest`.
 *   - `ts/__tests__/vnext-compiler.test.ts`, against `compileVNextPolicy`.
 * So the contracts, this compiler and the doc agree byte for byte. Re-pin only under the doc's §9.
 */
import type { Address, Hex } from "viem";

const FUNDING_TIME = 1_800_000_000n;

export const VNEXT_GOLDEN = {
  inputs: {
    chainId: 8453n,
    /** The factory is `CREATE(factoryDeployer, nonce 0)`; its constructor deploys the implementation at nonce 1. */
    factoryDeployer: "0x00000000000000000000000000000000000000D1" as Address,
    /** Well-known anvil test account 0; its key is public. */
    payer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
    /** Well-known anvil test account 1; its key is public. */
    operator: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
    jobId: "pcc:vnext:golden:job",
    terms: "pcc:vnext:golden:terms",
    acceptedPolicy: "pcc:vnext:golden:accepted-policy",
    policyNonce: 7n,
    expiry: 1_900_000_000n,
    fundingTime: FUNDING_TIME,
    units: [
      {
        milestoneIndex: 0n,
        step: "pcc:vnext:golden:step-a",
        requiredTier: 2,
        g: 1_000_000_003n,
        feeBps: 235,
        feeRecipient: "0x4444444444444444444444444444444444444444" as Address,
        reclaimAt: FUNDING_TIME + 30n * 86_400n,
        compositionSchemaVersion: 3,
        compositionRoot: "pcc:vnext:golden:composition-root",
        payouts: [
          { recipient: "0x1111111111111111111111111111111111111111" as Address, amount: 500_000_000n },
          { recipient: "0x2222222222222222222222222222222222222222" as Address, amount: 300_000_000n },
          { recipient: "0x3333333333333333333333333333333333333333" as Address, amount: 176_500_003n },
        ],
      },
      {
        /** Above 2^53: a JS `number` would silently corrupt it. */
        milestoneIndex: 0x0102030405060708090a0b0c0d0e0f10n,
        step: "pcc:vnext:golden:step-b",
        requiredTier: 0,
        g: 7n,
        feeBps: 0,
        feeRecipient: "0x0000000000000000000000000000000000000000" as Address,
        /** Exactly MAX_RECLAIM_DELAY: the upper edge, which is legal. */
        reclaimAt: FUNDING_TIME + 365n * 86_400n,
        compositionSchemaVersion: 0,
        compositionRoot: null,
        payouts: [{ recipient: "0x1111111111111111111111111111111111111111" as Address, amount: 7n }],
      },
    ],
    evidence: { unit: 0, package: "pcc:vnext:golden:evidence-package" },
  },
  constants: {
    SETTLEMENT_UNIT_DOMAIN: "0x2999f23df0b8dc0a4395e01bb071b526a68d659e9834e3952f403a9b7e3b511a",
    POLICY_SALT_DOMAIN: "0x9c545f70e44ba4292821022010c5750f92d0a3f2cbf06099ed1eaec2ba2ec8ef",
    POLICY_NONCE_DOMAIN: "0x4100c882ff75eaf8d18f6a8be89328b40d631d33d71e71bbe1f469f6f06f7b2c",
    EVIDENCE_COMMITMENT_DOMAIN: "0xae13dc2c47a210d242db75f30fde58d99e336c5c6cfea063b095efadbc5cf5f0",
    EIP712_DOMAIN_TYPEHASH: "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
    EIP712_NAME_HASH: "0xe2e457cd120e2826d4315f6af338fb561270850be7d01f8c8d75ee8924c18969",
    EIP712_VERSION_HASH: "0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6",
    JOB_POLICY_TYPEHASH: "0xda434b1043344df560573b6643eb6441876460071a7660bbe9f73214d62db142",
  } as Record<string, Hex>,
  derivedInputs: {
    jobIdHash: "0xefe464484039d8b2610c0719aa007f2ec19d1b7a3cab39e44b9a2e9b6cc9ad07",
    termsHash: "0x5bd8b6812d7f76d3ac1aecf197e53ad8dac34d43f382762570779cc43d2042bc",
    acceptedPolicyDigest: "0xca2881812de3c0ed41b81d5ae29ea56f6aa4bae1b0b960e79bdd532057ae6430",
    stepIdA: "0x012e76b28f24b769f2172713b56b980f5c9a9b24b8c9cb5f41b3cbf6dc136d6d",
    stepIdB: "0x2bb8b6d8553474bc66bf364fffa4611181ddc005540fa6385a08c316bcede4f1",
    compositionRoot: "0xd3afcdc6d5d44ae571b83908fa7331a73644e2f5f1ec82455e7e60f0f2cde6db",
    packageDigest: "0x85d72263a9d80c5eeecff75b5dd16e4d8cccc6441b7fe3c1c72d613bc1307d39",
  } as Record<string, Hex>,
  outputs: {
    factory: "0xc5806EA76348d369460284F39E7b65027e6052Ba" as Address,
    implementation: "0x0448F3d8EFEaEc835E18bccA58539233BAE5a5A6" as Address,
    initCodeHash: "0xba9d6c77ac1a8f5e64b35d8b87228496f1fad0bb189e9688ed7252857b4f0b1a" as Hex,
    prePolicyRoot: "0xc715f1c1249e4fb6e7b8bd64593b1eb84f4161d3b601b5a8bfb965de70871222" as Hex,
    salt: "0x2d1c6150450f10c652a7e59f26f0dd3ad0e39606e1fd071beabbf6f71353a425" as Hex,
    escrow: "0x4c3c893eF98D67C55f88E7c6F491bb63606d4682" as Address,
    unitIds: [
      "0x89fdc0545fa70c1557b4773ec4be1ad099c3eba97f62c1b505fa52e2562738a1",
      "0x8baa29d524fcaa98cb7820ebd653bf3c656720069988de57e6ecec49460d4510",
    ] as Hex[],
    unitsRoot: "0x59cab750ff6458bb2f54033aa684ab5f8af18671019b73c3ecf2871f4d34d54a" as Hex,
    jobPolicyHash: "0x9a76ae0d585f1ca8162005f051704b26d7077e5aff6c22b9406c00bda0976b47" as Hex,
    domainSeparator: "0xb9653bb57f2627de01133194170d328d16d728b81a7a17c2490d861a4af57880" as Hex,
    digest: "0x70396a1657b195306d333213cb89663fbab819ef9982557a30250e335dd65156" as Hex,
    policyKey: "0xdbe1329b76f15734ac713883218519118d309989e4405d840ae804ba2615d969" as Hex,
    feeScheduleHashes: [
      "0x258438ded8181cd3430f8ba0afa19e0416f01386c42fe5628a31655f64882d7c",
      "0x197076bc51efdb4e475f7aedc50c0b7927847df52094fb8548a726fa1540b5b7",
    ] as Hex[],
    payoutConfigHashes: [
      "0x76a1ace900e1466f058778acc04080011182e02cc61097cb95185c1d02e243a4",
      "0xe1c96f82e4d08d43719bda865e8f5dd015c2c05393d9193962cc287ea54c3110",
    ] as Hex[],
    claimIds: {
      u0_principal0: "0x8def2fb8a9c7ad07664aa4cc582436792ed218afb571c1a3688cec5e0b7ee872",
      u0_principal1: "0x65bb6d604a0cad95371fd60eae5c70513de5c5480a106f847fa2df6dde196ad8",
      u0_principal2: "0x172fd16edc971a0a44ee3b241973222669ae81021f6ba8de34a16c72d0c3d96d",
      u0_fee: "0xeb8b9fc5b6cc1c0556eb0debfe023150e82eafc69a1a65d673c4ba2b7e367964",
      u0_refund: "0x4d69ba3166cfe5f97567528fd7a604b8e4eba4d4edba822cf48dea9d0cc1ea67",
      u1_principal0: "0xe27061a0182573bd4bd244ef44c7451791a976e2eb3c2a6f6921e5e7571f0e2c",
      u1_refund: "0xa5511656bf6c0c6e96186853618a271f366397bd195c067f79105cdad6a949e9",
    } as Record<string, Hex>,
    evidenceCommitmentU0: "0x0c21605cc29c989f04c14b696ca7196fdc208c6483ebf77321ab6cc13b605439" as Hex,
    fees: [
      { f: 23_500_000n, n: 976_500_003n },
      { f: 0n, n: 7n },
    ],
    encodedConfigsLength: 1280,
  },
  /** doc §7: the input-type freeze. */
  selectors: {
    "createEscrow((address,address,bytes32,bytes32,uint256,bytes32,bytes32))": "0x886deb02",
    "predictEscrow((address,address,bytes32,bytes32,uint256,bytes32,bytes32))": "0xa5b0de55",
    "saltOf((address,address,bytes32,bytes32,uint256,bytes32,bytes32))": "0xb9f0389f",
    "policyKey(address,address,bytes32)": "0x68fe3ce4",
    "revokePolicy(address,address,bytes32,uint256)": "0xd4a3d9af",
    "fund((uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[],(uint256,bytes,bytes))":
      "0x7976bcc7",
    "policy()": "0x0505c8c9",
    "unitState(bytes32)": "0x4ea93b0c",
    "unitCount()": "0xf584fbf6",
    "unitIdAt(uint256)": "0x57853e8e",
    "unitTerms(bytes32)": "0x2ad489ed",
    "feeScheduleHashOf(bytes32)": "0xee274758",
    "payoutAt(bytes32,uint256)": "0x1e7d162f",
    "finalize(bytes32)": "0x92584d80",
    "reclaimAfterDeadline(bytes32)": "0xb3f8fa4a",
    "dischargeClaim(bytes32)": "0xb409a86d",
  } as Record<string, Hex>,
} as const;
