# PCC agent golden path

For a coding agent helping a human buy physical work or put an instrument on PCC. Choose buy or supply, then follow the steps in order. Use the gateway the human supplied as PCC_BASE.

Generated from [starter/buyer/buyer-path.json](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/buyer/buyer-path.json), [starter/runbook/runbook.json](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/runbook.json), [starter/runbook/index.json](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/index.json) and [apps/dashboard/public/agent-package.json](https://github.com/LamaSu/physical-capability-cloud/blob/master/apps/dashboard/public/agent-package.json). Do not edit the generated artifact.

## Rules before either path

Use the PCC gateway you were given; there is no default. Never call production unless told to. pcc-node needs https, or plain http to 127.0.0.1 or [::1].

Ask the human only for what you cannot do or find yourself (class C facts), in one batch per phase, each with one line saying why. Anything you can check or look up, do. Money and safety values are never defaulted: price, payout, license rate and every safety limit come from the human or a cited source the human confirms.

Never claim success until the relevant doneWhen checks are verified against actual responses or the device. A listing, an HTTP 200, a mock run or a hand-written evidence bundle does not prove physical completion. Report blocked or failed checks honestly.

Never execute a composition, submit a job, fund escrow or spend through a payment challenge without the human's explicit approval of the plan, price, scope and evidence requirements. The automatic buyer path ends at STOP. Keep API keys, private keys and transcripts out of logs, chat, reports and version control.

## Buy: plan, read back, hand off

Buy: discover capabilities and hand a priced composition to the human

This composed plan carries no binding quote. A per-capability negotiated quote exists outside this path; committing it creates a job and escrow, so it needs the human's approval. totalPriceUSD is the sum of steps[].estimatedPriceUSD. The catalog estimate uses each candidate's baseCost, the spec's maximum base cost per job, falling back to minimum or zero when unavailable. Per-unit charges are ignored, so the estimate can be high or low. Estimates come from this gateway's capability candidates and are not verified prices. These fields are API-labelled USD estimates, but the catalog provider parses raw amounts without currency conversion. Label these limitations in the handoff and never invent a quote field or treat a zero estimate as a confirmed free service.

### 1. get-key

Use the assigned gateway and keep a valid API key in private local state.

Ask the human only for missing facts:

- The gateway to use, only if neither PCC_BASE nor the assignment identifies it; this determines where requests go.
- An email or public wallet address, only if no valid key or authorized identifier is available; provisioning requires one identifier.

Direct HTTP → `POST /api/auth/provision`. Auth: public; no Bearer key required.
Request: Do not call the `provision_api_key` tool, or any tool that hands this response back to you: a tool result enters the conversation, and the tool cannot send publicKey. Only if no existing valid key: check the request shape before sending, because the 5-per-IP-per-hour provisioning limit counts rejected (400) attempts too. Write the request body to .pcc/provision-request.json with your file-writing tool, not with echo or printf, whose arguments other users of the machine can read (ps): {email} or {walletAddress}, and your own locally generated Ed25519 publicKey (64 hex characters, optional 0x prefix), so the gateway does not mint an Ed25519 key for you. publicKey is optional: if you omit it, the response carries ed25519.private_key once (the same key again as ed25519.private_key_pkcs8_base64); store it with the API key in the private 0600 file and never print it. Whether or not you send publicKey, the response can also carry operator_wallet.private_key, an EVM wallet key the gateway mints when it writes an on-chain identity for you; it stays in the same private 0600 file and is never printed. Keep a locally generated private key locally. Optional name and capability are strings. Then run the recipe below as one script, from the folder you work in. It makes .pcc/ private (0700) and ignored by git before any secret arrives, writes the response straight to .pcc/provision.json, prints only the HTTP status and the fields to read, and writes .pcc/auth.header from the file without printing the key; never print, cat or paste .pcc/provision.json. The supply path captures its key the same way (starter/runbook/00-prerequisites.md, step 4).

```bash
umask 077 && mkdir -p .pcc && chmod 700 .pcc
if git rev-parse --git-dir >/dev/null 2>&1 && ! git check-ignore -q .pcc/provision.json; then echo '.pcc/' >> "$(git rev-parse --git-path info/exclude)"; fi
curl -s -o .pcc/provision.json -w 'HTTP %{http_code}\n' -X POST "$PCC_BASE/api/auth/provision" -H 'Content-Type: application/json' --data-binary @.pcc/provision-request.json
rm -f .pcc/provision-request.json
python3 -c 'import json; r = json.load(open(".pcc/provision.json")); print({k: r.get(k) for k in ("error", "message", "retry_after_seconds", "key_id", "operator_id", "trace_id")}, "ed25519.public_key:", (r.get("ed25519") or {}).get("public_key"))'
python3 -c 'import json; k = json.load(open(".pcc/provision.json"))["api_key"]; open(".pcc/auth.header", "w").write("Authorization: Bearer " + k + "\n")'
chmod 600 .pcc/provision.json .pcc/auth.header
```

Read response fields: key_id, operator_id, trace_id, ed25519.public_key.
Store only, never read into the conversation: api_key, usage.header (holds api_key), usage.example (holds api_key), ed25519.private_key (only when publicKey was omitted), ed25519.private_key_pkcs8_base64 (only when publicKey was omitted), operator_wallet.private_key (when present).
Gateway source: [provision.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/provision.ts), [api-key-auth.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/auth/api-key-auth.ts), [security-hardening.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/security-hardening.ts), [rate-limiter.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/rate-limiter.ts).

Direct HTTP → `GET /api/auth/validate`. Auth: public validation route; send the key in Authorization: Bearer `<key>` for the handler to validate.
Request: Validate any existing key before provisioning; validate the new key after provisioning. Read the Authorization header from private local state, never expose the key in command arguments or reports: send it as a header file with curl -H @.pcc/auth.header, as below. The provisioning recipe writes that file. For an existing key held in an environment variable, make .pcc/ private as that recipe's first line does, then write the file with `umask 077; printf 'Authorization: Bearer %s\n' "$PCC_API_KEY" > .pcc/auth.header`; printf is a shell builtin, so the key never appears in a command's arguments. No request body.

```bash
curl -s "$PCC_BASE/api/auth/validate" -H @.pcc/auth.header
```

Read response fields: valid, operatorId.
Gateway source: [provision.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/provision.ts), [api-gate.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/api-gate.ts).

Done when:

- PCC_BASE names the gateway the human assigned; never use production unless told to.
- An existing or newly provisioned key is stored privately (.pcc/ is 0700 and ignored by git), no key or private key was printed, and the validation response contains valid: true.

### 2. discover

Discover supported types and actual available operators for the desired outcome without paying for search.

Ask the human only for missing facts:

- The desired outcome and location or other acceptance constraints, only when absent from the assignment and impossible to determine locally; these select suitable operators.

Tool: `list_capability_types` → `GET /api/capabilities/types`. Auth: public GET; no Bearer key required.
Request: No body or query parameters. Read the returned union of template, registered catalog and CSD types.
Read response fields: types.
Gateway source: [capabilities.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/capabilities.ts), [api-gate.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/api-gate.ts).

Tool: `search_capabilities` → `GET /api/capabilities/templates`. Auth: public GET; no Bearer key required.
Request: The package tool accepts {query}, but this HTTP handler ignores query parameters and returns all templates. Filter the returned templates locally for structural and pricing hints; this is not live operator search.
Read response fields: templates[].capabilityType, templates[].name, templates[].description, templates[].basePrice, templates[].currency.
Gateway source: [capabilities.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/capabilities.ts), [api-gate.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/api-gate.ts).

Direct HTTP → `POST /ask`. Auth: public; no Bearer key or payment required.
Request: Send {query: `<plain-English need>`} or {query: {text: `<plain-English need>`}} with nonempty text of at most 500 characters. Use this public catalog search; do not submit payment credentials for discovery.
Read response fields: results[].serviceType, results[].name, results[].provider.identifier, results[].additionalProperty. The response returns at most 20 results. additionalProperty includes named values such as available, assuranceTiers and materials. results[] is empty when no service matches. This search does not return a price.
Gateway source: [well-known-aeo.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/well-known-aeo.ts), [api-gate.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/api-gate.ts).

Done when:

- Types and template hints have been read, and the public search results identify candidate services for the human's outcome.
- Availability and assurance tiers come from returned service properties; a listed type or template alone is not evidence that an operator is available.

### 3. compose

Create a proposed plan within the human's budget and assurance requirements, with returned price estimates.

Ask the human only for missing facts:

- The total budget in USD and minimum assurance tier (0–3), only if the human has not already supplied or confirmed them; money and safety choices are never defaulted.

Tool: `propose_composition` → `POST /api/compose`. Auth: Authorization: Bearer `<key>` required; a SIWE session is also accepted.
Request: Send {outcomeType, steps, budgetUSD, minAssuranceTier} from the assignment and human's choices. Build steps from discovered capability types (1–20 nonempty strings, each at most 120 characters); without steps, outcomeType alone must itself be a capability type. outcomeChain plans only its last entry, so use steps for the intended sequence. outcomeType is 1–120 characters; budgetUSD is positive and at most 1000000000; minAssuranceTier is 0, 1, 2 or 3. Optional location is {lat, lng, radiusKm?}; optimizeFor is price, speed or quality; requester is {agentId, did?}; description is 1–4000 characters. Do not silently relax constraints.
Read response fields: compositionId, status, steps[].capabilityType, steps[].capabilityId, steps[].kernelId, steps[].operatorAddress, steps[].estimatedPriceUSD, totalPriceUSD, totalDurationMs, effectiveAssuranceTier, budgetUSD, budgetRemainingUSD, expiresAt, rejectionReason. HTTP 201 means status proposed; HTTP 200 may instead contain over_budget or no_path_found. Inspect status and rejectionReason. totalDurationMs can contain a one-hour placeholder per catalog candidate; it is not a promised ETA. Graph-derived steps always have an empty operatorAddress; catalog steps can too when the kernel lookup fails.
Gateway source: [compose.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/compose.ts), [composition.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/spec/src/types/composition.ts), [capability.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/spec/src/types/capability.ts), [negotiation.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/negotiation.ts), [api-gate.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/api-gate.ts).

Done when:

- The response has status: proposed, a compositionId and nonempty steps, plus totalPriceUSD and steps[].estimatedPriceUSD; record expiresAt and the assigned capabilities.
- This composed plan carries no binding quote. A per-capability negotiated quote exists outside this path; committing it creates a job and escrow, so it needs the human's approval. The returned prices are estimates; report missing or zero pricing rather than inventing a field or confirming a free service.

### 4. read-plan

Read the saved plan back and inspect its price, assignments, constraints and expiry before handing it off.

Ask the human only for missing facts: none.

Tool: `get_composition` → `GET /api/compose/{id}`. Auth: Authorization: Bearer `<key>` required; a SIWE session is also accepted.
Request: Set id to the returned compositionId; no body. Read the saved object rather than relying on a previous success status.
Read response fields: compositionId, status, steps, totalPriceUSD, totalDurationMs, effectiveAssuranceTier, budgetUSD, expiresAt.
Gateway source: [compose.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/compose.ts), [api-gate.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/api-gate.ts).

Done when:

- The saved response has the same compositionId, status: proposed, nonempty steps and unexpired expiresAt, with totalPriceUSD and per-step estimatedPriceUSD consistent with the proposed plan.
- The human's outcome, budget and assurance choices match the returned plan; unresolved provider, pricing or timing limitations are identified.

### 5. STOP — handoff

Stop and hand the human the saved plan and estimated prices with their limitations.

Human handoff; approval is required before any further action:

- Explicit approval for the specific plan and any spend before proceeding beyond this terminal path; presenting the estimate or receiving an API success response is not approval.

Done when:

- The human receives the gateway, compositionId, capability assignments, per-step estimates, the API-labelled USD totalPriceUSD, expiry, assurance tier and all pricing or timing limitations, including the lack of currency conversion. This composed plan carries no binding quote. A per-capability negotiated quote exists outside this path; committing it creates a job and escrow, so it needs the human's approval.
- No execution, funding, payment, paid search or job submission occurred. Never claim physical work succeeded until its outcome evidence has been read; this path ends with a proposal.

## Supply: follow the starter runbook

Device to registered kernel: onboarding a machine as a PCC operator
Source status: second cut, written against master 753feb43 and pcc-node 0.1.1; each phase lists what is still pending.

Use [starter/AGENTS.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/AGENTS.md) and work through these phase files in order. Each file contains the commands and checks. Wait for its required human approval. When a phase's doneWhen says it reports blocked, report it blocked and continue to its next phase; later phases and the final session report still run. Do not skip checks or call a blocked phase successful.

### 0. prerequisites — [starter/runbook/00-prerequisites.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/00-prerequisites.md)

Goal: A working PCC_BASE, pcc-node with signing support, and an API key kept out of logs.
Done when:

- `GET $PCC_BASE/api/health` returns 200
- pcc-node --version prints 0.1.1 or later, and python3 -c "import nacl" succeeds
- `GET $PCC_BASE/api/auth/validate` with your key returns valid: true

Ask the human: which PCC gateway to use, if PCC_BASE is not already set; the email to register the operator key under. Next: identify.

### 1. identify — [starter/runbook/01-identify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/01-identify.md)

Goal: Know exactly what the device is and how to reach it, from the device itself.
Done when:

- make, model, serial and firmware recorded from the device (its API, nameplate or manual)
- the device answers on the network address you will configure

Ask the human: nothing. Next: intake.

### 2. intake — [starter/runbook/02-intake.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/02-intake.md)

Goal: Collect the facts only the human has, in one batch.
Done when:

- every class C fact answered, or explicitly routed to research

Ask the human: authority to operate; location; emergency stop: where it is and who can press it; supervision; consumables; price; availability. Next: research.

### 3. research — [starter/runbook/03-research.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/03-research.md)

Goal: Find the device's control interface, safe limits and typical inputs and outputs, with citations.
Done when:

- every value you will use as a limit has a unit and a citation

Ask the human: nothing. Next: build.

### 4. build — [starter/runbook/04-build.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/04-build.md)

Goal: A pcc-node configuration for the device, its typed operations, and a safety envelope the human has confirmed once.
Done when:

- pcc-node.json describes the device
- each operation has typed inputs and outputs
- the human confirmed the safety envelope (one yes or edit)

Ask the human: one confirmation of the drafted safety envelope. Next: register.

### 5. register — [starter/runbook/05-register.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/05-register.md)

Goal: The kernel, its signing key, its capability and its device exist on the gateway, and buyers can find the capability.
Done when:

- `GET /api/kernels/<id>` shows your kernel with a non-null signingKey
- `POST /api/capabilities` returned 201 for your capability, priced from intake
- `POST /api/setup/register-device` returned 201 or 200, with no capabilities listed
- `GET /api/capabilities/search` finds your capability

Ask the human: nothing. Next: verify.

### 6. verify — [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md)

Goal: The emergency stop reads correctly and the device stops on its own command. The test job waits for a queue-only submission and is reported blocked.
Done when:

- the stop read STOPPED during the drill, then CLEAR from a stored policy, and the device stopped on its own command
- no test job was submitted: the phase reports it blocked until the gateway offers a queue-only submission

Ask the human: permission for one emergency-stop drill. Next: operate.

### 7. operate — [starter/runbook/07-operate.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/07-operate.md)

Goal: The operating loop runs with all eight rules and refuses any job that carries money; with no job it may run on the current gateway, it reports blocked.
Done when:

- the loop runs and refuses jobs with a negotiation session or an escrow
- `GET /api/operators/:slug/status` shows no missing slot you can fill
- operate is reported blocked while it has no job it may run

Ask the human: nothing. Next: publish.

### 8. publish — [starter/runbook/08-publish.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/08-publish.md)

Goal: Optionally publish the setup as a kit others can reuse, with the license rate the human chooses.
Done when:

- the human decided whether to publish, and at what license rate

Ask the human: whether to publish; the license rate (0 to 100 basis points; never defaulted). Next: session.

### 9. session — [starter/runbook/09-session.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/09-session.md)

Goal: Close the attempt with one roll-up report.
Done when:

- the session report was sent (201, or 200 deduped)

Ask the human: nothing. Next: stop after the session report.

## Named events: recover or report

Events an onboarding agent can hit, each mapped to what to do and where the runbook covers it (R6). Keys are `<phase>`.`<event>`. When an event happens, read its entry, then its runbook section; if guidance/`<key>`.md exists in this starter, read that too. An entry's report says which phase and outcome to report when the event ends the phase.

| Event id | Trigger | What to do |
| --- | --- | --- |
| buyer.identifier-required | 400 identifier_required | Use an authorized email or public EVM wallet address; ask only if neither is available. |
| buyer.invalid-identifier | 400 invalid_email, invalid_wallet_address or invalid_type | Read the message and correct the identifier or field type without guessing another identity. |
| buyer.invalid-public-key | 400 invalid_public_key | Regenerate or normalize the local Ed25519 public key to 64 hex characters; never send its private key. |
| buyer.key-limit | 429 rate_limited or too_many_keys | Reuse an existing valid key. Honor retry_after_seconds or the Retry-After header; provisioning rate_limited specifies 3600 seconds. Check the request shape before sending because the 5-per-IP-per-hour provisioning limit counts rejected (400) attempts too. Do not loop-provision. |
| buyer.invalid-key | 401 invalid_key | Check private local state and the Authorization header, then provision only when no valid existing key remains. |
| buyer.auth-required | 401 api_key_required | Send the stored Bearer key to the assigned gateway; return to get-key if validation fails. |
| buyer.invalid-query | 400 INVALID_QUERY from public search | Send nonempty query text of at most 500 characters, then retry once. |
| buyer.no-match | Public search returns results: [] | Refine the query using discovered types and known constraints. If no operator matches, report the gap and stop; never fabricate a provider. |
| buyer.invalid-compose | 400 validation_failed | Read details and fix the request shape. Preserve human-selected budget and assurance values. |
| buyer.no-path | status: no_path_found | Read rejectionReason, revisit discovery and correct type or location mismatches. If no feasible plan remains, report the limitation and stop. |
| buyer.over-budget | status: over_budget | Show the returned total and rejectionReason. Stop unless the human changes the budget or scope; never increase the budget automatically. |
| buyer.plan-missing | 404 not_found | Check the gateway and saved compositionId; if missing, propose and read back a fresh plan before handoff. |
| buyer.plan-expired | 410 expired | Re-propose using the same confirmed constraints and read the new plan back. Present its new price and expiry. |
| buyer.payment-required | If any route answers 402 | Do not supply payment credentials or pay. Report the unexpected payment requirement and stop. |
| buyer.server-failure | 5xx, including provision_failed during get-key, INTERNAL_ERROR from /ask, or lowercase internal_error from other routes | If the body has report_hint, send the report it describes once through pcc_report: {type: "bug", summary: `<redacted one-line summary>`, endpoint, method, status, errorCode, traceId}. Otherwise report the redacted failure with the same fields once. Do not claim success or repeatedly retry. |
| prerequisites.no-gateway | No gateway URL was given, and .pcc/base does not exist. | Ask the human which PCC gateway to use (class C). Never guess one, and never use production unless told to. Read [starter/runbook/00-prerequisites.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/00-prerequisites.md), section “1. The gateway: PCC_BASE”. Report prerequisites blocked. |
| prerequisites.gateway-unreachable | `GET <gateway>/api/health` does not answer 200 with JSON. | Stop and report what you saw. Don't try another address. Read [starter/runbook/00-prerequisites.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/00-prerequisites.md), section “1. The gateway: PCC_BASE”. Report prerequisites blocked. |
| prerequisites.no-crypto | import nacl.signing fails, or pcc-node refuses with LogSigningRefused or mentions pynacl. | Install pcc-node with the crypto extra. Without it the node can never sign evidence, so its work can never verify. Read [starter/runbook/00-prerequisites.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/00-prerequisites.md), section “2. pcc-node, with the crypto extra”. Report prerequisites failed. |
| prerequisites.key-leaked | An API key, a .pcc header file or a private key was printed, pasted into the conversation, or committed. | Tell the human. Provision a new key (phase 0 step 4, same email) and rewrite .pcc/api-key and .pcc/auth.header. Then revoke the leaked key: find its id with `GET /api/auth/keys` (match its prefix) and send `DELETE /api/auth/keys/<id>` with the new key. Never repeat the leaked value. Read [starter/runbook/00-prerequisites.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/00-prerequisites.md), section “4. An operator API key, captured without logging it”. Report prerequisites blocked. |
| identify.device-unreachable | The device does not answer at the recorded address. | Check that the address includes its port and that the device is on. Ask the human only to power it up or give its address. Read [starter/runbook/01-identify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/01-identify.md), section “1. Ask the device”. Report identify blocked. |
| identify.device-unknown | Neither the device's own API, nor its manual, nor its label names the make and model. | Describe it to `POST /api/onboard/identify-device`, or send a photo. Pass on only the clarifying questions you can't answer yourself. Read [starter/runbook/01-identify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/01-identify.md), section “2. If the device can't say what it is”. |
| intake.dont-know | The human answers "don't know" to a class C question. | Don't press. Treat it as class B: research it, then propose a value with its source for the human to confirm. Money and safety are never defaulted. Read [starter/runbook/02-intake.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/02-intake.md), section “The asking rule (R2)”. |
| intake.asks-about-pay | The human asks how prices, payouts, fees or contributor pay work. | Answer from the runbook. The price is theirs to set. PCC cannot yet pay a wallet they name, so this runbook runs test jobs only and nothing is paid out yet. Publishing a kit adds a license that the buyer pays on top (phase 8). Quote no number that isn't in the runbook or the gateway. Read [starter/runbook/08-publish.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/08-publish.md), section “How contributor pay works (tell the human this before they choose)”. |
| intake.asks-about-safety | The human asks what the emergency stop, supervision or limits mean. | A physical stop is required; PCC's remote stop is best effort, not a safety device. Every limit comes from a cited source, or from the human, and the human confirms the envelope once. Read [starter/runbook/02-intake.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/02-intake.md), section “The class C questions”. |
| research.sources-conflict | Two sources, or a source and the human's answer, give different values for the same quantity. | Don't pick one. List both with their citations and ask the human. Read [starter/runbook/03-research.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/03-research.md), section “The rule”. |
| research.no-citation | A limit, input range or output you need has no unit or no citation. | It cannot become a limit yet. Research it with the ready-to-fire prompts, or ask the human for a value they confirm. Read [starter/runbook/03-research.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/03-research.md), section “Ready-to-fire prompts”. |
| build.envelope-edited | The human changes a value in the safety envelope, or the envelope changes after it was confirmed. | Re-check the value's unit and source, show the changed lines, and record a new confirmation with the new digest. Never run under an envelope the human hasn't confirmed. Read [starter/runbook/04-build.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/04-build.md), section “3. The safety envelope: draft, then one confirmation (R8)”. |
| register.refused | A register call (kernel, signing key, capability, device or channel) answers 4xx. | Read the {error, message} body and fix what it names. Report the route and the status, never a key. Read [starter/runbook/05-register.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/05-register.md). Report register failed. |
| register.signing-refused | register_signing_key refuses with LogSigningRefused, or mentions pynacl. | Install the crypto extra, delete .pcc/node-keys.json and .pcc/node-public-key, run phase 0 step 3 again, then the signing step. Read [starter/runbook/05-register.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/05-register.md), section “2. The kernel's signing key”. Report register failed. |
| verify.job-missing | Once a queue-only submission exists: the test job never shows up in `GET /api/operator/jobs` for your kernel. | Check that the submit answered with a jobId and that the job names your kernel, then report it. Don't fall back to /api/setup/test-job: it runs on a built-in mock device. Read [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md), section “3. Run it the way the operating loop will (phase 7), once, by hand”. Report verify blocked. |
| verify.params-refused | A job's parameters fail the type check or the envelope check. | Don't touch the device. Set the job's status to failed with the reason. Read [starter/runbook/07-operate.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/07-operate.md), section “The operating loop”. Report verify failed. |
| verify.device-busy | The device reports busy or estopped when a job is due to run. | Don't run it, and don't queue over it. Try again later, and report it if it stays busy. Read [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md), section “3. Run it the way the operating loop will (phase 7), once, by hand”. |
| verify.estop-drill-failed | During the drill the stop did not read STOPPED, or the device did not stop on its own command. | Stop onboarding and report exactly what happened. Clear the stop only after the human confirms the device is safe. Read [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md), section “1. Read the stop, and drill it, before anything runs”. Report verify failed. |
| operate.paid-job-refused | A job's `GET /api/jobs/<jobId>/settlement` shows a negotiation session or an escrow: it carries money. | Don't run it. Send failed with reason payout_destination_unbound, and report it: PCC cannot yet pay a wallet the human confirmed. Read [starter/runbook/07-operate.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/07-operate.md), section “The operating loop”. Report operate blocked. |
| operate.estop-active | `GET /api/operator/policy/<kernelId>` shows emergencyStop: true, answers with the gateway's default policy (source "default", no updatedAt), or cannot be read. | Take no job this round. On entering the state, send the device its stop once. Resume only after the human clears the stop. Read [starter/runbook/07-operate.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/07-operate.md), section “The operating loop”. |
| operate.device-down | The device stops answering, or its consumables run out. | Stop taking jobs, and say so in the capability description or with the emergency stop. Report it. Read [starter/runbook/07-operate.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/07-operate.md), section “Keep the listing honest”. Report operate blocked. |
| publish.asks-about-license | The human asks what a kit license is, or what rate to choose. | Explain it: 0-100 bps of each job's gross, 50 by default, 0 allowed, paid by the buyer on top, and shared with upstream kits when forked. Pay is shown in test mode for now. The rate is theirs to choose. Read [starter/runbook/08-publish.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/08-publish.md), section “How contributor pay works (tell the human this before they choose)”. |
| session.stopping-early | You are blocked, the human stops, or you run out of budget. | Send the session report anyway, with abandoned or budget_stop, saying where and why. Read [starter/runbook/09-session.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/09-session.md). Report session abandoned. |
| verify.test-job-blocked | The gateway offers no server-enforced queue-only submission (true of every current gateway). | Don't submit a test job: /api/jobs/submit can start it on the gateway's own devices before any check. Report verify blocked; the drill's result stands. Read [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md), section “2. The test job: blocked on the current gateway”. Report verify blocked. |
| verify.stop-not-clear | The stop does not read CLEAR after the drill's resume, or immediately before a run. | Don't submit and don't run. Report what the policy read showed. Read [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md), section “1. Read the stop, and drill it, before anything runs”. Report verify blocked. |
| verify.money-attached | Once a queue-only submission exists: the test job's `GET /api/jobs/<jobId>/settlement` shows a session or an escrow. | Don't run it: it is not a test job. Report what the settlement showed. Read [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md), section “2. The test job: blocked on the current gateway”. Report verify blocked. |
| verify.evidence-not-stored | `POST /api/operator/evidence` answered without "stored": true for this jobId (HTTP 200 included). | Send status failed with reason evidence_not_stored, never completed, and report what the receipt said. Read [starter/runbook/06-verify.md](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/runbook/06-verify.md), section “3. Run it the way the operating loop will (phase 7), once, by hand”. Report verify failed. |

## Report the attempt

For buyer friction, a missing binding quote or a failed check, send a redacted report:

Tool: `pcc_report` → `POST /api/feedback`. Auth: public; no Bearer key required.
Request: Send {type: "bug", summary: `<redacted one-line summary>`, endpoint, method, status, errorCode, traceId} for an unrecoverable failure, a 5xx or the same step failing twice. If the response body has report_hint, copy its send fields and traceId and add summary. Report each distinct failure once; never include keys, tokens, private keys, email addresses or a transcript.
Read response fields: status, id (only for a newly submitted report), submitted, deduped (when deduplicated), message. A newly submitted report returns HTTP 201 with status, id, submitted: true and message. A deduplicated report returns HTTP 200 {status, submitted: false, deduped: true, message} with no id; accept it and do not retry.
Gateway source: [feedback.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/routes/feedback.ts), [report-hint.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/report-hint.ts), [api-gate.ts](https://github.com/LamaSu/physical-capability-cloud/blob/master/packages/gateway/src/middleware/api-gate.ts), [agent-package.json](https://github.com/LamaSu/physical-capability-cloud/blob/master/apps/dashboard/public/agent-package.json).

Supply reporting rule: Report every phase when it ends, whether it worked or not, then one final report with phase "session". Generate one sessionId (UUID v4) per attempt; seq counts up from 0. Never guess a field; never send a transcript.

Tool: `pcc_report_attempt` → `POST /api/feedback`. Follow [starter/bin/pcc-report](https://github.com/LamaSu/physical-capability-cloud/blob/master/starter/bin/pcc-report) from the starter directory; it wraps that reporting contract and keeps attempt state locally. Report every phase and one final session even when blocked.

From the starter directory, run `bin/pcc-report <phase> <outcome> "<redacted summary>"` after each phase, then `bin/pcc-report session <outcome> "<redacted roll-up>"`.

Include the route, status, named error, expected check and observed result. Never include secrets or a transcript. A feedback receipt acknowledges the report; it does not verify physical success.
