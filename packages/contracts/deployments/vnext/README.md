# deployments/vnext: the V-next deploy records

`script/DeployVNextSettlement.s.sol` writes one record per deployment here:

- `<network>/CANONICAL.json` for the canonical deployment;
- `<network>/PROVISIONAL-<label>.json` for a provisional one, where `<label>` is `VNEXT_LABEL` (`[A-Za-z0-9_-]{1,64}`);
- a `DRYRUN-` prefix on either name for a run without `--broadcast`, so a simulation never writes the record itself.

`CANONICAL.schema.json` is the committed, language-neutral JSON Schema (draft 2020-12) for
`<network>/CANONICAL.json`. Every writer field is required, and additional fields are rejected. PROVISIONAL
and DRYRUN records are out of scope. The oracle (TypeScript) and print host (Python) validate the same
committed file against this schema (steward ruling R8); the contracts vitest drift guard compares its
properties with the Solidity writer's serialized keys.

The gateway's paid-scope reader (readmodels #609) requires an explicit `PCC_VNEXT_RECORD_NETWORK` (for example,
`PCC_VNEXT_RECORD_NETWORK=base-sepolia`) and reads only that directory's committed `CANONICAL.json`
from `@pcc/contracts`. The economics lane owns this operator-approved record and its schema.
`PCC_VNEXT_RECORD_LABEL` must be unset; any legacy label configuration, including an empty value,
fails closed. Missing or malformed records, chain mismatches, provisional records and dry runs
also fail closed, with no default or fallback. The canonical writer's authority fields are
`mode: "CANONICAL"`, `label: ""`, `canonical: true`, `doNotPin: false`, and `broadcast: true`.

Readers must check `chainId` against the record's directory slug: `base` is 8453, `base-sepolia` is 84532,
`anvil` is 31337, and other chains use `chain-<chainId>`. JSON Schema cannot perform this check because it
needs the file path. A missing record or a `chainId` mismatch fails closed.

A record with `scheduleTestnetOnly: true` is a demo deployment with short settlement windows. Real value
must never settle against it. Schedule fields come from the constants compiled into that build, and are
bound into `digest`; editing them invalidates the recorded digest. The schema checks the record's shape;
readers still need to check its path, digest and on-chain deployment before trusting it.

Spec revision 2 hashes 23 static ABI words. Its eight appended schedule words are the hash of the exact
unpadded `scheduleId` string, `scheduleTestnetOnly`, `challengeWindowSec`, `appealWindowSec`,
`backupWindowSec`, `emergencyReviewWindowSec`, `minReclaimDelaySec` and `maxReclaimDelaySec`, in that order.

Each canonical record field:

- `canonical`: `true` for the canonical deployment.
- `doNotPin`: `false`, permitting canonical deployment pins.
- `mode`: `"CANONICAL"`, the deployment namespace.
- `label`: `""`, the canonical record has no provisional label.
- `broadcast`: `true`, the record represents a broadcast deployment.
- `provisionalTagOnChain`: human-readable provisional cohort marker guidance (`"n/a"` for canonical).
- `factory`: deployed settlement escrow factory address.
- `implementation`: deployed settlement escrow implementation address.
- `library`: linked settlement library address.
- `implementationCodehash`: implementation runtime bytecode hash.
- `libraryCodehash`: linked library runtime bytecode hash.
- `primaryAttester`: primary O5 attester address.
- `escalationAttester`: escalation O5 attester address.
- `usdc`: settlement asset address, pinned for supported chains.
- `eas`: provenance registry address, read from the attesters.
- `o5SchemaUid`: O5 provenance schema identifier.
- `o5TypeHash`: attesters' O5 typed-data type hash.
- `primaryCohortId`: primary signer cohort identifier.
- `escalationCohortId`: escalation signer cohort identifier.
- `signerSetIntersection`: number of signers shared by the two cohorts at verification time.
- `quorumFloor`: lower of the primary and escalation signer thresholds.
- `signerSetsFullyDisjoint`: whether the signer-set intersection is zero.
- `signerOverlapExplicitlyAllowed`: whether the operator explicitly allowed signer overlap.
- `primaryEnabled`: whether the primary cohort was enabled at verification time.
- `escalationEnabled`: whether the escalation cohort was enabled at verification time.
- `primaryDisabledAt`: primary cohort disable timestamp, or zero when never disabled.
- `escalationDisabledAt`: escalation cohort disable timestamp, or zero when never disabled.
- `routeDiversityRule`: human-readable signer diversity check and re-verification instructions.
- `chainId`: positive integer chain identifier, which must match the containing directory slug.
- `specVersion`: deterministic deployment spec revision used to derive deployment salts.
- `blockNumber`: block number when the deployment record was written.
- `scheduleId`: compiled settlement schedule identifier, with trailing zero bytes removed.
- `scheduleTestnetOnly`: whether this build uses short testnet-only windows and must never settle real value.
- `challengeWindowSec`: compiled primary challenge window, in seconds.
- `appealWindowSec`: compiled appeal window, in seconds.
- `backupWindowSec`: compiled backup attestation window, in seconds.
- `emergencyReviewWindowSec`: compiled emergency review window, in seconds.
- `minReclaimDelaySec`: compiled minimum reclaim delay, in seconds.
- `maxReclaimDelaySec`: compiled maximum reclaim delay, in seconds.
- `solc`: Solidity compiler version used by the recorded build.
- `optimizer`: optimizer configuration used by the recorded build.
- `reverify`: command to re-derive the deployment tuple from on-chain state.
- `digest`: ABI-encoded tuple and compiled schedule digest for record integrity.

Before a run broadcasts, the script reads the existing record back and refuses to publish a rival deployment under
the same name.

**This directory is committed on purpose, and must stay a real directory.** `foundry.toml` grants forge read-write
here and nowhere else in `deployments/`. The script refuses to read or write a record unless this directory exists,
no symlink sits at or above it, and no symlink sits anywhere below it. The grant alone does not contain a write
that goes through a symlink, and creating this directory at run time would follow a symlinked `deployments/`.
CI also fails on any committed symlink under `deployments/` (`ts/__tests__/deployments-no-symlinks.test.ts`).
Not covered: a link swapped in between the check and the write, a filesystem mounted inside this tree, and a hard
link from a record to a file elsewhere (git cannot commit one; placing one needs local write access).
