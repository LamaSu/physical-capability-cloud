# @pcc/print-host

Private workspace package for the N144 October MVP print host. This package contains
the run loop, host configuration, testnet key custody, local per-unit evidence sessions,
deterministic test support, V-next package construction and one-shot evidence
broadcasting, and repros of the toolkit gaps that prevent REAL-mode
IPP printing and production of the oracle's required evidence.
Its source enters the gateway image through `COPY . .`; only the build skips it
via the Dockerfile's turbo filter.

## Configuration and testnet keys

Build from the workspace root with `pnpm --filter "@pcc/print-host..." build` to
build the host and its contracts, kernel, kernel-sdk, and spec dependencies. Run the CLI with
`node packages/print-host/dist/cli.js keygen --out <absolute-directory> [--not-after <UTC-timestamp>]` and
`node packages/print-host/dist/cli.js check-config <absolute-config-path>`.
The `print-host` bin is available through pnpm linking; `dist/cli.js` has mode 0644.
Both commands print public
identity JSON only; keygen also prints the generated file paths. Keygen refuses
existing files and writes the device and operator keys at 0600 inside a private
directory. An optional `--not-after` must be later than the current time and the
keys' `createdAt`. Keep the funded Ed25519 device principal separate from the secp256k1
operator EOA. The per-unit SESSION key signs the bundle (H1(b)). The device key
signs LO-EV-1 delegations through `signDelegation`; `signD2` signs the 32 bytes
the caller supplies, behind a guard that refuses bytes beginning with the UTF-8
prefixes `pcc-kernel-signing-key:` and `sha256:` in either raw or hex form.
Load it with `delegationBinding: { chainId, operator }` from the host's configured
chain and operator identity; loading without that binding permits public identity
checks and D2, but refuses delegation signing. Delegations name one bounded job id
(1–256 ASCII letters, digits, `_`, `.`, `:`, or `-`, starting with a letter or digit),
the spec's exact MVP action set, and a distinct 32-byte session public key. Their
whole-second issuance lies between funding and the first event, expiry equals
reclaimAt, and maxSignatures equals the finalized event count (1–1000).
Delegation input must be a plain object with exactly these 11 own enumerable data
properties: `sessionId`, `parentAgentId`, `publicKey`, `issuedAt`, `expiresAt`,
`scope`, `jobId`, `fundedAt`, `reclaimAt`, `firstEventAt`, and `eventCount`. Extra
properties are refused even when their value is `undefined`, and accessors are
refused. `sessionId` must match `/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/`.
`fundedAt`, `issuedAt`, `expiresAt`, and `reclaimAt` must be integer Unix seconds
in the range `1_600_000_000 <= t < 2^32`. `firstEventAt` uses the same range and
may include a fractional second for event timing.
`signD2` accepts exactly 32 raw bytes or their `0x`-prefixed lowercase hex encoding.
Both UTF-8 prefixes, `pcc-kernel-signing-key:` and `sha256:`, are refused after decoding.
An honest D2 input is a SHA-256 output, so the `sha256:` guard's false refusal has
probability 2^-56 per unit; grinding a package body to force a single-unit refusal
costs about 2^56 SHA-256 evaluations, acceptable for the MVP. The durable fix is a
typed package body hashed inside the key module.
The local unit session supplies the delegated bundle while the toolkit's GAP-7
unit session and bundle builders remain open.
The local per-unit session implementation is described below. The unchanged GAP-7
repro still checks for the requested session API in the toolkit's exports.

The operator key has
three scoped uses: D1 `FinalMilestonePackageV2` signatures, zero-value EIP-1559
`submitEvidence(unitId, packageDigest)` transactions, and EIP-712 `JobPolicy`
acceptance signatures. V-next `fund()` always requires the operator acceptance:
the operator never sends the funding transaction
(`packages/contracts/src/VNextSettlementEscrow.sol:346`). The WP-A wallet proof
remains open. Loading the key binds all three signing methods to the configured
chain. JobPolicy acceptance was added by #620. D1 uses the fixed domain name
`PCC FinalMilestonePackage`, version `2`, and the supplied escrow address for both
the message and verifying contract. For D1 and `submitEvidence`, the escrow address
is supplied per signing call until canonical deployment binding is added; no
escrow configuration field is needed yet. Policy acceptance binds the deployment
through the loaded terms and derives the escrow as described below.

October ships no `invokeBackup` path. A recursive source guard test enforces the
absence of its name and selector and checks the host's `submitEvidence` selector
against the repository escrow ABI.

For the Thursday acceptance hand-off, run:

```bash
node packages/print-host/dist/cli.js sign-policy --config /absolute/host.json --terms /absolute/terms.json --input /absolute/policy.json --out /absolute/signature.json
```

`sign-policy` requires `process.getBuiltinModule`: Node >= 20.16 on the 20.x
line or >= 22.3 on the 22.x line. The `@pcc/spec` producer uses that API; on an
older Node, every `sign-policy` call fails closed with `bad_input`.

The terms file strictly contains `chainId` (a required integer number, 84532 or
31337), `factory` and `implementation` (required,
valid non-zero deployment addresses), `minG` (an unsigned decimal string),
`allowedRequiredTiers` (an array of numbers), `reclaimMinSeconds`,
`reclaimMaxSeconds`, `maxFeeBps`, `allowedFeeRecipients` (an array of addresses),
`allowedPayoutRecipients` (a required, non-empty array of addresses with no
case-insensitive duplicates), `operatorPayoutRecipient` (a required address in
that allowlist), `maxPassThrough` (an unsigned decimal string in USDC base units),
`maxUnits`, and `maxAcceptanceSeconds`. For each unit, the host sums every payout
to `operatorPayoutRecipient`, comparing addresses case-insensitively. The policy's
total pass-through is the sum of each unit's `n` minus that operator amount, and
must be at most `maxPassThrough`. A CARRIER unit paying only the treasury counts
its entire `n`; the cap applies across the policy, including all its units.
Other scalar limits are integer numbers. `reclaimMinSeconds` must be at least
864000 (10 days), and `reclaimMaxSeconds` at most 31536000 (365 days).
The file also requires a valid non-zero address `settlementToken` and a
`subjectPins` object. A `termsHash` field in a terms file is refused with `bad_terms`.
On chain 84532, `settlementToken` must equal Base Sepolia USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), compared case-insensitively;
another token is refused at load with `bad_terms`. Chain 31337 accepts any
valid non-zero token address for anvil mocks.
Pins may contain only the 18 `SubjectBlockFields` keys from `@pcc/spec`, with exact
bytes32 values, an address for `operatorSettlementAddress`, or an integer number
for `integrityGrade` (0–255). `committedProgramHash` is required. An
`operatorSettlementAddress` pin must equal `operatorPayoutRecipient`, compared
case-insensitively. Optional bytes32 `bindingsRoot` pins the computed bindings root.
Unknown fields, accessors, and non-plain terms or pin objects are refused with
`bad_terms`.

Thursday's PRINT unit uses the following complete terms template. Replace the
host-specific placeholders with the values computed below, take `factory` and
`implementation` from GO-1's CANONICAL deployment record, and set
`maxAcceptanceSeconds` to the operator's quote-to-sign window in integer seconds.
Economics' terms file does not specify that acceptance window.

```json
{
  "chainId": 84532,
  "factory": "<factory from GO-1 CANONICAL record>",
  "implementation": "<implementation from GO-1 CANONICAL record>",
  "maxUnits": 1,
  "allowedRequiredTiers": [1],
  "minG": "750000",
  "maxFeeBps": 0,
  "allowedFeeRecipients": [],
  "operatorPayoutRecipient": "<host EOA>",
  "allowedPayoutRecipients": ["<host EOA>", "0x6463ACd05141c1EF6583E4Fd978FC61Fff4045DC"],
  "maxPassThrough": "250000",
  "reclaimMinSeconds": 864000,
  "reclaimMaxSeconds": 1814400,
  "maxAcceptanceSeconds": "<operator quote-to-sign window in integer seconds>",
  "settlementToken": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "subjectPins": {
    "committedProgramHash": "0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a",
    "operatorPrincipal": "<derived host operator word>",
    "operatorSettlementAddress": "<host EOA>",
    "authorizedTuplesRoot": "<oracle host tuple root>",
    "childrenRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "expertSetRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "executorSetRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "expectedRecipient": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "targetSystemIdentity": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "recipeRef": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "sampleManifestRef": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "operatingEnvelopeHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "expectedRouteArea": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "expectedLocationHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "captureNonceAnchor": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "challengeAnchor": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "integrityGrade": 0
  },
  "bindingsRoot": "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd"
}
```

Compute `operatorPrincipal` with the `@pcc/spec` producers
`principalTupleWord("operator", formatOperatorPrincipalId(chainId, <host EOA>))`.
The host also checks this word against the signing operator EOA in code.
`operatorSettlementAddress` is the host EOA and must equal
`operatorPayoutRecipient`. At Wednesday's sitting, construct the host's one
(operator, kernel, device) triple with the `@pcc/spec` producers:

```text
authorizedTuple(formatOperatorPrincipalId(84532, <host EOA>), <kernelId>, formatDevicePrincipalId(<device public key>))
```

`formatDevicePrincipalId` produces `ed25519:0x` followed by 64 lowercase hex
digits. Feed that tuple into the oracle's `computeAuthorizedTuplesRoot([tuple])`,
then cross-check the computation against the oracle's Thursday-shape golden v2
(`pcc-oracle` commit `23bdcc2`,
`config/testnet/s2-subject-block-thursday-shape-golden.json`; vendored in
`test/fixtures/oracle-23bdcc2-s2-thursday-shape-golden-v2.json`). `@pcc/spec` exports
`authorizedTuple` but has no public root producer. A root without the host's
triple prevents settlement, so Thursday's terms must pin this value. Thursday
uses `bindings: []`, whose root is the pin above. All twelve zero fields and
`integrityGrade: 0` are exact pins.

These economic limits mirror economics' Thursday terms file at
`/mnt/sparkbulk/pcc-reconciliation/returns/pcc-economics-work/terms/print-unit-thursday.v1.json`.
Thursday allows only tier 1: tier 2 must NOT be allowed because S2's ladder is
`tier1`. The reclaim maximum is 1814400 seconds because `reclaimAt` is policy
creation plus 21 days. Thursday's settlement token is Circle USDC on Base Sepolia
at the address above. Economics #8165 supersedes the old `termsHash` pin; the file's
version digest
`0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7`
is only a FILE-VERSION digest of economics' terms document, never a policy's
`termsHash`, and goes into no policy.
Each policy derives its own `termsHash` from its funded units using the ratified
v2.1 rule:

```text
TERMS_DOMAIN = keccak256(utf8("PCC:vnext:job-terms:v1"))
milestones[i] = (units[i].milestoneIndex, units[i].stepId, units[i].g, units[i].reclaimAt)
milestonesRoot = keccak256(abi.encode((uint256,bytes32,uint256,uint64)[] milestones))
termsHash = keccak256(abi.encode(bytes32 TERMS_DOMAIN, address settlementToken, uint8 assuranceTier, bytes32 milestonesRoot))
```

Both encodings use `abi.encode`. Milestones retain the funded `UnitConfig[]`
order, including each unit's own reclaim deadline. Every unit must have the same
`requiredTier`, and its `requestedTier` must match that job-level assurance tier.
The host's tier limits, payout allowlist, and other local terms are configuration
outside this preimage. The local producer follows `pcc-oracle src/terms-hash.ts`
at `87bc14e` and will be replaced by `@pcc/spec`'s producer when it merges.
Terms for one chain never load for a key bound to another chain; the loader
refuses them before reading the key file. Loaders validate and freeze all terms
at key load; a key loaded without terms
refuses policy acceptance signing. The explicit deployment terms will be replaced
by economics' N150 canonical deployment record when it lands.

Both terms and input paths must be absolute, regular files and cannot be symlinks.
The terms file must belong to the current uid and deny group/other writes, with a
64 KiB limit. The input has a 1 MiB limit and no ownership or mode requirement.
Readers open without following links or blocking on FIFOs, recheck the opened
file's identity, type and size (plus terms ownership and permissions), read bounded
bytes, and erase their buffers after parsing.

The strict input JSON is
`{ "policy": { ... }, "units": [ ... ], "subjectBlock": { ... }, "bindings": [ ... ] }`,
using the exported `JobPolicyFields` and `UnitConfig` shapes from
`@pcc/contracts/vnext` and `SubjectBlockFields` and `SubjectBinding` from `@pcc/spec`.
The subject block must have exactly its 18 fields. Bindings must have exactly
`planUnitKey`, `requirementIdHash`, `sourceKind`, `propositionKind`, and `valueRef`;
duplicate `requirementIdHash` values are refused. The producer requires lowercase
bytes32 values and settlement addresses. Build each binding's `planUnitKey` with
`computePlanUnitKey(unitOrdinal, milestoneIndex, stepId)`. Producer admission
errors are reported only as `bad_input`.
Every compiler `bigint` field is an unsigned decimal string: policy `chainId`,
`policyNonce`, and `expiry`; unit `milestoneIndex`, `g`, `f`, `n`, and `reclaimAt`;
and each payout's `amount`. Tier, fee-basis-point, and composition-version fields
remain integer numbers. Unknown fields and a caller-supplied clock are refused.
Library callers can set `OperatorKeyLoadOptions.clock` when loading the key;
the closure captures that function and reads it exactly once per signing call,
after snapshotting the input. The default returns the current time. The existing
load option `now` only controls key-file expiry validation.

Before signing, the host checks the operator address and bound chain, requires
the policy's factory and implementation to match the loaded deployment terms
case-insensitively, and refuses zero factory, implementation or escrow addresses.
It derives the escrow with the compiler's `predictEscrow` and `policySalt` from
the full policy identity and refuses any other escrow. It recomputes
the ordered units root with the compiler's helpers, and checks every unit against
the terms. It also checks the compiler's pre-policy root, which commits the checked
economic configuration. Gross payment must meet `minG`, the required tier and fee recipient must
be allowed, fees must be at most `maxFeeBps`, and reclaim time must lie within the
inclusive window from `policy.expiry + reclaimMinSeconds` through
`now + reclaimMaxSeconds`. Measuring the lower bound from expiry guarantees the
minimum reclaim delay even if funding occurs at the latest allowed time.
The zero fee recipient is
allowed only with zero fees. Every payout recipient must be allowed, compared
case-insensitively. The compiler's `computeFee` must match both `f` and `n`, and
non-empty, positive payouts must sum exactly to `n`. The host also calls the
compiler's `buildUnitConfig` for context-free validation, checks the supplied
`requestedTier` against its derived value, and maps validation failures to
`bad_input`. Unit count must be between one and `maxUnits`, and
acceptance expiry must be in the future and no farther away than
`maxAcceptanceSeconds`. The signature uses the compiler's `jobPolicyTypedData`
unchanged; its verifying contract is `policy.escrow`.

The host also requires `policy.termsHash` to match the derivation from the loaded
settlement token and the same ordered units snapshot (`terms_hash_mismatch`).
Mixed required tiers give `assurance_tier_mismatch`; the existing compiler
validation refuses a mismatched requested tier with `bad_input`.
The host checks every subject pin (`subject_pin_mismatch`), and
requires `subjectBlock.operatorSettlementAddress` to equal the configured payout
recipient (`settlement_address_mismatch`). It computes `subjectBlockHash` with
`computeSubjectBlockHash`, `bindingsRoot` with `computeBindingsRoot`, and
`acceptedPolicyDigest` with
`computeAcceptedPolicyDigest({ termsHash, subjectBlockHash, bindingsRoot })`, all
from `@pcc/spec`. A configured root pin that differs gives
`bindings_root_mismatch`; a policy digest that differs gives
`accepted_policy_mismatch`. Every unit must have `compositionSchemaVersion: 0`
and an all-zero `compositionRoot`, otherwise `composition_not_supported`.
All these refusals happen before signing.

The host derives both principal words with
`principalTupleWord("operator", formatOperatorPrincipalId(chainId, address))`
from `@pcc/spec`, using the loaded terms' chain and the same input snapshot as
the acceptance checks. `subjectBlock.operatorPrincipal` must match the signing
operator EOA's word (`operator_principal_mismatch`), and `subjectBlock.payer`
must match `policy.payer`'s word (`payer_principal_mismatch`), compared
case-insensitively. An optional `operatorPrincipal` pin remains allowed; the
derived check runs regardless of that pin's value or presence. A producer throw
gives `bad_input`. These checks also run before signing.

Success creates a new mode-0644 JSON file containing exactly `operator`, `chainId`
(a number), `escrow`, `acceptanceDigest`, `signature`, `subjectBlockHash`,
`bindingsRoot`, `acceptedPolicyDigest`, `termsHash`, `subjectBlock`, and `bindings`.
The output `termsHash` is the derived value checked before signing. The subject
block and bindings are the public objects as parsed, with lowercase hex, so the
hand-off carries the objects signed over alongside their hashes. Existing output files
are refused. If chmod, writing or closing fails after creation, the command removes
the file it created so the operator can retry. The command exposes only public
identity, acceptance and subject data; on failure it
prints only a closed error code.

The strict JSON configuration has `kernelId`, `deviceId`, `printer.uri`,
`chain.chainId`, `chain.rpcUrlFile`, `gateway.baseUrl`, `gateway.apiKeyFile`,
`keys.deviceKeyFile`, `keys.operatorKeyFile`, and `dataDir`. All file and directory
paths must be absolute. Only Base Sepolia (84532) and offline anvil (31337) are
accepted. Secret files and their immediate parent directories must belong to the
current uid and deny group/other access; the configuration file must deny
group/other writes. `checkHostConfig` checks both keys, the credential files, and
the private data directory, then returns only the public identity. It can throw
`HostConfigError`, `KeyFileError`, or `SecretFileError`.

The printer uses the kernel's built-in IPP client from #640; no npm `ipp`
package is required. Only `ipp://` URIs are supported; `ipps://` is refused
because the client does not support TLS yet. Credentials, queries and fragments
in the URI are refused. The defaults are a 2000 ms poll interval, a 20000 ms
cancel-confirm deadline, a 15000 ms request timeout, a 120000 ms Print-Job
timeout, a 32 MiB maximum document and the `application/pdf` document format.
Printer initialization errors exit with the closed code `adapter_init_failed`.

Testnet-only is a policy enforced on the configuration's `chainId`. The operator
EOA has the same address on every chain: never fund it on mainnet. The evidence
broadcaster checks `eth_chainId` against the configuration before transaction signing.

Secret reads compare the checked path's device/inode with the opened descriptor,
then recheck its permissions and ownership before reading bounded bytes from that
descriptor. Loaders erase mutable buffers after parsing. JavaScript strings and
the signing closures' retained keys cannot be reliably erased; key objects expose
only public data and signing functions, and their JSON/string/inspection methods
redact private state. Parser and validation errors use fixed codes and trusted
field labels without retaining input values or exception causes. All custody
errors use `<code>: <path>`, with a field label for `bad_schema` or the fixed
testnet-only sentence for `testnet_only`. Keygen and check-config print that
message once; sign-policy prints only the code.

The host must produce ONE signed bundle per settlement unit: print events plus pulled carrier
events on success, or `execution_failed` evidence on failure. A committed print-only
package can never be extended with later carrier events: `submitEvidence` is one shot.
The reference is
pcc-oracle's B5 print-host bundle contract, **including the 10/10 amendment**
(pcc-oracle `16aa336b`; on the Spark:
`/mnt/sparkbulk/pcc-reconciliation/returns/pcc-oracle-work/print-host-bundle-contract-20261009.md`),
sections 3.0, 4.2 and 5, and amended hazards H1 and H6. Q-E2 was ruled yes
(evidence #7539): H1(b) mints the session key at finalization and permits its
delegation's `issuedAt` to precede signing time. Producer rules require
`fundedAt <= issuedAt <= first event`, `expiresAt = reclaimAt`, exactly
`contractIds: [jobId]`, `maxSignatures` equal to the event count, and the operator
principal as `parentAgentId`. H6 gives the device key exactly two uses: LO-EV-1
delegation signing and D2 over raw32(packageBodyHash). The session key signs the
bundle once; the mandatory MVP package signature set is exactly D1 and D2.
These repros track the needed pcc-adk toolkit changes;
the local session and package library supply the MVP pipeline while those APIs
remain parked.

## Run loop

```bash
print-host run --config /absolute/host.json [--once] [--poll-only] [--no-submit] [--inputs-dir /absolute/inputs]
```

The equivalent direct invocation is
`node packages/print-host/dist/cli.js run ...`. `--config` is required.
`--once` runs one tick; otherwise the host polls until SIGINT or SIGTERM.
`--poll-only` polls and heartbeats without opening the printer or loading signing
keys. `--inputs-dir` selects the local manifest/document source. Without it,
the default source returns `job_inputs_unavailable` and no job is claimed.
Real mode requires positive `maxFeePerGasCap`, `maxPriorityFeePerGasCap`, and
`gasCap` before startup. Use `--no-submit` explicitly to print and relay without
package submission. A unit first processed with sending disabled (`--no-submit`,
missing caps, `realMode: false`, or no broadcaster or keys) ends
`evidence_stored` with `submit_disabled` (or `package_inputs_missing` for an
incomplete manifest); a later sending run never settles it.
All run logs contain closed codes only.

A sending run never settles units that an earlier `--no-submit` (or capless)
run left as `evidence_stored` with `submit_disabled` or
`package_inputs_missing` in the same data directory: they stay forfeited.
Run `--no-submit` rehearsals in their own data directory. Before the first
sending run, point the config's `dataDir` at a directory that no `--no-submit`
run has used, then keep that SAME directory for every later sending run and
every restart. Crash recovery (`submit_attempted` read-back and its nonce
priority, saved packages and receipts) and the one-print-per-unit markers live
there; a new directory forgets them. Never point a sending host at a funded
unit or job that a rehearsal directory already printed.

Before a sending run, check:
- the data directory follows the rule above: never used by a `--no-submit`
  run, and the same one for every later sending run and restart;
- the run is supervised and covers one unit, unless r5d's chain change
  (the collapse review's F1) has also merged. That change narrows which
  decoded send-time escrow errors release the operator's nonce; see
  "Evidence transaction caps".

A real-mode adapter must report `source.simulated` as exactly `false`.
Otherwise, or if a real-mode host that is not poll-only has no adapter at all,
the host halts with `adapter_simulated` before polling, claiming or printing,
logs that code once, and the CLI exits non-zero.
Only poll-only operation may run without an adapter.

The CLI uses the **STRICT e-stop reader by default**. Execution requires a parsed
poll with an own `emergencyStop: "clear"` field and an own `jobs` array.
`"stopped"`, `"unavailable"`, missing or malformed stop data, and poll errors
prevent execution. The host polls again immediately before printing, watches
the stop while printing, and cancels on shutdown or a stopped poll.
Stopping the host mid-print forfeits that unit: its signed failure bundle follows
the receipt and commit path and spends the unit's one shot. A failed mid-print
poll has the same effect.

The local source reads `<encodeURIComponent(jobId)>.json` and the named PDF in
the same directory. A manifest contains these fields:

| Field | Shape |
| --- | --- |
| `jobName` | Nonempty string, at most 256 characters, with no control characters |
| `totalPages` | Integer 1–50 |
| `documentFile` | A plain basename, at most 240 UTF-8 bytes; the file must begin `%PDF-` |
| `unit.settlementUnitId`, `unit.challengeNonce` | Lowercase `0x`-prefixed bytes32; the challenge nonce must be nonzero for packaging |
| `unit.fundedAt`, `unit.reclaimAt` | Integer Unix seconds in `[1_600_000_000, 2^32)`, with `reclaimAt > fundedAt` |
| `unit.chainId` | 84532 or 31337, matching the configured chain |
| `unit.escrow` | Nonzero EIP-55 address |
| `unit.jobIdHash`, `unit.stepId`, `unit.compositionRoot`, `unit.acceptedEnvelopeHash` | Lowercase `0x`-prefixed bytes32 |
| `unit.milestoneIndex` | Nonnegative safe integer |
| `unit.compositionSchemaVersion` | Unsigned 16-bit integer |
| `unit.tChallengeRef` | Nonempty challenge reference string, at most 256 characters, with no control characters or unpaired surrogates |
| `unit.evidenceTimeBounds` | `{ "start": "...", "end": "..." }`, canonical decimal Unix-second strings with `start <= end`, covering every event |
| `program` | `{ "programHash": "...", "attestationSetRoot": "...", "workProductRoot": "..." }`, each lowercase `0x`-prefixed bytes32 |

The printer job name is host-derived from the PCC job id; the manifest's `jobName` is metadata only.
Package fields are optional
for compatibility with existing manifests; missing fields still allow printing
and relay storage, then journal `package_inputs_missing` and skip settlement
submission. Supplied fields are strictly validated, including partial package
inputs, and unknown fields are refused. Operator, kernel and funded device
identities come from the configured runtime. The operator's inputs manifest is
Thursday's only unit source (#7866). Evidence's committed S2 program supplies
`program`; copy those fields byte for byte into every manifest before printing.
Set `unit.evidenceTimeBounds.end` to the decimal `reclaimAt`, and choose `start`
at or before the first print event so the bounds cover every event. An end before
the final event produces terminal `package_invalid` after the print.
The gateway settlement block and economics' canonical funded record are future
unit-context sources. The file source invents no package defaults.

The private `dataDir/journal/` contains per-job mode-0600 JSONL records and the
saved signed bundle. Appends sync their file and directory before returning.
Before recording or reporting a claim, the host reserves its lowercase bytes32
settlement unit in a mode-0600 `.unit-<hex>.used.json` sidecar and syncs the file
and directory. Every job state retains this reservation. A crash after the marker
leaves the unit used even if no claim was recorded. The reservation check
reads older public package, bundle, receipt and session artifacts only for
journaled jobs that no valid reservation marker names; an artifact naming the
unit establishes that it is used. A job named by a valid marker is never
rescanned, and a malformed marker of another unit names no job. An empty or
unparseable first session record (`00000000.json`) of an unmarked legacy job
binds no unit: that session never opened, so nothing was printed under it. A
first record that parses with a malformed unit ID, or any other unreadable
older artifact, still fails closed with `journal_invalid`.
The bundle, package, and receipt artifacts share an atomic save: a unique
exclusive temporary file is written and fsynced, linked to its final name,
then unlinked and the directory fsynced. A leftover temporary file is ignored
and cannot block a later save.
The mode-0700 `dataDir/sessions/` holds each unit session's public journal;
device and session seeds are never written there. The session opens after
`in_progress_reported`, adds every result event in order, then mints and
delegates its session key at finalization. Finalization is repeatable from its
public records and retains one signed bundle.

Initialization exclusively creates `dataDir/journal/.lock`, containing the pid,
the process's `/proc/self/stat` start time (field 22), and the kernel boot id as
`{pid, startTime, bootId}`.
Another process with the same identity causes `data_dir_locked`. A different
boot id, absent pid, or changed process start time permits stale-lock takeover;
unreadable `/proc` refuses startup. Clean exit releases the lock. To clear a stale
lock manually, stop all hosts using this data directory, compare the saved
identity with `/proc/sys/kernel/random/boot_id` and `/proc/<pid>/stat`, and only
after confirming the original process is gone remove `journal/.lock`. The
launcher uses its own PID namespace, so a matching pid alone proves nothing;
check the host's namespace or stop its launcher before manual removal.
Avoid simultaneous stale-lock replacements: takeover checks the existing inode
before unlinking, but the check and unlink are separate operations and leave a
narrow race between two concurrent replacements.

Normal job order is `claimed`, `in_progress_reported`, `printing`, `printed`
or `print_failed`, `bundle_saved`, then `evidence_stored`. A failed-print
bundle is still the unit's evidence: it follows the same package and submission
path, leaving the verdict to the oracle. Any `execution_failed` in the unit's
signed history blocks release, even if a later event records completion. A re-run
requires a NEW funded unit. A failed unit pays nothing; the payer reclaims its
refund at `reclaimAt`. Busy jobs retry within the host's bound
and produce no bundle; empty-event jobs end with `no_bundle`, and simulated
evidence ends with `simulated_refused`. None submits. An explicit `realMode: false`
library rehearsal may relay simulated evidence as an unsigned `{events, bundleHash}`
envelope that retains its simulation tags, without adding it to the strict unit
session or granting it delegated authority. It always ends `evidence_stored`
with `submit_disabled`, even for an incomplete manifest, and never packages or
submits it, including on a later sending run. When the gateway refuses an
evidence POST without storing anything (`500 evidence_store_failed`;
`503 read_failed`, `503 scope_requirements_unavailable` or
`503 wallet_link_unavailable`; any `429`), the host re-posts the same saved bundle in the same process, at
most five POSTs in all. Before each re-post it waits 5, 20, 60, then 120
seconds, or a longer reply's `Retry-After`, capped at 300 seconds per wait.
Each refused POST logs its closed code (`server_error`, `unavailable` or
`rate_limited`). While waiting, the host sends no heartbeat, polls nothing
and claims nothing. A host stop ends the wait with no further journal record;
a restart marks the job `interrupted` and never re-posts its bundle. If the
last POST is also refused, the job ends `evidence_refused` with that refusal's
code. An ambiguous post (`indeterminate`) is never re-posted and ends
`evidence_indeterminate`; any other refusal ends `evidence_refused` at once.
None of these outcomes reaches package submission.

Only after durable `evidence_stored` does the host build and sign D1 and D2.
It saves and fsyncs the full signed public package as a mode-0600
`<encodeURIComponent(jobId)>.package.json` artifact in the job journal directory,
then journals `package_built` with only the public `packageDigest` and
`evidenceBlockHash`. Next it POSTs the persisted `{body, signatures}` envelope
to the gateway receipt route, checks the receipt's chain, escrow, settlement unit
and digest against that package, atomically saves `<encodeURIComponent(jobId)>.receipt.json`,
and journals `receipt_stored`. The receipt file contains
`{receipt, signatureHex, receiptDigest, kid}`; hand its `{receipt, signatureHex}`
to the `/settle` caller. PASS and FAIL bundles use this same call order:
**build, receipt, submitEvidence**. No broadcaster submission is allowed without
a stored, binding receipt.

The broadcaster signs after successful preflight, then awaits the host's hook
that journals and fsyncs `submit_attempted` with the public transaction hash.
That durable attempt is the last step before `sendRawTransaction`, after signing
and immediately before the send. If the hook fails, no transaction is sent and
the host halts. Chain outcomes are `submitted`, `already_committed`,
`conflict`, `refused`, or `submit_indeterminate`. A matching existing commitment
requires no send; a conflict halts that job. In real CLI mode all three positive
transaction caps must be configured unless `--no-submit` is explicit; disabled
submission invokes neither package signers nor transaction signer.
`package_inputs_missing` is likewise an `evidence_stored` code.
An already saved package or receipt keeps its `package_built` or `receipt_stored`
state while sending is disabled and logs `submit_disabled`. The host keeps
polling and checking e-stop and allows new claims; an enabled run can submit
the saved package later.
Funding and expiry times must be integer Unix seconds in `[1_600_000_000, 2^32)`;
millisecond values are refused before claim or session opening. Before running,
the host checks the device key's load-time delegation parent against its operator
principal and refuses missing, mismatched or compromised device identities.

A pre-send RPC failure, `unreconciled_transaction`, or `caps_exceeded` leaves the
job at its previous state and writes no attempt. Receipt 429s, 5xx replies
(including `503 receipt_signer_unavailable`), network and timeout failures,
unrecognized refusals, and the operator-fixable refusals below retry without
a new journal record. Failures back off per job from 5 seconds, doubling to
60 seconds; a low cap keeps logging `submit_caps_exceeded` until the operator
raises it.
Receipt `409 receipt_exists` (`receipt_conflict`), `409 kernel_mismatch`
(`receipt_kernel_mismatch`), `400 invalid_package_body`
(`receipt_invalid_package_body`), `422 invalid_package_signatures`
(`receipt_invalid_package_signatures`) and `400 invalid_settlement_unit`
(`receipt_invalid_settlement_unit`) are terminal `refused`: they are never
submitted and their receipts are never posted again. The persisted package
cannot pass these checks, so the unit is never paid; the payer reclaims at
`reclaimAt`. These gateway-fixable refusals retry under their own log codes:
`404 job_not_found`, `422 package_challenge_refused`,
`422 package_registry_refused`, `422 package_operator_refused` and
`503 receipt_storage_unavailable`; such a unit no longer holds up the host while
backing off (see recovery below). A `409 kernel_emergency_stopped` and other
409 errors retry without submission; a receipt for a different package is
terminal `receipt_mismatch`.
A source failure on restart logs its closed input code and retries from
`evidence_stored`; only a returned incomplete manifest writes `package_inputs_missing`.

On restart, `submit_attempted` and `submit_indeterminate` reconcile by read-back
only, using the persisted package's chain, escrow, unit, schema and digest rather
than a reloaded manifest. The exact digest commitment becomes `already_committed`;
a different commitment becomes `conflict`. Confirmed absence after a journaled attempt
stays `submit_indeterminate`. Check the transaction hash from `submit_attempted`
on the chain's explorer. If it is mined, the next read-back resolves the unit.
If it is not mined, the host keeps reading back. This round adds no resend tool.
The host never
automatically resends and exposes no resubmit flag. Interrupted printing or
partial session work is journaled `interrupted` and never reprinted or reposted.
Recovery covers only unfinished-settlement records: `evidence_stored` with no
code, `package_built`, `receipt_stored`, `submit_attempted` and
`submit_indeterminate`.
Only `evidence_stored` with no code can resume package construction.
`package_built` without `receipt_stored` re-POSTs the persisted package; the route
is idempotent per digest. `receipt_stored` reloads and validates its artifact and
package binding before the first attempt. Missing, malformed, or mismatched
stored receipt artifacts halt as `journal_invalid`. Read-back-only states never
POST a receipt. Missing or altered package artifacts likewise halt.
Unresolved attempts take priority over every new send on the operator's nonce
stream. Repeated unchanged read-back outcomes log their code without growing
the durable journal.
While a recovered code-less `evidence_stored`, `package_built` or
`receipt_stored` unit backs off after a failed attempt, it no longer holds up
the host: the next tick attempts the next ready recovered unit, or polls,
checks e-stop and may claim new work. Once its backoff ends, a tick makes one
attempt for it; after an attempt the run loop waits until the backoff ends or
the next heartbeat is due, whichever is sooner. The exception is the
operator's spend caps: while any stored receipt backs off on
`submit_caps_exceeded`, the host polls and claims nothing because new units
would face the same caps. `submit_attempted` and `submit_indeterminate` still
block: every tick reads them back first, and the host polls and claims nothing
until read-back resolves them.
Escrow accepts one `submitEvidence` per unit; preserving the attempt before
sending prevents restart from consuming that slot twice.

## Per-unit evidence session

`openUnitEvidenceSession` and `resumeUnitEvidenceSession` expose `addEvent`,
`addPrintResult`, and `finalize`. The session uses the device key's
`publicKeyHex`, `delegationParent`, and `signDelegation`. Opening checks the bound
parent and refuses compromised device keys before creating the journal.
Its only device signing operation is `signDelegation`. Finalization mints a separate session key,
authorizes it for the unit's job, signs one bundle, and erases the session secret.
The complete signed bundle is journaled before return; repeated or resumed
finalization returns the same bundle, including after expiry. An unfinalized
session refuses finalization before funding or at or after expiry.

Both add methods stamp absent `settlementUnitId` and `challengeNonce` fields and
refuse conflicting values with `event_binding`. Every committed event carries
both fields. Events must bind the job and one consistent kernel, fall within the
inclusive funded interval, and on addition be no later than the session clock
plus 300 seconds. That future limit is never reapplied during journal replay.
Present `source.simulated` or `payload.mock` tags are refused with
`event_fabricated` unless exactly `false`. A print result's entire event batch is
validated before any event is appended, including unit binding, kernel
consistency, and the session's 1000-event limit. The print's already signed
success bundle is not consumed. Session errors contain only closed
`UnitSessionError` codes, without paths, values, or library messages.

The journal directory has mode 0700 and committed record files have mode 0600;
both must belong to the process's effective uid. Records use sequential
`%08d.json` names. Each append first exclusively creates a same-directory temp
named `.%08d.json.<uuidv4>.tmp` with `O_CREAT | O_EXCL | O_NOFOLLOW`, writes its
bytes, fsyncs and closes it, then atomically links it to the final record name.
The temp is unlinked and the directory is fsynced. Exclusive linking preserves
the refusal when another writer has already created that final record. Replay
ignores orphan temps matching that exact pattern and remains strict about all
other entries and committed bytes. A directory containing only orphan temps
can be opened again. A crash before the final link leaves no committed final
record, so a retry may mint and sign a fresh bundle. The hash chain detects
corruption and naive edits, not a writer with access to the directory.

The local GAP-7 port keeps the frozen carrier fixture without unit fields. Its
one deliberate fixture difference sets the fake print adapter's
`source.simulated` to `false` before printing so the session can accept those
events. A separate test feeds the frozen simulated print result and verifies
`event_fabricated` with nothing journaled. The original toolkit GAP repro stays
unchanged.

## Operator relay gateway client

`createGatewayClient({baseUrl, apiKey, kernelId, wallet?})` uses the Node 20+ global fetch
and keeps the API key in a closure. The frozen client exposes five calls:

- `pollJobs()` requests `GET /api/operator/jobs?kernelId=...&status=queued`,
  validates the job list, drops foreign-kernel jobs, and marks lists of 50 or
  more as truncated. The gateway offers no paging and returns an empty list
  on facade failure, so an empty poll alone is not proof that the site is idle.
- `heartbeat()` sends only `{kernelId, status: "online"}` to
  `POST /api/operator/heartbeat`. Capability announcements are omitted because
  the gateway automatically creates missing capability rows with zero pricing.
- `reportInProgress(jobId)` sends only `"in_progress"` to
  `POST /api/operator/job-status`: **never a terminal status**. Settlement owns
  a paid job's terminal status; the client accepts no status parameter.
- `postRelayEvidence(jobId, bundle)` sends `{jobId, kernelId, evidence: bundle}`
  to `POST /api/operator/evidence`, using the key's `decide` authority on its
  own kernel. The other three calls need `operate`. Acknowledgment is accepted
  only for `stored: true` with the sent job id, `event_bundle_hash` model, and
  matching `sha256:` content hash. A `stored: false` receipt is an error.
- `postReceipt(jobId, {body, signatures})` sends `{packageEnvelope:{body,signatures}}`
  to `POST /api/operator/jobs/:jobId/receipt` with the same operator auth and
  `decide` authority. A strict 200 contains only `{receipt, signatureHex,
  receiptDigest, kid}`; the receipt contains only `{chainId, escrow,
  settlementUnitId, packageDigest, receivedAt}`. The same package digest returns
  the original receipt. A different digest returns `409 receipt_exists`; a
  missing gateway signer returns `503 receipt_signer_unavailable`. A `409`
  `kernel_mismatch` returns the closed code `receipt_kernel_mismatch`.
  The route's other refusal constants return `receipt_refused` with the
  constant as sub-code, each only under its matching status:
  `404 job_not_found`, `400 invalid_package_body`, `400 invalid_settlement_unit`,
  `422 invalid_package_signatures`, `422 package_challenge_refused`,
  `422 package_registry_refused`, `422 package_operator_refused` and
  `503 receipt_storage_unavailable`. Any other status or error keeps the generic
  mapping.

The optional wallet must be `0x` followed by 40 hex digits and is normalized to
lowercase once. Only evidence and receipt POSTs carry one `X-PCC-Wallet` header;
poll, heartbeat and status requests omit it. The CLI uses the loaded operator
address and reads its API key from the configured mode-0600 `apiKeyFile`.

The library client's fallback e-stop reader returns
`{proceed: false, why: "reader_unavailable"}`. The CLI explicitly selects the
strict reader described above. Library callers and tests may inject an
`EmergencyStopReader`; only a successfully parsed poll reaches it. Reader
failures prevent execution.

Each call uses redirect refusal, a single 15-second timeout covering headers
and streamed body reads, and a 1 MiB response limit. These defaults may be
configured for tests. Error results contain only closed codes, HTTP status,
allowlisted subcodes, and a bounded integer retry delay. Success parsing requires
a JSON 200 response. Non-200 JSON bodies are decoded only to classify the
gateway's allowlisted refusal fields; server messages and unknown fields are
never returned. JSON, strings, and inspection of the client expose only its
base URL and kernel id.

Evidence is limited to 1,000,000 serialized UTF-8 bytes and a tagged
`sha256:` hash with 64 lowercase hex digits before any request. Evidence posts
are not idempotent, and the client never retries one. An unreadable or
malformed acknowledgment, timeout, network failure, or unrecognized 5xx returns
`indeterminate`; the host must reconcile from its journal before deciding what
to do next. Three refusal classes prove storage did not occur: the known
`500 evidence_store_failed` (`server_error`); `503 read_failed`,
`scope_requirements_unavailable` and `wallet_link_unavailable` (`unavailable`);
and any `429` (`rate_limited`). On this route a `429` comes only from the
gateway's global rate limiter before the handler runs, or from an edge proxy
that never passed the request on. Only those allow the host to post the same
bundle again; see the run loop.

bundleHash is spec's tagged SHA256, as hashBundle produces it.

The unit route and settlement block are future gateway inputs; the local
manifest source supplies job and package context until those routes exist.
The gateway client does not supply unit context or job inputs, and carrier calls
are not available through it.

The carrier client is parked for Thursday per R9: gateway owns EasyPost; label fetch comes later.

## V-next package pipeline

The run loop connects this library pipeline after durable relay storage.
The host EOA is the PRINT unit's V-next operator under steward ruling R1 (#7803).

1. Finalize the unit session's ONE delegated, signed bundle containing the print
   events and pulled carrier events. The bundle's session signature covers the
   71 UTF-8 bytes of its `sha256:` hash; its device delegation covers LO-EV-1.
2. Supply `UnitContext` from the funded unit and gateway challenge: chain, escrow,
   settlement unit id, job hash, milestone, step, composition root and version,
   accepted envelope hash, nonzero challenge nonce and reference, operator,
   kernel, funded device public key, and decimal Unix-second evidence bounds.
   Supply `ProgramContext` with `programHash`, `attestationSetRoot`, and
   `workProductRoot`, each a lowercase bytes32. These values have no defaults.
3. `buildMilestonePackage(bundle, unitContext, programContext)` checks bundle
   bindings and signatures and returns the closed FinalMilestonePackageV2 body,
   EvidenceBlockV2 and their hashes without signing. The unit-context digest
   binds the nonce. D3 v2 commits the exact spec delegation bytes, parent
   signature, funded device public key, ed25519 scheme 1 and key version 1.
4. `signMilestonePackage(built, operatorKey, deviceKey)` adds mandatory D1
   (`secp256k1-eip712`, operator address) and D2 (`ed25519-raw32`, device public
   key). Both bind `packageBodyHash`; D2 signs its raw 32 bytes. The body hash
   uses SHA-256 over raw32(keccak256(`PCC:vnext:evidence-package-sig:v1`)), a
   big-endian uint64 UTF-8 byte length, then JCS(body). The package digest is
   SHA-256(JCS({body, signatures})), after lowercase-signer, first-wins
   deduplication and sorting as the oracle contract specifies.
   Before signing, it derives the settlement unit id from the body's own fields
   and checks the block's unit-context digest against the body's unit binding
   and challenge nonce, rejecting a mismatch as `bad_body`. It trusts the block's
   events root and D3 digest to come from `buildMilestonePackage`.
5. POST the signed envelope to the N149 gateway receipt route, verify its package
   binding, and save its public receipt for the `/settle` caller.
6. The operator broadcasts `submitEvidence(unitId, packageDigest)` once while
   FUNDED_ACTIVE and before reclaimAt. The escrow's commitment uses layout
   format 1 even though the body's package format is `"2"`. A successful receipt
   must be followed by comparing `evidenceBundleHashOf(unitId)` with the
   domain-separated commitment for the unit's frozen chain id (proven through
   its settlement unit id), escrow, unit, stored schema version and package digest.

Inputs still owed by other lanes: evidence supplies the committed program hash
and the attestation/work-product roots (Q-E3 and S2 goldens); gateway supplies
the challenge and unit block; economics N150 supplies the canonical
escrow record. The host obtains the N149 receipt from the gateway. This package
does not choose a profile or tier,
or attest a settlement verdict. A locally valid package is only one input to the
gateway and oracle checks.

Parity tests import the public gateway's body validator/body hash,
signature canonicalizer, digest preimage and operator verifier by relative path.
Gateway canonicalization refuses duplicate or mixed-case signers, so parity
uses valid unique lowercase sets; separate tests pin the oracle's first-wins
repair rule. The public repo has no unit-context, D3 v2 or EvidenceBlockV2 hash
implementation: tests pin independently encoded contract-formula goldens for
those hashes. No oracle implementation is imported.

## Evidence transaction caps

The `chain` configuration accepts `maxFeePerGasCap` and
`maxPriorityFeePerGasCap` in wei, plus `gasCap` in gas units. Each is a canonical
unsigned decimal string fitting uint256. The priority cap must not exceed the
total fee cap. Omitted caps mean zero to the library broadcaster; real CLI runs
refuse startup unless all three are positive or `--no-submit` is explicit.
The broadcaster snapshots and validates these caps even for
manually constructed config and refuses excessive estimated fees or gas before
calling the operator signer.
These caps bound only the L2 execution fee (gas × maxFeePerGas); on an OP-stack
chain such as Base Sepolia, an L1 data fee is charged on top and is not covered
by any cap. That fee is small for a `submitEvidence` transaction of about 180
bytes, so fund the operator with a margin.

Optional controls are `confirmations` (1–64, default 1), `rpcTimeoutMs`
(1–60,000, default 10,000), `receiptTimeoutMs` (1–3,600,000, default 60,000), and
`pollingIntervalMs` (1–60,000, default 1,000). The RPC URL comes only from
`chain.rpcUrlFile` through the secret-file reader. RPC URLs, raw transactions
and server text are excluded from results and logs. Sends have no retries.
Before latching or sending, the broadcaster parses the signed transaction and
checks its chain, escrow, call data, nonce, gas and fee values against what it
validated, and requires EIP-1559 type and zero value. A mismatch is
`refused/signing_failed`, with no latch or send.

`createEvidenceBroadcaster(config, operatorKey)` returns `submit(input, hooks?)` and
`readBack(input)`. The input is `{escrow, unitId, packageDigest,
compositionSchemaVersion}`. Both calls use the unit's frozen chain id, proven
through its settlement unit id, and its stored schema version for the expected
commitment; a version mismatch is refused as `unit_mismatch` before an initial send.
Submitting an already latched unit returns `indeterminate` with its retained
transaction hash after snapshotting the input and before frozen-unit or RPC
checks, including after a refused send.
`readBack` never signs or sends. An uncommitted getter
returns `refused` with `EvidenceNotCommitted`. Factory configuration errors carry
only `bad_config`.
The optional hook is `{beforeSend: async ({transactionHash, nonce}) => ...}`.
The broadcaster awaits it after signing and immediately before `sendRawTransaction`.
Hook rejection sends nothing, releases that attempt's latch and nonce hold, and
propagates the error. Callers without a hook retain the ordinary broadcaster behavior.

The closed outcomes are `submitted`, `already_committed`, `conflict`,
`indeterminate`, `refused`, `caps_exceeded` and `rpc_unavailable`. Matching
read-back means `already_committed`; a different stored commitment means
`conflict`. After a send with no confirmed receipt in time, `indeterminate`
requires caller reconciliation by read-back. Never automatically resend it.
A send-time refusal requires a decoded escrow error. Undecoded hex data or a
transport error is `indeterminate` with the transaction hash unless read-back
shows a commitment. Every post-send refusal includes the transaction hash for
journaling. Reconciliation returns `already_committed` or `conflict` for a
committed unit, and an unreadable unit is `indeterminate`.
The broadcaster serializes submissions within its instance for operator nonce
safety and remembers sent units, including ambiguous sends. The run loop's
durable `submit_attempted` record preserves the no-resend rule across process
restarts.
Within an instance, a decoded send-time escrow error releases that attempt's
nonce from both cross-unit checks, whatever its read-back outcome, while the
unit's own latch remains. Otherwise, `submit` refuses another unit as
`unreconciled_transaction` until each earlier transaction it sent has a receipt
or the operator's latest nonce has passed its nonce, and also refuses when the
RPC's pending nonce does not exceed every unreleased nonce it signed. A send
that never reached the chain blocks other units in that instance until its
nonce is consumed. The operator can consume nonce N with any transaction from
the operator EOA, after which the same instance settles it; or reconcile, then
start a new broadcaster. Across instances, including a restart, the caller
must still reconcile first.

## Repros for pcc-adk

Each `GAP-n` calls the exported toolkit and asserts what the host needs. By default,
`gap(name, fn)` registers `it.fails`; a fixed gap therefore makes the expected-failure
test fail until its registration is updated. Set `PRINT_HOST_SHOW_GAPS=1` to register
ordinary tests and see the actual unmet assertions. Passing controls check a print's
success bundle, positive decimal cancel ids (and rejection of whitespace, hex, and
exponent strings), both cancel/event orders, the once-only cancel report control,
and a silent printer's once-only cancel-confirm deadline. An Ed25519 seed scan checks
isolated leak forms, seed-free text, random bytes, and real event hashes/signature
as false-positive controls.
GAP-7 also checks that an intact copied journal resumes alongside the requirement to
refuse a tampered copy. The original journal is scanned again after resume and delivery,
before finalization can erase a leaked session seed. The intact copy's scan detects
only the original bundle's session key.

The at-rest scan covers eight text forms: 64-hex seed, `0x`-prefixed 64-hex seed,
128-hex secret key, base64 seed, base64url seed, base64 secret key, JSON numeric
index-keyed Uint8Array secret key, and JSON numeric seed array. It also scans every
raw 32-byte window, covering a raw 32-byte seed, a raw 64-byte secret key, and a
raw seed at an odd byte offset, and directly searches raw bytes for the device
seed. It does NOT cover decimal Uint8Array text, `util.inspect` Buffer text,
odd-nibble hex, colon-separated hex, prefixed or wrapped base64, base64/base64url
tokens over 8192 characters, or decimal-string arrays.

The scan de-duplicates candidate seeds but derives an Ed25519 public key for every
unique 32-byte window, so its cost grows with journal bytes. GAP-7 has an explicit
60-second timeout, including its six scans; a timing control exercises all six on
a synthetic journal at least ten times the r8 reference's size.

When a toolkit change makes a GAP test pass, the same PR changes that test's `gap(` to `it(`; the repro is then that fix's acceptance test.

Paths and line numbers below refer to the supplied toolkit HEAD, a57ca6e1.

| Test name | What the host called | What it needs | Toolkit lines (path:line) |
| --- | --- | --- | --- |
| GAP-1 real mode never simulates | `createIppPrintKernel({mockMode:false, uri:"ipp://127.0.0.1:9/ipp/print", kernelId, deviceId}).print({documentData, ...})` | Refuse unavailable real printing, or record no simulated or mock events. Reporting a downgrade is not enough: simulated evidence cannot settle. The current repro fails on its own assertion only because the IPP mock finishes inside its 1 s timeout. | `packages/kernel/src/adapters/ipp-adapter.ts:130`, `:136`, `:143`, `:432`; `packages/kernel/src/printer-job.ts:352` |
| GAP-2 a print's evidence holds only its own job's events (N106) | Two sequential `runPrintJob` calls sharing one adapter and emitter; `emitter.getEvents(A.jobId, A.stepId)` after B | A holds exactly its three events, each with `ippJobId:101`, and contains none of B's events. | `packages/kernel/src/printer-job.ts:193`, `:208`; `packages/kernel/src/adapters/types.ts:59` |
| GAP-3 a reported failure returns a SIGNED execution_failed bundle | `runPrintJob` followed by adapter `execution_failed {ippJobId, state:"canceled"}` | A bundle containing failure and no completion, with a verifiable Ed25519 signature over its bundle hash. | `packages/kernel/src/printer-job.ts:256`, `:269` |
| GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:300, ...})`; advance exactly 300 ms, then await real async work; also use a silent printer | One or more cancels, all for the print's own id (never `"stop"`); return a signed failure bundle with no completion and exactly one `execution_failed` with `origin:"device"`. A reporting printer reaches state 7; the silent printer reports `reason:"cancel-unconfirmed"` at its deadline and permits a following print instead of a busy refusal with `reason:"quiescing"`. The result has `failure:{kind:"timeout", origin:"device"}` and truthy `cancelRequested`. Assumes a contract-honouring adapter: these GAPs do not test the real IppAdapter's own origin stamping or cancel-confirm deadline. | `packages/kernel/src/printer-job.ts:230`, `:240`, `:248`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:477-481`, `:717-725` |
| GAP-5 an abort input cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:10_000, signal, ...})`; abort under both cancel/event orders, then await real async work; also use a silent printer | One or more cancels, all for the print's own id (never `"stop"`); signed failure evidence with no completion before timeout whether state 7 arrives before or after cancellation resolves, with exactly one `execution_failed` carrying the print's own `ippJobId` and `origin:"device"`. The silent printer instead reports `reason:"cancel-unconfirmed"` at its deadline and permits a following print instead of a busy refusal with `reason:"quiescing"`. The result has `failure:{kind:"aborted", origin:"device"}` and truthy `cancelRequested`. Assumes a contract-honouring adapter: these GAPs do not test the real IppAdapter's own origin stamping or cancel-confirm deadline. | `packages/kernel/src/printer-job.ts:107`, `:230`, `:240`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:717-725` |
| GAP-6 the unit fields reach every event | `runPrintJob({... settlementUnitId, challengeNonce})`, passed through a requested-option cast | The signed bundle holds exactly three events; every event payload commits both unit fields. | `packages/kernel/src/printer-job.ts:107`, `:179`; `packages/kernel/src/evidence-emitter.ts:138`, `:192` |
| GAP-7 a unit-level evidence session signs ONE journaled bundle under a delegated session key | Dynamically find `openUnitEvidenceSession` / `resumeUnitEvidenceSession`; open with PCC `jobId`, `parentAgentId = eip155:84532:<lowercase operator>`, whole-second `fundedAt`, and `expiresAt` set to the unit's `reclaimAt`; add print events and pickup, resume, add delivery, finalize | Per pcc-evidence bus #7537 H1(b), mint and authorize the session key at finalization: bundle `jobId` equals the requested PCC job id, authorization `parentAgentId` matches the operator, `contractIds` is exactly `[jobId]`, whole-second `issuedAt` lies between `fundedAt` and the earliest event timestamp, `expiresAt` equals `reclaimAt`, and `maxSignatures` equals this ONE bundle's event count. Every event binds `settlementUnitId` and `challengeNonce`. Keep device and session seeds off disk, journal the signed bundle before return, return byte-identical repeat/resumed finalization, reject another unit and a broken journal with an intact-copy resume control, and require files mode 0600 and all journal directories mode 0700. | API absent; `packages/spec/src/evidence/signing-preimage.ts:239` |
| GAP-8 a busy refusal is reported as busy and emits no failure (N127) | `runPrintJob` after adapter refuses start with top-level `busy: true` (also retained in `data`) | Top-level `result.busy` is a structured object with `reason:"device"`, never `true` or a string; no failure evidence. | `packages/kernel/src/printer-job.ts:221`, `:228`; `packages/kernel/src/adapters/types.ts:37` |

Adk was asked in bus #7752 to test the real IppAdapter's origin stamping and
cancel-confirm deadline. A PR1 fix that flips GAP-4/5 flips the kernel half.

The unit options, `signal`, top-level `busy`, `failure`, `cancelRequested`, and unit
evidence session API are requested toolkit shapes. Local types and dynamic lookup
keep the repros compilable before those APIs exist. GAP-7 consumes print events,
never the print's success bundle.

## Running

From the workspace root:

```bash
pnpm install
pnpm --filter @pcc/print-host test
PRINT_HOST_SHOW_GAPS=1 pnpm --filter @pcc/print-host test
pnpm --filter @pcc/print-host typecheck
```

The default run has nine flipped expected-failure registrations; the SHOW run
reports only GAP-1 and GAP-7 as actual unmet assertions. GAP-5 has two
cancel/event orders, and GAP-4 and GAP-5 each have a silent-printer variant.
A root `pnpm test` may drop `PRINT_HOST_SHOW_GAPS` under turbo's strict environment
mode; use the `--filter` commands above.
Typecheck `test/` separately as well: the production tsconfig deliberately excludes
tests, and Vitest does not typecheck them.

`FakeMachineAdapter` implements the toolkit's `MachineAdapter`. Tests script each
start as success with a device job id, busy, or error; await `started()`; explicitly
`emit` print events with `ippJobId`; and inspect `commands` and `cancels`.
Its `cancelJob(jobId)` accepts positive safe integer numbers or decimal strings
matching `/^[1-9][0-9]*$/` whose numeric value is a safe integer, and records numbers.
For the active job it emits `execution_failed {ippJobId, state:"canceled", origin:"device"}` before
cancellation resolves, or on a later real event-loop poll with
`{cancelEventOrder:"after-resolve"}`. The default `cancelBehavior:"report"` reports
cancellation once. With `cancelBehavior:"silent"`, the printer never reports state
7; a real timer with `cancelConfirmMs` (default 50 ms) emits exactly one device-origin
`execution_failed {ippJobId, state:"processing", reason:"cancel-unconfirmed", jobStateReasons:[], origin:"device"}`
if that job is still active, then ends work so quiesce resolves. Repeated cancels
retain the first deadline, and fake timers cannot stall it. Dispose clears the
deadline. Other ids change nothing, and `"stop"` ends
work without a terminal event. A successful replacement start retains the old cancel
handles. In silent mode, cancelling the replacement before the old deadline fires
arms no new deadline; when the old callback runs it skips the replacement, which
remains silent indefinitely unless a later cancel arms a fresh deadline. This replacement
sequence is a declared gap in the fake. The after-resolve poll retains its handle in the
same way: a replacement cancelled before the stale poll fires gets no report.
Real-time waits let hashing finish; fake-time draining
is only a fallback. Each test uses its own
kernel and device ids. IPP repros use fake timers and dispose the adapter; the only
real-mode URI is the loopback discard endpoint above. All signing keys are generated
in memory at runtime. Signatures are verified using `@pcc/kernel-sdk` and Node's
crypto API.
