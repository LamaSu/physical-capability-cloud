# RTP Absorption #04 — Transport Abstraction: Decision-Ready Implementation Plan

> **Status:** Implementation plan (decision-gated). **No transport code is written by this
> document.** It exists to let a PCC core maintainer make ONE strategic call —
> *libp2p-as-substrate vs. keep the custom `dht-core`* (doc 02 open Q8) — and then hand a
> sequenced, low-ambiguity build plan to `/go`.
> **Companion docs:** the design is [`02-connection-transport-abstraction.md`](./02-connection-transport-abstraction.md);
> the lifecycle/settlement counterpart is [`03-task-lifecycle-timeout-freshness.md`](./03-task-lifecycle-timeout-freshness.md).
> **Prereqs already landed** on `feat/rtp-canonicalization-and-timeout` (see §1) — this plan
> picks up from there.

---

## 1. What is already built (so this plan starts un-gated)

The two doc-02 prerequisites that are **independent of the transport choice** are done and
tested on branch `feat/rtp-canonicalization-and-timeout`:

| Prereq | doc-02 / doc-03 ref | Where | Tests |
|---|---|---|---|
| **Canonicalization unification** — a2a now signs/verifies over the SAME `@pcc/spec` `canonicalize` (JCS) as evidence/job-spec, so a signature made on one path verifies on the other. | doc 02 open Q1 | `packages/a2a/src/crypto.ts` | `crypto.test.ts` cross-path proof (4 tests) |
| **First-class `timed_out` lifecycle** — `timed_out` state + `dispatched`/`accepted` ACK split, `TimeoutCause`, `TimeoutPolicy`, a pure reducer + `JobLifecycleRegistry` (heartbeat-and-ack at job grain). | doc 03 §6–§7 | `packages/spec/src/types/job-lifecycle.ts`, `packages/spec/src/util/job-lifecycle.ts` | `job-lifecycle.test.ts` (26 tests) |
| **Signed request-freshness envelope** — `{issuedAt, expiry, nonce}` signed via Ed25519 over the unified canonical form; single-use nonce set. | doc 03 §6.7/§7.5 | `packages/a2a/src/freshness.ts` | `freshness.test.ts` (12 tests) |

**Why this matters for doc 02:** the `TransportEnvelope.senderSig` (doc 02 §7.2) and the bundle's
`kernelSignature` now agree on one canonicalization — the exact precondition doc 02 §6.4 invariants
1–2 require *before any transport ships*. The freshness envelope is the additive `{issuedAt, expiry,
nonce}` layer the `TransportEnvelope` was always going to grow (doc 03 §7.5). So Phase 0 below no
longer has to relitigate canonical form or freshness — only the interface + the `https` wrapper remain.

---

## 2. The single blocking decision (doc 02 open Q8)

Everything downstream forks on one question:

> **Do we adopt libp2p as the transport/identity/routing substrate, or keep the custom
> `CoreTransport`/`dht-core` and build NAT traversal ourselves?**

This is the only decision that changes the *architecture* (not just the schedule). Every other open
question (sessionPubKey delivery Q2, key custody Q3, CBOR Q4, relay trust Q6, dedup location Q7,
discovery Q10, fragmentation DoS Q11) is answerable **after** Q8 and inside a single transport's
implementation — they do not block starting.

### 2.1 Decision matrix

| Axis | **A. libp2p substrate** | **B. Keep custom `dht-core`** |
|---|---|---|
| NAT traversal | DCUtR hole-punch + Circuit Relay v2 + AutoNAT **for free** | Build frp/relay glue ourselves (per transport) |
| Identity/routing | PeerID = pubkey; collapses identity+routing+transport | Already have `did:pkh`/ERC-8004 + `CoreTransport` mux |
| Code delta | **Large dep**; partial rewrite of `dht`/`federation` | Incremental; reuse `CoreTransport`/`CoreMessage` |
| Constrained devices (ESP32) | libp2p too heavy device-side anyway → still need `lan-relay`/MQTT | Same — MQTT/MQTT-SN either way |
| Wallet/intermittent (XMTP/Waku) | Waku **is** libp2p — natural fit | Bridge libp2p-based Waku into custom stack (friction) |
| Sovereignty / supply-chain | Mature OSS, MIT/Apache | Fewer deps, fully in-house |
| Time-to-first-transport | Slower (substrate adoption first) | **Faster** (`persistent-websocket` over existing `CoreTransport`) |

### 2.2 Recommendation (non-binding — owner decides)

**Hybrid, decision-deferred-by-construction:** keep `dht-core` for the *near-term* transports that
need no hole-punching (`https`, `persistent-websocket`, `lan-relay`) and treat libp2p as a **drop-in
`reverse-tunnel`/`decentralized` adapter** evaluated at Phase 3–4, *after* the `KernelTransport`
interface exists. Rationale: the `KernelTransport` plugin boundary (Phase 0) makes Q8 reversible —
libp2p becomes one registry entry, not a rewrite — so we should **not** block Phases 0–2 on it.
**Pick now only if you want to skip building NAT glue twice.** If sovereignty/lightness dominates →
B; if you expect heavy NAT + want Waku/GossipSub for free → A.

> **What `/go` needs from the owner:** one line — `Q8 = A`, `Q8 = B`, or `Q8 = hybrid (default)` —
> plus `Q9 = XMTP | DIDComm` (only gates Phase 3). Everything else has a safe default below.

---

## 3. Phased build plan (maps to doc 02 §8)

Each phase is independently shippable and gated only where noted. Risk labels are doc 02's.
The `KernelTransport` interface + envelope (Phase 0) are **decision-independent** — they can start
immediately regardless of Q8.

### Phase 0 — Interface + envelope + `https` wrapper (LOW; **Q8-independent, start now**)
- Add `KernelTransport`, `TransportRegistry` (mirror `registerAdapter`), `TransportEnvelope`,
  `ConnectionSpec` to `@pcc/spec` + `@pcc/kernel-sdk`.
- **Fold in the prereqs from §1:** the envelope's `senderSig` uses the unified `canonicalize`; add the
  `{issuedAt, expiry, nonce}` freshness fields by composing `@pcc/a2a` `FreshnessEnvelope`.
- Implement only the `https` transport (wraps today's `createKernelHandler`); `buildManifest`
  synthesizes `{type:"https"}` from the legacy `endpointURL` (back-compat).
- **Ship the §6.4 transport-conformance test suite** (invariants 1–10) — every future transport must
  pass it. The canonicalization + freshness tests on this branch are the seed.
- *Exit:* no existing kernel changes; conformance suite green.

### Phase 1 — `persistent-websocket` + the missing dispatcher (MEDIUM)
- **Default impl: custom `CoreTransport`/`CoreMessage`** (new protocol `/pcc/job-dispatch/1.0.0`) with
  reconnect/backoff. *(If `Q8 = A`: implement over a libp2p stream instead — same interface.)*
- Add the gateway-side `KernelDispatcher` filling the dead branch at `job.facade.ts:~255-285`.
- **Wire the doc-03 lifecycle:** dispatch sets `dispatched`; the kernel ACK (`POST /api/jobs/:id/ack`)
  drives `dispatched→accepted` via `JobLifecycleRegistry` (already built); a reaper tick calls
  `registry.reap()` to fire `timed_out{dispatch}`. This is the doc-03 Phase 1 work, now unblocked.
- *Exit:* an outbound-only LAN robot receives a job and returns a signed `ResultPayload`; a kernel
  that never ACKs flips to `timed_out{dispatch}`. HTTPS kernels untouched.

### Phase 2 — Durable queue + device-twin shadow + `lan-relay` (MEDIUM)
- Durable store-and-forward behind the dispatcher (SQLite or Mosquitto). Persist `JobLifecycleState`
  + deadlines in the `@pcc/workflow` EventStore; convert the in-memory `JobLifecycleRegistry` reaper
  into a `@pcc/workflow` reaper Activity (crash-safe). Add job heartbeat (`POST /api/jobs/:id/heartbeat`)
  → `timed_out{heartbeat}`/`{execution}`.
- `lan-relay` (mDNS + local MQTT/MQTT-SN) + CID-fragmentation for constrained frames.
- *Decision inputs consumed here:* Q2 (sessionPubKey delivery), Q3 (ESP32 key custody), Q4 (CBOR),
  Q7 (dedup location), Q11 (fragmentation DoS quotas).
- *Exit:* ESP32/Arduino onboard; restart-survival; dark-kernel detected in seconds.

### Phase 3 — `decentralized` (wallet + intermittent) (MEDIUM; **gated on Q9**)
- Wallet→endpoint resolver (`did:pkh`/ERC-8004 → inbox/service endpoint).
- **`Q9 = XMTP`** → XMTP client transport (turnkey, ~60-day inbox); **`Q9 = DIDComm`** → DIDComm-v2
  client (sovereign, transport-agnostic). Default recommendation: DIDComm-over-MQTT primary, XMTP as
  a hosted convenience. Add a Waku Store light node for intermittent backlog; anchor evidence to IPFS.
- Reconciles doc 03's transport-aware `dispatch_timeout_s` (a store-and-forward kernel is *not*
  refunded just for taking hours — doc 03 §6.5 answers doc 02 Q5).
- *Exit:* the four device classes covered; RTP `xmtp`-parity-plus-evidence.

### Phase 4 — `reverse-tunnel` + discovery polish (LOW; **where `Q8 = A` libp2p lands, if chosen**)
- frp/cloudflared adapters **and/or** a libp2p Circuit-Relay-v2 + DCUtR adapter (this is the natural
  home for libp2p if `Q8 = hybrid`). Optional `.well-known` discovery + `pcc://` URI to match RTP.
- *Exit:* turnkey NAT bypass; discovery parity.

**Rollback (all phases):** every transport is a registry entry; disabling one reverts affected kernels
to `https`. L4 evidence is never modified, so no phase can corrupt historical evidence.

---

## 4. Defaults if the owner does not answer

So `/go` is never blocked waiting on a human:

| Question | Safe default | Reversible? |
|---|---|---|
| Q8 substrate | **hybrid** (custom near-term; libp2p as a Phase-4 adapter) | Yes — interface boundary makes it a registry entry |
| Q9 decentralized | **DIDComm-over-MQTT primary, XMTP optional** | Yes — both are `decentralized` registry entries |
| Q2 sessionPubKey | ride in envelope (simple), make manifest-resolvable later | Yes |
| Q4 CBOR | JSON canonical is normative; CBOR must decode to identical canonical bytes | Yes |
| Q7 dedup | gateway dedups by `bundleHash` **and** envelope `nonce` (both) | Yes |

Only Q8 and Q9 are worth a human's time; the rest are defaulted above and refined inside their phase.

---

## 5. One-paragraph ask for the owner

> Pieces A (canonicalization) and B (timeout lifecycle + signed freshness) are built, tested, and
> committed on `feat/rtp-canonicalization-and-timeout`; they unblock doc-02 Phase 0 (no canonical-form
> or freshness work remains). To start the transport abstraction, reply with **Q8** (`A` libp2p /
> `B` custom dht-core / `hybrid` default) and **Q9** (`XMTP` / `DIDComm`). Phase 0 + Phase 1 can then
> be kicked off as a `/go` build with no further decisions — the dispatcher fills the `job.facade.ts`
> dead branch and wires the already-built `JobLifecycleRegistry` for `timed_out{dispatch}`.

---

*End of implementation plan. No transport source code was modified in producing this document.*
