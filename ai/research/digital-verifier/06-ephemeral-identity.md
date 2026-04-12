# Ephemeral Agent Identity in ERC-8004 — sessionKey / principalKey

**Research target**: Design an ephemeral identity tier for PCC's ERC-8004 integration so that millions of short-lived child agents spawned by a single registered parent can sign work, be held accountable, and propagate reputation to the parent — all without requiring per-agent on-chain registration.

**Date**: 2026-04-11
**Output file**: `C:\Users\globa\physical-capability-cloud\ai\research\digital-verifier\06-ephemeral-identity.md`
**Status**: Draft (written incrementally)

---

## 0. Executive Summary

PCC's current ERC-8004 integration (see `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\erc8004.ts`) assumes one registered `AgentRegistryId` per agent. This maps cleanly onto the current PCC scale — one kernel per shop, one operator per kernel, a few long-lived autonomous agents negotiating on the A2A bus. It breaks catastrophically the moment you try to run an agent-decomposed enterprise: a top-level "close out Q2 books" task spawns a tree of sub-tasks, each sub-task spawns a handful of worker sub-agents, each worker fires off a swarm of tool-call agents. A single human intent in the agent-run future expands into thousands to millions of ephemeral agents that live for two seconds and produce one signed evidence event. Registering each one in an ERC-721 `IdentityRegistry` is a non-starter: at ~50k gas per registration on Ethereum L1 that's somewhere north of $3,000 per human intent at current gas prices before you've done a single unit of actual work; the registry would bloat into a garbage dump of two-second-lifespan identifiers; and no reputation system can meaningfully accumulate feedback against an agent that already exited before the feedback was written.

The fix is a two-tier identity scheme. **The `principalKey`** is the persistent, ERC-8004-registered agent — registered once, lives across sessions, accumulates reputation, is slashable, is stakeable. **The `sessionKey`** is an ephemeral keypair derived deterministically from the principalKey using a hardened BIP32-style derivation path, issued off-chain, scoped tightly, time-limited, and cheap enough to mint millions of. Every sessionKey signature can be cryptographically chained back to its principalKey via the derivation proof, so a verifier that observes a sessionKey-signed evidence event can always determine *which registered agent to hold accountable*. Reputation feedback, slashing, and revocation all flow to the principalKey; the sessionKey is a disposable receipt.

This is not a new idea. It is the same shape as OS process trees (parent PID owns child), SSH agent forwarding (one key authorizes a chain of connections), OAuth delegated tokens (client A delegates to client B), capability-based security (revocable, least-privilege), UCAN (the explicitly-designed delegation-chain-for-agents spec), and Google's macaroons (contextual caveats that attenuate a root authority). It is also the shape of Bittensor's hotkey/coldkey split — the sensitive, stakeable key stays cold, and a separate operational key signs daily work — which was the original framing the user asked about. PCC's version differs from Bittensor's in four ways: (1) the ephemeral sessionKey is *derived* from the principalKey rather than being independently-generated and linked via a registry entry, so a single signature proves the parent relationship without a round-trip; (2) each sessionKey carries a scope capability token limiting what it can sign for, borrowing from UCAN/macaroons; (3) reputation effects auto-route to the parent via ERC-8004's Reputation Registry using the derivation proof as evidence of parenthood, closing the loop with the existing contract; and (4) the naming avoids the word "hotkey," which in the cryptocurrency context carries baggage we don't want — PCC uses `sessionKey` and `principalKey`.

**The naming choice matters.** "Hotkey" and "coldkey" are load-bearing Bittensor terminology with wrong connotations for PCC. A hotkey is operationally-available, but the word "hot" implies "has funds loaded and ready to move" which is wrong for PCC — sessionKeys shouldn't hold funds at all. "Coldkey" implies hardware-wallet-grade cold storage, which is correct for some principalKeys (a large operator's root key) but wrong for most (a typical agent's principalKey lives in a secure enclave or a server-side KMS, warm but not cold). The better framing is *session* (this authority is for the duration of a single job or burst of jobs) and *principal* (this is the underlying accountable entity from RBAC vocabulary). I considered `delegateKey` / `rootKey` as an alternative and rejected it: "delegate" is already overloaded in Bittensor (delegated stake), and "root" implies filesystem root, which is a security-reviewer smell. `sessionKey` / `principalKey` is the terminology this report standardizes on. The rest of this document uses it exclusively.

The rest of the report: (1) first-principles argument for ephemeral identity as a primitive; (2) how Bittensor's hotkey/coldkey actually works and what PoA's subnet does with it; (3) the BIP32/SLIP-0010 derivation choice and why Ed25519-hardened-only is the right default given PCC's existing Ed25519 stack; (4) an ERC-8004 architecture read; (5) delegation model trade-offs; (6) accountability and slashing routing; (7) revocation; (8) scope capability tokens; (9) interaction with workflowSteps (R02) and touchstones (R01); (10) threat model; (11) concrete TypeScript interfaces; (12) the sign-and-verify flow; (13) revocation-list placement; (14) gas cost analysis; (15) known failure modes from production delegation schemes; (16) reputation-propagation semantics; (17) test strategy; and (18) the concrete PCC implementation plan with file paths.

---

## 1. First Principles: Ephemeral Identity as a Fundamental Primitive

When a system is expected to scale from "one agent with one job" to "one agent spawning a tree of a million sub-agents in a single human intent," identity stops being a one-off registration problem and starts being an *allocation* problem. You can no longer treat every identity as a durable record because the arrival rate of new identities exceeds any reasonable rate at which they can be durably written. The right move at that point is to split identity into two separable concerns.

**Durable accountability** — the question of "who is responsible for this action in the long run." This requires persistence: a record that outlives the action, can be looked up later, can accumulate reputation over many interactions, can be served with a notice of revocation, and can be held financially or reputationally responsible if something goes wrong. It doesn't need to be cheap per-action because the persistent entity is amortized over many actions. It doesn't need to be fast because registration is not on the hot path. It does need to be *global* (the same registered entity shows up from anywhere in the network) and it does need to be *authoritative* (there's one canonical registry, not ten).

**Ephemeral execution authority** — the question of "who cryptographically vouched for this particular action, right now." This requires speed: a single signature must be generatable in microseconds. It requires cheapness: a single signature-capable keypair must cost nothing to mint because you'll mint millions. It requires bounded scope: the execution authority shouldn't be able to do anything beyond the specific job it was issued for, because it is broadly distributed and will occasionally be leaked. It *does not* require global persistence or authoritative uniqueness, because it exists only long enough to sign the action, after which the signature itself is the receipt and the keypair can be discarded.

These two concerns pull in opposite directions. You cannot satisfy both with a single primitive. Every working system that has grappled with this in the adjacent space has split them.

**OS process trees** — the canonical example. A Unix process has a long-lived `uid` (the user that owns it, roughly analogous to a persistent accountable entity) and an ephemeral `pid` (the process instance identifier, which is reused as processes exit). When a process forks, the child inherits `uid` but gets a new `pid`. When the child does something auditable (writes a file, opens a port), the `uid` is what shows up in audit logs — not the `pid`, because the `pid` will be reused in seconds. Accountability propagates to the durable identity; execution runs under the ephemeral one. If the ephemeral child misbehaves, you kill it; the parent is still around to spawn a replacement.

**SSH agent forwarding** — a user has a persistent SSH key pair (the accountable identity). When they SSH into a bastion host, the bastion has temporary access to act as them for the duration of the session, but the bastion never sees the private key. The ephemeral authority is scoped (can only sign for this session) and time-limited (expires when the session closes). Revocation is trivial: the user closes the SSH session, and the ephemeral authority is gone. The user's durable key is never exposed.

**OAuth access tokens** — a user has a long-lived refresh token (the accountable identity, effectively). A client requests an access token (the ephemeral authority), which is short-lived (minutes to hours) and scoped to specific operations. When the access token leaks, the damage is bounded by scope and time. The refresh token lives in a more secure location (not on the hot path) and can be revoked, which invalidates all derived access tokens.

**Capability-based security** — the whole field is built on the principle that holders of an authority should be able to attenuate it (reduce scope, reduce time, add predicates) before passing it on to others. A capability is a first-class transferable object whose holder can do only what the capability says, and no more. This is the direct ancestor of both UCAN and macaroons.

**UCAN (User Controlled Authorization Network)** — a specification built for exactly this problem in the distributed-web space. UCANs are signed, delegable, attenuable capability tokens where the delegator signs a capability and the delegate can further attenuate and delegate it, forming a chain. The root of the chain is an authority that holds some resource, and every leaf is a scoped, time-limited capability to do something with that resource. UCAN is explicit about the trade-off: "the principle of least authority should be used when delegating a UCAN: minimizing the amount of time that a UCAN is valid for and reducing authority to the bare minimum required for the delegate to complete their task." This is verbatim the design principle we need for sessionKeys. ([UCAN specification](https://github.com/ucan-wg/spec))

**Google macaroons** — bearer credentials with "contextual caveats" that attenuate the macaroon. The holder of a root macaroon can derive a child macaroon with additional caveats (must be used before time T, from IP X, for operation Y), and the child can be freely shared, sub-delegated, or leaked with bounded damage. Macaroons add a very nice primitive — *third-party caveats* — where a caveat can say "this is valid only if a third-party certifier has signed that predicate P holds." This turns into a general way to chain external signers into an authorization decision, which maps directly onto PCC's touchstone-and-verifier architecture. ([Macaroons paper](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/))

**JWT with short TTLs** — the lowest-end version of the same pattern. A JWT is an unsigned-by-the-bearer bearer token with a short time-to-live. You can't attenuate it after issuance, you can't chain-delegate it, and revocation is notoriously hard (which is why JWTs are typically used only for the access-token role and never for durable identity). JWT is the counterexample that shows what happens when you try to collapse the two concerns into one: you get a token that is neither durably accountable nor cleanly revocable, and production systems end up bolting on separate refresh-token infrastructure to reintroduce the split.

**The PCC position**: ephemeral identity is not a nice-to-have. It is a fundamental primitive that the protocol must support natively, or else the protocol is economically incompatible with the agent-run enterprise workload it claims to target. We split durable accountability (ERC-8004 principalKey) from ephemeral execution authority (derived sessionKey + capability scope) along exactly the axis that OS process trees, SSH, OAuth, UCAN, and macaroons have all independently landed on. The split is the design, not an afterthought.

---

## 2. Bittensor's Hotkey/Coldkey Pattern

The hotkey/coldkey split in Bittensor is the closest existing crypto-native design to what PCC needs, and it's worth understanding exactly what it does and where it falls short. ([Bittensor wallets docs](https://docs.learnbittensor.org/keys/wallets))

In Bittensor, a wallet consists of two separable keypairs. The **coldkey** holds the stakeable balance. It is the only key that can authorize transfers of TAO, can change staking allocations, can register new subnet participation, can rotate hotkeys, and can authorize governance operations. The coldkey is supposed to live in cold storage — a hardware wallet, a pen-and-paper backup, an offline machine — and be decrypted only when absolutely necessary. The security model assumes the coldkey is rarely-used and well-protected.

The **hotkey** is the operational key that does the actual work of mining and validating. It signs requests to miners, it submits validator weights to the blockchain, it participates in the consensus protocol. The hotkey is typically warm (stored on the validator/miner machine, loaded into memory at startup, used continuously) and therefore at meaningfully-higher risk of compromise. The trade-off is deliberate: the hotkey is the key that is online and exposed, but compromising it costs the attacker less than compromising the coldkey because the attacker cannot move stake or change consensus rules, they can only disrupt the specific miner/validator's operations. Hotkey compromise is recoverable; coldkey compromise is catastrophic.

The two keys are associated via an on-chain registry entry: when a validator or miner registers on a subnet, they bind their hotkey to their coldkey by submitting a transaction signed by the coldkey. After that, the network knows "hotkey X is operationally-controlled by the coldkey Y, and reward emissions for X flow to Y's staking position." A single coldkey can own many hotkeys, one per subnet or per miner instance. You can see this in PoA subnet code — the `WALLET_HOTKEY=default` env var in `C:\Users\globa\scratch\poa-subnet\.env.example` is the operational key the validator loads, and the miner_hotkey field in `C:\Users\globa\scratch\poa-subnet\anti_gaming\outlier.py` is the per-miner operational identity used to attribute work and score outliers. Reputation in PoA accrues at the hotkey level (a misbehaving miner's hotkey gets outlier-flagged), but the economic consequences (stake slashing, reward redirection) route to the coldkey that owns the hotkey.

What is good about this pattern:

- **Separation of the valuable thing from the exposed thing.** The valuable thing (stake, governance power, reward destination) stays cold. The exposed thing (operational signing key) is online. If the online key leaks, the valuable thing is still safe.
- **Recoverability.** Because the hotkey is bound to the coldkey via a registry transaction, the coldkey holder can rotate the hotkey at any time by submitting a "change hotkey" transaction. The old hotkey is immediately powerless.
- **Multi-instance scaling.** One coldkey, many hotkeys — a single large operator can run many validator instances under one economic identity.
- **On-chain accountability routing.** There is no ambiguity about who owns a hotkey: the chain has the binding, verifiers can look it up, and there's no way to claim "that wasn't me" after signing with a registered hotkey.

What is bad about this pattern for PCC's needs:

- **On-chain binding costs gas for every hotkey.** Bittensor validators only spin up a few hotkeys per coldkey — tens, maybe hundreds over a career. That's fine. PCC agents might need to spin up *millions* of sessionKeys over a career — one per ephemeral sub-agent per human intent. Spending gas per sessionKey-to-principalKey binding is economically infeasible.
- **No derivation — the hotkey is a random independent key.** Because the association is via a registry entry, the hotkey and coldkey have no cryptographic relationship. You cannot look at a hotkey signature and derive its coldkey from cryptography alone; you must consult the registry. For PCC, we want a signature to *cryptographically* prove its principalKey without a registry lookup, because (a) it's cheaper, (b) it makes offline verification possible, and (c) it lets us batch-verify millions of sessionKey signatures without hammering the registry.
- **No scope attenuation.** A hotkey in Bittensor has the full set of operational authorities for that miner/validator instance. There is no way for a coldkey to issue a hotkey that is scoped down to "can only sign validator weights, cannot sign mining requests." PCC needs scope attenuation because our sessionKeys are issued for specific workflow contracts, not for general-purpose operation.
- **Hotkeys are long-lived.** A Bittensor hotkey lives for the life of a miner instance — weeks or months. They're not really ephemeral. PCC sessionKeys might live for 30 seconds.
- **Hotkey-to-hotkey child delegation (the "child hotkey" feature) adds an on-chain transaction per child.** Bittensor's attempt to scale delegation further — the [child hotkey feature](https://blog.bittensor.com/child-hotkeys-77d0b855ce59) — lets a hotkey delegate stake to another hotkey, but this is still an on-chain operation. It's a nice pattern for stake-routing but not for identity scaling.

**The PCC departure**: we take the *valuable-stays-cold, operational-stays-warm* principle from Bittensor, we take the *per-instance operational key* shape, but we abandon the *on-chain binding* step and replace it with *cryptographic derivation*. A sessionKey is derived from the principalKey using a hardened SLIP-0010 path (the Ed25519 variant of BIP32); given the sessionKey pubkey, the parent pubkey, and the derivation path, a verifier that has been given a derivation proof can independently confirm the parent-child relationship without consulting any registry. This collapses millions of dollars of binding gas down to zero, and it gives us an O(1) verification path instead of a registry-lookup path.

---

## 3. Derivation Scheme: SLIP-0010 Hardened Ed25519

PCC's existing identity stack is Ed25519 everywhere. DIDs use `did:key` with the `ed25519-pub` multicodec prefix (`0xed01`). Credential signing uses `Ed25519Signature2020`. Kernel agents sign evidence bundles using Ed25519 via `node:crypto`. The existing code lives at `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\did.ts` (`createKeyDID`, `deriveKeyDID`) and `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\credentials.ts` (`signCredential`, `verifyCredential`). All keys are raw 32-byte Ed25519 keys encoded as hex.

This is important because it constrains the derivation scheme. BIP32 was designed for secp256k1, where non-hardened (public) child key derivation is straightforward: the parent public key can derive the child public key without knowing the parent private key, which is useful for watch-only wallets. **Ed25519 does not support non-hardened derivation.** The mathematical reason is that Ed25519's clamping process (multiplying by the cofactor, zeroing specific bits) makes the private key a hash-derived multiplier rather than the direct key material, which breaks the linearity assumption that secp256k1 uses for public child derivation.

SLIP-0010 is the formal specification for using BIP32-style derivation with Ed25519. It specifies ([SLIP-0010 spec](https://github.com/satoshilabs/slips/blob/master/slip-0010.md)):

1. **Master key generation**: `I = HMAC-SHA512(Key = "ed25519 seed", Data = seed)`. Split into `I_L` (32 bytes, the private key) and `I_R` (32 bytes, the chain code). Every 32-byte `I_L` is a valid Ed25519 private key, so there's no rejection step.

2. **Child key derivation (hardened only)**: `I = HMAC-SHA512(Key = c_par, Data = 0x00 || ser256(k_par) || ser32(i))` where `c_par` is the parent chain code, `k_par` is the parent private key, `i` is the child index (must be >= 2^31 for hardened). `I_L` becomes the child private key; `I_R` becomes the child chain code.

3. **No public derivation**: For Ed25519, "only hardened key generation from private parent key to private child key is supported."

The Cardano team (IOHK) published a [BIP32-Ed25519 paper](https://input-output-hk.github.io/adrestia/static/Ed25519_BIP.pdf) that describes a variant allowing public derivation by keeping extended keys in a specific affine subspace, but it requires non-standard Ed25519 key handling, is complex to implement, and has limited library support outside the Cardano ecosystem. PCC does not need public derivation for sessionKeys — the principalKey holder always has the private key when deriving sessionKeys — so SLIP-0010 hardened-only is the right choice: simpler, better-tested, and fully sufficient.

**What "hardened-only" means for PCC's verification model**: a verifier cannot independently derive the child public key from just the parent public key and the derivation path. The verifier needs a **derivation proof** — the parent signs a statement binding the sessionKey's public key to its derivation path. This is actually a feature, not a bug: it means the parent must *explicitly consent* to each sessionKey, and the consent is a signed artifact that travels with the sessionKey. Without the parent's signature, a random Ed25519 key cannot claim to be derived from a specific parent.

**Derivation path format**: We use a standard BIP32-style path with hardened indices. The path encodes the purpose, the parent agent's chain ID, a session counter, and optionally a sub-task index:

```
m / 8004' / {chainId}' / {sessionCounter}' / {subTaskIndex}'
```

- `8004'` — purpose field, locks this derivation tree to ERC-8004 sessionKeys.
- `{chainId}'` — the EVM chain ID where the principalKey is registered (e.g., 84532 for Base Sepolia).
- `{sessionCounter}'` — a monotonically increasing counter per principalKey, ensuring each session gets a unique key.
- `{subTaskIndex}'` — optional, for multi-step sessions where a parent issues sessionKeys for several sub-tasks at once.

Example: `m/8004'/84532'/42'/0'` — the 43rd session on Base Sepolia, first sub-task.

**Why not BLS or Schnorr?** BLS threshold signatures allow partial keys and aggregate signatures, which are useful for multi-party signing but irrelevant for the parent-child relationship (there's always exactly one parent signing one child's authority). Schnorr aggregation compresses multiple signatures into one, which would be useful if we needed to verify a chain of 100 sessionKeys in one signature, but the typical PCC verification path is one or two levels deep. BLS and Schnorr add complexity without addressing the actual bottleneck, which is on-chain registration cost — and SLIP-0010 eliminates that bottleneck entirely by moving issuance off-chain.

---

## 4. ERC-8004 Architecture as Implemented in PCC

Before designing the ephemeral identity extension, we need to understand exactly what ERC-8004 provides today. The PCC types are at `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\erc8004.ts`.

ERC-8004 defines three registries ([ERC-8004 specification](https://eips.ethereum.org/EIPS/eip-8004)):

**Identity Registry** — An ERC-721 (NFT) contract with URIStorage. Each agent gets a unique `agentId` (a token ID) and is represented on-chain as an NFT. The token URI resolves to an `AgentRegistrationFile` (a JSON document, typically served at `.well-known/agent-registration.json`) that describes the agent's services, protocols, trust models, and cross-chain registrations. The `AgentRegistryId` format is `eip155:{chainId}:{identityRegistryAddress}`, globally unique across chains. Registration is a one-time on-chain transaction (~50k gas) and persists indefinitely.

In the PCC type system, the key types are:
- `AgentRegistryId` — the global identifier string (`eip155:84532:0x...`)
- `AgentRegistrationFile` — the off-chain metadata with `services: AgentService[]`, `supportedTrust: TrustModel[]`, `active: boolean`
- `AgentService` — a service endpoint (web, A2A, MCP, OASF, ENS, DID, email) with optional skills and domains
- `TrustModel` — one of `reputation`, `crypto-economic`, `tee-attestation`, `zkml`

**Reputation Registry** — A standard interface for posting and fetching feedback signals against a registered `agentId`. Each `ReputationFeedback` carries a `value` (signed int128), decimal precision, two string tags, an optional endpoint, and an optional off-chain `feedbackURI` pointing to a more detailed `FeedbackFile` on IPFS. The `ReputationSummary` aggregates count + summary value. PCC defines standard tags in `PCC_REPUTATION_TAGS`: `ASSURANCE`, `QUALITY`, `UPTIME`, `RESPONSE_TIME`, `EVIDENCE_COMPLETENESS`, `COMPLETION_RATE`.

**Validation Registry** — A separate registry for independent validator checks. A `ValidationRequest` asks a validator to assess an agent; the `ValidationResponse` returns a score (0-100) with optional tags and URI. A `ValidationSummary` aggregates responses.

**Where ephemeral identity is NOT accommodated today**: There is no concept of "this signature was produced by a derived child of a registered agent" anywhere in ERC-8004 or in PCC's current types. Every `agentId` is independently registered. Every `ReputationFeedback` targets a registered `agentId`. If a sessionKey-signed event arrives at the Reputation Registry today, there is no way to route its consequences to the parent principalKey.

**What needs to change**: The extension is *additive* — we do not modify the existing ERC-8004 contracts or types. Instead:

1. The `FeedbackFile` (off-chain IPFS) gains an optional `sessionProof` field that contains the derivation proof linking the signing sessionKey back to the registered `agentId`. Verifiers include this when filing feedback about sessionKey-signed work.

2. The Reputation Registry accepts feedback against the `agentId` of the *principalKey*, not the sessionKey. The sessionKey has no agentId and never will. The `feedbackURI` points to a `FeedbackFile` that includes the sessionProof so auditors can trace the specific ephemeral agent.

3. The `AgentRegistrationFile` gains an optional `sessionKeyPolicy` field describing the agent's sessionKey issuance policy: maximum lifetime, maximum scope, derivation path prefix. This is informational (off-chain JSON), not enforced on-chain, but it lets other agents assess trust: "this agent issues 30-second sessionKeys with scope limited to evidence_submit" is more trustworthy than "this agent issues 24-hour sessionKeys with scope *."

---

## 5. Delegation Models: Explicit vs Implicit vs Capability

There are three ways a principalKey can authorize a sessionKey to act on its behalf.

**Explicit delegation** — the principalKey signs a message that says "I authorize sessionKey X to act on my behalf for actions A until time T, bound to contracts C." The signed authorization message (the `SessionKey` struct in Section 11) is an explicit, self-contained capability token. The verifier checks: (1) sessionKey signature on the evidence event, (2) principalKey signature on the SessionKey struct, (3) scope constraints. No on-chain state is needed for issuance; revocation can be either time-based (expire) or on-chain (emit a revocation event).

*Advantages*: Clear audit trail. Each sessionKey carries its authorization. No implicit assumptions. Easy to implement.
*Disadvantages*: The principalKey must be available (hot enough) to sign the SessionKey struct for each new session. For deeply-nested sub-agent trees, the root must sign all the way down or each intermediate level must have explicit delegation authority.

**Implicit delegation** — the sessionKey's authority is proven purely by cryptographic derivation from the principalKey. A verifier checks: (1) sessionKey signature on the evidence event, (2) derivation proof (given parent pubkey + path, can derive child pubkey, and the derived pubkey matches). No parent signature on a capability token needed. Authority is implicit in the derivation relationship.

*Advantages*: No parent signature required at issuance time. Parent can derive keys offline.
*Disadvantages*: No scope attenuation without an additional mechanism. Any derived key has the same authority as any other derived key — there's no way to say "this key can only sign evidence_submit" without an out-of-band document. Revocation is harder because there's no signed artifact to point to.

**Capability delegation** — the principalKey issues a capability token (like a UCAN or macaroon) that *accompanies* the sessionKey. The sessionKey signs the evidence; the capability token restricts what the evidence can claim. The verifier checks: (1) sessionKey signature, (2) derivation proof, (3) capability token validity (scope, time, caveats).

*Advantages*: Full scope control. Composable (capability tokens can be sub-attenuated by intermediate agents). Compatible with the macaroon/UCAN patterns that the web3 ecosystem already understands.
*Disadvantages*: More complex. Three things to verify instead of two. Capability token format needs a standard.

**PCC's choice: explicit delegation with embedded scope.** We choose explicit delegation because PCC already has a signing infrastructure (Ed25519 on every agent), the principalKey is typically warm (it's a running agent, not a cold-storage wallet), and the scope metadata is small enough to embed directly in the `SessionKey` struct rather than carrying a separate capability token. The signed `SessionKey` struct *is* the capability token — it contains the scope, the expiry, and the parent's signature. This is simpler than full UCAN chain delegation (which is overkill when the typical PCC delegation depth is 1-2 levels) and more capable than implicit delegation (which can't express scope constraints).

For multi-level delegation (a parent spawns a child that spawns a grandchild), each level signs the next level's SessionKey struct. The chain is linear and short (2-3 levels typical, capped at 5 by policy). A verifier unwinds the chain by following parent signatures back to the registered principalKey. This is essentially a simplified UCAN proof chain without the full UCAN vocabulary.

---

## 6. Accountability, Slashing, and Reputation Routing

The core accountability invariant: **all reputation consequences accrue to the principalKey.** A sessionKey never has reputation of its own. A sessionKey is a receipt, not an identity.

When a verifier catches a sessionKey misbehaving (e.g., submitting fabricated evidence, failing a touchstone, or exceeding its scope), the accountability flow is:

1. **The verifier constructs a `ReputationFeedback` record** targeting the principalKey's `agentId`. The `value` is negative (reflecting the severity of the infraction). The `tag1` is the relevant PCC reputation tag (e.g., `QUALITY`, `EVIDENCE_COMPLETENESS`). The `feedbackURI` points to an IPFS-stored `FeedbackFile`.

2. **The `FeedbackFile` includes a `sessionProof` field** containing:
   - The sessionKey's public key
   - The derivation path
   - The parent's signed `SessionKey` struct (proving the parent authorized this sessionKey)
   - The offending evidence event signed by the sessionKey
   - The verification failure details (e.g., touchstone expected answer vs actual answer)

3. **The Reputation Registry records the feedback against the principalKey's `agentId`**, exactly as it would for a directly-signed event. From the Reputation Registry's perspective, nothing is different — it receives feedback for a registered agent. The sessionProof in the FeedbackFile is supporting evidence, not a protocol-level field.

4. **The principalKey's `ReputationSummary.summaryValue` drops** by the feedback value. This is the same mechanism that already exists in `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\erc8004.ts` — the `ReputationSummary` type with `count`, `summaryValue`, `summaryValueDecimals`.

5. **The principalKey agent can inspect the feedback** and decide whether to revoke the offending sessionKey (if it's still alive), adjust its delegation policy, or take corrective action. The principalKey's *active* sessionKeys are NOT automatically revoked — the parent decides. Auto-revocation at configurable thresholds is an optional policy the parent can set (e.g., "if my reputation drops below score X, auto-revoke all outstanding sessionKeys").

**Why not hold the sessionKey accountable directly?** Because the sessionKey has no on-chain presence, no staked funds, no reputation history. Filing feedback against a key that doesn't exist in the Identity Registry is meaningless. The sessionKey will be garbage-collected in seconds; the feedback would have no target. The principalKey is the durable entity with something to lose — reputation, stake, and future business. This is identical to how OS audit logging works: audit events are attributed to the `uid`, not the `pid`, because the `uid` is the accountable entity. It is also identical to how Bittensor routes economic consequences to the coldkey even though the hotkey did the work.

**Slashing** — for crypto-economic trust models (one of the `TrustModel` options in ERC-8004), the principalKey may have staked funds in an escrow or staking contract. A slashing condition triggered by sessionKey misbehavior proceeds exactly as if the principalKey misbehaved directly. The slashing evidence includes the sessionProof to prove the principalKey authorized the sessionKey. The principalKey cannot deny responsibility because the SessionKey struct is signed by the principalKey's private key — cryptographic non-repudiation.

---

## 7. Revocation

SessionKeys are cheap, disposable, and short-lived. In most cases, revocation is unnecessary because the key expires before any adversary can exploit it. But there are two cases where early revocation matters: (1) a sessionKey is compromised before expiry (e.g., a child agent's memory is dumped), and (2) a parent detects that a child is misbehaving and wants to kill its authority immediately.

**Time-based expiry (default)**: Every `SessionKey` struct has an `expiresAt` timestamp. The default maximum lifetime is 3600 seconds (1 hour), and most PCC workloads will use much shorter lifetimes — 30-300 seconds for single workflow steps. Verifiers reject any sessionKey-signed event whose timestamp is past `expiresAt`. No on-chain transaction needed. The key is dead when the clock says it's dead.

**On-chain revocation event (optional, for high-assurance)**: The principalKey emits a `SessionKeyRevoked(sessionId, parentAgentId, revokedAt)` event on the Identity Registry chain. This is a cheap event emission (~20k gas, no state write). Verifiers operating at Tier 2-3 check the revocation event log before accepting sessionKey-signed evidence.

**Off-chain revocation list (for Tier 0-1)**: The principalKey publishes a signed revocation list at a well-known URL (e.g., `{agentURI}/session-revocations.json`). The list is a signed JSON array of revoked session IDs. Verifiers at Tier 0-1 check this list (with caching) instead of consulting the chain. This is the cheapest option and sufficient for low-assurance work.

**Revocation by tier**:

| Tier | Revocation Method | Latency | Cost |
|------|-------------------|---------|------|
| 0 | Time-based expiry only | Zero (automatic) | Free |
| 1 | Time-based + off-chain revocation list | Seconds (HTTP fetch) | Free |
| 2 | Time-based + on-chain event + off-chain list | ~12s (block time) | ~20k gas |
| 3 | Time-based + on-chain event + off-chain list + verifier consensus | ~30s (multi-verifier) | ~20k gas |

**Revocation propagation for multi-level chains**: If a principalKey revokes a first-level sessionKey that had itself issued second-level sessionKeys, all second-level keys are implicitly revoked because their proof chain includes a link signed by the now-revoked first-level key. Verifiers that check revocation at any link in the chain will reject the entire chain.

---

## 8. Session Scope: Capability Tokens Embedded in SessionKey

Every sessionKey must be scoped. An unscoped sessionKey is equivalent to giving a random process full access to the parent's identity — a capability-security anti-pattern. The scope is embedded directly in the `SessionKey` struct as a `SessionScope` object.

The scope restricts three dimensions:

1. **Allowed actions** — an array of action types the sessionKey can sign for. PCC defines these action types:
   - `evidence_submit` — submit an evidence bundle for a job
   - `workflow_step_complete` — sign completion of a workflow step
   - `touchstone_response` — respond to a touchstone task
   - `attestation_sign` — sign a verifier attestation
   - `heartbeat` — sign a liveness heartbeat
   - `quote_respond` — respond to a quote request

2. **Contract IDs** — the sessionKey is bound to specific contract or job IDs. A sessionKey issued for job `job-abc-123` cannot sign evidence for job `job-xyz-789`. This is the tightest scope constraint and the most important: it means a leaked sessionKey can only damage the specific job it was issued for.

3. **Maximum signatures** — a rate limit on how many times the sessionKey can sign. For single-step workflow tasks, this is typically 1. For multi-event jobs (e.g., streaming sensor data), it may be higher. A verifier that has seen more signatures from a sessionKey than `maxSignatures` rejects the excess.

**Scope verification** is the verifier's responsibility. When a verifier receives a sessionKey-signed event, it checks:
- Is the event's action type in `sessionKey.scope.allowedActions`?
- Is the event's contract/job ID in `sessionKey.scope.contractIds`?
- Has this sessionKey exceeded `maxSignatures`?
- Is the current time within `[issuedAt, expiresAt]`?

Any failure is a scope violation and triggers a negative `ReputationFeedback` against the principalKey.

---

## 9. Interaction with Workflow Steps (R02) and Touchstones (R01)

**Workflow steps (from the R02 report at `C:\Users\globa\physical-capability-cloud\ai\research\digital-verifier\02-workflow-steps.md`)**: The R02 design adds `workflowSteps[]` to `BuilderContract` — a typed DAG of digital operations where each step declares input/output schemas and dependencies. SessionKeys integrate naturally:

1. A parent agent creates a `BuilderContract` with `workflowSteps[]`.
2. For each step, the parent derives a sessionKey scoped to that step: `scope.contractIds = [contractId]`, `scope.allowedActions = ['workflow_step_complete', 'evidence_submit']`.
3. The parent spawns an ephemeral child agent, hands it the sessionKey + SessionScope + parentSignature.
4. The child executes the step, produces a typed output conforming to the step's output schema, signs the evidence event with its sessionKey.
5. The evidence event bundle includes: `{evidence, sessionKey, parentSignature, derivationProof}`.
6. The verifier validates: sessionKey signature, scope (correct contract, correct action type), derivation proof (chains to registered parent), and step output schema conformance.

**The challenge anchor (from R02)** — each contract instance may include a `challenge` field: a validator-issued freshness anchor that prevents replay. SessionKeys interact with the challenge anchor naturally: the sessionKey signs a response to the challenge, and the challenge anchor's `nonce` is included in the signed payload. Since the sessionKey is time-limited and the challenge is time-limited, the two together provide strong replay protection.

**Touchstones (from the R01 report at `C:\Users\globa\physical-capability-cloud\ai\research\digital-verifier\01-touchstone.md`)**: Touchstones are known-answer tasks injected into the work stream to statistically detect lazy execution. When a touchstone is assigned to a sessionKey-scoped child agent:

1. The child cannot distinguish a touchstone from a real task (by design — touchstones are indistinguishable from real work).
2. The child signs its response with the sessionKey, just like any other workflow step.
3. The verifier grades the touchstone response against the known answer.
4. If the response fails, a negative `ReputationFeedback` is filed against the *principalKey* (not the sessionKey), using the sessionProof to establish the accountability chain.
5. The principalKey's reputation drops. The verifier may additionally flag the sessionKey for revocation.

**The critical routing logic**: Touchstone reputation consequences always flow to the principalKey, because that's the entity that chose to delegate work to the child. If the parent delegates to a lazy child, the parent is responsible for the laziness — this is the stake-your-reputation-on-your-children invariant that makes the whole system work. The parent cannot escape accountability by delegating to ephemeral throwaway agents.

---

## 10. Security Analysis

### Threat 1: Adversary extracts a sessionKey and uses it beyond its scope

**Attack**: An adversary dumps a child agent's memory, extracts the sessionKey private key, and uses it to sign unauthorized evidence events.

**Defense**: Scope + time limits. The sessionKey's `SessionScope` restricts which actions and contracts it can sign for. The `expiresAt` timestamp caps the window of vulnerability. `maxSignatures` limits the volume of abuse. Even with a stolen key, the adversary can only sign for the specific job the key was issued for, within the time window, up to the signature limit. The damage is bounded and attributable.

**Residual risk**: If the adversary steals the key during its valid window and signs a single fraudulent evidence event before the real child signs, the verifier sees two conflicting events for the same step. This is detectable (two signatures from the same sessionKey for the same step) and triggers investigation. The parent can revoke the sessionKey immediately.

### Threat 2: Adversary compromises principalKey

**Attack**: The adversary obtains the principalKey private key and can derive unlimited sessionKeys, impersonate the agent completely.

**Defense**: The principalKey should be protected proportionally to its value. For high-value operators: hardware wallet, HSM, or TEE enclave. For typical agents: secure enclave or server-side KMS. SessionKeys are derived and used in ephemeral memory — they don't need HSM protection because their damage radius is bounded by scope and time. The design trades sessionKey security for principalKey security, concentrating the security investment where it matters. This is exactly the same trade-off as Bittensor's coldkey-in-hardware / hotkey-in-memory, and it's the right one.

**Residual risk**: If the principalKey is compromised, the agent is fully impersonated until the key is rotated. PCC's rotation path: the operator (who controls the ERC-721 identity token) can transfer the token to a new address and re-register with a new principalKey. All sessionKeys derived from the old principalKey become invalid because the registration chain is broken.

### Threat 3: Replay of old sessionKey-signed evidence

**Attack**: An adversary captures a sessionKey-signed evidence event and replays it against a new contract or a new time window.

**Defense**: Three layers. (a) The `expiresAt` timestamp makes old evidence stale — verifiers reject it. (b) The `scope.contractIds` binding means the evidence is only valid for the specific contract it was signed for. (c) The challenge primitive from R02/R05 requires a fresh nonce in every evidence event — replay of an old nonce is trivially detectable. Together, these three make replay a non-threat.

### Threat 4: Sybil — one actor runs many principalKeys

**Attack**: An adversary registers many principalKeys to dilute reputation penalties. Each principalKey has a thin reputation history, so slashing one has minimal consequence.

**Defense**: Reputation is per-principalKey and must be independently earned. A new principalKey starts with zero reputation and cannot bid on Tier 2-3 jobs (which require reputation thresholds per PCC's `applyColdStartGate` in `PopulationContext`). Sybils must each independently complete work and accumulate reputation, making the attack expensive. Additionally, PCC's assurance tiers gate access by reputation: Tier 0 is open, but Tiers 1-3 require increasing reputation scores. A Sybil with fresh identities is locked out of high-value work.

### Threat 5: Parent denies responsibility for child

**Attack**: A principalKey agent claims "I didn't authorize that sessionKey" after the sessionKey misbehaves.

**Defense**: The `SessionKey` struct is signed by the principalKey's private key. The signature is included in the derivation proof bundle. The verifier can present the signed SessionKey struct as evidence: "Here is your signature on the authorization. It verifies against your registered public key. You authorized this." Cryptographic non-repudiation. The parent cannot deny what their key signed.

### Threat 6: Scope escalation — child exceeds its scope

**Attack**: A sessionKey tries to sign for actions or contracts outside its declared scope.

**Defense**: The verifier checks scope before accepting any sessionKey-signed event. The scope check is O(1) (set membership for action types, set membership for contract IDs, counter for maxSignatures). Any scope violation is rejected and filed as negative reputation feedback against the principalKey. The sessionKey itself cannot modify its scope — the scope is in the `SessionKey` struct, which is signed by the parent and tamper-evident.

### Threat 7: UCAN-style chain length attack

**Attack**: In a multi-level delegation chain (principalKey -> sessionKey1 -> sessionKey2 -> ... -> sessionKeyN), an adversary creates a very deep chain to exhaust verifier resources during chain-unwinding.

**Defense**: PCC caps delegation depth at 5 levels (configurable per assurance tier). Verifiers reject chains exceeding the depth limit. This is a hard-coded policy, not a suggestion. Legitimate PCC workloads rarely exceed 2-3 levels. The cap is generous for the actual use case and prohibitive for abuse.

---

## 11. Concrete TypeScript Interfaces

These interfaces extend PCC's existing identity types at `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\`.

```typescript
import type { AgentRegistryId } from "./erc8004.js";
import type { DIDString } from "./types.js";

// ---------------------------------------------------------------------------
// Session Key Types
// ---------------------------------------------------------------------------

/** The persistent, ERC-8004-registered agent identity */
export interface PrincipalKey {
  /** ERC-8004 registered agent ID (eip155:{chainId}:{registry}) */
  agentId: AgentRegistryId;
  /** DID of the principal (did:key:z...) */
  did: DIDString;
  /** Raw Ed25519 public key (32 bytes, hex-encoded) */
  publicKey: string;
}

/** An ephemeral, derived key authorized to act on behalf of a principal */
export interface SessionKey {
  /** Unique session identifier (UUID v4) */
  sessionId: string;
  /** The principal agent this session acts for */
  parentAgentId: AgentRegistryId;
  /** SLIP-0010 derivation path from parent (e.g., "m/8004'/84532'/42'/0'") */
  derivationPath: string;
  /** Raw Ed25519 public key of the session key (32 bytes, hex) */
  publicKey: string;
  /** Block timestamp or Unix timestamp when issued */
  issuedAt: number;
  /** Block timestamp or Unix timestamp when this key expires */
  expiresAt: number;
  /** What this session key is allowed to do */
  scope: SessionScope;
  /**
   * Ed25519 signature of the parent over the canonical form of this struct
   * (excluding this field). Proves the parent authorized this sessionKey.
   */
  parentSignature: string;
  /**
   * Delegation depth (0 = directly issued by principalKey,
   * 1 = issued by a first-level sessionKey, etc.). Max 5.
   */
  delegationDepth: number;
  /**
   * For depth > 0: the SessionKey of the issuing parent session.
   * Forms a linked list back to the principalKey.
   */
  parentSessionKey?: SessionKey;
}

/** Scope restrictions for a session key */
export interface SessionScope {
  /** Allowed action types (e.g., ['evidence_submit', 'workflow_step_complete']) */
  allowedActions: SessionAction[];
  /** Contract or job IDs this session is bound to */
  contractIds: string[];
  /** Maximum number of signatures this session key may produce */
  maxSignatures: number;
}

/** Enumerated session action types */
export type SessionAction =
  | "evidence_submit"
  | "workflow_step_complete"
  | "touchstone_response"
  | "attestation_sign"
  | "heartbeat"
  | "quote_respond";

// ---------------------------------------------------------------------------
// Derivation Proof
// ---------------------------------------------------------------------------

/**
 * Proof that a sessionKey is derived from a principalKey.
 * Travels with every sessionKey-signed evidence event.
 */
export interface SessionProof {
  /** The session key that signed the event */
  sessionKey: SessionKey;
  /** Cryptographic derivation proof */
  derivationProof: DerivationProof;
}

/** Cryptographic proof of key derivation */
export interface DerivationProof {
  /** Parent's Ed25519 public key (the principalKey's pubkey) */
  parentPublicKey: string;
  /** SLIP-0010 derivation path */
  derivationPath: string;
  /** The derived Ed25519 public key (must match sessionKey.publicKey) */
  derivedPublicKey: string;
  /** For multi-level: array of intermediate proofs, root-first */
  chain?: DerivationProof[];
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/** A revocation record for a session key */
export interface SessionKeyRevocation {
  /** The session being revoked */
  sessionId: string;
  /** The principalKey's agentId that issued this session */
  parentAgentId: AgentRegistryId;
  /** Timestamp of revocation */
  revokedAt: number;
  /** Reason for revocation */
  reason: "compromised" | "misbehavior" | "parent_request" | "scope_violation";
  /** Parent's signature over the revocation record */
  parentSignature: string;
}

/** Off-chain revocation list served at {agentURI}/session-revocations.json */
export interface RevocationList {
  /** The principalKey that manages this list */
  parentAgentId: AgentRegistryId;
  /** All currently revoked sessions */
  revocations: SessionKeyRevocation[];
  /** Timestamp of last update */
  updatedAt: number;
  /** Parent's signature over the canonical form of this list */
  signature: string;
}

// ---------------------------------------------------------------------------
// Session Key Policy (in AgentRegistrationFile)
// ---------------------------------------------------------------------------

/** Policy describing how a principalKey issues session keys */
export interface SessionKeyPolicy {
  /** Maximum lifetime in seconds for any issued sessionKey */
  maxLifetimeSeconds: number;
  /** Maximum delegation depth (0 = no sub-delegation, 5 = max) */
  maxDelegationDepth: number;
  /** Derivation path prefix (e.g., "m/8004'/84532'") */
  derivationPathPrefix: string;
  /** Default allowed actions for new sessions */
  defaultAllowedActions: SessionAction[];
  /** Whether the principal posts an off-chain revocation list */
  publishesRevocationList: boolean;
  /** URL of the revocation list (if published) */
  revocationListUrl?: string;
}
```

---

## 12. Sign-and-Verify Flow

The complete lifecycle of a sessionKey, from issuance through verification:

### Issuance (principalKey side)

```
Principal Agent (holds principalKey private key):

  1. DERIVE sessionKey:
     seed = principalKey.privateKey + chainCode
     childKey = SLIP0010_Derive(seed, path="m/8004'/84532'/{counter}'/{subTask}'")
     → sessionKey.privateKey, sessionKey.publicKey

  2. CONSTRUCT SessionKey struct:
     sessionKey = {
       sessionId: uuid(),
       parentAgentId: principal.agentId,
       derivationPath: "m/8004'/84532'/42'/0'",
       publicKey: hex(childKey.publicKey),
       issuedAt: now(),
       expiresAt: now() + 300,  // 5 minutes
       scope: {
         allowedActions: ["evidence_submit", "workflow_step_complete"],
         contractIds: ["job-abc-123"],
         maxSignatures: 3,
       },
       delegationDepth: 0,
     }

  3. SIGN the SessionKey struct:
     canonical = canonicalize(sessionKey)  // deterministic JSON serialization
     sessionKey.parentSignature = ed25519_sign(principal.privateKey, canonical)

  4. HAND OFF to child agent:
     → sessionKey struct (with parentSignature)
     → sessionKey private key (derived in step 1)
     → derivation proof metadata
```

### Execution (sessionKey side)

```
Child Agent (holds sessionKey private key + SessionKey struct):

  1. EXECUTE the assigned workflow step
     → produces evidence event (typed output conforming to step schema)

  2. SIGN the evidence event:
     evidencePayload = {
       jobId: "job-abc-123",
       stepId: "step-001",
       action: "workflow_step_complete",
       output: { ... typed output ... },
       timestamp: now(),
       challengeNonce: "nonce-from-contract",  // replay protection
     }
     signature = ed25519_sign(sessionKey.privateKey, canonicalize(evidencePayload))

  3. BUNDLE for submission:
     bundle = {
       evidence: evidencePayload,
       signature: signature,
       sessionProof: {
         sessionKey: <the full SessionKey struct including parentSignature>,
         derivationProof: {
           parentPublicKey: principal.publicKey,
           derivationPath: "m/8004'/84532'/42'/0'",
           derivedPublicKey: sessionKey.publicKey,
         },
       },
     }
     → submit bundle to verifier / evidence registry
```

### Verification (verifier side)

```
Verifier (has the evidence bundle):

  Step 1: VERIFY child signature
    ed25519_verify(
      sessionKey.publicKey,
      canonicalize(bundle.evidence),
      bundle.signature
    ) → must be true

  Step 2: VERIFY derivation proof
    // For SLIP-0010 hardened derivation, the verifier cannot independently
    // derive the child pubkey from only the parent pubkey + path (hardened
    // derivation requires the private key). Instead, the verifier checks
    // that the parent SIGNED the SessionKey struct, which binds the
    // derived pubkey to the parent's identity.
    
    // Extract the SessionKey struct (excluding parentSignature field)
    sessionKeyBody = removeField(bundle.sessionProof.sessionKey, "parentSignature")
    
    ed25519_verify(
      bundle.sessionProof.derivationProof.parentPublicKey,
      canonicalize(sessionKeyBody),
      bundle.sessionProof.sessionKey.parentSignature
    ) → must be true

  Step 3: VERIFY ERC-8004 registration
    // Look up the parentAgentId in the Identity Registry
    // Confirm the registered agent's public key matches parentPublicKey
    registeredKey = identityRegistry.getPublicKey(sessionKey.parentAgentId)
    assert(registeredKey == bundle.sessionProof.derivationProof.parentPublicKey)

  Step 4: CHECK scope
    assert(bundle.evidence.action IN sessionKey.scope.allowedActions)
    assert(bundle.evidence.jobId IN sessionKey.scope.contractIds)
    assert(signatureCount(sessionKey.sessionId) < sessionKey.scope.maxSignatures)

  Step 5: CHECK expiry
    assert(now() >= sessionKey.issuedAt)
    assert(now() <= sessionKey.expiresAt)

  Step 6: CHECK revocation (tier-dependent)
    // Tier 0: skip (time-based expiry only)
    // Tier 1: fetch off-chain revocation list from agentURI
    // Tier 2-3: check on-chain SessionKeyRevoked events
    assert(sessionKey.sessionId NOT IN revocationList)

  Step 7: CHECK delegation depth
    assert(sessionKey.delegationDepth <= MAX_DELEGATION_DEPTH)  // default 5

  Step 8: ACCEPT
    // All checks passed. Evidence is treated as if signed by principalKey.
    // Reputation effects route to principalKey.agentId.
```

---

## 13. Revocation List Placement

Where the revocation list lives determines its latency, cost, and auditability.

**On-chain event log (Tier 2-3)**: The principalKey emits a `SessionKeyRevoked` event on the Identity Registry chain. Advantages: canonical, tamper-proof, globally visible. Disadvantages: ~20k gas per revocation, 12-second block latency (on Base), requires the principalKey to have ETH for gas. Appropriate for Tier 2-3 where the evidence is high-stakes (medical, aerospace) and the cost of a false acceptance exceeds the gas cost of revocation.

**Off-chain signed JSON (Tier 1)**: The principalKey publishes a `RevocationList` at `{agentURI}/session-revocations.json`. The list is signed by the principalKey so verifiers can authenticate it. Advantages: free, instant (HTTP publish), no gas. Disadvantages: not globally canonical (a verifier must fetch from the specific URL), depends on the principalKey's server being available, can be temporarily censored by network issues. Appropriate for Tier 1 where the work is standard production and the cost of a brief false acceptance is manageable.

**Off-chain with periodic Merkle root commitment (hybrid)**: The principalKey publishes the revocation list off-chain but periodically commits a Merkle root of the list on-chain (e.g., every hour or every 100 revocations). Verifiers check the off-chain list for speed but can audit against the on-chain Merkle root for integrity. This is the strongest hybrid and appropriate for Tier 2 operators who want the speed of off-chain with the auditability of on-chain.

**Time-based expiry only (Tier 0)**: No revocation list at all. SessionKeys expire in 30-300 seconds. If a key is compromised in that window, the damage is bounded by scope and maxSignatures. Appropriate for Tier 0 prototyping and low-stakes work.

**Recommendation**: Default to time-based expiry for Tier 0, off-chain signed JSON for Tier 1, on-chain events for Tier 2-3. Let the `SessionKeyPolicy` in the `AgentRegistrationFile` declare which method the principalKey uses, so verifiers know where to look.

---

## 14. Gas Cost Analysis

The entire point of the sessionKey design is to minimize on-chain costs. Here's the breakdown:

| Operation | Where | Gas Cost | Frequency |
|-----------|-------|----------|-----------|
| principalKey registration | On-chain (Identity Registry) | ~50k gas (one-time) | Once per agent lifetime |
| sessionKey issuance | Off-chain (parent signs struct) | 0 gas | Per session (millions) |
| sessionKey derivation | Off-chain (SLIP-0010 HMAC) | 0 gas | Per session (millions) |
| Per-use verification | Off-chain (Ed25519 verify) | 0 gas | Per evidence event |
| sessionKey revocation (if needed) | On-chain event (optional) | ~20k gas | Rare (only on compromise/misbehavior) |
| Reputation feedback | On-chain (Reputation Registry) | ~30k gas | Per feedback event |
| Off-chain revocation list | HTTP publish | 0 gas | As needed |

**Comparison with naive full-registration approach**:

If PCC required full ERC-8004 registration for every ephemeral agent:
- 1 million sessionKeys per day = 1M * 50k gas = 50 billion gas/day
- At 30 gwei gas price = 1,500 ETH/day = ~$4.5M/day at $3000/ETH
- Plus the registry bloat: 1M new NFTs per day in the Identity Registry

With the sessionKey approach:
- 1 principalKey registration: 50k gas one-time = $0.15
- 1M sessionKeys per day: $0 on-chain cost
- Occasional revocations: negligible
- **Total on-chain cost: < $1/day regardless of sessionKey volume**

This is a reduction of approximately 6 orders of magnitude. The sessionKey design makes agent-run-enterprise workloads economically feasible on-chain. Without it, PCC is architecturally incompatible with the workload it claims to serve.

---

## 15. Known Failure Modes from Production Delegation Schemes

Every production delegation scheme that has seen significant use has discovered failure modes. PCC should learn from each.

**OAuth refresh token theft**: The classic attack is stealing a refresh token and maintaining long-term persistence. The attacker keeps exchanging the refresh token for new access tokens, staying undetected because the system doesn't notice concurrent usage. **PCC defense**: sessionKeys are not refreshable. There is no "refresh a sessionKey" operation. When a sessionKey expires, a new one must be derived from the principalKey. The principalKey is the only thing that can mint sessionKeys, and the principalKey is warm-but-secured (KMS/enclave), not exposed to the child agent's runtime. Even if an attacker steals a sessionKey, they cannot use it to mint more sessionKeys — it is a terminal authority.

**JWT revocation difficulty**: JWTs are stateless, so revoking one requires maintaining a blacklist and checking it on every verification — which undermines the statelessness that was the point of JWTs. Large-scale JWT blacklists become performance bottlenecks. **PCC defense**: SessionKeys are NOT stateless in the JWT sense. They carry a signed struct with explicit scope and expiry. Revocation is layered: time-based (free, automatic), off-chain list (for Tier 1, cheap), on-chain (for Tier 2-3, canonical). The key insight is that most sessionKeys don't need revocation at all because they expire in seconds. The revocation list is a *small* data structure (only the compromised/misbehaving sessions, which are rare), not a large one (all sessions ever issued, which would be huge).

**UCAN chain length attacks**: UCAN proof chains can be arbitrarily deep, forcing verifiers to traverse and verify every link. An attacker can construct a chain with hundreds of links, each requiring a signature verification, to exhaust verifier CPU. **PCC defense**: Hard cap on delegation depth (default 5, configurable down to 1 per assurance tier). Chains exceeding the depth limit are rejected without traversal. The typical PCC chain is 1-2 links deep. The cap is enforced at the verifier, not at issuance, so an attacker can construct a deep chain but no verifier will process it.

**Macaroon caveat explosion**: Macaroons allow unlimited caveats to be appended, each adding a predicate that must be checked. An attacker can append thousands of caveats to create a computationally expensive verification. **PCC defense**: SessionScope is a fixed-size struct with three fields (allowedActions array, contractIds array, maxSignatures integer). There is no open-ended caveat mechanism. Scope verification is O(n) in the number of action types and contract IDs, which are both small (typically 1-3 items). The design trades the expressiveness of arbitrary caveats for the predictability of a fixed schema.

**Bittensor child hotkey on-chain cost**: Bittensor's child hotkey feature requires an on-chain transaction per child delegation. At scale (thousands of children), this becomes expensive and slow. **PCC defense**: SessionKey issuance is entirely off-chain. The principalKey signs the SessionKey struct locally and hands it to the child. No chain interaction. This is the single most important design decision in the entire ephemeral identity system.

---

## 16. Reputation Propagation Semantics

When a sessionKey fails a touchstone or produces bad evidence, the exact reputation flow is:

1. **Verifier detects failure.** The failure could be: touchstone answer mismatch, evidence schema validation failure, scope violation, expired sessionKey used after expiry, duplicate signature (replay attempt), or attestation disagreement with other verifiers.

2. **Verifier constructs ReputationFeedback.** The feedback record targets the `parentAgentId` from the sessionKey struct:
   ```typescript
   const feedback: ReputationFeedback = {
     agentId: sessionKey.parentAgentId,  // the principalKey's registered ID
     value: -50n,                         // severity-weighted negative score
     valueDecimals: 0,
     tag1: PCC_REPUTATION_TAGS.QUALITY,
     tag2: "sessionKey-failure",
     feedbackURI: "ipfs://Qm...",         // points to FeedbackFile with sessionProof
   };
   ```

3. **FeedbackFile on IPFS includes the sessionProof.** This is the evidentiary record. It contains the full SessionKey struct, the derivation proof, the offending evidence event, the expected vs actual values (for touchstone failures), and the verifier's analysis.

4. **Reputation Registry records the feedback.** The `ReputationSummary` for the principalKey's `agentId` updates: `count` increments, `summaryValue` decreases by the feedback value. This is the standard ERC-8004 feedback pipeline — no protocol changes needed.

5. **The principalKey agent can query its reputation** and see the new feedback. It can inspect the `feedbackURI` to understand which sessionKey failed and why.

6. **Configurable auto-response thresholds.** The principalKey agent can set internal policies:
   - If reputation drops below threshold X: auto-revoke all active sessionKeys
   - If a specific sessionKey receives N negative feedbacks: auto-revoke that sessionKey
   - If reputation drops below threshold Y: stop issuing new sessionKeys until reputation recovers
   These are client-side policies, not protocol-enforced — the principalKey agent implements them in its own code.

7. **SessionKeys do NOT receive feedback independently.** There is no feedback record in the Reputation Registry for a sessionKey. The sessionKey has no `agentId`, no entry in the Identity Registry, and no reputation. It exists only in the off-chain SessionKey struct and in the evidence bundles it signed. The principalKey is the sole reputational entity.

---

## 17. Test Strategy

### Unit Tests

Location: `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\__tests__\session-key.test.ts`

1. **SLIP-0010 derivation correctness**: Derive a child key from a parent key using known test vectors (from the SLIP-0010 specification). Verify the derived public key matches the expected output.

2. **SessionKey struct signing**: Create a SessionKey struct, sign it with a parent key, verify the signature. Modify one field and verify the signature fails.

3. **Scope enforcement**: Create a sessionKey with specific scope. Sign events that are in-scope and out-of-scope. Verify the scope checker accepts/rejects correctly.

4. **Expiry enforcement**: Create a sessionKey with a 60-second lifetime. Verify acceptance within the window and rejection after expiry.

5. **maxSignatures enforcement**: Create a sessionKey with maxSignatures=3. Sign 3 events (accepted), sign a 4th (rejected).

6. **Derivation proof validation**: Create a derivation proof with correct parent pubkey, path, and derived pubkey. Verify it passes. Tamper with the path and verify it fails. Tamper with the parent pubkey and verify it fails.

7. **Revocation**: Create a sessionKey, add it to a revocation list, verify the revocation check rejects it.

8. **Multi-level chain**: principalKey -> sessionKey1 -> sessionKey2. Verify the verifier can unwind the chain. Revoke sessionKey1 and verify sessionKey2 is implicitly rejected.

### Integration Tests

Location: `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\__tests__\session-key-integration.test.ts`

9. **Parent-child-grandchild chain (3 levels)**: A principalKey issues a sessionKey, which issues a sub-sessionKey (depth 2), which signs an evidence event. A verifier unwinds the full chain back to the registered principalKey. Verify all signature checks pass.

10. **Touchstone interaction**: A sessionKey-signed touchstone response is graded by a verifier. On failure, verify the ReputationFeedback is correctly constructed with the sessionProof targeting the principalKey's agentId.

11. **Workflow step interaction**: A sessionKey signs a workflow step completion. Verify the evidence bundle includes the sessionProof and passes full verification.

12. **Scope violation detection**: A sessionKey signs an event for a contract ID not in its scope. Verify the verifier rejects it and the scope violation is flagged.

### Performance Tests

Location: `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\__tests__\session-key-perf.test.ts`

13. **Derivation throughput**: Derive 10,000 sessionKeys from a single principalKey. Target: <1 second on Spark (119GB RAM, CPU is still ARM-based).

14. **Verification throughput**: Verify 10,000 sessionKey-signed events (single-level chain). Target: 10k verifications per second on Spark.

15. **Multi-level verification throughput**: Verify 10,000 events with 3-level chains. Target: 3k verifications per second on Spark (each verification is ~3x the work of single-level).

---

## 18. Concrete Ephemeral Identity Implementation for PCC

### File Layout

```
packages/spec/src/identity/
  erc8004.ts                    ← existing (unchanged)
  types.ts                      ← existing (unchanged)
  did.ts                        ← existing (unchanged)
  credentials.ts                ← existing (unchanged)
  session-key.ts                ← NEW: SessionKey types + SessionScope + SessionProof
  session-key-crypto.ts         ← NEW: SLIP-0010 derivation + sign + verify (Node.js only)
  session-key-validation.ts     ← NEW: browser-safe scope/expiry/depth validation
  index.ts                      ← MODIFIED: add session-key exports
  __tests__/
    session-key.test.ts          ← NEW: unit tests
    session-key-integration.test.ts ← NEW: integration tests
    session-key-perf.test.ts     ← NEW: performance tests
```

### File: `session-key.ts` — Types Only (Browser-Safe)

Contains all interfaces from Section 11: `PrincipalKey`, `SessionKey`, `SessionScope`, `SessionAction`, `SessionProof`, `DerivationProof`, `SessionKeyRevocation`, `RevocationList`, `SessionKeyPolicy`. No runtime code, no `node:crypto` imports. Safe for browser import (same pattern as `types.ts`).

### File: `session-key-crypto.ts` — SLIP-0010 Derivation + Signing (Node.js Only)

Functions:

```typescript
/**
 * Derive a session key from a principal key using SLIP-0010 hardened Ed25519.
 * Returns the derived private key, public key, and chain code.
 */
export function deriveSessionKey(
  parentPrivateKey: string,    // hex
  parentChainCode: string,     // hex (from initial seed or previous derivation)
  derivationPath: string,      // e.g., "m/8004'/84532'/42'/0'"
): { privateKey: string; publicKey: string; chainCode: string };

/**
 * Issue a complete SessionKey struct: derive the key, construct the struct,
 * sign it with the parent key. Returns the SessionKey (with parentSignature)
 * and the derived private key.
 */
export function issueSessionKey(
  parentPrivateKey: string,
  parentChainCode: string,
  parentAgentId: AgentRegistryId,
  scope: SessionScope,
  options?: {
    lifetimeSeconds?: number;     // default 300
    derivationPath?: string;      // auto-generated if omitted
    delegationDepth?: number;     // default 0
  },
): { sessionKey: SessionKey; privateKey: string; chainCode: string };

/**
 * Sign an evidence payload with a session key.
 */
export function signWithSessionKey(
  sessionPrivateKey: string,
  payload: unknown,
): string;   // hex-encoded Ed25519 signature

/**
 * Construct a complete SessionProof for an evidence bundle.
 */
export function buildSessionProof(
  sessionKey: SessionKey,
  parentPublicKey: string,
): SessionProof;
```

### File: `session-key-validation.ts` — Verification (Browser-Safe for Scope/Expiry, Node.js for Crypto)

```typescript
/**
 * Verify a session-key-signed evidence bundle. Checks all 7 steps from Section 12.
 * Returns a detailed result with per-step pass/fail.
 */
export function verifySessionKeyBundle(
  bundle: {
    evidence: unknown;
    signature: string;
    sessionProof: SessionProof;
  },
  options: {
    /** Current timestamp (for expiry check) */
    now?: number;
    /** Maximum delegation depth */
    maxDepth?: number;
    /** Revocation list to check against */
    revocations?: string[];  // session IDs
    /** ERC-8004 registry lookup: returns registered public key for an agentId */
    lookupRegisteredKey: (agentId: AgentRegistryId) => Promise<string | null>;
  },
): Promise<SessionVerificationResult>;

export interface SessionVerificationResult {
  valid: boolean;
  steps: {
    childSignature: boolean;
    parentSignature: boolean;
    registryLookup: boolean;
    scopeCheck: boolean;
    expiryCheck: boolean;
    revocationCheck: boolean;
    depthCheck: boolean;
  };
  /** The principalKey's agentId (for routing reputation) */
  principalAgentId?: AgentRegistryId;
  /** Error message if invalid */
  error?: string;
}

/**
 * Browser-safe scope validation (no crypto, pure logic).
 */
export function validateScope(
  sessionKey: SessionKey,
  action: SessionAction,
  contractId: string,
  signatureCount: number,
): { valid: boolean; error?: string };

/**
 * Browser-safe expiry validation.
 */
export function validateExpiry(
  sessionKey: SessionKey,
  now?: number,
): { valid: boolean; error?: string };
```

### Integration with `index.ts`

The existing `index.ts` at `C:\Users\globa\physical-capability-cloud\packages\spec\src\identity\index.ts` exports all identity modules. Add:

```typescript
// Session Key types (browser-safe)
export type {
  PrincipalKey,
  SessionKey,
  SessionScope,
  SessionAction,
  SessionProof,
  DerivationProof,
  SessionKeyRevocation,
  RevocationList,
  SessionKeyPolicy,
  SessionVerificationResult,
} from "./session-key.js";

// Session Key validation (browser-safe, no crypto)
export {
  validateScope,
  validateExpiry,
} from "./session-key-validation.js";

// Session Key crypto (Node.js only)
export {
  deriveSessionKey,
  issueSessionKey,
  signWithSessionKey,
  buildSessionProof,
  verifySessionKeyBundle,
} from "./session-key-crypto.js";
```

### Integration with `AgentRegistrationFile`

The existing `AgentRegistrationFile` in `erc8004.ts` gains an optional field:

```typescript
export interface AgentRegistrationFile {
  // ... existing fields ...
  /** Optional: policy for sessionKey issuance (ephemeral identity tier) */
  sessionKeyPolicy?: SessionKeyPolicy;
}
```

### Integration with `FeedbackFile`

The existing `FeedbackFile` in `erc8004.ts` gains an optional field:

```typescript
export interface FeedbackFile {
  // ... existing fields ...
  /** If feedback relates to sessionKey-signed work, the proof chain */
  sessionProof?: SessionProof;
}
```

### Integration with KernelAgent

The `KernelAgent` at `C:\Users\globa\physical-capability-cloud\packages\agent-kernel\src\kernel-agent.ts` can use sessionKeys when spawning sub-agents for workflow steps. The evidence emitter's signing callback currently uses `this.wallet.signMessage()` — for sessionKey-scoped work, it would use `signWithSessionKey()` with the derived sessionKey instead. The principalKey is the kernel agent's wallet key; the sessionKey is per-job.

### ERC-8004 Registration Extension

On-chain, the only new event needed is:

```solidity
event SessionKeyRevoked(
    bytes32 indexed sessionId,
    uint256 indexed parentAgentId,
    uint256 revokedAt
);
```

This is emitted by the Identity Registry contract when a principalKey revokes a sessionKey. It requires no state changes (event-only, ~20k gas). Verifiers listen for these events and maintain a local revocation cache.

---

## Summary of Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Naming | `sessionKey` / `principalKey` | Avoids "hotkey/coldkey" baggage; maps to RBAC vocabulary |
| Derivation scheme | SLIP-0010 hardened Ed25519 | Matches PCC's existing Ed25519 stack; simpler than BIP32-Ed25519 public derivation |
| Derivation proof model | Explicit (parent signs SessionKey struct) | Consent is provable; scope is embedded; parent must be warm |
| Scope mechanism | Fixed SessionScope struct | Predictable verification cost; avoids caveat explosion |
| Revocation by tier | Tier 0: expiry; Tier 1: off-chain list; Tier 2-3: on-chain events | Cost-proportional to assurance requirements |
| Reputation routing | All feedback to principalKey | SessionKeys have no durable identity; parent is accountable |
| Delegation depth cap | 5 levels max | Prevents chain-length attacks; 2-3 is typical |
| On-chain footprint | principalKey registration only; sessionKeys off-chain | 6 orders of magnitude gas savings vs naive approach |
| Multi-level delegation | Linked list of SessionKey structs | Each level signs the next; chain is verifiable |

This design makes PCC compatible with agent-run-enterprise workloads where millions of ephemeral agents sign work every day, while maintaining full accountability, revocability, and reputation consequences through the persistent principalKey identity tier.

