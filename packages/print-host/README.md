# @pcc/print-host

Private workspace package for the N144 October MVP print host. This package contains
the run loop, host configuration, testnet key custody,
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
signs ONLY LO-EV-1 delegations and D2, through `signDelegation` and `signD2`.
Load it with `delegationBinding: { chainId, operator }` from the host's configured
chain and operator identity; loading without that binding permits public identity
checks and D2, but refuses delegation signing. Delegations name one bounded job id
(1–256 ASCII letters, digits, `_`, `.`, `:`, or `-`, starting with a letter or digit),
the spec's exact MVP action set, and a distinct 32-byte session public key. Their
whole-second issuance lies between funding and the first event, expiry equals
reclaimAt, and maxSignatures equals the finalized event count (1–1000).
`signD2` accepts exactly 32 raw bytes or their `0x`-prefixed lowercase hex encoding.
The local unit session supplies the delegated bundle while the toolkit's GAP-7
remains open.

The operator key has
three scoped uses: D1 `FinalMilestonePackageV2` signatures, zero-value EIP-1559
`submitEvidence(unitId, packageDigest)` transactions, and EIP-712 `JobPolicy`
acceptance signatures. V-next `fund()` always requires the operator acceptance:
the operator never sends the funding transaction
(`packages/contracts/src/VNextSettlementEscrow.sol:346`). The WP-A wallet proof
remains open. Loading the key binds all three signing methods to the configured
chain. D1 uses the fixed domain name
`PCC FinalMilestonePackage`, version `2`, and the supplied escrow address for both
the message and verifying contract. The escrow address is supplied per signing
call until canonical deployment binding is added; no escrow configuration field
is needed yet.

October ships no `invokeBackup` path. A recursive source guard test enforces the
absence of its name and selector and checks the host's `submitEvidence` selector
against the repository escrow ABI.

For the Thursday acceptance hand-off, run:

```bash
node packages/print-host/dist/cli.js sign-policy --config /absolute/host.json --terms /absolute/terms.json --input /absolute/policy.json --out /absolute/signature.json
```

The terms file strictly contains `minG` (an unsigned decimal string),
`allowedRequiredTiers` (an array of numbers), `reclaimMinSeconds`,
`reclaimMaxSeconds`, `maxFeeBps`, `allowedFeeRecipients` (an array of addresses),
`allowedPayoutRecipients` (a required, non-empty array of addresses with no
case-insensitive duplicates), `maxUnits`, and `maxAcceptanceSeconds`. The payout
allowlist binds acceptance to who receives each unit's net payment. All remaining scalar terms are integer
numbers. Loaders validate and freeze the terms; a key loaded without terms refuses
policy acceptance signing.

The strict input JSON is `{ "policy": { ... }, "units": [ ... ] }`, using the
exported `JobPolicyFields` and `UnitConfig` shapes from `@pcc/contracts/vnext`.
Every compiler `bigint` field is an unsigned decimal string: policy `chainId`,
`policyNonce`, and `expiry`; unit `milestoneIndex`, `g`, `f`, `n`, and `reclaimAt`;
and each payout's `amount`. Tier, fee-basis-point, and composition-version fields
remain integer numbers. Unknown fields and a caller-supplied clock are refused.

Before signing, the host checks the operator address and bound chain, recomputes
the ordered units root with the compiler's helpers, and checks every unit against
the terms. It also checks the compiler's pre-policy root, which commits the checked
economic configuration. Gross payment must meet `minG`, the required tier and fee recipient must
be allowed, fees must be at most `maxFeeBps`, and reclaim time must lie within the
inclusive configured window from the current time. The zero fee recipient is
allowed only with zero fees. Every payout recipient must be allowed, compared
case-insensitively. The compiler's `computeFee` must match both `f` and `n`, and
non-empty, positive payouts must sum exactly to `n`. The host also calls the
compiler's `buildUnitConfig` for context-free validation, checks the supplied
`requestedTier` against its derived value, and maps validation failures to
`bad_input`. Unit count must be between one and `maxUnits`, and
acceptance expiry must be in the future and no farther away than
`maxAcceptanceSeconds`. The signature uses the compiler's `jobPolicyTypedData`
unchanged; its verifying contract is `policy.escrow`.

Success creates a new mode-0644 JSON file containing exactly `operator`, `chainId`
(a number), `escrow`, `acceptanceDigest`, and `signature`. Existing output files
are refused. This command prints no policy or private key data; on failure it
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
events on success, or `execution_failed` evidence on failure. The reference is
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
print-host run --config /absolute/host.json [--once] [--poll-only] [--inputs-dir /absolute/inputs]
```

The equivalent direct invocation is
`node packages/print-host/dist/cli.js run ...`. `--config` is required.
`--once` runs one tick; otherwise the host polls until SIGINT or SIGTERM.
`--poll-only` polls and heartbeats without opening the printer or loading signing
keys. `--inputs-dir` selects the local manifest/document source. Without it,
the default source returns `job_inputs_unavailable` and no job is claimed.
All run logs contain closed codes only.

The CLI uses the **STRICT e-stop reader by default**. Execution requires a parsed
poll with an own `emergencyStop: "clear"` field and an own `jobs` array.
`"stopped"`, `"unavailable"`, missing or malformed stop data, and poll errors
prevent execution. The host polls again immediately before printing, watches
the stop while printing, and cancels on shutdown or a stopped poll.

The local source reads `<encodeURIComponent(jobId)>.json` and the named PDF in
the same directory. A manifest contains these fields:

| Field | Shape |
| --- | --- |
| `jobName` | Nonempty string, at most 256 characters, with no control characters |
| `totalPages` | Integer 1–50 |
| `documentFile` | A plain basename, at most 240 UTF-8 bytes; the file must begin `%PDF-` |
| `unit.settlementUnitId`, `unit.challengeNonce` | Lowercase `0x`-prefixed bytes32; the challenge nonce must be nonzero for packaging |
| `unit.fundedAt`, `unit.reclaimAt` | Nonnegative safe-integer Unix seconds, with `reclaimAt > fundedAt` |
| `unit.chainId` | 84532 or 31337, matching the configured chain |
| `unit.escrow` | Nonzero EIP-55 address |
| `unit.jobIdHash`, `unit.stepId`, `unit.compositionRoot`, `unit.acceptedEnvelopeHash` | Lowercase `0x`-prefixed bytes32 |
| `unit.milestoneIndex` | Nonnegative safe integer |
| `unit.compositionSchemaVersion` | Unsigned 16-bit integer |
| `unit.tChallengeRef` | Nonempty challenge reference string, at most 256 characters, with no control characters or unpaired surrogates |
| `unit.evidenceTimeBounds` | `{ "start": "...", "end": "..." }`, canonical decimal Unix-second strings with `start <= end`, covering every event |
| `program` | `{ "programHash": "...", "attestationSetRoot": "...", "workProductRoot": "..." }`, each lowercase `0x`-prefixed bytes32 |

The first five table rows are the printing inputs. Package fields are optional
for compatibility with existing manifests; missing fields still allow printing
and relay storage, then journal `package_inputs_missing` and skip settlement
submission. Supplied fields are strictly validated, including partial package
inputs, and unknown fields are refused. Operator, kernel and funded device
identities come from the configured runtime. The gateway settlement block and
economics' canonical funded record are the future source of the unit context;
the evidence lane owns the three program roots. The file source is the seam
for those inputs and invents no package defaults.

The private `dataDir/journal/` contains per-job mode-0600 JSONL records and the
saved signed bundle. Appends sync their file and directory before returning.
The mode-0700 `dataDir/sessions/` holds each unit session's public journal;
device and session seeds are never written there. The session opens after
`in_progress_reported`, adds every result event in order, then mints and
delegates its session key at finalization. Finalization is repeatable from its
public records and retains one signed bundle.

Normal job order is `claimed`, `in_progress_reported`, `printing`, `printed`
or `print_failed`, `bundle_saved`, then `evidence_stored`. A failed-print
bundle is still the unit's evidence: it follows the same package and submission
path, leaving the verdict to the oracle. Busy jobs retry within the host's bound
and produce no bundle; empty-event jobs end with `no_bundle`, and simulated
evidence ends with `simulated_refused`. None submits. An explicit `realMode: false`
library rehearsal may relay simulated evidence, but records `submit_disabled`
and never packages or submits it. An ambiguous relay post
ends with `evidence_indeterminate`; a refusal ends with `evidence_refused`.
Neither reaches package submission.

Only after durable `evidence_stored` does the host build and sign D1 and D2.
It saves and fsyncs the full signed public package as a mode-0600
`<encodeURIComponent(jobId)>.package.json` artifact in the job journal directory,
then journals `package_built` with only the public `packageDigest` and
`evidenceBlockHash`. It journals and fsyncs `submit_attempted` **before**
`sendRawTransaction`. Chain outcomes are `submitted`, `already_committed`,
`conflict`, `refused`, or `submit_indeterminate`. A matching existing commitment
requires no send; a conflict halts that job. All three positive transaction
caps must be configured; omitted caps attach `submit_disabled` to
`evidence_stored` and invoke neither package signers nor transaction signer.
`package_inputs_missing` is likewise an `evidence_stored` code.

On restart, `submit_attempted` and `submit_indeterminate` reconcile by read-back
only, using the persisted package's chain, escrow, unit, schema and digest rather
than a reloaded manifest. The exact digest commitment becomes `already_committed`;
a different commitment becomes `conflict`. Confirmed absence after a journaled attempt
stays `submit_indeterminate` for operator reconciliation. The host never
automatically resends and exposes no resubmit flag. Interrupted printing or
partial session work is journaled `interrupted` and never reprinted or reposted.
`evidence_stored` without a skip code and `package_built` can resume safe local
work before the first submit attempt.
Unresolved attempts take priority over every new send on the operator's nonce
stream. Repeated unchanged read-back outcomes log their code without growing
the durable journal.
Escrow accepts one `submitEvidence` per unit; preserving the attempt before
sending prevents restart from consuming that slot twice.

## Operator relay gateway client

`createGatewayClient({baseUrl, apiKey, kernelId})` uses the Node 20+ global fetch
and keeps the API key in a closure. The frozen client exposes four calls:

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
`sha256:` hash with 64 lowercase hex digits before any request. Evidence posts are
not idempotent and are never retried. An unreadable or malformed acknowledgment,
timeout, network failure, or unrecognized 5xx returns `indeterminate`; the host
must reconcile from its journal before deciding what to do next. The known
`500 evidence_store_failed` and `503 read_failed` or
`scope_requirements_unavailable` refusals establish that nothing was stored.

bundleHash is spec's tagged SHA256, as hashBundle produces it.

The unit route and settlement block are future gateway inputs; the local
manifest source supplies job and package context until those routes exist.

## Carrier gateway client

`createCarrierClient({baseUrl, apiKey, kernelId, spendApprovalId})` buys labels
with `buyLabel({jobId, documentHash, toAddress, fromAddress, parcel})` through
`POST /api/carrier/shipments`. `getShipment(jobId)` reads the shipment and
`pullCarrierEvents(jobId)` reads its carrier evidence through the gateway.
The host never calls EasyPost and holds no EasyPost key. The frozen client keeps
its gateway API key in a closure and uses the same bounded requests and redirect
refusal as the operator relay client.

Every label requires the operator's go: configure a non-empty `spendApprovalId`
before calling `buyLabel`, including in TEST mode to preserve the approval habit.
The client refuses before sending without it. Purchase retries occur only for a
`502` whose JSON has `retry: true`, at most twice, with byte-identical bodies.
An HTTP `200` replay succeeds with `replayed: true`. The receipt includes the
label and tracking identifiers, provider mode, mock flag, and the commitment's
hash and `committedAt` timestamp. Provider mode is recorded; the host decides
which modes it accepts.

Label-before-print integration comes in a later PR: the host must buy the label
and read `commitment.committedAt` before it prints. TEST-mode carrier events have
`source.simulated: true`, and `/settle` refuses them. The oracle and evidence
requirements govern the demo's release basis (bus #7765).

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
   Before signing, it checks the block's unit-context digest against the body's
   unit binding and challenge nonce, rejecting a mismatch as `bad_body`.
5. The operator broadcasts `submitEvidence(unitId, packageDigest)` once while
   FUNDED_ACTIVE and before reclaimAt. The escrow's commitment uses layout
   format 1 even though the body's package format is `"2"`. A successful receipt
   must be followed by comparing `evidenceBundleHashOf(unitId)` with the
   domain-separated commitment for the unit's frozen chain id (proven through
   its settlement unit id), escrow, unit, stored schema version and package digest.

Inputs still owed by other lanes: evidence supplies the committed program hash
and the attestation/work-product roots (Q-E3 and S2 goldens); gateway N149 supplies
the receipt, challenge and unit block; economics N150 supplies the canonical
escrow record. This package does not create a receipt, choose a profile or tier,
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
total fee cap. Omitted caps mean zero and disable broadcasting; supply all three
before sending. The broadcaster snapshots and validates these caps even for
manually constructed config and refuses excessive estimated fees or gas before
calling the operator signer.
These caps bound only the L2 execution fee (gas × maxFeePerGas); on an OP-stack
chain such as Base Sepolia, an L1 data fee is charged on top and is not covered
by any cap. That fee is small for a `submitEvidence` transaction of about 150
bytes, so fund the operator with a margin.

Optional controls are `confirmations` (1–64, default 1), `rpcTimeoutMs`
(1–60,000, default 10,000), `receiptTimeoutMs` (1–3,600,000, default 60,000), and
`pollingIntervalMs` (1–60,000, default 1,000). The RPC URL comes only from
`chain.rpcUrlFile` through the secret-file reader. RPC URLs, raw transactions
and server text are excluded from results and logs. Sends have no retries.

`createEvidenceBroadcaster(config, operatorKey)` returns `submit(input)` and
`readBack(input)`. The input is `{escrow, unitId, packageDigest,
compositionSchemaVersion}`. Both calls use the unit's frozen chain id, proven
through its settlement unit id, and its stored schema version for the expected
commitment; a version mismatch is refused as `unit_mismatch` before any send.
`readBack` never signs or sends. An uncommitted getter
returns `refused` with `EvidenceNotCommitted`. Factory configuration errors carry
only `bad_config`.

The closed outcomes are `submitted`, `already_committed`, `conflict`,
`indeterminate`, `refused`, `caps_exceeded` and `rpc_unavailable`. Matching
read-back means `already_committed`; a different stored commitment means
`conflict`. After a send with no confirmed receipt in time, `indeterminate`
requires caller reconciliation by read-back. Never automatically resend it.
A refusal after the send is reported only after a read-back: a committed unit
returns `already_committed` or `conflict`, and an unreadable unit is `indeterminate`.
The broadcaster serializes submissions within its instance for operator nonce
safety and remembers sent units, including ambiguous sends. The run loop's
durable `submit_attempted` record preserves the no-resend rule across process
restarts.
Within an instance, `submit` refuses another unit as `unreconciled_transaction`
until each earlier transaction it sent has a receipt or the operator's latest
nonce has passed its nonce, and also refuses when the RPC's pending nonce does
not exceed every nonce it signed. Across instances, including a new broadcaster
or a restart, the caller must reconcile an indeterminate operator transaction
first, so an unseen pending transaction cannot compete for the same nonce.

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
refuse a tampered copy. The original journal and intact copy are scanned again after
resume and delivery, before finalization can erase a leaked session seed.

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
remains silent indefinitely. This replacement sequence is a declared gap in the fake.
Real-time waits let hashing finish; fake-time draining
is only a fallback. Each test uses its own
kernel and device ids. IPP repros use fake timers and dispose the adapter; the only
real-mode URI is the loopback discard endpoint above. All signing keys are generated
in memory at runtime. Signatures are verified using `@pcc/kernel-sdk` and Node's
crypto API.
