# PCC Adapter Bounties — First 50 Machine Types

**Date**: 2026-04-29
**Branch**: `feat/contributor-economics`
**Status**: Open. Bounties are claimable today.

---

## TLDR

We are paying **$2,000 to $10,000 USD** flat **plus a 250bp lifetime royalty**
on every job that uses your adapter, for the first 50 priority machine-type
adapters listed in §4. The royalty is on-chain, immutable, content-addressed,
and routed through `MilestoneEscrow.splitPayout()`. Apache-2.0 licensed,
public source repo, you keep ownership of the `ContributorNFT`.

**Cross-link**: see [`docs/CONTRIBUTOR_ECONOMICS.md`](./CONTRIBUTOR_ECONOMICS.md)
for the underlying economic primitives, and
[`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`](./DEPLOY_CONTRIBUTOR_ECONOMICS.md)
for the on-chain mint flow you will follow at payout.

---

## 1. Why this exists

PCC is a control plane for physical capabilities. To turn a physical machine
into a billable PCC capability, someone has to write the adapter that bridges
the machine's native interface (firmware API, MQTT topic, MTConnect agent,
SiLA-2 endpoint, vendor cloud, raw G-code over WebSocket) to the
`@pcc/kernel` adapter interface. That adapter is the load-bearing component
between "physical machine in a workshop" and "callable capability on
`https://capability.network`."

Today PCC ships 5 production adapter implementations (OctoPrint, OPC-UA,
SiLA-2, generic-HTTP, mock) plus a Modbus-TCP scaffold. The
`ai/research/machine-class-standards.md` audit identifies ~50 high-priority
machine types where structured parameter data already exists (Cura,
Opentrons shared-data, MTConnect, Allotropy, OPC-UA companion specs) and
adapter scaffolding is straightforward for someone with vendor-API access.

This doc turns that audit into a market.

We pay flat USDC for the integration work. We pay a 250bp lifetime royalty
because the integration keeps producing value every time someone runs a job
through it, and that value should flow back to the integrator forever — not
to PCC, not to a platform, not to the OEM. See
[`docs/CONTRIBUTOR_ECONOMICS.md`](./CONTRIBUTOR_ECONOMICS.md) for why this
specifically is not an OEM-rent model.

---

## 2. The deal (mechanics)

For each adapter accepted into the registry:

- **Flat bounty in USDC**: $2,000 (hobby tier) → $5,000 (production tier) →
  $10,000 (industrial tier) → up to $25,000 case-by-case (frontier tier).
  Paid to the wallet you specify within 7 days of approval.
- **Lifetime royalty**: 250bp on every job that uses your adapter,
  indefinitely. Encoded as a `RateSchedule` minted into a `ContributorNFT`
  with `role=integrator`. The on-chain `RateScheduleRegistry` seals the
  schedule under its sha256, so the rate is immutable from your end and
  cannot be revoked by PCC.
- **Payment mechanism**: At approval, you (or a PCC ops account at your
  request) mint a `ContributorNFT` bound to your `RateSchedule` per
  `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`. PCC funds an initial milestone
  in your name (the flat bounty). Future jobs that use your adapter route
  250bp to your wallet via `MilestoneEscrow.splitPayout()` automatically.
- **Open-source license requirement**: Apache-2.0. Adapter source must live
  in a public repo (you choose the host — GitHub, Codeberg, GitLab, your
  own forge). The license is non-negotiable: PCC is a public protocol and
  contributor-economics requires that adapters be forkable. If you fork
  someone else's accepted adapter and it ends up routed to instead of the
  original, you earn that adapter's 250bp going forward; the original
  author still earns from any operator who hasn't migrated. See FAQ §8.7.
- **You retain ownership of the NFT**: The `ContributorNFT` is ERC-721. You
  can transfer, sell, or hold it. The 250bp accrues to whoever owns the
  token at settlement time.

---

## 3. Tier matrix

| Tier | Examples | Flat bounty | RateSchedule (bootstrap year) | Why this tier |
|------|----------|-------------|-------------------------------|---------------|
| Hobby | OctoPrint (already shipped), Moonraker, Klipper-direct, Bambu Lab MQTT (lan-mode), PrusaLink | **$2,000** | 250bp constant first 12 months, your choice after | Large installed bases, low integration cost, individual maker-author can ship in a weekend |
| Production | Bambu Lab Cloud API, Prusa Cloud API, Formlabs Cloud API, Universal Robots URCap, Opentrons OT-2 (already shipped), OT-Flex, generic Fanuc Focas, generic ROS-2 driver | **$5,000** | 250bp constant first 12 months, your choice after | Mid-volume manufacturing/lab use, vendor-API access required, ~1-2 weeks of focused work |
| Industrial | Hamilton STAR, Tecan EVO, Beckman Coulter Echo, Beckman Biomek, Mazak SmoothAi MTConnect, Haas Connect, Agilent OpenLab CDS, Waters Empower CDS, Thermo Chromeleon CDS, Bruker TopSpin | **$10,000** | 250bp constant first 12 months, your choice after | High-value lab automation, complex integration (proprietary protocols, narrow expert pool, vendor licensing constraints), ~3-6 weeks of focused work |
| Frontier (case-by-case) | Fanuc R-30iB / Kuka iiQKA / ABB RobotWare full integration, semicon equipment (Applied Materials, Lam, ASML), custom one-off bespoke machines, anything requiring physical reverse-engineering of a closed protocol | **up to $25,000** | negotiated | Highly specialized, may require dedicated lab time, sometimes NDA negotiation. **Talk to us before starting** — open an issue at `LamaSu/physical-capability-cloud` with tag `adapter-bounty-frontier` |

The 250bp first-year rate is the standardized **bootstrap rate**. After 12
months you choose your continuation rate (see §7 for templates). The most
common continuations: 100bp flat-forever, 50bp with a 5-year sunset, or
250bp adoption-decayed (rate shrinks as `jobsPerDay` grows).

---

## 4. The 50-priority adapter list

Pulled from
[`ai/research/machine-class-standards.md`](../ai/research/machine-class-standards.md).
"Currently claimed by" defaults to **OPEN** unless otherwise noted.
"Reference docs" links are the primary integration target — most adapters
will need additional vendor docs the integrator sources independently.

### 4.1 3D printing / additive (12)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 1 | OctoPrint (any FDM via firmware) | Hobby | **SHIPPED** (`@pcc/kernel-octoprint`) | https://docs.octoprint.org/en/master/api/ |
| 2 | Moonraker (Klipper) | Hobby | OPEN | https://moonraker.readthedocs.io/en/latest/web_api/ |
| 3 | Klipper-direct (no Moonraker) | Hobby | OPEN | https://www.klipper3d.org/API_Server.html |
| 4 | Bambu Lab MQTT (lan-mode) | Hobby | OPEN | https://github.com/Doridian/OpenBambuAPI |
| 5 | Bambu Lab Cloud API | Production | OPEN | https://github.com/Doridian/OpenBambuAPI |
| 6 | Prusa Cloud API | Production | OPEN | https://connect.prusa3d.com/docs |
| 7 | PrusaLink (local) | Hobby | OPEN | https://github.com/prusa3d/Prusa-Link |
| 8 | Formlabs Cloud API (SLA) | Production | OPEN | https://formlabs.com/dental/dashboard-api/ |
| 9 | Stratasys Insight (FDM industrial) | Industrial | OPEN | Vendor SDK; contact us for intro |
| 10 | EOS EOSPRINT (SLS/DMLS) | Industrial | OPEN | OPC-UA AM (OPC 40540) + EOS API |
| 11 | Markforged Eiger | Production | OPEN | https://eiger.io/api |
| 12 | Carbon CLIP | Industrial | OPEN | Carbon API (vendor licensed) |

### 4.2 CNC / subtractive (8)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 13 | Generic G-code over WebSocket | Hobby | OPEN | grbl, GRBL-Web, CNCjs |
| 14 | Haas Connect (HaasConnect REST) | Production | OPEN | https://www.haascnc.com/HaasConnect.html |
| 15 | Mazak SmoothAi (MTConnect) | Industrial | OPEN | https://www.mtconnect.org + Mazak agent docs |
| 16 | Hurco WinMax | Industrial | OPEN | Hurco WinMax SDK |
| 17 | Tormach PathPilot | Production | OPEN | https://tormach.com/pathpilot |
| 18 | Okuma OSP API | Industrial | OPEN | Okuma OpenAPI (vendor) |
| 19 | DMG MORI Tulip / Celos | Industrial | OPEN | https://en.dmgmori.com/products/digitization/celos |
| 20 | Generic Fanuc Focas | Production | OPEN | Fanuc Focas library + MTConnect Fanuc adapter |

### 4.3 Lab automation / liquid handling (10)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 21 | Opentrons OT-2 (Python protocols + HTTP) | Production | **SHIPPED** | https://docs.opentrons.com/v2/ |
| 22 | Opentrons OT-Flex | Production | OPEN | https://docs.opentrons.com/v2/ |
| 23 | Hamilton STAR (HSL / Venus) | Industrial | OPEN | PyLabRobot Hamilton backend; vendor SDK |
| 24 | Tecan EVO (EvoWare) | Industrial | OPEN | PyLabRobot Tecan backend; Tecan Connect API |
| 25 | Beckman Coulter Biomek | Industrial | OPEN | Allotropy ASM Biomek parser + vendor SDK |
| 26 | Beckman Coulter Echo (acoustic dispenser) | Industrial | OPEN | Allotropy ASM Echo parser + Echo Plate Reformat |
| 27 | Eppendorf epMotion | Production | OPEN | epBlue API |
| 28 | SiLA-2 generic (any SiLA-2 device) | Production | **SHIPPED** (`@pcc/kernel-sila`) | https://sila-standard.com |
| 29 | Cytena C.Sight (single-cell printer) | Industrial | OPEN | Cytena API (vendor licensed) |
| 30 | Sartorius Ambr 250 (bioreactor) | Industrial | OPEN | Ambr API + SiLA-2 |

### 4.4 Robotics / manipulation (6)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 31 | Universal Robots URCap | Production | OPEN | https://www.universal-robots.com/articles/ur/ur-developer/ |
| 32 | ABB RobotWare (Robot Web Services) | Industrial | OPEN | https://developercenter.robotstudio.com/api/RWS |
| 33 | Fanuc R-30iB (Karel + Focas) | Frontier | OPEN | Fanuc Karel + Roboguide |
| 34 | Kuka iiQKA / iiwa | Frontier | OPEN | https://www.kuka.com/en-us/products/robotics-systems/software/digital-and-connected-services/iiqka |
| 35 | Yaskawa MotoLogix / MotoCom | Industrial | OPEN | Yaskawa MotoCom32 SDK |
| 36 | Generic ROS-2 driver | Production | OPEN | https://docs.ros.org/en/jazzy/ + `ros2_control` |

### 4.5 PCB / electronics assembly (4)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 37 | LPKF ProtoMat (PCB milling) | Production | OPEN | LPKF CircuitPro API |
| 38 | Yamaha SMT pick-and-place | Industrial | OPEN | Yamaha SMT Manager + IPC-2581 |
| 39 | Panasonic NPM SMT | Industrial | OPEN | Panasonic NPM-PM API |
| 40 | JUKI SMT (KE/RX series) | Industrial | OPEN | JUKI Smart Solutions API |

### 4.6 Electronics / test (4)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 41 | Keysight benchtop SCPI generic | Production | OPEN | IVI / SCPI / VISA |
| 42 | Rohde & Schwarz SCPI generic | Production | OPEN | IVI / SCPI / VISA |
| 43 | Tektronix SCPI generic | Production | OPEN | IVI / SCPI / VISA |
| 44 | Anritsu MS46xxx VNA | Industrial | OPEN | Anritsu MS46xxx programming manual |

### 4.7 Wet-chemistry & analytical (4)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 45 | Agilent OpenLab CDS | Industrial | OPEN | Allotropy ASM Agilent parser + OpenLab CDS API |
| 46 | Waters Empower CDS | Industrial | OPEN | Allotropy ASM Waters parser + Empower Toolkit |
| 47 | Thermo Chromeleon CDS | Industrial | OPEN | Allotropy ASM Thermo parser + Chromeleon SDK |
| 48 | Bruker TopSpin (NMR) | Industrial | OPEN | TopSpin AU programs + IconNMR |

### 4.8 Soft / orchestration (2)

| # | Target machine | Tier | Currently claimed by | Reference docs |
|---|----------------|------|----------------------|----------------|
| 49 | Generic Modbus-TCP gateway | Hobby | **SCAFFOLD** (`@pcc/kernel-modbus`, scaffolded; full impl OPEN) | Modbus TCP spec |
| 50 | Generic OPC-UA companion-spec gateway | Production | **SHIPPED** (`@pcc/kernel-opcua`) | https://reference.opcfoundation.org |

**3 already-shipped slots (OctoPrint, Opentrons OT-2, OPC-UA, SiLA-2)** are
listed for context — their bounty windows have closed. The Modbus-TCP scaffold
is open: someone needs to take the existing skeleton to a passing test-vector
suite for production use; that's a Hobby-tier bounty.

**Net 47 open bounties, 3 shipped, 1 scaffolded.**

---

## 5. Submission criteria — ready-to-publish bar

A bounty payout requires all of the following.

### 5.1 Adapter package

- Public GitHub (or other public forge) repo, Apache-2.0 licensed.
  License header at the top of every source file.
- TypeScript or another supported `@pcc/kernel` adapter language (TS is
  the canonical path; Rust + Python adapters accepted with a thin TS
  shim that conforms to the kernel adapter interface).
- Implements the kernel adapter interface exported from
  `packages/kernel/src/adapters/` (see existing `octoprint`, `opcua`,
  `sila`, `generic-http`, `mock` adapters for the canonical shape).
- Package name follows `@<your-namespace>/kernel-<machine-type>` or
  `pcc-kernel-<machine-type>` — both are accepted.

### 5.2 Tests

- A `__tests__/` directory with at least 5 must-pass test cases per
  machine type:
  1. **Discovery / handshake** — adapter can detect / connect to the
     target machine (or a fixture / recorded-trace stand-in).
  2. **Health snapshot** — adapter returns a `DeviceStatusDTO` with the
     correct `healthStatus` enum value.
  3. **Job submission** — adapter accepts a job with valid params for
     the relevant `BuiltinCapabilityType` and emits `execution_started`.
  4. **Evidence emission** — adapter emits at least one event per assurance
     tier 0 / 1 (sensor reading, completion event with bundle hash).
  5. **Error path** — adapter handles an invalid-param submission with a
     structured `Result<T>` failure (no thrown exceptions to the kernel).
- A test fixture directory with realistic recorded responses
  (`.json`, `.xml`, `.bin` as appropriate). Real machine traces are
  preferred over fully-synthetic ones.
- `vitest run` (or your runner of choice) green from a clean clone.

### 5.3 Solidity (if any)

- If your adapter introduces any Solidity component (custom escrow, custom
  evidence verifier, etc.) — `forge test` must be green.
- Most adapters do **not** need any Solidity. The base contracts
  (`MilestoneEscrow`, `ContributorNFT`, `RateScheduleRegistry`) are
  shared infrastructure.

### 5.4 README

Must include:

- One-line description of the target machine and what the adapter does.
- Install instructions (`pnpm add @<ns>/kernel-<type>` or equivalent).
- Configure: env vars, adapter config object, what credentials are needed,
  where to obtain them.
- Run a test job: a minimal copy-pasteable command-sequence the operator
  follows to verify the adapter end-to-end.
- Troubleshooting: at least the 3 most common failure modes (connection
  refused, auth failure, unsupported job param) with diagnosis steps.

### 5.5 End-to-end proof

One verifiable demonstration that the adapter actually executed a real job
on a real (or recorded-real) machine:

- A screenshot or short video of a job submitted via PCC using the adapter,
  showing:
  - The job ID
  - The capability type and target machine
  - The resulting evidence bundle hash (sha256)
  - The `execution_completed` event timestamp
- The evidence bundle CID (IPFS / Storacha) so reviewers can independently
  fetch and verify the bundle.

For Frontier-tier bounties, we may waive the live-machine requirement and
accept a recorded-trace replay if obtaining the physical machine for a one-off
demo is impractical. Talk to us first.

---

## 6. How to claim

### 6.1 Pick from the open list

Browse §4 and identify the machine type you want to integrate. Confirm it is
listed as `OPEN` (not `SHIPPED` or `SCAFFOLD`).

### 6.2 Announce your intent

To prevent two people racing on the same adapter, announce your intent
**before** you start writing code:

- **Preferred**: Open a GitHub Discussion at
  `LamaSu/physical-capability-cloud` with title
  `[adapter-bounty] Claiming #<N>: <machine-type>` and a 2-3 sentence
  description of your approach.
- **Alternate**: Post in the PCC Network Discord channel (see §10) tagging
  `@adapter-bounty`. <!-- TODO: confirm exact channel name -->

We will mark the entry in §4 of this doc as `claimed by @<your-handle>`
within 1 business day. If you don't see the entry update within 3 days,
ping us — the table is the authoritative claim register.

The intent-claim is a **soft hold** for 4 weeks. After 4 weeks of no
visible progress (no commits to a public repo, no Discord activity), the
entry returns to `OPEN`. We will email you 1 week before this happens.

### 6.3 Build it

Implement the adapter against the `@pcc/kernel` adapter interface. Read the
existing `octoprint` adapter (`packages/kernel/src/adapters/octoprint/`) as
the reference implementation. The interface is small: `discover()`,
`getHealth()`, `submitJob()`, `streamEvents()`, plus optional
`cancelJob()`. Total surface is under 200 lines of types.

When you have the 5 must-pass tests green from §5.2, you're review-ready.

### 6.4 Open a review issue

At `LamaSu/physical-capability-cloud`, open an issue with:

- **Title**: `[adapter-bounty] Submitting #<N>: <machine-type>`
- **Tag**: `adapter-bounty`
- **Body**: link to your public adapter repo, link to the §6.2 announcement,
  the end-to-end proof from §5.5, and a copy-pasteable runbook for the
  reviewer to verify locally.

### 6.5 Review

PCC core team (currently the `feat/contributor-economics` maintainers)
reviews against the criteria in §5. Review SLA: **<2 weeks** from issue open
to verdict. Verdicts are PASS / WARN / FAIL.

- **PASS**: Goes straight to §6.6.
- **WARN**: Specific issues called out; you have 4 weeks to address. Most
  WARN verdicts are README polish or missing edge-case tests.
- **FAIL**: Substantive technical issues (does not pass criteria in §5,
  evidence emission broken, license non-compliant). You can resubmit
  after fixing — no penalty, no claim loss.

### 6.6 Mint and pay

On PASS:

1. You publish your `RateSchedule` per
   [`docs/CONTRIBUTOR_ECONOMICS.md`](./CONTRIBUTOR_ECONOMICS.md) §"How to use
   it." Use the bootstrap template in §7 below for a 250bp first-year rate.
2. You mint your `ContributorNFT` per
   [`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`](./DEPLOY_CONTRIBUTOR_ECONOMICS.md)
   "Mint a ContributorNFT" — `role=integrator`, scheduleHash from step 1,
   metadataUri pointing to the adapter's NPM page or GitHub release.
   Alternatively, request that PCC ops mint it on your behalf (we will
   mint it, transfer the NFT to your wallet, and email you the txid).
3. PCC funds the flat bounty to the wallet you specify. **7 days from PASS
   to payment.** Payment is in USDC on Base Sepolia (testnet) until mainnet
   contracts are deployed; once mainnet is live (see deferral list in
   `ai/research/contributor-economics/99-resume-here.md`), bounties are
   reissued in USDC on Base mainnet.
4. We add your adapter to the public adapter index at
   `https://capability.network/api/capabilities/templates` (it ships in
   the next gateway release after merge).

### 6.7 Earn

Once your `ContributorNFT` is minted and any operator's job uses your
adapter, the 250bp routes to your wallet on every milestone release via
`MilestoneEscrow.splitPayout()`. Settlement is automatic. No invoice,
no claim form.

---

## 7. RateSchedule template — the standard bootstrap year

A copy-pasteable schedule for the standardized 250bp bootstrap. Publish this
JSON exactly as written via `POST /api/contributors/schedules` and the gateway
will return a `scheduleHash` you reference at NFT mint.

### 7.1 Recommended default — 250bp first year, 100bp forever

```json
{
  "version": 1,
  "segments": [
    { "kind": "constant", "startTime": 0, "endTime": 31557600, "bps": 250 },
    { "kind": "constant", "startTime": 31557600, "endTime": null, "bps": 100 }
  ],
  "notes": "250bp first year (bootstrap), 100bp thereafter. Adjust the second segment to your preference — that's your call."
}
```

The first segment runs from t=0 (the publish moment) for 31,557,600 seconds
(one Julian year) at 250bp. The second segment runs from year-1 to forever
at 100bp.

### 7.2 Aggressive bootstrap with adoption decay

```json
{
  "version": 1,
  "segments": [
    { "kind": "constant", "startTime": 0, "endTime": 15778800, "bps": 250 },
    {
      "kind": "adoption-indexed",
      "startTime": 15778800, "endTime": null,
      "scale": 200, "floorBps": 25, "capBps": 250
    }
  ],
  "notes": "250bp for first 6 months, then adoption-indexed: bps = clamp(200 / sqrt(jobsPerDay), 25, 250). High early, decays as the network gets busy, never below 25bp."
}
```

This is the curve for "I want to be paid more in the early days when there are
few jobs, and let the rate drift down as adoption grows. I keep a 25bp floor
so I always get paid something."

### 7.3 Flat-forever

```json
{
  "version": 1,
  "segments": [
    { "kind": "constant", "startTime": 0, "endTime": null, "bps": 250 }
  ],
  "notes": "250bp forever. Simple, predictable, no surprises for operators or for me."
}
```

For integrators who want maximum predictability and don't want to think
about second-segment design. The trade-off: operators have stronger
incentive to seek out forks (see FAQ §8.7) if your 250bp feels high once
volume grows.

### 7.4 Sunset at 5 years

```json
{
  "version": 1,
  "segments": [
    { "kind": "constant", "startTime": 0, "endTime": 31557600, "bps": 250 },
    { "kind": "linear-decay", "startTime": 31557600, "endTime": 157788000, "startBps": 250, "endBps": 0 },
    { "kind": "constant", "startTime": 157788000, "endTime": null, "bps": 0 }
  ],
  "notes": "250bp first year, linearly decays from 250bp to 0bp over years 1-5, then 0bp forever. The 'I'll maintain this for 5 years and then it should be community infrastructure' curve."
}
```

Choose this if you intend to actively maintain the adapter for ~5 years and
then release it to the commons.

---

## 8. FAQ

### 8.1 What if someone else builds the same adapter?

Forks are legal and expected. The `ContributorNFT` is per-adapter-instance,
not per-machine-type. Two integrators can each have an integrator-role NFT
for the same target machine. Operators choose which adapter to install,
and the 250bp goes to whichever NFT is referenced in the active
`CompositionManifest` for the job (see
[`docs/CONTRIBUTOR_ECONOMICS.md`](./CONTRIBUTOR_ECONOMICS.md) §"How to use
it"). The market sorts: if your adapter is faster, more reliable, or has
better evidence emission, operators pick it; you earn. If a fork is better,
operators migrate; the fork earns.

This is a feature, not a bug. The forcing function is that the best
adapter wins.

### 8.2 Can I assign or sell the NFT?

Yes. `ContributorNFT` is a standard ERC-721. You can transfer or sell it
at any time. **Do this before you take the bounty if you want the bounty
itself paid to a different wallet** — the bounty goes to whoever owns the
token at funding time. After funding, future 250bp royalties go to whoever
owns the token at each milestone release.

If you sell the NFT, the buyer inherits both the future royalty stream and
the (sealed, immutable) `RateSchedule`. They cannot change the rate; they
can mint a v2 with a different schedule and try to migrate operators to it
(see §8.7).

### 8.3 What about IP / patents on the manufacturer's API?

This is your problem, not PCC's. Apache-2.0 requires you to certify you have
the right to license the code under Apache-2.0. If you used vendor-supplied
SDKs, headers, or proprietary protocols:

- If the SDK is itself permissively licensed, link to it as a runtime
  dependency, do not vendor it into your adapter source.
- If the SDK requires a vendor agreement to redistribute, you cannot
  satisfy the Apache-2.0 requirement for the adapter source unless you
  reimplement the wire protocol from public docs / clean-room
  reverse-engineering. Talk to a lawyer.
- If the manufacturer holds patents on the protocol itself, the same
  applies. PCC takes no position on whether your adapter is patent-clean
  — that is your representation under the Apache-2.0 patent grant.

We will not knowingly accept an adapter that obviously infringes a vendor
license or patent. We rely on your representation. If a vendor sends us a
takedown, we will remove the adapter from the registry; the
`ContributorNFT` stays minted (it's immutable) but no future jobs route
through it.

### 8.4 Tax treatment?

US recipients: the bounty is USDC income at fair-market value at receipt.
You are responsible for 1099 reporting on your own. PCC does not withhold,
does not issue 1099s, and does not maintain a payroll relationship with
bounty recipients.

Outside the US: consult a local tax advisor. PCC has no tax presence in
your jurisdiction.

The 250bp royalty stream is also income at receipt of each milestone. Track
it as you would any cryptocurrency-denominated revenue.

### 8.5 What if the manufacturer changes their API?

Your bounty and your `RateSchedule` continue indefinitely — they are
immutable on-chain. But:

- If your adapter breaks against the new API, no operator will route jobs
  through it, so the 250bp stream trends to zero.
- You have two choices: (a) update your adapter (you keep your existing NFT
  and keep earning), or (b) someone forks it, fixes it, mints their own
  NFT, and operators migrate; the fork-author earns going forward.

We don't have an SLA on adapter maintenance. The market does.

### 8.6 Cross-chain?

Currently Base Sepolia (testnet). The path to Base mainnet is documented
in [`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`](./DEPLOY_CONTRIBUTOR_ECONOMICS.md)
"Mainnet deployment" and is gated on external audit. `ContributorNFT` is
per-chain — there is no cross-chain portability in v1. See the deferred
list in
[`ai/research/contributor-economics/99-resume-here.md`](../ai/research/contributor-economics/99-resume-here.md)
for cross-chain ONFT / CCIP work.

For now: bounties are paid in USDC on whichever chain you specify (Base
Sepolia today; Base mainnet once live). The royalty stream lives on the
same chain as the milestone escrow that funded the job.

### 8.7 What happens if my adapter is ranked #2 vs #1?

There is no exclusivity on machine types. Operators select adapters at
job-submission time based on three signals:

- **Reputation** — ERC-8004 score on the integrator's wallet,
  surfaced via `pcc_get_reputation`
- **Cost** — operator-side cost of running the adapter (compute, bandwidth,
  vendor-API fees) plus the adapter's RateSchedule
- **Reliability** — historical success rate of jobs routed through the
  adapter

If you ship a faster, more reliable, or cheaper-to-run adapter than the
existing one, operators will switch. Both NFTs continue to exist; only the
one referenced in each job's `CompositionManifest` earns. There is no
"winner takes all" — operators with existing job mixes may keep using your
adapter for backward-compat reasons even after a faster one ships.

### 8.8 Can I bundle multiple machine types into one adapter?

One `ContributorNFT` is one machine type. If your adapter genuinely covers
3+ machine types (e.g., a generic SCPI adapter that works on Keysight,
R&S, and Tektronix), you can:

- Mint one NFT per machine type with the same schedule, claim 3 separate
  bounties (one per machine type listed in §4), or
- **Talk to us first** — we can structure a bundled bounty (e.g., $4k for
  three SCPI variants packaged in one repo) which is faster to execute on
  both sides. Open an issue tagged `adapter-bounty-bundle`.

### 8.9 What's the timeline?

- **Claim acknowledgement**: 1 business day from §6.2 announcement to entry
  update in §4.
- **Review**: <2 weeks from §6.4 issue open to PASS/WARN/FAIL verdict.
- **Bounty payment**: 7 days from PASS to USDC in your wallet.
- **Royalty accrual**: starts at the next operator job that uses your
  adapter and runs through `MilestoneEscrow.splitPayout()`.

Median end-to-end from claim to first-paid royalty (claim + build + review
+ first job): we expect 3-8 weeks for hobby tier, 4-12 weeks for
production tier, 8-20 weeks for industrial tier.

### 8.10 How do I get help?

- **PCC Network Discord**: https://discord.gg/CRFvvUgeV4 — channels:
  `#announcements`, `#operators`, `#dev`, and (for this program)
  `#adapter-bounty`. <!-- TODO: confirm #adapter-bounty channel exists; if not, create it -->
- **GitHub Issues**: `LamaSu/physical-capability-cloud` with tag
  `adapter-bounty` — best for technical questions about the kernel
  adapter interface.
- **Email**: <TODO: confirm public adapter-bounty contact email>
- **Twitter / X**: <TODO: confirm PCC Network handle>

For frontier-tier integrations involving NDA-gated APIs or custom
hardware, please email before opening a public issue.

---

## 9. About the 250bp lifetime royalty (the part that matters)

A platform-style adapter program would offer rev-share that is revocable,
contractually-mediated, and dependent on the platform's continued operation.
PCC's contributor-economics primitive is structurally different in three
ways that compound:

- **On-chain**: Your `RateSchedule` is published to the `RateScheduleRegistry`
  contract, content-addressed by `sha256(canonicalJSON(schedule))`. Once
  published, the bytes are sealed forever. PCC cannot edit them. PCC cannot
  delete them. The schedule outlives PCC itself if the contract survives.
- **Immutable on your end**: Your `ContributorNFT` seals 5 fields at mint
  (`role`, `scheduleHash`, `ipId`, `metadataUri`, `mintedAt`) with no setter.
  Updating your rate requires minting a new NFT. We cannot "TOS-update" your
  rate. There is no admin key.
- **Routing is content-addressed**: Settlement looks up your schedule by
  hash, evaluates it against the current job context (jobValueCents,
  jobsPerDay, time-elapsed), and pays out via `splitPayout()`. The lookup
  cannot be redirected. The hash is the root of trust.

This is structurally distinct from "platform adapter program with rev-share
and a TOS." Once your `ContributorNFT` is minted with a given `scheduleHash`,
that share is yours forever as long as operators choose your adapter.

For the underlying thesis on why we deliberately do not have an OEM royalty
class — and why the 250bp goes to integrators (the people doing the
integration work) rather than OEMs (the people who built the hardware once,
years ago) — see
[`docs/CONTRIBUTOR_ECONOMICS.md`](./CONTRIBUTOR_ECONOMICS.md) and
[`ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md`](../ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md)
§3.

---

## 10. Footer

- **Discord**: https://discord.gg/CRFvvUgeV4 (PCC Network)
- **GitHub**: https://github.com/LamaSu/physical-capability-cloud
- **Twitter / X**: <TODO: confirm PCC Network handle>
- **Adapter-bounty contact**: open an issue tagged `adapter-bounty` at
  the GitHub repo above, or post in the PCC Network Discord
- **Date**: 2026-04-29

### Cross-references

- [`docs/CONTRIBUTOR_ECONOMICS.md`](./CONTRIBUTOR_ECONOMICS.md) — economic
  primitives (RateSchedule, ContributorNFT, splitPayout, the 10-role enum)
- [`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`](./DEPLOY_CONTRIBUTOR_ECONOMICS.md) — on-chain mint flow
- [`docs/AGENT_INTEGRATION.md`](./AGENT_INTEGRATION.md) §12 — full
  REST + MCP surface for contributor economics (8 endpoints, 7 MCP tools)
- [`ai/research/machine-class-standards.md`](../ai/research/machine-class-standards.md) — the structured-data
  audit that produced the 50-priority list
- [`ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md`](../ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md) — full
  integrator role definition + no-OEM thesis
- [`docs/claros-layer4-amendment.md`](./claros-layer4-amendment.md) — why
  there is no OEM royalty class at the protocol level
