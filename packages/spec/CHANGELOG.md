# Changelog

## [0.2.0](https://github.com/LamaSu/physical-capability-cloud/compare/spec-v0.1.0...spec-v0.2.0) (2026-09-06)


### Features

* 4-level federation Phase 1 — @pcc/dht-core + @pcc/federation + CRDTs (impl-fed) ([#53](https://github.com/LamaSu/physical-capability-cloud/issues/53)) ([60aca58](https://github.com/LamaSu/physical-capability-cloud/commit/60aca5851bbdb523bd006c3b4cadbda0f53430ba))
* **agent-onboarder:** Tier 0+1+2 UI + Wave 3+4 + 233-tool agent-package ([b7aa300](https://github.com/LamaSu/physical-capability-cloud/commit/b7aa300031b5d14fdb9cbefcf3f37a7fe0e0d6d1))
* AGNTCY ADS bridge — source + publisher + OASF catalog + cosign signing (impl-xray) ([#51](https://github.com/LamaSu/physical-capability-cloud/issues/51)) ([8a99b8d](https://github.com/LamaSu/physical-capability-cloud/commit/8a99b8d14ddfefec96c7ec64b802f7e9aa30c398))
* **asset-outbound:** asset-as-agent outbound demand keystone ([#89](https://github.com/LamaSu/physical-capability-cloud/issues/89)) ([02980e5](https://github.com/LamaSu/physical-capability-cloud/commit/02980e5aecb59c031268f4978eb82f6a86cb4ad5))
* **capture-sim:** Genesis-sim rollout evidence channel (split from [#76](https://github.com/LamaSu/physical-capability-cloud/issues/76), surgical revive) ([#79](https://github.com/LamaSu/physical-capability-cloud/issues/79)) ([9bed852](https://github.com/LamaSu/physical-capability-cloud/commit/9bed8521fc48b912cc59064f40700d0c1f683039))
* **capture:** LingBot-Map streaming 3D evidence channel (split from [#76](https://github.com/LamaSu/physical-capability-cloud/issues/76)) ([#80](https://github.com/LamaSu/physical-capability-cloud/issues/80)) ([c0bfe21](https://github.com/LamaSu/physical-capability-cloud/commit/c0bfe217c0fe25d9f08093935abf56ac9ec95309))
* **compose,graph-search:** wire planner to graph-search for multi-step paths ([#95](https://github.com/LamaSu/physical-capability-cloud/issues/95)) ([36ffe40](https://github.com/LamaSu/physical-capability-cloud/commit/36ffe40bd9bf0c5f0837d75fba4d51b0d7388bf7))
* **compose:** composition engine — agentic-composition keystone ([#88](https://github.com/LamaSu/physical-capability-cloud/issues/88)) ([e8a8ae2](https://github.com/LamaSu/physical-capability-cloud/commit/e8a8ae219775620190637fe0895757491c6f5316))
* **contract-builder:** tier-1 manufacturing templates (CNC turning, sheet-metal, injection-molding) + 11 certifications ([#36](https://github.com/LamaSu/physical-capability-cloud/issues/36)) ([83bc50a](https://github.com/LamaSu/physical-capability-cloud/commit/83bc50a3eb9eed74144f4c3273ea9093bf6734a2))
* **contracts:** generic BackendAuthorRegistry — vendor-agnostic refactor of PR [#55](https://github.com/LamaSu/physical-capability-cloud/issues/55) ([#57](https://github.com/LamaSu/physical-capability-cloud/issues/57)) ([9dc24c0](https://github.com/LamaSu/physical-capability-cloud/commit/9dc24c0b04160d3704b62139f19fd423d70cbe06))
* **contracts:** multi-stablecoin MilestoneEscrow ([75c508c](https://github.com/LamaSu/physical-capability-cloud/commit/75c508c43706ea9c6c209fce7112ced08febecbc))
* **contributor-economics:** on-chain ContributorNFT + RateScheduleRegistry + splitPayout + 218-tool agent surface ([#7](https://github.com/LamaSu/physical-capability-cloud/issues/7)) ([fa17c59](https://github.com/LamaSu/physical-capability-cloud/commit/fa17c59d1de3ae52e03d9847cf0c41570a870e05))
* DCC4 TEE + DCC5 zkSNARK verification + Automata TEE-wrap upgrade worker (impl-dcc) ([#50](https://github.com/LamaSu/physical-capability-cloud/issues/50)) ([fb40032](https://github.com/LamaSu/physical-capability-cloud/commit/fb400328fa226f9e8e26d85bb19697a26d857e04))
* **gateway+dashboard:** keyless identity-complete onboarding (4 fixes, coord 01234bff) ([#190](https://github.com/LamaSu/physical-capability-cloud/issues/190)) ([cb15951](https://github.com/LamaSu/physical-capability-cloud/commit/cb159510738851a611e95c0f8480b18db8d10c43))
* **gateway:** A2A v1.0 surface — /a2a/tasks/send adapter + WoT Thing Description ([#33](https://github.com/LamaSu/physical-capability-cloud/issues/33)) ([3ed1c56](https://github.com/LamaSu/physical-capability-cloud/commit/3ed1c5677ec29c3843d2e0f18b1364c91607a067))
* **gateway:** emit matchedCapabilityDigest on every matched decompose node ([146d1b4](https://github.com/LamaSu/physical-capability-cloud/commit/146d1b4906852951a7a84e4fe2a1eee424b09c9d))
* **gateway:** matchedCapabilityDigest — deal-snapshot binding, emitted on every matched decompose node ([ff15a4f](https://github.com/LamaSu/physical-capability-cloud/commit/ff15a4f8e7430f8f6c585445023839348c0ec0c7))
* **gateway:** spec-compliant MCP Apps bridge — lifecycle, fixed templates, hardening ([#260](https://github.com/LamaSu/physical-capability-cloud/issues/260)) ([52d2133](https://github.com/LamaSu/physical-capability-cloud/commit/52d213334dadfdaa14c289f054002906c36f3b96))
* **gateway:** typed host-mediated MCP-App operations (R4 PR2) ([#263](https://github.com/LamaSu/physical-capability-cloud/issues/263)) ([a3e14d8](https://github.com/LamaSu/physical-capability-cloud/commit/a3e14d8190e48338bafa03cb2999b3940b7295c0))
* **graph-search:** capability graph search — Dijkstra over the capability graph ([#92](https://github.com/LamaSu/physical-capability-cloud/issues/92)) ([45f52c3](https://github.com/LamaSu/physical-capability-cloud/commit/45f52c363e9eec46db34c08b3d254768b9c6491c))
* **kernel-sdk:** register [#235](https://github.com/LamaSu/physical-capability-cloud/issues/235) Ed25519 signing proof via POST /api/kernels ([0d5dd3f](https://github.com/LamaSu/physical-capability-cloud/commit/0d5dd3f84986a3d385faccedc8b88ce09c8fcc99))
* **observability:** agent-onboarding observability + pcc_report feedback (DRAFT design + reference impl pieces 1-3) ([#141](https://github.com/LamaSu/physical-capability-cloud/issues/141)) ([f61b3ec](https://github.com/LamaSu/physical-capability-cloud/commit/f61b3ec64fb94ae951bf527de8614d6c4515394e))
* **onramp:** add ui-artifact spec schemas + dashboard-v1 builtin CSD ([ffd6eb9](https://github.com/LamaSu/physical-capability-cloud/commit/ffd6eb96802dcc365a451ce858b4652b4a864f81))
* **onramp:** ui_artifacts registry (On-Ramp Wave 1) ([d4ab910](https://github.com/LamaSu/physical-capability-cloud/commit/d4ab91021b63ad8a82ba91d4b9b57c22cf7e3837))
* **onramp:** Wave 2 — the pcc-ui kit + shell + example manifests ([6b9ec46](https://github.com/LamaSu/physical-capability-cloud/commit/6b9ec466db6a2cde13b09cba023d3c9507bd34cb))
* **reputation:** per-step reputation propagation through compositions ([#91](https://github.com/LamaSu/physical-capability-cloud/issues/91)) ([34abd66](https://github.com/LamaSu/physical-capability-cloud/commit/34abd667ab8b5ff04aa0a6fa601cbcc346c52e10))
* **skills:** human-node skill capabilities for agentic composition ([#90](https://github.com/LamaSu/physical-capability-cloud/issues/90)) ([17548de](https://github.com/LamaSu/physical-capability-cloud/commit/17548dee33b799d30fd380da43bbaa7dc2c34f5c))
* **spec, contract-builder:** liquid-handling-prep capability template (Hamilton) ([af4f499](https://github.com/LamaSu/physical-capability-cloud/commit/af4f499d8b61ed1854856e0ff4631617ced0c527))
* **spec,db:** persist CSD usage attribution to SQLite ([#123](https://github.com/LamaSu/physical-capability-cloud/issues/123)) ([9b1563a](https://github.com/LamaSu/physical-capability-cloud/commit/9b1563af663ed4df654cc46af7f80ec155a5fb0c))
* **spec,gateway:** composition commitment v2 + document.print-and-mail plan/CSD + GET /api/requests/:id/commitment ([98dc809](https://github.com/LamaSu/physical-capability-cloud/commit/98dc809faa21ea488247acb2abf956ccd11e6c2b))
* **spec,gateway:** composition commitment v2 + document.print-and-mail plan/CSD + GET /api/requests/:id/commitment ([f7ef5ed](https://github.com/LamaSu/physical-capability-cloud/commit/f7ef5ed22fb9a91d275cff6edd9ad0b0c1143875))
* **spec,gateway:** Option C — algorithm-tagged registered signing keys (Ed25519-default) ([472b2bc](https://github.com/LamaSu/physical-capability-cloud/commit/472b2bcff4b8519665ec76bc464f7c3ff87eca82))
* **spec,gateway:** pcc-suggest-templates A2A skill + CSD usage attribution ([#118](https://github.com/LamaSu/physical-capability-cloud/issues/118)) ([1fff087](https://github.com/LamaSu/physical-capability-cloud/commit/1fff087ea7cf487d9c0eec6be99e8f425829875a))
* **spec:** add algorithm-tagged RegisteredSigner + fail-closed normalizer (Option C) ([8eea9c2](https://github.com/LamaSu/physical-capability-cloud/commit/8eea9c2961891b7ca7348ff723940321f838a0c5))
* **spec:** add canonical isFabricated evidence predicate (coord [#312](https://github.com/LamaSu/physical-capability-cloud/issues/312)/[#316](https://github.com/LamaSu/physical-capability-cloud/issues/316)) ([8e3b22d](https://github.com/LamaSu/physical-capability-cloud/commit/8e3b22d1e2ff7f8659b74a7b6143eae4fd8c43df))
* **spec:** add evidence primitives [#52](https://github.com/LamaSu/physical-capability-cloud/issues/52)-[#55](https://github.com/LamaSu/physical-capability-cloud/issues/55) (v1.5-industrial) + parity fixtures ([f95e4f9](https://github.com/LamaSu/physical-capability-cloud/commit/f95e4f9d30e0dd188bc6042efec2446135b0f178))
* **spec:** add M1 canonical capability-contract identity resolver ([643d9e7](https://github.com/LamaSu/physical-capability-cloud/commit/643d9e70a159de96518cda01d3d91fe0e51ffc34))
* **spec:** bind print-and-mail CSD evidence to the real event types (courier_pickup_confirmed / courier_delivery_confirmed / printer_job_verified / photo_captured / commitment.labelHash) ([6011f6c](https://github.com/LamaSu/physical-capability-cloud/commit/6011f6cf7edf451a27a83c672701146dde41dfd2))
* **spec:** D2 registry-&gt;contract adapter + composition seam (increment 1) ([97e35af](https://github.com/LamaSu/physical-capability-cloud/commit/97e35af07cc58e5c1b52e00636d12b5a63f1eb4f))
* **spec:** evidence emitter manifest — supply-side evidence declaration ([c60793c](https://github.com/LamaSu/physical-capability-cloud/commit/c60793c0789d7cb1e05bd863a22f801695f2efc9))
* **spec:** evidence-primitive vocabulary v1 foundation ([cb84ed1](https://github.com/LamaSu/physical-capability-cloud/commit/cb84ed1b8aaeced7cec63ae0fcf2afaa3c9c5e53))
* **spec:** evidence-primitive vocabulary v1 foundation ([1c475e9](https://github.com/LamaSu/physical-capability-cloud/commit/1c475e9fef217196b2956877c8bdb1f18fce798e))
* **spec:** implementer-d2-alpha: D1 composition-block seam ABI mirror ([57c9b33](https://github.com/LamaSu/physical-capability-cloud/commit/57c9b33a014cfbcbf4a47316930485f8a5e54ba7))
* **spec:** implementer-d2-alpha: D2 registry-&gt;contract adapter + snapshot digest ([961b3bb](https://github.com/LamaSu/physical-capability-cloud/commit/961b3bb45472a04be1594ce6ec0e7a3a1a56a0a9))
* **spec:** implementer-d2-alpha: wire optional composition block onto CsdSchema ([c447623](https://github.com/LamaSu/physical-capability-cloud/commit/c4476237d9f49deee6eb33111420a5799c56eb01))
* **spec:** inc-3a deriveCompositionRoot byte-exact reference fn (shadow-only; F1+F3 re-audit closed, F2 open) ([a91a915](https://github.com/LamaSu/physical-capability-cloud/commit/a91a9159ede71f322a3021208e8f64367a30002e))
* **spec:** industrial evidence primitives + shared verifier lib ([18a82c0](https://github.com/LamaSu/physical-capability-cloud/commit/18a82c0cb3d59b507874f39e779e2ae86b9ea3c1))
* **spec:** M1 canonical capability-contract identity resolver ([3dd32fb](https://github.com/LamaSu/physical-capability-cloud/commit/3dd32fb790d637d8f7fb2cbb6bba50506e86fe25))
* **spec:** RFC-001 work primitives — 7 types + canonical hashes (rebased) ([#71](https://github.com/LamaSu/physical-capability-cloud/issues/71)) ([7ef63e4](https://github.com/LamaSu/physical-capability-cloud/commit/7ef63e450f57c452b42f7f48109af0a4eb80a882))
* **spec:** seed make-pizza + courier-route + hot-food-prep CSDs for Tuesday demo ([#127](https://github.com/LamaSu/physical-capability-cloud/issues/127)) ([d41e833](https://github.com/LamaSu/physical-capability-cloud/commit/d41e833601a3a0cedba4a00ea8ee1ad5f3a074d3))
* supply-side evidence — devices declare which primitives they emit at onboarding ([51d7677](https://github.com/LamaSu/physical-capability-cloud/commit/51d767760b463c2dcb9fb87bc4ccb7bdf0b7cc7c))
* **tool-catalog:** scaffold tool-catalog registry — adapter/kernel packages independent of live operators ([#85](https://github.com/LamaSu/physical-capability-cloud/issues/85)) ([ea58abc](https://github.com/LamaSu/physical-capability-cloud/commit/ea58abc3a532feda90f01486a4530dba6eb585d4))


### Bug Fixes

* **aggregator:** impl-romeo SSRF guard, UNVETTED default, PatternScanner quarantine (supersedes universal-aggregator) ([#39](https://github.com/LamaSu/physical-capability-cloud/issues/39)) ([085cb82](https://github.com/LamaSu/physical-capability-cloud/commit/085cb825f97e87d5ba65d38943fb3edd5cbddea3))
* **detector:** reject fabricated evidence at ALCOA/settlement/tier gates (coord [#312](https://github.com/LamaSu/physical-capability-cloud/issues/312)/[#316](https://github.com/LamaSu/physical-capability-cloud/issues/316)) ([7cdf9d4](https://github.com/LamaSu/physical-capability-cloud/commit/7cdf9d48e630bc1b442be75b501a2ef6e4061222))
* **gateway:** serve simulated flag + ALCOA authentic leg + reconcile deviceType enum (detector gateway-side) ([5b817d7](https://github.com/LamaSu/physical-capability-cloud/commit/5b817d7ab2e908ea33aa8739f001f84c5f97bd4e))
* **gateway:** settlement_failed session status + safe retry/cancel for stuck commits ([8ed80da](https://github.com/LamaSu/physical-capability-cloud/commit/8ed80da9ac278aec2921c7b37b31af5a8a14ac84))
* **gateway:** settlement_failed session status + safe retry/cancel for stuck commits ([1b164ff](https://github.com/LamaSu/physical-capability-cloud/commit/1b164ff7129c8af01399eb9d0e61a8f8a5075340))
* **kernel-sdk,gateway:** harden [#235](https://github.com/LamaSu/physical-capability-cloud/issues/235) signing identity — 5 findings (2 critical) ([f1cbd25](https://github.com/LamaSu/physical-capability-cloud/commit/f1cbd25288e6d0579f54653d3c373fbe3df0b731))
* **kernel:** adapters fail loud + tag simulated evidence (write-lie + state-lie) ([#238](https://github.com/LamaSu/physical-capability-cloud/issues/238)) ([a8e5057](https://github.com/LamaSu/physical-capability-cloud/commit/a8e50578af89b8576b7735128d37c28f578037c0))
* **onramp:** public artifact reads via apiGate + whole-body key refusal ([2fa2798](https://github.com/LamaSu/physical-capability-cloud/commit/2fa2798ff7e8bc88f92ef9a8d16920855e2b3bc8))
* **spec,gateway:** address sol re-review of on-ramp hardening ([ad551f7](https://github.com/LamaSu/physical-capability-cloud/commit/ad551f74ff2a9b9b854d6038c1545d7371eef279))
* **spec,gateway:** harden on-ramp artifact security (sol pass, this-lane-only) ([59aa547](https://github.com/LamaSu/physical-capability-cloud/commit/59aa5477d54b84f90647c291932f73e526c4ba02))
* **spec,gateway:** harden on-ramp artifact share-boundary (sol pass — credential detection + resource caps) ([444fe40](https://github.com/LamaSu/physical-capability-cloud/commit/444fe40007796e631100f0811e887a0bbd58b73c))
* **spec:** precise blockedOn + free-text type-hint slugification + evidence-vocab v2 CSD alignment ([#318](https://github.com/LamaSu/physical-capability-cloud/issues/318)) ([75e013b](https://github.com/LamaSu/physical-capability-cloud/commit/75e013bffb3d8f5568cf0383ac509b088a0c7c76))
* **spec:** reconcile deviceType zod enum to TS union (canonical isFabricated lives in [#240](https://github.com/LamaSu/physical-capability-cloud/issues/240) @pcc/spec) ([acae402](https://github.com/LamaSu/physical-capability-cloud/commit/acae402d8d6653b42875e7e1486f5474f66efd62))
* **spec:** reconcile event-type zod enum too (same drift bug, caught by the new test) ([7ebe56d](https://github.com/LamaSu/physical-capability-cloud/commit/7ebe56d55f7760d318e1cf2ac369b570a21e2c7a))
* **spec:** reject missing required Option fields in inc-3a compositionRoot derivation ([5e42247](https://github.com/LamaSu/physical-capability-cloud/commit/5e42247b1a7f8e65117aa98d2bd40759fab399be))
* **test:** align isFabricated test with [#240](https://github.com/LamaSu/physical-capability-cloud/issues/240)'s non-null canonical contract ([2e16ce1](https://github.com/LamaSu/physical-capability-cloud/commit/2e16ce149bc25b4221610f328a74e5fbbe125aa3))


### Documentation

* **spec:** fix stale containsApiKey budget-exhaustion comment ([2827715](https://github.com/LamaSu/physical-capability-cloud/commit/282771590fd105eb1fb07e05d783741107f363be))


### Refactor

* **spec:** extract drift + log-chain verifiers into shared @pcc/spec lib ([3d91900](https://github.com/LamaSu/physical-capability-cloud/commit/3d919001929137f794ad21494f90429a16e0eb0e))
