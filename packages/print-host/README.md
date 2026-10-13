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

The unit route, settlement block, and job inputs come in later PRs; none are
available through this client yet.

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

The second test run reports eleven failures across eight gaps (GAP-5 has two
cancel/event orders, and GAP-4 and GAP-5 each have a silent-printer variant).
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
