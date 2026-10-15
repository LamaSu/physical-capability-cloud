# @pcc/print-host

Private workspace package for the N144 October MVP print host. The host application
comes in later PRs. This package contains host configuration, testnet key custody,
deterministic test support, and repros of the toolkit gaps that prevent REAL-mode
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
The toolkit still needs the unit session and bundle builders recorded by GAP-7.

The operator key has
three scoped uses: D1 `FinalMilestonePackageV2` signatures, zero-value EIP-1559
`submitEvidence(unitId, packageDigest)` transactions, and EIP-712 `JobPolicy`
acceptance signatures. V-next `fund()` always requires the operator acceptance:
the operator never sends the funding transaction
(`packages/contracts/src/VNextSettlementEscrow.sol:346`). The WP-A wallet proof
remains open. Loading the key binds all three signing methods to the configured
chain. D1 uses the fixed domain name
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
The file also requires a non-zero bytes32 `termsHash` and a `subjectPins` object.
Pins may contain only the 18 `SubjectBlockFields` keys from `@pcc/spec`, with exact
bytes32 values, an address for `operatorSettlementAddress`, or an integer number
for `integrityGrade` (0–255). `committedProgramHash` is required. An
`operatorSettlementAddress` pin must equal `operatorPayoutRecipient`, compared
case-insensitively. Optional bytes32 `bindingsRoot` pins the computed bindings root.
Unknown fields, accessors, and non-plain terms or pin objects are refused with
`bad_terms`.

Thursday's PRINT unit uses the following terms template. Replace the three
host-specific placeholders with the values computed below:

```json
{
  "termsHash": "0xf037904088f851954883103836132ab016be7a8b0ff4867a4b7b6463a5e4f6b7",
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
  "bindingsRoot": "0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd",
  "reclaimMaxSeconds": 1814400
}
```

Compute `operatorPrincipal` with the `@pcc/spec` producers
`principalTupleWord("operator", formatOperatorPrincipalId(chainId, <host EOA>))`.
The host also checks this word against the signing operator EOA in code.
`operatorSettlementAddress` is the host EOA and must equal
`operatorPayoutRecipient`. At Wednesday's sitting, compute `authorizedTuplesRoot`
over the host's one (operator, kernel, device) triple with the oracle's
`computeAuthorizedTuplesRoot([authorizedTuple(<operator id>, <kernelId>, "ed25519:<device key>")])`,
then cross-check the computation against the oracle's Thursday-shape golden
(`pcc-oracle` commit `87bc14e`,
`config/testnet/s2-subject-block-thursday-shape-golden.json`; vendored in
`test/fixtures/oracle-87bc14e-s2-thursday-shape-golden.json`). `@pcc/spec` exports
`authorizedTuple` but has no public root producer. A root without the host's
triple prevents settlement, so Thursday's terms must pin this value. Thursday
uses `bindings: []`, whose root is the pin above. All twelve zero fields and
`integrityGrade: 0` are exact pins.

These fields extend the complete host terms described above. For Thursday,
`reclaimMaxSeconds` must be at least 1814400 because `reclaimAt` is policy creation
plus 21 days. The pinned `termsHash` is the hash of economics' terms document;
the host's tier limits, payout allowlist, and other local terms are configuration
and are not its preimage.
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

The host also requires `policy.termsHash` to match the loaded pin
(`terms_hash_mismatch`), checks every subject pin (`subject_pin_mismatch`), and
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
`bindingsRoot`, `acceptedPolicyDigest`, `subjectBlock`, and `bindings`. The subject
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

Testnet-only is a policy enforced on the configuration's `chainId`. The operator
EOA has the same address on every chain: never fund it on mainnet. The runtime PR
will check `eth_chainId` against the configuration before any signing.

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
pcc-oracle's B5 print-host bundle contract (bus #7386; on the Spark:
`/mnt/sparkbulk/pcc-reconciliation/returns/pcc-oracle-work/print-host-bundle-contract-20261009.md`),
sections 3.0, 4.2 and 5. Toolkit changes belong to pcc-adk; this package records the needed
behavior without changing or working around the toolkit.

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

The default e-stop reader always returns
`{proceed: false, why: "reader_unavailable"}`, even if a future response says
`emergencyStop: "clear"`. **Production must keep this default until PR5 lands**
with pcc-adk's `readEmergencyStop`. Tests may inject an `EmergencyStopReader`;
only a successfully parsed poll reaches it. Reader failures prevent execution.

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

The unit route, settlement block, job inputs, and carrier calls come in later
PRs; none are available through this client yet.

## Repros for pcc-adk

Each `GAP-n` calls the exported toolkit and asserts what the host needs. By default,
`gap(name, fn)` registers `it.fails`; a fixed gap therefore makes the expected-failure
test fail until its registration is updated. Set `PRINT_HOST_SHOW_GAPS=1` to register
ordinary tests and see the actual unmet assertions. Passing controls check a print's
success bundle, positive decimal cancel ids (and rejection of whitespace, hex, and
exponent strings), both cancel/event orders, and an Ed25519 seed scan with isolated
leak forms, seed-free text, and real event hashes/signature as false-positive controls.
GAP-7 also checks that an intact copied journal resumes alongside the requirement to
refuse a tampered copy.

The scan derives Ed25519 keys from 32-byte windows in hex runs, base64/base64url tokens (at most 8192 characters), and JSON byte arrays/index-keyed objects; it does not scan raw binary byte windows.

When a toolkit change makes a GAP test pass, the same PR changes that test's `gap(` to `it(`; the repro is then that fix's acceptance test.

Paths and line numbers below refer to the supplied toolkit HEAD, a57ca6e1.

| Test name | What the host called | What it needs | Toolkit lines (path:line) |
| --- | --- | --- | --- |
| GAP-1 real mode never simulates | `createIppPrintKernel({mockMode:false, uri:"ipp://127.0.0.1:9/ipp/print", kernelId, deviceId}).print({documentData, ...})` | Refuse unavailable real printing, or record no simulated or mock events. Reporting a downgrade is not enough: simulated evidence cannot settle. | `packages/kernel/src/adapters/ipp-adapter.ts:130`, `:136`, `:143`, `:432`; `packages/kernel/src/printer-job.ts:352` |
| GAP-2 a print's evidence holds only its own job's events (N106) | Two sequential `runPrintJob` calls sharing one adapter and emitter; `emitter.getEvents(A.jobId, A.stepId)` after B | A contains none of B's events, identified by B's `ippJobId`. | `packages/kernel/src/printer-job.ts:193`, `:208`; `packages/kernel/src/adapters/types.ts:59` |
| GAP-3 a reported failure returns a SIGNED execution_failed bundle | `runPrintJob` followed by adapter `execution_failed {ippJobId, state:"canceled"}` | A bundle containing failure and no completion, with a verifiable Ed25519 signature over its bundle hash. | `packages/kernel/src/printer-job.ts:256`, `:269` |
| GAP-4 a timeout cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:300, ...})`; advance exactly 300 ms, then await real async work | One or more cancels, all for job 104 (never `"stop"`); keep polling to the canceled state and return a signed failure bundle with no completion and exactly one `execution_failed {ippJobId:104, origin:"device"}` when the device reports cancellation. The result has `failure.kind === "timeout"` and truthy `cancelRequested`. | `packages/kernel/src/printer-job.ts:230`, `:240`, `:248`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:477-481`, `:717-725` |
| GAP-5 an abort input cancels the device job and returns a SIGNED execution_failed bundle | `runPrintJob({timeoutMs:10_000, signal, ...})`; abort jobs 105/115 under both cancel/event orders, then await real async work | One or more cancels, all for the print's own id (never `"stop"`); signed failure evidence with no completion before timeout whether state 7 arrives before or after cancellation resolves, with exactly one `execution_failed` carrying the print's own `ippJobId` and `origin:"device"` when the device reports cancellation. The result has `failure.kind === "aborted"` and truthy `cancelRequested`. | `packages/kernel/src/printer-job.ts:107`, `:230`, `:240`; `packages/kernel/src/adapters/ipp-adapter.ts:231`, `:717-725` |
| GAP-6 the unit fields reach every event | `runPrintJob({... settlementUnitId, challengeNonce})`, passed through a requested-option cast | Every recorded event payload commits both unit fields. | `packages/kernel/src/printer-job.ts:107`, `:179`; `packages/kernel/src/evidence-emitter.ts:138`, `:192` |
| GAP-7 a unit-level evidence session signs ONE journaled bundle under a delegated session key | Dynamically find `openUnitEvidenceSession` / `resumeUnitEvidenceSession`; open with PCC `jobId`, `parentAgentId = eip155:84532:<lowercase operator>`, whole-second `fundedAt`, and `expiresAt` set to the unit's `reclaimAt`; add print events and pickup, resume, add delivery, finalize | Per pcc-evidence bus #7537 H1(b), mint and authorize the session key at finalization: bundle `jobId` equals the requested PCC job id, authorization `parentAgentId` matches the operator, `contractIds` is exactly `[jobId]`, whole-second `issuedAt` lies between `fundedAt` and the earliest event timestamp, `expiresAt` equals `reclaimAt`, and `maxSignatures` equals this ONE bundle's event count. Every event binds `settlementUnitId` and `challengeNonce`. Keep device and session seeds off disk, journal the signed bundle before return, return byte-identical repeat/resumed finalization, reject another unit and a broken journal with an intact-copy resume control, and require files mode 0600 and all journal directories mode 0700. | API absent; `packages/spec/src/evidence/signing-preimage.ts:239` |
| GAP-8 a busy refusal is reported as busy and emits no failure (N127) | `runPrintJob` after adapter refuses start with top-level `busy: true` (also retained in `data`) | Top-level `result.busy` is a structured object with `reason:"device"`, never `true` or a string; no failure evidence. | `packages/kernel/src/printer-job.ts:221`, `:228`; `packages/kernel/src/adapters/types.ts:37` |

The unit options, `signal`, top-level `busy`, and unit evidence session API are
requested toolkit shapes. Local types and dynamic lookup keep the repros compilable
before those APIs exist. GAP-7 consumes print events, never the print's success bundle.

## Running

From the workspace root:

```bash
pnpm install
pnpm --filter @pcc/print-host test
PRINT_HOST_SHOW_GAPS=1 pnpm --filter @pcc/print-host test
pnpm --filter @pcc/print-host typecheck
```

The second test run reports nine failures across eight gaps (GAP-5 has two orders).
Typecheck `test/` separately as well: the production tsconfig deliberately excludes
tests, and Vitest does not typecheck them.

`FakeMachineAdapter` implements the toolkit's `MachineAdapter`. Tests script each
start as success with a device job id, busy, or error; await `started()`; explicitly
`emit` print events with `ippJobId`; and inspect `commands` and `cancels`.
Its `cancelJob(jobId)` accepts positive safe integer numbers or decimal strings
matching `/^[1-9][0-9]*$/` whose numeric value is a safe integer, and records numbers.
For the active job it emits `execution_failed {ippJobId, state:"canceled"}` before
cancellation resolves, or on a later real event-loop poll with
`{cancelEventOrder:"after-resolve"}`. Other ids change nothing, and `"stop"` ends
work without a terminal event. Real-time waits let hashing finish; fake-time draining
is only a fallback. Each test uses its own
kernel and device ids. IPP repros use fake timers and dispose the adapter; the only
real-mode URI is the loopback discard endpoint above. All signing keys are generated
in memory at runtime. Signatures are verified using `@pcc/kernel-sdk` and Node's
crypto API.
