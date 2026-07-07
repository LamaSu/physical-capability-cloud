# PCC Request-Freshness, Replay Protection & Idempotency Audit

AGENT_NAME: auditor-freshness-charlie  
STATUS: DONE  
Date: 2026-06-22

---

## 1. Freshness / TTL Window Inventory (cited)

| Window | Default | Source |
|---|---|---|
| `WorkflowChallenge.maxAgeSeconds` | **600 s (10 min)** | `packages/spec/src/types/evidence.ts:155`; `packages/verifier/src/workflow/challenge-service.ts:29` |
| Capture nonce TTL (CVP G3) | **120 s (hard cap)** | `packages/verifier/src/workflow/challenge-service.ts:36–37`; hard cap enforced at `:209` |
| Negotiation session TTL | **30 min (1 800 000 ms)** | `packages/spec/src/types/negotiation.ts:203–204` (`SESSION_TTL_MS = 30 * 60_000`) |
| Wizard session TTL | **24 h** | `packages/gateway/src/routes/wizard.ts:59,62` (`TTL_MS = 24 * 60 * 60 * 1000`) |
| Idempotency cache TTL | **24 h** (env-overridable) | `packages/gateway/src/middleware/idempotency.ts:23` (`IDEMPOTENCY_TTL_MS`) |
| SIWE session cookie `maxAge` | **24 h** | `packages/gateway/src/auth/siwe-auth.ts:28,351` |
| Execution scope default duration | **30 min** (caller-overridable, doc cap 120 min) | `packages/gateway/src/routes/ot2-scope.ts:84` (`expiresInMinutes ?? 30`); doc table `docs/EXECUTION_SCOPE_PROTOCOL.md:185` |
| Graph-search / demand TTL | **30 min** | `packages/gateway/src/routes/graph-search.ts:88`; `routes/asset-outbound.ts:67` |
| Active-listing staleness grace | **24 h** | `packages/gateway/src/facades/populators/staleness.ts:27` |
| Block anchor anti-replay: `computedAtBlock > anchor.blockNumber` (strictly later block) | per-block | `packages/verifier/src/workflow/challenge-service.ts:139–142` |
| On-chain `CaptureAnchor.captureHash` dedup | permanent (mapping stays) | `docs/CAPTURE_VERIFICATION.md:§8.1` — contract check `exists[captureHash]` |

---

## 2. Replay Protection — What PCC Has vs. Lacks

### HAS

| Mechanism | Enforced by | Where |
|---|---|---|
| Block-anchored `WorkflowChallenge` (UUID + `anchor.blockHash` + `maxAgeSeconds`) | `ChallengeService.verifyExecutionProof` | `packages/verifier/src/workflow/challenge-service.ts:111–157` |
| `proofHash = SHA256(challengeId ‖ blockHash ‖ workOutputRoot)` — proof binds to a specific block hash, preventing pre-roll | same | `:127–133` |
| `computedAtBlock > challenge.anchor.blockNumber` (strict ordering) | same | `:139–142` |
| Capture nonce (CVP G3): block-anchored, 120 s TTL, visual nonce echo | `ChallengeService.verifyCaptureNonce` | `challenge-service.ts:244–282` |
| On-chain `captureHash` mapping as permanent replay prevention (CC1+) | `CaptureClassRegistry.sol` | `docs/CAPTURE_VERIFICATION.md:§8` — `exists[captureHash]` prevents re-anchor |
| EIP-712 `salt` (32-byte random) on every off-chain attestation | `generateSalt()` in `OffChainSigner.attest()` | `packages/attestations/src/off-chain.ts:90–95, 204–205` |
| EIP-712 `expirationTime` field — verifier checks at `OffChainVerifier.verify()` | `OffChainVerifier.verify()` | `packages/attestations/src/off-chain.ts:351–358` |
| Negotiation session ID is `crypto.randomBytes`-based; state machine gates commitment | `packages/gateway/src/routes/negotiation.ts` preamble | |
| Idempotency cache (in-memory, per-client-key) 24 h TTL — prevents exact replay of quote/simulate/route POSTs | `packages/gateway/src/middleware/idempotency.ts` | ONLY covers 3 routes: `POST /api/capabilities/quote|simulate|route` |
| Execution scope: status checked (`scope.status === "active"`), `expiresAt` enforced, `commandCount >= maxCommands` rejected | `device-relay.ts:89`; `ot2-scope.ts:142` | `packages/gateway/src/routes/ot2-scope.ts:142` |

### LACKS (gaps)

| Gap | Where | Risk |
|---|---|---|
| **Evidence-submit dedup gap (doc 02 Q7 confirmed):** `POST /api/operator/evidence` generates a new `bundleId = ev-${uuidv4()}` on every call — no dedup by `bundle.id`, `bundleHash`, or any nonce in the request body | `packages/gateway/src/routes/operator-relay.ts:120–137` | Double-submitted evidence (replay of same telemetry) can produce two rows with different IDs, both linked to the same job |
| **No signed `issued_at` / `expiry` on inbound HTTP requests:** Zero routes check a signed timestamp in the Authorization header or body. RTP signs its envelope with `issued_at` + a 5-min window; PCC has NO analog. | All gateway routes | A stolen Bearer token remains valid indefinitely until revoked; no replay window |
| **Idempotency gate covers only 3 routes:** `quote`, `simulate`, `route`. Evidence ingest (`POST /api/operator/evidence`), job submit (`POST /api/jobs/submit`), escrow fund (`POST /api/escrow/fund`), negotiation commit are NOT covered | `packages/gateway/src/middleware/idempotency.ts:28–32` | |
| **Challenge freshness check is OPTIONAL in EvidenceVerifier:** `options?.challenge && options?.executionProof` — if the caller omits these, the freshness check is silently skipped | `packages/verifier/src/evidence-verifier.ts:156` | A kernel can submit evidence without a challenge and the verifier will still attest `valid` |
| **Attestation `expirationTime` is optional (defaults 0 = never):** `OffChainSigner.attest` defaults `expirationTime ?? 0n`, meaning attestations never expire unless the caller explicitly sets a deadline | `packages/attestations/src/off-chain.ts:200` | |
| **Capture nonce challenge cache is in-memory only:** on multi-instance deploy, a challenge issued by instance A cannot be verified by instance B | `docs/CAPTURE_VERIFICATION.md:§11 "challenge cache exhaustion"` |  |
| **Execution scope `expiresInMinutes` is caller-supplied, no server-side cap enforced in code:** doc says max 120 min but the route code applies `expiresInMinutes ?? 30` with no validation cap | `packages/gateway/src/routes/ot2-scope.ts:84` | A caller can pass `expiresInMinutes: 99999` |

---

## 3. Execution Scope — Lease / Dead-Man-Switch Semantics

The execution scope (`docs/EXECUTION_SCOPE_PROTOCOL.md`) is PCC's closest analog to an RTP execution lease:

- **Time-bound:** default 30 min, max 120 min per doc; stored as `expiresAt` ISO string.
- **Tool-allowlisted:** `allowedTools[]` locked at scope creation.
- **Command-budget:** `commandCount < maxCommands` enforced per call.
- **Revocable:** `POST /api/ot2/scope/:id/revoke` immediately sets status → REVOKED; all subsequent calls rejected (`scope.status !== "active"`).
- **Emergency stop:** revokes ALL active scopes for a kernel at once.
- **Auto-expiry:** checked lazily on each incoming tool call (`if (new Date(scope.expiresAt) < new Date())`). No proactive dead-man-switch tick — expiry is only detected at the next call.

**Gap:** The lazy expiry means a scope that passed its `expiresAt` will not be forcibly terminated mid-execution; the next _new_ command will be rejected but an in-flight command running on the device is not interrupted.

Source lines: `ot2-scope.ts:84,142`; `device-relay.ts:89`; `docs/EXECUTION_SCOPE_PROTOCOL.md:67–77`.

---

## 4. Signed Inbound Request Freshness

**No analog exists today.** A full search of `packages/gateway/src` for patterns `issued_at`, `issuedAt.*sign`, `signed.*envelope`, `request.*signature` returned zero hits outside the evidence / attestation layer.

PCC authenticates inbound requests via:
1. Static Bearer token (`Authorization: Bearer pcc_live_...`) — no `issued_at`, no window, valid until revoked.
2. SIWE session cookie with 24-hour `maxAge` — freshness at session creation only; subsequent requests in the window carry the cookie without re-signing.
3. API key scope check (role-based, per `scope-checker.ts`) — no timestamp binding.

RTP's analog would be: an envelope header `X-Request-Issued-At: <unix_ms>` signed with the caller's Ed25519 key, with the gateway rejecting requests older than 5 minutes. PCC has none of this.

---

## 5. THREAT_MODEL Coverage — Replay / Stale / Timeout / Double-Claim

From `docs/THREAT_MODEL.md`:

### Covered threats (with mitigations stated)

> **Dishonest Operator — "Replay old telemetry":**  
> "Nonce in job commitment; timestamps checked against block time"  
> (`docs/THREAT_MODEL.md:11–12`)

This threat is _partially_ mitigated. The `WorkflowChallenge` + `ExecutionProof` system does bind execution to a block, but the freshness check in `EvidenceVerifier` is OPTIONAL (see §2 Lacks). If the challenge is not supplied to the verifier, the block-time binding is not enforced at attestation time.

### NOT covered in THREAT_MODEL

The THREAT_MODEL (58 lines total) does **not** mention:
- Double-submission of evidence bundles (the replay dedup gap)
- Replay of a valid signed Bearer token from a stolen credential
- Stale HTTP requests (no `issued_at` window)
- Idempotency gap on payment routes (escrow fund, job submit)
- Execution scope expiry not proactively enforced

The document focuses on economic fraud (fake evidence, material swap, frivolous disputes, courier theft) and verifier collusion, but does not enumerate request-layer replay attacks.

---

## 6. Conformance Constraints for Any Freshness/Timeout Design

The following MUST hold to preserve PCC's signed-evidence/provenance model:

**C-1 Evidence-bundle CID invariance:** Any replay-detection mechanism that adds a nonce or `issued_at` to evidence submissions MUST NOT change the content of the `EvidenceBundle` — the `bundleHash` is `SHA256(canonical(events[]))` and any mutation breaks the kernel's `kernelSignature`. Replay keys must be stored _alongside_ the bundle, not inside it.

**C-2 Challenge non-reuse:** A `WorkflowChallenge.challengeId` MUST be single-use. If the gateway issues challenges, it must track consumed challenge IDs for at least `maxAgeSeconds` (600 s). The current `ChallengeService` generates random UUIDs but does NOT maintain a consumed-challenge set at the gateway; freshness is enforced by block-time window alone. A stricter design should add a consumed-UUID set with TTL = `maxAgeSeconds`.

**C-3 Block anchor integrity:** Any time-bound on inbound requests (e.g. a 5-min `issued_at` window like RTP) must use wall-clock time independent of block time. The `BlockAnchor.timestamp` is a block timestamp (seconds precision, can lag real time by 1–2 blocks). Request freshness checks must NOT re-use the block timestamp as the wall-clock reference — they need `Date.now()`.

**C-4 Attestation validity spans must exceed job dispute windows:** The dispute windows are 1 h (T0), 4 h (T1), 24 h (T2), 72 h (T3) (`docs/THREAT_MODEL.md:57`). If `OffChainAttestation.expirationTime` is set (C-opt), it MUST exceed the relevant tier's dispute window. A freshness design that forces short attestation lifetimes (< 72 h) would break Tier-3 disputes.

**C-5 Capture nonce TTL must remain ≤ 120 s:** The CVP's G3 gate binds "Contemporaneous" (ALCOA+ C) to a ≤120 s window. Any upstream protocol that issues or validates capture challenges MUST NOT loosen this to align with a longer `issued_at` window — the 120 s is a trust anchor, not an implementation detail.

**C-6 Evidence-submit dedup key must be deterministic from content:** To fix the replay gap on `POST /api/operator/evidence`, the dedup key must be derived from the `bundleHash` (SHA256 of events), not from a random `bundleId`. This allows the gateway to safely reject exact re-submissions without generating a new ID and row each time.

**C-7 Execution scope revocation must propagate to in-flight hardware commands:** Any dead-man-switch design that proactively expires scopes at the server must also issue a stop command to the hardware adapter (OT-2 / device) before marking the scope EXPIRED. The current lazy check (`expiresAt < now` on next call) does not halt in-flight motion.

---

## See Also

- `docs/rtp-absorption/02-connection-transport-abstraction.md` — transport design doc that raised Q7
- `packages/verifier/src/workflow/challenge-service.ts` — `ChallengeService`
- `packages/spec/src/types/evidence.ts:143–165` — `BlockAnchor`, `WorkflowChallenge`, `ExecutionProof`
- `packages/gateway/src/middleware/idempotency.ts` — idempotency gate (3 routes only)
- `packages/gateway/src/routes/operator-relay.ts:93–162` — evidence ingest (no dedup)
- `packages/attestations/src/off-chain.ts:90–95` — EIP-712 salt / `expirationTime`
- `docs/THREAT_MODEL.md` — partial coverage
- `docs/EXECUTION_SCOPE_PROTOCOL.md` — scope as execution lease
- `docs/CAPTURE_VERIFICATION.md:§3,§6,§8` — CVP nonce + on-chain replay prevention
