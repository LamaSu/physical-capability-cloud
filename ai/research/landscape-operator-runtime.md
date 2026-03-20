# Landscape Report: Operator Runtime / Device Orchestration

**Date:** 2026-03-20
**Researcher:** wheel-scout agent
**Task:** Evaluate existing solutions before building an operator runtime that connects real physical devices (3D printers, CNC machines, lab equipment) to a cloud orchestration platform with: (1) device registry, (2) kernel config system, (3) job submission API, (4) evidence-to-settlement flow.

---

## Landscape Report: Operator Runtime / Device Orchestration

### Existing Solutions Found

| # | Solution | Solves Problem? | Maintained? | Recommendation |
|---|----------|----------------|-------------|----------------|
| 1 | [OctoFarm](https://github.com/OctoFarm/OctoFarm) — OctoPrint multi-instance manager | Partially (3D printers only, no job routing API, no settlement) | Stalled (v2.0 planned, private repo; last public release 1.7.x, activity thin in 2025) | Skip |
| 2 | [FDM Monster](https://github.com/fdm-monster/fdm-monster) — Node.js 3D printer farm platform | Partially (OctoPrint/Moonraker/PrusaLink/Bambu, SQLite, REST API, no settlement, no multi-protocol) | Yes (active, AGPL-3.0) | Skip |
| 3 | [3DPrinterOS](https://www.3dprinteros.com/) — Cloud 3D printer fleet management | Partially (SaaS only, closed-source, printer-specific, no Modbus/OPC-UA, no on-chain settlement) | Yes (commercial) | Skip |
| 4 | [Repetier Server](https://www.repetier-server.com/) — Browser-based printer manager | Partially (printers only, no job routing API, no settlement) | Yes (commercial) | Skip |
| 5 | [EdgeX Foundry](https://www.edgexfoundry.org/) — Open source IoT edge platform | Partially (device registry + protocol adapters via Device Services, no job-to-evidence-to-settlement pipeline) | Yes (Linux Foundation, v4.0) | Skip |
| 6 | [ThingsBoard](https://github.com/thingsboard/thingsboard) — Open source IoT platform + Gateway | Partially (device registry, Modbus/OPC-UA gateway, dashboards; job scheduler in PE only; no on-chain settlement; Java/Spring stack) | Yes (active) | Skip |
| 7 | [Azure IoT Hub](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-identity-registry) — Cloud device registry + job scheduling | Partially (device identity registry, job scheduling against device twins; proprietary cloud lock-in; no evidence IPFS upload; no EVM settlement) | Yes (Microsoft) | Skip |
| 8 | [Temporal](https://github.com/temporalio/sdk-typescript) — Durable workflow engine with TypeScript SDK | Partially (durable job execution, retry/timeout, state machine; no device registry; no adapter config; no IPFS/settlement plumbing) | Yes (active) | Skip |
| 9 | [smart-industry](https://github.com/jukbot/smart-industry) — Open source MES for job-shop manufacturers | No (no device adapter layer, no protocol support, last active ~2019-2020, unmaintained) | No | Skip |
| 10 | npm ecosystem (orchestration, xstate, flowed, agenda, restate) | No (general-purpose; none provide device registry, physical adapter config, or evidence-to-settlement flow) | Varies | Skip |

---

### Solution Deep-Dives

#### OctoFarm
- Aggregates multiple OctoPrint instances into a single UI. Reads OctoPrint REST/WebSocket APIs.
- No concept of capability routing, job submission API, evidence bundles, or settlement.
- v2.0 has been "planned" on a private repo for 2+ years; public releases stalled at 1.7.x.
- **Gap:** Printer-only, UI-only, no programmable job submission, no settlement layer.

#### FDM Monster
- Node.js backend + SQLite, supports OctoPrint/Moonraker/PrusaLink/Bambu via REST+WebSocket.
- Has a REST API and can batch-distribute files to printer farms.
- AGPL-3.0: any integration in a SaaS product requires open-sourcing the whole product.
- **Gap:** Printers only (no Modbus, no OPC-UA, no lab equipment). No job routing by capability. No evidence collection pipeline. No on-chain settlement. AGPL is incompatible with PCC's architecture as a private commercial project.

#### EdgeX Foundry
- Most architecturally relevant general-purpose candidate. Has: Device Services (adapter plugins per protocol), a Metadata service (device registry), a Scheduler, and Application Services (data export).
- Device Services exist for Modbus and OPC-UA.
- **Gap:** Go/Java microservices stack (not TypeScript). No concept of "capability" as a billable unit. No job-result → IPFS evidence upload. No EVM escrow settlement. Scheduler triggers data reads, not job execution flows. Extremely heavyweight (12+ microservices) for what PCC needs.

#### ThingsBoard
- Java/Spring Boot; strong Modbus, OPC-UA, BACnet gateway. Good device management UI.
- PE edition has a scheduler; CE does not.
- **Gap:** Not TypeScript. No job-to-evidence pipeline. No IPFS. No on-chain settlement. Designed for telemetry/monitoring, not capability execution flows. Would require wrapping in a sidecar to even call into PCC's JobRunner.

#### Azure IoT Hub
- Proprietary. Device twin registry + job scheduling is conceptually the right model.
- **Gap:** Complete Azure cloud lock-in. No physical-adapter config system (assumes devices run Azure IoT SDK). No IPFS evidence storage. No EVM escrow. Monthly cost at scale. Not self-hostable.

#### Temporal
- Closest to solving the durable execution piece (retries, timeouts, state persistence).
- TypeScript SDK is mature.
- **Gap:** Temporal is a workflow engine, not a device platform. It has no device registry, no protocol adapter config, no IPFS evidence upload, and no settlement integration. Adopting it would require building all four missing layers on top of it anyway — plus adding a Temporal server dependency that PCC currently doesn't need given the simpler JobRunner already exists.

---

### What PCC Already Has (Confirmed by Codebase Audit)

The following are confirmed present in the codebase and do NOT need to be built:

| Component | Location | Status |
|-----------|----------|--------|
| Device adapters (OctoPrint, Modbus, OPC-UA, mock-FDM, mock-chromatograph) | `packages/kernel/src/adapters/` | Present |
| JobRunner (adapter.execute → getProgress → getStatus → evidenceEmitter) | `packages/kernel/src/job-runner.ts` | Present |
| SQLite persistence via Drizzle ORM | `packages/db/src/` | Present |
| KernelRepository (findAll, findById, findDevicesByKernel) | `packages/db/src/repositories/kernels.ts` | Present |
| JobRepository (findAll, findByKernel, findByStatus, updateStatus) | `packages/db/src/repositories/jobs.ts` | Present |
| EvidenceBundleRepository | `packages/db/src/repositories/evidence.ts` | Present |
| EscrowRepository + settlement routes (batch ERC-4337) | `packages/db/src/repositories/settlement.ts`, `packages/gateway/src/routes/settlement.ts` | Present |
| IPFS evidence storage (Helia + Storacha) | `packages/kernel/src/evidence-storage*.ts` | Present |
| Fastify gateway with kernel/job/settlement routes | `packages/gateway/src/routes/` | Present |
| Schema: `shop_kernels`, `kernel_devices`, `jobs`, `evidence_bundles` | `packages/db/src/schema/` | Present |

### What Is Confirmed MISSING (the true gaps)

| Gap | Description |
|-----|-------------|
| **Adapter config store** | `kernel_devices` schema has `type` and `model` but NO adapter-specific config (no `adapter_url`, `modbus_host`, `opcua_endpoint`, `octoprint_api_key`). There is no mechanism to persist "this device uses the OctoPrint adapter at http://192.168.1.50" and reconstruct it at runtime. |
| **Kernel config loader** | No code path that reads DB device records and instantiates the correct adapter class (OctoPrintAdapter, ModbusAdapter, OpcuaAdapter) with its stored config. The kernel wires adapters manually in tests and simulations; there is no production config-driven instantiation. |
| **POST /api/jobs (submit)** | `jobs.ts` route file has GET and PATCH but NO POST. There is no REST endpoint that accepts a job, looks up the right kernel/device/adapter, instantiates the JobRunner, and executes it. `job_submit` exists as a telemetry event label but no handler. |
| **Job → adapter routing** | No router that takes a job's `capabilityId`, finds the kernel that has that capability, picks the right device, and wires the right adapter. |
| **Evidence → settlement trigger** | No code path that, upon `JobRunner.run()` completing successfully, (a) uploads the evidence bundle to IPFS, (b) writes the IPFS CID back to the DB, and (c) calls `submitSettlement()` or releases the MilestoneEscrow. The settlement route accepts manual POST calls but is not triggered automatically by job completion. |

---

### Recommended Path

- [ ] ADOPT: None
- [ ] EXTEND: None
- [x] BUILD: All four missing layers must be built within PCC

### Build Justification (required if recommending BUILD)

**No existing solution covers the full stack.**

The problem has five simultaneous constraints that no existing tool satisfies together:

1. **Multi-protocol physical adapter layer** — Only EdgeX comes close, but it is a Go/Java microservices platform. PCC already has TypeScript adapters for OctoPrint, Modbus, OPC-UA, and SiLA2 in `packages/kernel/src/adapters/`. Adopting EdgeX would mean throwing away working code and re-wrapping it in Go Device Services.

2. **TypeScript monorepo integration** — All existing solutions (EdgeX, ThingsBoard, Temporal+sidecar) are separate deployable services. PCC is a pnpm monorepo where the gateway, kernel, db, and contracts packages share types directly. Bridging to a foreign runtime would require a full API contract boundary and lose the type safety that `@pcc/spec` provides.

3. **Evidence-to-IPFS-to-settlement pipeline** — No IoT platform on the market does this. 3D printer managers (OctoFarm, FDM Monster, 3DPrinterOS) have no concept of cryptographic evidence bundles. IoT platforms (EdgeX, ThingsBoard, Azure IoT Hub) are telemetry/monitoring focused — they collect data but do not package it as content-addressed bundles for on-chain dispute resolution. On-chain escrow settlement (MilestoneEscrow + batch ERC-4337) is entirely absent from every solution surveyed.

4. **AGPL risk** — FDM Monster (the only technically viable Node.js candidate) is AGPL-3.0. Integrating it into a private commercial cloud platform would require open-sourcing the entire PCC codebase.

5. **Scope is four discrete, bounded additions to existing code** — The gaps are: (a) two new DB columns on `kernel_devices`, (b) a config loader function in the kernel package, (c) a `POST /api/jobs` route that wires `JobRunner`, and (d) a completion hook that calls `evidenceStorage.store()` then `submitSettlement()`. This is 200–400 lines of glue code in existing packages, not a new system. No external dependency is justified at this scope.

**Decision: BUILD the four missing layers directly in PCC.** Adopt zero new runtime dependencies. Extend the existing `kernel_devices` schema, add a `KernelConfigLoader`, add `POST /api/jobs` to the gateway, and wire a `JobCompletionHandler` that sequences evidence upload → DB write → settlement trigger.

---

## Sources Consulted

- [OctoFarm GitHub](https://github.com/OctoFarm/OctoFarm)
- [FDM Monster GitHub](https://github.com/fdm-monster/fdm-monster)
- [FDM Monster Docs](https://docs.fdm-monster.net/)
- [3DPrinterOS Fleet Management](https://www.3dprinteros.com/3d-printer-fleet-management)
- [EdgeX Foundry Platform](https://www.edgexfoundry.org/software/platform/)
- [EdgeX Foundry Docs v4.0](https://docs.edgexfoundry.org/4.0/)
- [ThingsBoard GitHub](https://github.com/thingsboard/thingsboard)
- [ThingsBoard Gateway (Modbus/OPC-UA)](https://github.com/thingsboard/thingsboard-gateway)
- [Azure IoT Hub Identity Registry](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-identity-registry)
- [Azure IoT Hub Job Scheduling](https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-jobs)
- [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)
- [smart-industry GitHub](https://github.com/jukbot/smart-industry)
- [Repetier Server vs 3DPrinterOS comparison](https://www.3dprinteros.com/3dprinteros-vs-repetier-server)
- [Top IIoT Platforms 2026](https://iiotblog.com/2025/12/12/top-10-iiot-platforms-to-watch-in-2026/)
- [Best Industrial IoT Platforms 2026](https://reliamag.com/guides/best-industrial-iot-platforms-2026/)
