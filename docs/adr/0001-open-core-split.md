# ADR: Open-core split — Apache 2.0 monorepo + proprietary PCC Oracle

- Status: Accepted
- Date: 2026-04-23
- Author: Ryan (globalmysterysnailrevolution)
- Supersedes: informal "everything Apache 2.0" assumption
- Implements: isolation of the commercial settlement surface into a
  proprietary repo while keeping the rest of PCC permissive.

## Context

PCC spans ~22 packages and one public gateway. Earlier licensing analysis
conflated two different axes:

1. **Commercial use** — does the protocol charge? (yes: 2.35% on every
   settled escrow, hardcoded on-chain)
2. **Cloud delivery** — does the software run as a service over a
   network? (yes: `https://capability.network`)

Conflating the two made us defensively exclude several libraries
(DePHY/AGPL, Doubango/dual-license, Truepic/EULA, Witness Camera/GPLv3)
that would have been usable under the correct architectural split. It
also made us assume the rent had to be captured *inside* the open-source
boundary, which is precisely the risk an AGPL/BUSL transitive dependency
would weaponize.

The corrective insight: the rent is captured at exactly one layer —
the settlement attestation — and that layer is already a single service
in a separate repo. Every other layer (gateway, verifier, detector, UI,
pcc-node, contracts, MCP server, workflow runtime) can be open-core
without risk, because none of them alone can release escrow funds.

## Decision

Adopt an **open-core split** with a strict copyleft-contagion boundary
at the HTTP edge:

| Layer | Repo | License | Role |
|-------|------|---------|------|
| Monorepo (gateway, verifier, detector, UI, pcc-node, contracts, MCP server, workflow runtime) | `LamaSu/physical-capability-cloud` (public) | **Apache 2.0** | The protocol. Public API, runnable locally, auditable, forkable. |
| PCC Oracle (settlement attestation service) | `LamaSu/pcc-oracle` (private) | **Proprietary** (LamaSu internal license) | The rent layer. Issues signed `MilestoneEscrow.release()` attestations. |

### Contagion boundary

The gateway calls the oracle over **HTTP** (`oracle-client.ts` →
`https://<oracle-host>/verify`). There is no in-process linking between
the open source codebase and the proprietary oracle.

```
┌───────────────────────── Apache 2.0 ──────────────────────────┐
│                                                                │
│  Agent → Gateway → Verifier (consensus cascade) → Evidence      │
│                        │                                         │
│                        ▼                                         │
│                  oracle-client.ts  ─────HTTP─────┐               │
│                                                  │               │
└──────────────────────────────────────────────────┼───────────────┘
                                                   │
                                                   ▼
                                        ┌────── Proprietary ──────┐
                                        │                          │
                                        │     PCC Oracle           │
                                        │     signs release()      │
                                        │                          │
                                        └──────────────────────────┘
```

This is the same pattern Grafana Labs / Grafana Cloud, Elastic /
Elastic Cloud, Sentry / sentry.io, and HashiCorp / Terraform Cloud use.
Network separation defeats copyleft contagion ("mere aggregation").

## Consequences — positive

1. **Previously-excluded libs become viable again.**
   - DePHY (AGPL): usable if run as a separate service; in-process only if the service is AGPL'd — we own the oracle, so in-process is fine there.
   - Doubango (dual-license): usable in the proprietary oracle under a commercial seat.
   - Truepic SDK (EULA): usable by operators who sign their own EULA; we ship no Truepic binaries, we just read C2PA manifests operators produce.
   - Witness Camera (GPLv3): runs on operators' own devices; output files cross the boundary, not the code.

2. **Transitive copyleft risk is bounded.** A GPL/AGPL dep accidentally pulled into the public monorepo would infect only Apache 2.0 code, not the revenue-generating service. We also add CI license scan (SPDX allowlist) as a defense in depth.

3. **The public repo becomes a genuine ecosystem asset.** Contributors can run it end-to-end against their own oracle (including a self-hosted reference implementation, if we ever publish one). This is a real adoption story, not a marketing one.

4. **Commercial story stays focused.** Revenue is explicitly and only the oracle. There is no "well actually we also sell support for the gateway" blurring — the contagion boundary forces clarity.

## Consequences — negative / costs

1. **Coordination overhead.** The oracle contract (request/response shape) now lives across two repos. Addressed by shipping an OpenAPI spec as the canonical schema and generating types for both sides (see Follow-ups).

2. **Release coupling.** Gateway and oracle can drift. Addressed by versioning the HTTP contract (`/v1/verify`), semver-enforced by release-please on both repos, and a contract-compatibility CI job that runs the oracle's integration tests against the gateway client stubs on every gateway PR.

3. **Dev ergonomics.** Local E2E needs both repos running. Addressed by `docker-compose.dev.yml` that boots a pinned oracle image against the monorepo dev gateway, plus `PCC_ORACLE_MODE=mock` for cases where settlement realism is not in scope.

4. **Audit surface doubled.** Every privacy/SOC2 audit now touches two repos. Scoping doc: the oracle holds private keys and attestation logs; the monorepo holds business logic and user data. Different audit profiles, not additive pain.

## Naming (disambiguation)

Two things were both called "oracle" and confused:

| Name | Location | License | Role | Trust model |
|------|----------|---------|------|-------------|
| **Consensus Oracle** | `packages/verifier/src/consensus-oracle/` (renamed from `oracle/` in this commit series) | Apache 2.0 | UMA → Chainlink → EigenLayer cascade. "Is the work real?" | Trust-neutral, multi-party |
| **PCC Oracle** | `C:/Users/globa/pcc-oracle` + `packages/gateway/src/services/oracle-client.ts` (HTTP client) | Proprietary | Signs `MilestoneEscrow.release()`. "Is it okay to pay?" | Trust us; we are the protocol operator |

They are complementary, not redundant. Flow:

```
Evidence bundle
   ↓
Consensus Oracle (open, cascade) ──► "verified: true, confidence: 0.93"
   ↓
PCC Oracle (private) ──► policy check + signed attestation
   ↓
MilestoneEscrow.release(attestation)
```

## SWF (Sovereign Wealth Fund) governance scope clarification

The SWF governance module (`/api/swf/*`, `packages/swf`) is Apache 2.0 and stays in the public repo. It governs protocol-level decisions (fee splits for rewards pools, treasury allocations, proposals) — not oracle operation. The 2.35% settlement fee is hardcoded in the MilestoneEscrow contract and not SWF-controlled; SWF participants only vote on how the accumulated fee pool is distributed downstream. This keeps the rent mechanism (oracle attestation) structurally separate from the decentralised governance story.

If SWF ever votes to change settlement economics, it would do so by proposing a new escrow contract deployment and migrating — it cannot reach inside the oracle.

## Security footgun eliminated

The old `oracle-client.ts` silently fell back to a mock verification
when `PCC_ORACLE_KEY` was unset OR when the escrow address did not
start with `0x`. Under the open-core split this became a load-bearing
risk: any misconfigured gateway could release real escrow funds based
on an all-green mock attestation.

Fixed by `PCC_ORACLE_MODE` env var (`real` | `mock` | `auto`):

- `NODE_ENV=production` + any mode → mock path is unreachable.
- `real` mode throws on missing key or non-hex escrow.
- `mock` mode rejected outright in production.
- `auto` is the default and behaves as `real` in prod, graceful fallback in dev.

Diagnostic endpoint: `getOracleMode()` from `oracle-client.ts` is
surfaced via `/api/status` so operators can verify mode at runtime.

## Follow-ups (tracked, in this branch unless noted)

- [x] Move oracle out of the suspended `wingdingspenpal/pcc-oracle` remote to `LamaSu/pcc-oracle` (private).
- [x] LICENSE declaring proprietary status added to oracle repo.
- [x] Rename `packages/verifier/src/oracle/` → `consensus-oracle/`.
- [x] Gateway `PCC_ORACLE_MODE` fail-closed-in-prod fix.
- [ ] OpenAPI spec at `packages/gateway/openapi/oracle.yaml` — versioned gateway↔oracle contract, source of truth for both sides.
- [ ] Add `release-please` config + Conventional Commits discipline to `LamaSu/pcc-oracle`.
- [ ] CI license scan (SPDX allowlist) on the public monorepo rejecting any transitive dep with `GPL-*` / `AGPL-*` / `SSPL-*` license without explicit override.
- [ ] Optional: publish a reference oracle (Apache 2.0, no signing key) so forks can run E2E without a LamaSu-issued key.

## References

- Open-core precedent: Grafana Labs / Grafana Cloud, Elastic / Elastic Cloud (pre-SSPL), Sentry / sentry.io, HashiCorp / Terraform Cloud.
- Copyleft contagion: GPLv3 §5, AGPLv3 §13 (remote network interaction), "mere aggregation" interpretation (FSF FAQ).
- PCC protocol fee: `contracts/src/MilestoneEscrow.sol::PROTOCOL_FEE_BPS = 235`.
- PCC Oracle repo: `LamaSu/pcc-oracle` (private, default branch `master`).
- PCC monorepo: `LamaSu/physical-capability-cloud` (public, default branch `master`).
