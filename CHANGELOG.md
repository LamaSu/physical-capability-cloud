# Changelog

All notable changes to **Physical Capability Cloud (PCC)** are documented here.

PCC is an open cloud control plane for physical manufacturing capabilities — "AWS for the physical world." Shop Kernels are Availability Zones. Capabilities are the billable unit (not machines — what machines *can do*). Settlement flows through milestone escrow on-chain. Verification is sovereign: IPFS-pinned evidence, Lit Protocol encrypted bundles, Bittensor-validated quality, W3C DIDs, and ZK Merkle proofs.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## 1.0.0 (2026-10-10)


### Features

* **adapter-pylabrobot:** quiesceEvidence() covers the run and every call in flight ([bf43140](https://github.com/LamaSu/physical-capability-cloud/commit/bf4314047f05ec4b64773dd814e944de80cb3892))
* **adk:** the operator runbook and starter kit, first cut (ADK item 5; R1, R2, R7) ([e33b49e](https://github.com/LamaSu/physical-capability-cloud/commit/e33b49ed2de699d6b12522647c57376ebfed2a88))
* **contracts:** read every unit's funded config back from a V-next escrow, provably ([c512096](https://github.com/LamaSu/physical-capability-cloud/commit/c512096ec5a09b4c05170df30050c00fb3d13df7))
* **contracts:** read every unit's funded config back from a V-next escrow, provably ([5c7a025](https://github.com/LamaSu/physical-capability-cloud/commit/5c7a025080ed49d7cc51bce11259689d3ace01bb))
* **contracts:** readMilestoneRecipients reads who a V2/V3 milestone will actually pay (N102) ([a15d698](https://github.com/LamaSu/physical-capability-cloud/commit/a15d6985e8d8a188269c450a7bbbb5cfd9b9670e))
* **contracts:** readMilestoneRecipients reads who a V2/V3 milestone will actually pay, at one pinned block (N102) ([8731dd9](https://github.com/LamaSu/physical-capability-cloud/commit/8731dd9bc2bf9f5556f5bf304c6b15e4379e3485))
* **evidence:** delegation-scope and event-time rules at settlement, one rule with the oracle ([8d1463c](https://github.com/LamaSu/physical-capability-cloud/commit/8d1463c15b744399e9411e09d8dba1f2adf74523))
* **evidence:** LO-EV-9 bind device evidence to the accepted job and kernel before settlement ([6f7877c](https://github.com/LamaSu/physical-capability-cloud/commit/6f7877c74edf22a6a27389c3c73cc89aa23bad02))
* **gateway:** accept seam for externally authored plans + end-to-end trace (R9 pure part) ([df359fb](https://github.com/LamaSu/physical-capability-cloud/commit/df359fb5e3e1d00f8724aef9721b484cf91fe3c3))
* **gateway:** attempt reports on /api/feedback (ADK track item 3) ([a5b3113](https://github.com/LamaSu/physical-capability-cloud/commit/a5b31135275c1eaf82d826501f09fab50f182612))
* **gateway:** implementer-golf: production D1 (operator) EIP-712 verifier for the FinalMilestonePackageV2 mint guard ([f9ef00e](https://github.com/LamaSu/physical-capability-cloud/commit/f9ef00e979b5d2c8114f379b7900c12ba043b8b9))
* **gateway:** live provider re-read for externally authored plans (R10) ([26cc0a9](https://github.com/LamaSu/physical-capability-cloud/commit/26cc0a90b266f1ded399096a170822a819833a7e))
* **gateway:** operator-onboarding funnel stages (ADK track item 4) ([55ca54a](https://github.com/LamaSu/physical-capability-cloud/commit/55ca54a6561f79695b94a0647bfd878b718bced5))
* **gateway:** OperatorWorkDTO and OperatorIncomeDTO read models for the operator inbox ([29c389b](https://github.com/LamaSu/physical-capability-cloud/commit/29c389bc5dc78f1244db8a0f4f343ab44aed951e))
* **gateway:** plan edits become constraints for the caller's agent, never mutations (product item 10) ([e32f456](https://github.com/LamaSu/physical-capability-cloud/commit/e32f456ffb9030583959b0fb4d71fa58081d0461))
* **gateway:** PlanPresentation preview completeness, evidence strength, expiry, honest unknowns (product item 6) ([d7ffcf7](https://github.com/LamaSu/physical-capability-cloud/commit/d7ffcf7e8e3ba42978d2010555d5fc1da03c7088))
* **gateway:** PlanPresentation read model for caller-authored plans (product section 5) ([2e95389](https://github.com/LamaSu/physical-capability-cloud/commit/2e95389986dd22d0851fe3484dbb5417b146e66e))
* **gateway:** port the FinalMilestonePackageV2 producer and fix its signature domain (item 8, not yet wired) ([52239f4](https://github.com/LamaSu/physical-capability-cloud/commit/52239f42b731ec35d47175e03f918be22f57fa22))
* **gateway:** R9 agent-plan routes — validate (live R10) and accept (seam → VCR deal binding → one R13 consume); money-path gated, 503 until wired ([ff71067](https://github.com/LamaSu/physical-capability-cloud/commit/ff71067bee8a1884224b6b9289a15cb346b5e682))
* **gateway:** SDK and wizard adapter templates carry quiesceEvidence(), and so do the test adapters ([781d398](https://github.com/LamaSu/physical-capability-cloud/commit/781d39876d71d3480c2565c7311517778c077845))
* **gateway:** server-side unmet-demand capture, flag default OFF (R44 D2, stacked on [#365](https://github.com/LamaSu/physical-capability-cloud/issues/365)) ([7b83f71](https://github.com/LamaSu/physical-capability-cloud/commit/7b83f717653b6f660339a78662c1cbb50c64f493))
* **gateway:** the production D1 (operator) EIP-712 verifier for the FinalMilestonePackageV2 mint guard (stacked on [#358](https://github.com/LamaSu/physical-capability-cloud/issues/358)) ([1f32094](https://github.com/LamaSu/physical-capability-cloud/commit/1f32094a430cee38248f56110ebe37e1cbc16bf9))
* **genui-b:** closed render IR + promotion - modern-port of [#272](https://github.com/LamaSu/physical-capability-cloud/issues/272) and the 6 orphaned promotion commits ([7597978](https://github.com/LamaSu/physical-capability-cloud/commit/7597978b96edf1e9135a18da977e0520d3a345c3))
* **genui-b:** derived render-state provenance - source-assigned class, freshness, no regression (PX-4; depends on [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344)) ([455e610](https://github.com/LamaSu/physical-capability-cloud/commit/455e610a071763d9f89a2b04c8fd0c2a0e234125))
* **genui-b:** list window disclosure: filters, offset, page and cap (N110) ([44e3bc3](https://github.com/LamaSu/physical-capability-cloud/commit/44e3bc373adeb3e02cf2dd3105837cb2e30aa33f))
* **genui:** declare the jobs total in the IR list window, and pin the N110 null case ([7d0c27c](https://github.com/LamaSu/physical-capability-cloud/commit/7d0c27caedced38905189f113fbe7a288b520095))
* **genui:** declare the jobs total in the IR list window, and pin the N110 null case ([7f089cb](https://github.com/LamaSu/physical-capability-cloud/commit/7f089cbbd8134a462bbb5ad644177c49081d75c5))
* **hosted-agent:** PCC's own hosted agent, P1 (ADK item 14): acts as the user, hard spend stop, confirmed writes ([7904446](https://github.com/LamaSu/physical-capability-cloud/commit/7904446a85cd4579d9958daca0e11b75395a1afe))
* **kernel:** every kernel adapter has an honest quiesceEvidence() ([af52d70](https://github.com/LamaSu/physical-capability-cloud/commit/af52d7096e2b7ed703138dfea4b00b126783bf56))
* **kernel:** LO-SE-1 pull-based camera capture. The kernel acquires every frame itself, for a named job; push-fed capture is simulated-only ([a5e5ff1](https://github.com/LamaSu/physical-capability-cloud/commit/a5e5ff1dbb366257bd9d0df392db43cffddb3b47))
* **onboard-kit:** templates, quick-start and generated adapters carry quiesceEvidence() ([4c69833](https://github.com/LamaSu/physical-capability-cloud/commit/4c6983342ff3d5058f6e5cfc5c1e778842985d63))
* **pcc-node:** the operating agent's device runtime and job port (ADK item 12, first cut) ([15161b6](https://github.com/LamaSu/physical-capability-cloud/commit/15161b6a4fa330dddd7f1022956dc4a6603bb432))
* PX-12 EconomicAgreementView, who gets paid what, when and why (server preview; retire fabricated IP pages) ([3956fce](https://github.com/LamaSu/physical-capability-cloud/commit/3956fced5a98e137109b9317dc4cd414f8c4b270))
* **readmodels:** ProductHomeDTO, GET /api/product/home (PX-7) ([0613b2f](https://github.com/LamaSu/physical-capability-cloud/commit/0613b2f8319231112f24fb328af444bfd35fb102))
* **spec:** ADK R8 safety envelope: draft from intake and cited references, confirm once, compile to typed I/O and a strict runtime envelope ([e5f5de1](https://github.com/LamaSu/physical-capability-cloud/commit/e5f5de1bcce6938fc6f8f4cc46e9141a06f55c9c))
* **spec:** Capability Kit manifest identity, OperatorBindingDTO and OpportunityDTO v0 contracts (interface-only; not before wave D) ([ae69fa6](https://github.com/LamaSu/physical-capability-cloud/commit/ae69fa6fc7ebca844aaaffa259c32dc82e783535))
* **spec:** economic agreements v1, an exact compiler to V-next per-unit payouts ([0972247](https://github.com/LamaSu/physical-capability-cloud/commit/09722478f68404d9cf35f7423fdd0886ed74dbb5))
* **spec:** evidence levels -- submitted / device_reported / inspected_output (must-close 5) ([37adc7b](https://github.com/LamaSu/physical-capability-cloud/commit/37adc7bf24fb0e9d3b027e1a92ca7ae602a303d9))
* **spec:** kit royalties, slice 1: licenseHash, the lineage split, and an exact computeKitSplit (R4) ([a4e7847](https://github.com/LamaSu/physical-capability-cloud/commit/a4e78476368b03049630f93350737c995f8f84e1))
* **spec:** onboarding intake schema and research prompt library (ADK item 6 / R2 / R5) ([9a4011a](https://github.com/LamaSu/physical-capability-cloud/commit/9a4011a76c39dec77f2c4e45a25e022af347d3b6))
* **spec:** pin FinalMilestonePackageV2 principal ids (pcc.evidence.principal-id.v1) ([afcb6a8](https://github.com/LamaSu/physical-capability-cloud/commit/afcb6a83d9a49ca08aff3d99f13e8e34dc4b92cd))
* **spec:** port [#336](https://github.com/LamaSu/physical-capability-cloud/issues/336)'s plain-data boundary, load-time intrinsics and canonicalize (verbatim from 8dc6ef2b) ([9214733](https://github.com/LamaSu/physical-capability-cloud/commit/921473367b3eaa869d27796d44c73dc38bfd6b80))
* **spec:** R8 round 4, part 1: the deadline needs no command parameter, and list-valued parameters declare allowedItems ([5954703](https://github.com/LamaSu/physical-capability-cloud/commit/595470313077c0290480d91b45b371696ea9da23))
* **spec:** the public acceptedPolicyDigest producer (subjectBlockHash, bindingsRoot, digest; goldens from [#270](https://github.com/LamaSu/physical-capability-cloud/issues/270)) ([4a371a9](https://github.com/LamaSu/physical-capability-cloud/commit/4a371a9299e67dd2355bb73e1f79ce8df447ae35))


### Bug Fixes

* **adapter-pylabrobot:** a failed barrier holds the adapter until a retried barrier answers, and only job-bound notifications are evidence ([20a4972](https://github.com/LamaSu/physical-capability-cloud/commit/20a4972f82234aaac130b540846e6153179653c3))
* **adapter-pylabrobot:** a failed evidence barrier fails the run and stops the sidecar before start returns ([a10bf94](https://github.com/LamaSu/physical-capability-cloud/commit/a10bf949b33a9f4b84275f9f0c2ecac4842205c6))
* **adapter-pylabrobot:** a sidecar crash is evidence only of the job recording, and a recycle's own stop is none ([d6f93cc](https://github.com/LamaSu/physical-capability-cloud/commit/d6f93ccaec3b52aab3c34a9d00decd17656002e0))
* **adapter-pylabrobot:** evidence.stopRecording is a notification barrier, and a late job-bound notification is dropped ([61e8eb9](https://github.com/LamaSu/physical-capability-cloud/commit/61e8eb9e8c5c1a6b64eba738f3ef2df7cdd2b014))
* **adapter-pylabrobot:** recording windows are attested by the sidecar process that holds them, and nothing runs or completes without that proof ([a3d8437](https://github.com/LamaSu/physical-capability-cloud/commit/a3d84374d5639092bf52f53e0868700e78006b30))
* **adk:** every runbook summary says it ends with the stop drilled and the test job waiting (verdict 115e) ([8333cac](https://github.com/LamaSu/physical-capability-cloud/commit/8333cac739dea842a85b13b552b1df27aedda84a))
* **adk:** the runbook reads the stop before anything runs, and the gateway cannot run its test job (verdict 115d) ([487ab59](https://github.com/LamaSu/physical-capability-cloud/commit/487ab5975ca0d1c92df867bf5269e3a2db4766a6))
* **adk:** the runbook submits no test job until the gateway can queue one without running it (verdict 115e) ([685c838](https://github.com/LamaSu/physical-capability-cloud/commit/685c838b474a22ecd39f0afe91ad2484f1b3cb92))
* **adk:** the session roll-up says the attempt ends blocked on the current gateway (verdict 115e) ([9d4653b](https://github.com/LamaSu/physical-capability-cloud/commit/9d4653bccec1e45d273297e02cbb31ecef6d896d))
* **agent-pack:** an offer's status is a claim, the report schema is contract v1, and claims are bound to the running gateway (verdict 102g) ([bf315c3](https://github.com/LamaSu/physical-capability-cloud/commit/bf315c3797f761fded38ca5feefdf449eb714375))
* **agent-pack:** an offer's verified flag is not outcome proof, consent may be null, and the bindings close their gaps (verdict 102h) ([4ca28ea](https://github.com/LamaSu/physical-capability-cloud/commit/4ca28ea2be1b29378c009abac90a3dba90058089))
* **agent-pack:** only true statements, attempt reporting, [#427](https://github.com/LamaSu/physical-capability-cloud/issues/427) folded in, the operator's thesis (ADK item 2: N75, N76, rehearsal R0, contract v1) ([7a46271](https://github.com/LamaSu/physical-capability-cloud/commit/7a4627175d7940056a76f964cab50d34c75e1e9f))
* **agent-runtime:** chat history refuses a tool block in the wrong role ([#456](https://github.com/LamaSu/physical-capability-cloud/issues/456) review round 2, Q5-1) ([73dd3a9](https://github.com/LamaSu/physical-capability-cloud/commit/73dd3a97b2c63b6c422787175ab2597b72e57520))
* **ci:** the required secret check covers the head commit's content only; PR text is an informational check, and merges carry no PR metadata (N44 r7) ([b9302b7](https://github.com/LamaSu/physical-capability-cloud/commit/b9302b75c6717794b68eff51c259e5dd6cae3127))
* **ci:** the secret scan's verdicts are check runs on the PR head, posted by a dedicated App from a master-only environment (N44 r6) ([77467d2](https://github.com/LamaSu/physical-capability-cloud/commit/77467d27739736439bef6d11f7d10215676f88dd))
* **contracts:** close the non-blocking follow-ups from the [#536](https://github.com/LamaSu/physical-capability-cloud/issues/536), [#479](https://github.com/LamaSu/physical-capability-cloud/issues/479) and [#477](https://github.com/LamaSu/physical-capability-cloud/issues/477) reviews ([6f4fbd8](https://github.com/LamaSu/physical-capability-cloud/commit/6f4fbd82f07d2d55aadd5f4ea4af101f5ee6f100))
* **contracts:** close the non-blocking follow-ups from the [#536](https://github.com/LamaSu/physical-capability-cloud/issues/536), [#479](https://github.com/LamaSu/physical-capability-cloud/issues/479) and [#477](https://github.com/LamaSu/physical-capability-cloud/issues/477) reviews ([7002e9b](https://github.com/LamaSu/physical-capability-cloud/commit/7002e9b9e3d9a72ffd776126aeed987c6e122a50))
* **contracts:** readMilestoneRecipients reports the milestone's actual outcome, not only the ordinary release (N102 round 2) ([f36e5e4](https://github.com/LamaSu/physical-capability-cloud/commit/f36e5e40a9bc596a4782f742ea379c57f190ffbc))
* **contracts:** verify() re-derives the factory's CREATE2 address from this build (N38, LO-ES-2) ([68a56e6](https://github.com/LamaSu/physical-capability-cloud/commit/68a56e66e06aec5adc39004e8f157d6f1d74b84b))
* **contracts:** verify() re-derives the factory's CREATE2 address from this build (N38, LO-ES-2) ([08f24f1](https://github.com/LamaSu/physical-capability-cloud/commit/08f24f12ef5686c0395a453e1a9aee4f764edcf0))
* **contracts:** verify() requires same-band cohorts and states exactly what it proves (N38 follow-ups to [#554](https://github.com/LamaSu/physical-capability-cloud/issues/554)) ([80432f5](https://github.com/LamaSu/physical-capability-cloud/commit/80432f5d261842e4257fac398cde7bcae035aef0))
* **contracts:** verify() requires same-band cohorts, reads its label through an accessor, and says exactly what it proves (N38 follow-ups) ([bd45fd9](https://github.com/LamaSu/physical-capability-cloud/commit/bd45fd942b1ea1d37797cb3195177c010fd0c6e4))
* **dashboard:** /discover, /leaderboard and /kernels no longer crash on a cold load (React [#310](https://github.com/LamaSu/physical-capability-cloud/issues/310)) ([ad42b2c](https://github.com/LamaSu/physical-capability-cloud/commit/ad42b2ca823ae479de32f1374ea68094c76d226d))
* **dashboard:** N50 — /setup and /setup/agent never send the API key to localhost:3200 ([a43ecb0](https://github.com/LamaSu/physical-capability-cloud/commit/a43ecb061ebff466c682716f12941f5da08cd18a))
* **dashboard:** the key lint binds a class field to its own class, and lets a constructor's name be read but never written (astra A03i, two MEDIUM) ([42394d1](https://github.com/LamaSu/physical-capability-cloud/commit/42394d1d67d2da2dde729de16eb38c4d11ece5b5))
* **dashboard:** the key lint reads x["y"] as x.y, refuses reads that hand back a protected object, and checks every change's target (astra A03g) ([57bdc18](https://github.com/LamaSu/physical-capability-cloud/commit/57bdc18cf48a6e83f115a8f401da4133fe370b5f))
* **dashboard:** the key lint rejects aliasing a protected object instead of chasing aliases (astra A03f F1, the whole family) ([426eb4b](https://github.com/LamaSu/physical-capability-cloud/commit/426eb4b72ae8c4d2fc66136ca7488506df7ddc29))
* **dashboard:** the key lint's mutation-target check follows every binding form, and a constructor's name by either access (astra A03h, two MEDIUM) ([234133b](https://github.com/LamaSu/physical-capability-cloud/commit/234133bcc8b2e7db489194fd0e5ed9650738bd4a))
* **docker:** install @pcc/hosted-agent's dependencies before the image build ([3f7011b](https://github.com/LamaSu/physical-capability-cloud/commit/3f7011b32e53142a6c41b542e18766f0cb5e980c))
* **docker:** install @pcc/hosted-agent's dependencies before the image build ([bf456f2](https://github.com/LamaSu/physical-capability-cloud/commit/bf456f2887e988760f277c41fdb0a6252aa704ca))
* **gateway,payments:** bounty surfaces stop presenting unfunded or unverified state (kits K0 slice 1) ([26848e0](https://github.com/LamaSu/physical-capability-cloud/commit/26848e0620c2b4913c41a17be94ecae858edfd06))
* **gateway:** [#440](https://github.com/LamaSu/physical-capability-cloud/issues/440) review follow-up: v2 digest tier and location handling (N20) ([6ef4b34](https://github.com/LamaSu/physical-capability-cloud/commit/6ef4b3407db08eb86d652a6831dd294e86771daf))
* **gateway:** a batch shows each caller only the parts of jobs it may read, as sent; claim release is gated (F3 r5) ([04cdf72](https://github.com/LamaSu/physical-capability-cloud/commit/04cdf72d8af11f99cf0a51b90cf4e4506f11121c))
* **gateway:** a block list N133 can't read never reads as nobody blocked ([7522ee6](https://github.com/LamaSu/physical-capability-cloud/commit/7522ee6e8c74283f8eacf79959bc2e0094bdd8be))
* **gateway:** a block list N133 cannot read never reads as nobody blocked (N133 follow-up, LOW-2) ([f6301ad](https://github.com/LamaSu/physical-capability-cloud/commit/f6301ad012879f204a26bdd2407821354fbfeb2e))
* **gateway:** a busy refusal is not a device failure ([#5205](https://github.com/LamaSu/physical-capability-cloud/issues/5205)) ([f806a34](https://github.com/LamaSu/physical-capability-cloud/commit/f806a3411eb0ce737de4fb06136a1b409bff7926))
* **gateway:** a CORS wildcard response is the server-side IR projection, never the raw body (astra [#562](https://github.com/LamaSu/physical-capability-cloud/issues/562) r1 F1) ([331688e](https://github.com/LamaSu/physical-capability-cloud/commit/331688e89601cc1dcf7a0c8e6927622627502240))
* **gateway:** a failed load of the governance rows refuses scoped keys instead of skipping the rows ([614770f](https://github.com/LamaSu/physical-capability-cloud/commit/614770f0f4f258782f17fb2777bb5f2fdd86f921))
* **gateway:** a MintablePackage exists only via assertMintablePackage, and a challenge mints once (E9b CRITICAL + HIGH) ([5b2be32](https://github.com/LamaSu/physical-capability-cloud/commit/5b2be32789a2adfdfdd3b2eb4f409ffa1b295240))
* **gateway:** a paid job is finished only by its settlement path (N85a) ([a9a05ac](https://github.com/LamaSu/physical-capability-cloud/commit/a9a05ac32d97950d5dc55c98d909ebb146ddb7c1))
* **gateway:** a price headline is accepted only when the v1 digest writes exactly its value ([#439](https://github.com/LamaSu/physical-capability-cloud/issues/439) follow-up, astra 130) ([b02d197](https://github.com/LamaSu/physical-capability-cloud/commit/b02d197eb833910b369c8d6b5fe4d2917aede8d7))
* **gateway:** a pricing rule that breaks the PricingRule contract is refused (N98 round 3) ([fc0502f](https://github.com/LamaSu/physical-capability-cloud/commit/fc0502f1f8e0b6b33e4c446c72dcecd9e192cbbb))
* **gateway:** a pricing rule's timeWindow must be the ScheduleWindow contract (N98 round 3) ([b7f5468](https://github.com/LamaSu/physical-capability-cloud/commit/b7f546894db0025ded9aaceebce564fa971d4dfa))
* **gateway:** a security fingerprint is a closed schema, and no monitor log or payment row keeps a caller's value (N107 r2) ([b8a3b5c](https://github.com/LamaSu/physical-capability-cloud/commit/b8a3b5c04769d440e32033c0a833fdccb5f9b23f))
* **gateway:** a TMP task is durable and write-once on the gateway's volume; creation refuses pipelines that can't enforce a tier (E11f HIGH 1, MEDIUM 5) ([98aec09](https://github.com/LamaSu/physical-capability-cloud/commit/98aec098021fd129869b57b779af67ed1b9090c9))
* **gateway:** a word outside the milestone's own vocabulary decides no funding (PX-7, [#389](https://github.com/LamaSu/physical-capability-cloud/issues/389) follow-up) ([6a0ec53](https://github.com/LamaSu/physical-capability-cloud/commit/6a0ec534923ecd9cd3e8bbb103c4d4cea94f84aa))
* **gateway:** a word outside the milestone's own vocabulary decides no funding (PX-7, [#389](https://github.com/LamaSu/physical-capability-cloud/issues/389) follow-up) ([9980d85](https://github.com/LamaSu/physical-capability-cloud/commit/9980d85bb99fff1f8c03f0e2b783ee596b37b968))
* **gateway:** an anonymous caller can no longer create a capability (N43) ([f9ab866](https://github.com/LamaSu/physical-capability-cloud/commit/f9ab866ef032f1515690ba0849a332b2f0c3d440))
* **gateway:** an anonymous caller can no longer create a capability (N43) ([ec5337c](https://github.com/LamaSu/physical-capability-cloud/commit/ec5337cddd0e6c4ae45e754e41283ab91043d2ee))
* **gateway:** an execution lease: a relayed call runs only after a synchronous start (N4b-gw r7, F3) ([28aa275](https://github.com/LamaSu/physical-capability-cloud/commit/28aa2759f86083f2f75719de891aa29ac534aa3c))
* **gateway:** an explicit null capabilityType is refused, not stored (N32, [#513](https://github.com/LamaSu/physical-capability-cloud/issues/513) r1 M3) ([df2cd6c](https://github.com/LamaSu/physical-capability-cloud/commit/df2cd6cd2f607891b84aaa7c08f004d17adb01de))
* **gateway:** an IPP adapter with no simulated marker counts as simulated, since it serves mock answers while its import is pending (N59 r5) ([b98c5d4](https://github.com/LamaSu/physical-capability-cloud/commit/b98c5d49d7faee4243815337336677d055493b03))
* **gateway:** attempt-analysis follow-ups: digest grammar, provenance weighting, gate test ([#467](https://github.com/LamaSu/physical-capability-cloud/issues/467)) ([b512dcf](https://github.com/LamaSu/physical-capability-cloud/commit/b512dcf78b8250110e8c34a4b836026f454be2f1))
* **gateway:** batch-tied records belong to what the live batch holds, and batch writes need the right identity (F3, review r5 of [#403](https://github.com/LamaSu/physical-capability-cloud/issues/403)) ([43ec901](https://github.com/LamaSu/physical-capability-cloud/commit/43ec901a623f2366d6fea753fb4817c03979c302))
* **gateway:** bound outstanding DNS resolutions in the N84 outbound guard (astra pack 144 MEDIUM) ([e49ac13](https://github.com/LamaSu/physical-capability-cloud/commit/e49ac13c9f7dc7dac0380c31f590bf59a080a857))
* **gateway:** close astra gp1 findings on [#594](https://github.com/LamaSu/physical-capability-cloud/issues/594) ([61ac73d](https://github.com/LamaSu/physical-capability-cloud/commit/61ac73dc39bf4e67c7f33c436d0d1063b5ed4390))
* **gateway:** close four matchableTerms gaps from astra's [#439](https://github.com/LamaSu/physical-capability-cloud/issues/439) review ([#439](https://github.com/LamaSu/physical-capability-cloud/issues/439) follow-up) ([49a6c5f](https://github.com/LamaSu/physical-capability-cloud/commit/49a6c5fff0a12467ed530b151da1cdb7ae82cc3f))
* **gateway:** credential-less CORS read access for the governed GenUI view's IR routes (row 37, item 109(b)) ([aa14727](https://github.com/LamaSu/physical-capability-cloud/commit/aa147274d02d7a31534b336f01913018bfe512a8))
* **gateway:** credential-less CORS read access for the governed GenUI view's IR routes (row 37, item 109(b)) ([96b4cf6](https://github.com/LamaSu/physical-capability-cloud/commit/96b4cf678ba407f301f67ad81285d157f9f36e52))
* **gateway:** disable POST /api/pgtr/relay (501) until target and calldata are signature-bound ([a57ca6e](https://github.com/LamaSu/physical-capability-cloud/commit/a57ca6e1011afaa85d2c3ff98580eecb2b990efd))
* **gateway:** disable POST /api/pgtr/relay (501) until target and calldata are signature-bound ([e20bd23](https://github.com/LamaSu/physical-capability-cloud/commit/e20bd23958ef5e286a11fd14ba97daf6e9ce108a))
* **gateway:** each source of a record is resolved on its own, so a batch-level source keeps the whole batch's owners (F3, review r6 of [#403](https://github.com/LamaSu/physical-capability-cloud/issues/403)) ([ef4bac3](https://github.com/LamaSu/physical-capability-cloud/commit/ef4bac33ab4a1ab95678adb8d9e6bfb8192a5a88))
* **gateway:** exact quote money, USDC only, validated pricing rules (N98 round 2) ([51a74a5](https://github.com/LamaSu/physical-capability-cloud/commit/51a74a5c99037443599239498fac88a544b9a00e))
* **gateway:** fixer-xray: close F1's D1 half fail-closed via an injected verifier ([39f958f](https://github.com/LamaSu/physical-capability-cloud/commit/39f958f28b870e85cae5e6cc79f94fc27811b077))
* **gateway:** fixer-zulu: close three evidence-lane seam gaps in the [#358](https://github.com/LamaSu/physical-capability-cloud/issues/358) mint guard (round 3) ([425c0d3](https://github.com/LamaSu/physical-capability-cloud/commit/425c0d39228a204ea598523c520f6ab2a5081746))
* **gateway:** GET /api/jobs bounds and coerces offset and limit, so a page never exceeds its limit (N111) ([9ca75b4](https://github.com/LamaSu/physical-capability-cloud/commit/9ca75b40d54256bbdfabbc0c325bef7a53e4096d))
* **gateway:** GET /api/jobs bounds and coerces offset and limit, so a page never exceeds its limit (N111) ([a0f9ddf](https://github.com/LamaSu/physical-capability-cloud/commit/a0f9ddf95a1e415058808e054deb81179af627b0))
* **gateway:** handle a current verdict on its own, so the gateway type-checks again ([#434](https://github.com/LamaSu/physical-capability-cloud/issues/434)) ([14ebfec](https://github.com/LamaSu/physical-capability-cloud/commit/14ebfec084d3538f6e49600feba1a38274066e95))
* **gateway:** judge the adapter instance a test job ran on, and count an unmarked extension as simulated (N59 r4) ([fd6ef21](https://github.com/LamaSu/physical-capability-cloud/commit/fd6ef21a2c7fe177f4752a5f21a93a4c36a26e15))
* **gateway:** keep this change to rule composition; requests without a key are unchanged ([9709b27](https://github.com/LamaSu/physical-capability-cloud/commit/9709b270925937c90f5f661c4b32aa93272bef01))
* **gateway:** legacy settlement reads say only what the job's escrow records show ([5fcd851](https://github.com/LamaSu/physical-capability-cloud/commit/5fcd85122d71797bdaff862bebaf6db5d0c5292c))
* **gateway:** N133 a mock escrow never funds a physical write outside a test process ([#591](https://github.com/LamaSu/physical-capability-cloud/issues/591) r1 HIGH) ([b91251b](https://github.com/LamaSu/physical-capability-cloud/commit/b91251b079d934d2aa0612a406b77a7c370395c4))
* **gateway:** N133 a paid write scope goes live only on the operator's acceptance and the buyer's own funding ([52bf9bb](https://github.com/LamaSu/physical-capability-cloud/commit/52bf9bb5bd51a5dcc635621ef6a41ad1707803bf))
* **gateway:** N133 a paid write scope goes live only on the operator's acceptance and the buyer's own funding ([e02fb61](https://github.com/LamaSu/physical-capability-cloud/commit/e02fb6132fe08b70f85319fbd7ff09e3094317cb))
* **gateway:** N133 the A2A buyer binding refuses a present non-string buyer ([5b0cea0](https://github.com/LamaSu/physical-capability-cloud/commit/5b0cea0ab9481f9722947a06f3736af4cfe0ae13))
* **gateway:** N31 agent-package configure is a policy write; one kernel-authority module ([#575](https://github.com/LamaSu/physical-capability-cloud/issues/575) r2) ([b0ab65c](https://github.com/LamaSu/physical-capability-cloud/commit/b0ab65cd888d90b2b7c2d24979af46f139059518))
* **gateway:** N31 operator routes act only for the kernel's operator or the admin ([113cb40](https://github.com/LamaSu/physical-capability-cloud/commit/113cb40ee262ff3a0988112fa137c7969ed00e56))
* **gateway:** N31 operator routes act only for the kernel's operator or the admin ([98f3ea3](https://github.com/LamaSu/physical-capability-cloud/commit/98f3ea3bcdcfd99aa5f141929c386d9abf13ec0a))
* **gateway:** N31b a "safe" tool never widens a scope; an unresolved device type fails closed ([049f64e](https://github.com/LamaSu/physical-capability-cloud/commit/049f64ea08cb6c8be77bbf5e4dcb852577f6f34f))
* **gateway:** N31b a proven scope holder may make its scoped write (DECISIONS 00:42) ([f635971](https://github.com/LamaSu/physical-capability-cloud/commit/f635971118aa8e713b35e3876c7ed1b895aecd0c))
* **gateway:** N31b a scope revoke takes the stop tier ([#6677](https://github.com/LamaSu/physical-capability-cloud/issues/6677)) ([9845842](https://github.com/LamaSu/physical-capability-cloud/commit/98458427b0bfe719117bac48869a7c5cd993e9f5))
* **gateway:** N31b nothing bypasses a scope's tool list, budget or escrow ([#6771](https://github.com/LamaSu/physical-capability-cloud/issues/6771)) ([bb265ca](https://github.com/LamaSu/physical-capability-cloud/commit/bb265caf521a0e905ab13d640a3ed5b95554930b))
* **gateway:** N31b the device relay runs on the kernel-authority tiers (N126) ([7fb2cdf](https://github.com/LamaSu/physical-capability-cloud/commit/7fb2cdf6e21e780e709e0ab370bef96f5b8c9eb6))
* **gateway:** N31b the device relay, heartbeat and capability announce act only for the kernel's operator ([d0ef0ce](https://github.com/LamaSu/physical-capability-cloud/commit/d0ef0cea6b22c514872e07b4f3f2b8c46940e707))
* **gateway:** N31b the relay guard runs on the kernel-authority tiers (N126) ([dc6d383](https://github.com/LamaSu/physical-capability-cloud/commit/dc6d3833f27ffe760fdb34c2570135416a00fddc))
* **gateway:** N31b the relay's human- and agent-facing side needs proof (DECISIONS 00:53) ([73c93f5](https://github.com/LamaSu/physical-capability-cloud/commit/73c93f5f1278701fad577c1bb3471e8a508481e7))
* **gateway:** N31b the tool-call handler's operator test takes proof too ([30ac360](https://github.com/LamaSu/physical-capability-cloud/commit/30ac360d08482ea1aefa591eb717a611a7529bc4))
* **gateway:** N83 follow-ups: every IANA zone name; the pack-111 test accepts WP-A's provisioning refusals ([5702e98](https://github.com/LamaSu/physical-capability-cloud/commit/5702e984a43133e8a189240e8c74679e5f979928))
* **gateway:** one gate object-authorizes every read of a job's records (F3) ([ccb8613](https://github.com/LamaSu/physical-capability-cloud/commit/ccb8613c163c78eb79beaa31d327d202f01a156d))
* **gateway:** one milestone vocabulary decides both payout and funding (PX-7, [#515](https://github.com/LamaSu/physical-capability-cloud/issues/515) r1) ([25def06](https://github.com/LamaSu/physical-capability-cloud/commit/25def06081acdfb733fed1a15415fd93b722a69f))
* **gateway:** operator read routes stop fabricating earnings and fleet data ([670b3b8](https://github.com/LamaSu/physical-capability-cloud/commit/670b3b8b7818531c5e5b4b2cc9883abef8ff6817))
* **gateway:** read an unreadable execution-scope expiry as expired (N133 follow-up) ([39d4ad1](https://github.com/LamaSu/physical-capability-cloud/commit/39d4ad1cca9abf147277e1b8f6e7a11f7ccc271f))
* **gateway:** refuse a request target the router would route differently, before any decision (N105) ([4c99f03](https://github.com/LamaSu/physical-capability-cloud/commit/4c99f03dd4b08f03d2265bb2f3a6bbdb69e8ed8f))
* **gateway:** refuse a request target the router would route differently, before any decision (N105) ([9fcd6e9](https://github.com/LamaSu/physical-capability-cloud/commit/9fcd6e92ebb67b6dc1a1313bda68b4dc8cfc886e))
* **gateway:** retire the legacy /api/ot2 relay; /api/relay is default-deny per kernel (N4b-gw 1, 4) ([dafa601](https://github.com/LamaSu/physical-capability-cloud/commit/dafa601fa9a05395a442e7c57c6844d0b63d0d1a))
* **gateway:** scope requirements compose with the built-in defaults ([4ce5ad2](https://github.com/LamaSu/physical-capability-cloud/commit/4ce5ad2766f5e7499e1deeb32e4cae475a154d55))
* **gateway:** scope requirements compose with the built-in defaults ([dcb6e38](https://github.com/LamaSu/physical-capability-cloud/commit/dcb6e38f5f533b86728c30b7ae31fe82a2fce340))
* **gateway:** setup test-job exercises the operator's own machine or says it did not (N59, ADK item 8) ([c721d9f](https://github.com/LamaSu/physical-capability-cloud/commit/c721d9fa9ae32843b5cb2a23dc571f4ebd0392c5))
* **gateway:** show kernel locations coarse unless the operator opts in (N68) ([6c6ded8](https://github.com/LamaSu/physical-capability-cloud/commit/6c6ded8f1c73f39ff04f2dc9590a4ac30b60eca5))
* **gateway:** stop the PGTR relay at a callback onRequest guard; remove the retained signer handler ([ef834ca](https://github.com/LamaSu/physical-capability-cloud/commit/ef834ca94cf5cf39cd12b677c12c1ab796cb3595))
* **gateway:** stop the PGTR relay at a callback onRequest guard; remove the retained signer handler ([0958280](https://github.com/LamaSu/physical-capability-cloud/commit/09582800018c180fa644572e57c16a9d9b62c0ed))
* **gateway:** test-job reads the adapter's own simulated marker after the run, so a mockMode or downgraded adapter never passes (N59 r3) ([f1fce59](https://github.com/LamaSu/physical-capability-cloud/commit/f1fce598bc0eb347d4f607b0fdb0ab7cfc596033))
* **gateway:** the approval list refuses an empty filter, and approval creation checks its body's types (N32 follow-up) ([e2f7e38](https://github.com/LamaSu/physical-capability-cloud/commit/e2f7e3857c9120cd6167ed4d2edd18fcac826429))
* **gateway:** the approval list refuses an empty filter, and approval creation checks its body's types (N32 follow-up) ([cf16f55](https://github.com/LamaSu/physical-capability-cloud/commit/cf16f5589840b569e22eaf31839a75911de9e6f2))
* **gateway:** the D1 operator lookup's bound is capped at Node's largest timer delay, 2^31 - 1 ms (E13d) ([2a3be66](https://github.com/LamaSu/physical-capability-cloud/commit/2a3be662f122426f463b0e19ccbacbf1dbefd2c9))
* **gateway:** the D1 operator lookup's deadline is also read from the monotonic clock, so a lookup that blocks past it is refused (E13c F2) ([df42a86](https://github.com/LamaSu/physical-capability-cloud/commit/df42a86c0cd3c155c2628d1f3821913a5ccaf0a7))
* **gateway:** the D1 operator lookup's deadline is latched before the abort, and a null bound is refused (E13b F2) ([21b4c54](https://github.com/LamaSu/physical-capability-cloud/commit/21b4c54d99e46f313e0914e8f1ea242463cc9ca5))
* **gateway:** the D1 verifier admits only the ratified body's spellings and bounds its operator lookup (E13 F1-F3) ([b933fd5](https://github.com/LamaSu/physical-capability-cloud/commit/b933fd58f80070f809b1eb6924ccd1536fd4ab01))
* **gateway:** the device relay is admin-only unless PCC_RELAY_GATE=open ([2f5b21d](https://github.com/LamaSu/physical-capability-cloud/commit/2f5b21dc85b30ce0cb93cf4e65674902a67eac4d))
* **gateway:** the device relay is admin-only unless PCC_RELAY_GATE=open ([53d6076](https://github.com/LamaSu/physical-capability-cloud/commit/53d6076b1b9c79ae3f2b83a82081b8b2a1af88d7))
* **gateway:** the discovery quote is the operator's registered price (N98) ([a7e1c79](https://github.com/LamaSu/physical-capability-cloud/commit/a7e1c79b36e12de77e977b12e8834bf1d0874577))
* **gateway:** the home counts held money only when the escrow record holds it (PX-7, [#409](https://github.com/LamaSu/physical-capability-cloud/issues/409) r3) ([95699aa](https://github.com/LamaSu/physical-capability-cloud/commit/95699aaa077037586bc7dc7567c385af39c9a605))
* **gateway:** the IR projection drops page metadata and resolves ordered alternatives like the renderer (astra [#562](https://github.com/LamaSu/physical-capability-cloud/issues/562) r2 F2, F3) ([403c314](https://github.com/LamaSu/physical-capability-cloud/commit/403c314540f80e202c70d204e2bf20041580241c))
* **gateway:** the relay admin gate runs after the request-target guard (astra n105m F2) ([3466934](https://github.com/LamaSu/physical-capability-cloud/commit/34669344ae3f66be8d08c877c5ba599d34d2b7bd))
* **gateway:** the security monitor and payment stats keep no request content (N107) ([b75ff12](https://github.com/LamaSu/physical-capability-cloud/commit/b75ff123bc825507ef80140488708457385b8814))
* **gateway:** the security monitor and payment stats keep no request content (N107) ([081b0c4](https://github.com/LamaSu/physical-capability-cloud/commit/081b0c4908d23f707b8d64db3d91608b6290e67b))
* **gateway:** treat an unreadable scope expiry as expired (N133) ([9775efe](https://github.com/LamaSu/physical-capability-cloud/commit/9775efe49d036d9cdc9ba9e4d8897a1fd116eb41))
* **gateway:** until a milestone's poster can be resolved, only an admin creates a TMP task ([#6182](https://github.com/LamaSu/physical-capability-cloud/issues/6182)) ([c57c6ba](https://github.com/LamaSu/physical-capability-cloud/commit/c57c6ba8e6c5edbe04d15b5fe455834b600de07d))
* **genui-b:** 'none' needs the route's own paging evidence (astra n110 r1 MEDIUM) ([f0a3efa](https://github.com/LamaSu/physical-capability-cloud/commit/f0a3efa864b1efe53d52546bbee5f72969e03151))
* **genui-b:** carry the list profile's declared paged.total through the cross-origin IR projection ([5342765](https://github.com/LamaSu/physical-capability-cloud/commit/5342765c144b2dadfebedba8cd3443a99a621bc4))
* **genui-b:** keep [#348](https://github.com/LamaSu/physical-capability-cloud/issues/348)'s "not reported" absence marker through the [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) merge ([c2edf19](https://github.com/LamaSu/physical-capability-cloud/commit/c2edf196dd299e302e5be24836092b37650a2173))
* **genui-b:** window notes say 'returned' for the server page; keep exact child counts (N110 review) ([bb4e1f4](https://github.com/LamaSu/physical-capability-cloud/commit/bb4e1f49968d64fc0e3d072a2f365acebafd32ba))
* **genui-ir:** an identifier cannot spell a claim the word window misses (review of [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r6) ([a3521ba](https://github.com/LamaSu/physical-capability-cloud/commit/a3521badc7e3e96a5d5077efcd8b01862b349b30))
* **genui-ir:** identifiers are attributed like free text; the backstop joins raw values of every attributed kind (steward [#5149](https://github.com/LamaSu/physical-capability-cloud/issues/5149) on [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r6) ([7f6d8d4](https://github.com/LamaSu/physical-capability-cloud/commit/7f6d8d433d62af710ffaf679c73636bfb8c82578))
* **genui-ir:** list rows are read by each route's own rows key; typed list fields pinned against the real producers (review of [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r5) ([c3e04dd](https://github.com/LamaSu/physical-capability-cloud/commit/c3e04dd93caaa05955a1b8f844ef4f89dac0e752))
* **genui-ir:** the list backstop also joins a status's raw value; pin the backstop and the currency type (review of [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r4) ([8c6d17f](https://github.com/LamaSu/physical-capability-cloud/commit/8c6d17f1738ad3742b5423f51d57c324a2bf8572))
* **genui-ir:** versions and percents are closed grammars (astra r6 on [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344)) ([aafaa0a](https://github.com/LamaSu/physical-capability-cloud/commit/aafaa0a362cc4d422d7ea0ef23572e378102ac4f))
* **hosted-agent:** close astra 224a/224b ([#456](https://github.com/LamaSu/physical-capability-cloud/issues/456) round 4): unterminated secrets, whole auth headers, closed-set logs, device relay, busy confirm ([66f26a9](https://github.com/LamaSu/physical-capability-cloud/commit/66f26a976c597c9f0a140991abf9dece309d1abd))
* **hosted-agent:** close the round-2 review and the lane's round-3 findings ([#456](https://github.com/LamaSu/physical-capability-cloud/issues/456)) ([89485fc](https://github.com/LamaSu/physical-capability-cloud/commit/89485fc16f4f02c91291faff682b7d943c019ef0))
* **hosted-agent:** every read of a thrown value is total, and only closed values leave ([#456](https://github.com/LamaSu/physical-capability-cloud/issues/456) round 6, astra 242) ([011288b](https://github.com/LamaSu/physical-capability-cloud/commit/011288b4a42ff256d7d655d8e4d757faadac3f6e))
* **hosted-agent:** loggers cannot throw, startup lines are closed, and the pack-mismatch line has no digest ([#456](https://github.com/LamaSu/physical-capability-cloud/issues/456) round 7, astra 243) ([f101b6d](https://github.com/LamaSu/physical-capability-cloud/commit/f101b6da913a1f1c91c57220bb2aaef45e9a0bfe))
* **hosted-agent:** offer only allow-listed tools, and show tool output only as a typed projection ([#456](https://github.com/LamaSu/physical-capability-cloud/issues/456) round 5, astra 239) ([f3f06ad](https://github.com/LamaSu/physical-capability-cloud/commit/f3f06adb858d8d89294b99bc70ae6d1ad6bad0ae))
* **hosted-agent:** the attempt sink logs a closed projection, never the report, and cannot reject ([#456](https://github.com/LamaSu/physical-capability-cloud/issues/456) round 8, astra 246) ([bcc9c7c](https://github.com/LamaSu/physical-capability-cloud/commit/bcc9c7c9050e577a13894dfe700a3e16abe5ad11))
* **kernel:** a busy refusal says so (JobResult.busy), so a caller queues the job instead of counting a device failure ([c87eff4](https://github.com/LamaSu/physical-capability-cloud/commit/c87eff4798cfd122770db9fffe1a54d328d0b913))
* **kernel:** a real-mode IPP progress event names the printer's job as ippJobId, so it is recorded (LO-EV-9) ([ab23585](https://github.com/LamaSu/physical-capability-cloud/commit/ab23585de79f598252744e92442af71701e7c12e))
* **kernel:** a sensor stop that fails is made again on the failure path, and cannot abort its cleanup ([2b6ab6a](https://github.com/LamaSu/physical-capability-cloud/commit/2b6ab6ab404f93e9b092240239ee95244dc40462))
* **kernel:** an event the runner accepted but could not record fails the run ([9be4e5f](https://github.com/LamaSu/physical-capability-cloud/commit/9be4e5fbc2fbc2b715978e5d1f2e50e211508b3b))
* **kernel:** bind the camera identity to the device node that is opened, and re-check it after the grab ([6bf15c0](https://github.com/LamaSu/physical-capability-cloud/commit/6bf15c0584592dfd28be38e8655024c4a58f509e))
* **kernel:** EvidenceEmitter stores a step's events in call order (N123) ([bf9f53a](https://github.com/LamaSu/physical-capability-cloud/commit/bf9f53ae54f9d7f299a5467fed8551f1ea6930b5))
* **kernel:** EvidenceEmitter stores a step's events in call order (N123) ([3d1ea1f](https://github.com/LamaSu/physical-capability-cloud/commit/3d1ea1f48192ff91e4f3cce2aeb74f3d6a700e0c))
* **kernel:** export JobRunnerOptions with the other JobRunner types ([ddd1f0c](https://github.com/LamaSu/physical-capability-cloud/commit/ddd1f0cfbf13e9379743c5ebbc436da8173fdade))
* **kernel:** finalizeBundle signs a deep snapshot of the step's events (pack 261) ([ce171b0](https://github.com/LamaSu/physical-capability-cloud/commit/ce171b0d24805072daed35b895fc162bbd374822))
* **kernel:** JobRunner evidence is bound to its job across handoffs, step keys and devices ([f7af668](https://github.com/LamaSu/physical-capability-cloud/commit/f7af6686cf6f5680b8370d7d66924c1488a3ad3a))
* **kernel:** JobRunner evidence sessions are job-scoped, closed and bounded ([7332bb4](https://github.com/LamaSu/physical-capability-cloud/commit/7332bb4f71e45f59d04af662d58919952ab8ee20))
* **kernel:** JobRunner passes its job's id to the machine at load and start ([99ec894](https://github.com/LamaSu/physical-capability-cloud/commit/99ec894d375eadf6d81972dbc8d4c918cbc31378))
* **kernel:** JobRunner records every evidence event before the tier check and the bundle ([cd9d877](https://github.com/LamaSu/physical-capability-cloud/commit/cd9d8770745384c3922a10bf892fbc1d17f02e64))
* **kernel:** JobRunner records every evidence event, in emission order, before the tier check and the bundle ([5a3386b](https://github.com/LamaSu/physical-capability-cloud/commit/5a3386b5f3fff31357b6cc355d02c42ba45fd0e8))
* **kernel:** PrinterLog's summary covers every entry of its job, and a failed first poll leaves nothing outstanding ([1b7c10d](https://github.com/LamaSu/physical-capability-cloud/commit/1b7c10da0a962388ac1bf5f8fe1d1440e42f1841))
* **kernel:** quiesceEvidence() is required, and a job's devices pass on only on its word ([a54be76](https://github.com/LamaSu/physical-capability-cloud/commit/a54be76e4e95fcfcc2f2f7dd0a3b35dabad850e6))
* **kernel:** the emitter's step lifecycle holds around its chain (pack 259) ([239b944](https://github.com/LamaSu/physical-capability-cloud/commit/239b944d6f3179729cdca23b540dc20e0af3626e))
* **kernel:** the IPP mock refuses a page count that is not a positive integer ([147c57d](https://github.com/LamaSu/physical-capability-cloud/commit/147c57d4346f171c5c63b32d76513fbf59bdb9eb))
* **mcp:** the full /mcp surface obeys the prod domain gate for its MCP App views (D14) ([c9ff823](https://github.com/LamaSu/physical-capability-cloud/commit/c9ff823dcf7f1a35c236727018cc47fb2ce77115))
* **onboard-kit:** a replaced sensor recording keeps nothing of the old one, in the template and the scaffolded adapter ([aaa405f](https://github.com/LamaSu/physical-capability-cloud/commit/aaa405fabca5f90133348cd88853175c72b469f9))
* **pcc-node:** _claim_ok reads the claim's attributes by name (as in [#512](https://github.com/LamaSu/physical-capability-cloud/issues/512)) ([72bbff8](https://github.com/LamaSu/physical-capability-cloud/commit/72bbff83675bd87d2e03f778610d0ed94f109103))
* **pcc-node:** a fail-closed execution lease before any relayed call reaches an adapter (N4b-gw r7, F3) ([b0afbe4](https://github.com/LamaSu/physical-capability-cloud/commit/b0afbe4bac0b970582e23ea0f8b952451ec02f5e))
* **pcc-node:** a sent start is unknown unless refused by contract, and the lease is skew-free (verdict 117c) ([6a4a1ac](https://github.com/LamaSu/physical-capability-cloud/commit/6a4a1ac4f7e010196252dfad5fc1a405d0989541))
* **pcc-node:** clean up PID/state on the daemon fail-closed path (133b Q1) ([4a98e58](https://github.com/LamaSu/physical-capability-cloud/commit/4a98e58b5cdc5542b9930e4a03d09318700fd0f8))
* **pcc-node:** close the four 133a review findings (start/daemon safety) ([5a921df](https://github.com/LamaSu/physical-capability-cloud/commit/5a921df032f8ea244717543242398261003b56d8))
* **pcc-node:** fail closed on a registration 401 + require an explicit gateway (item 133, board N119) ([8349c01](https://github.com/LamaSu/physical-capability-cloud/commit/8349c0126a8539f8f7e2034937ed83d22c841c28))
* **pcc-node:** fail closed on registration 401 + require an explicit gateway (item 133) ([108c778](https://github.com/LamaSu/physical-capability-cloud/commit/108c778800d854dc24a0e938b545a1e859005732))
* **pcc-node:** implementer-papa2: fail-closed evidence builder + [#333](https://github.com/LamaSu/physical-capability-cloud/issues/333)'s reviewed classifier ([df36ac5](https://github.com/LamaSu/physical-capability-cloud/commit/df36ac535913ab895d07306f6790d3b564043061))
* **pcc-node:** keys live under ~/.pcc-node, owner-only; the node honours the emergency stop (item 9) ([46783db](https://github.com/LamaSu/physical-capability-cloud/commit/46783db398fa4c234ff32fae34962610dd864d58))
* **pcc-node:** remove the relay executor that ran commands in a shell (N66) ([afb9fb0](https://github.com/LamaSu/physical-capability-cloud/commit/afb9fb0b9a32375a6cc8f641c044e3d27dec2f17))
* **pcc-node:** runs belong to a leased claim, device I/O is interruptible, and evidence is checked exactly (verdict 117b) ([a708c86](https://github.com/LamaSu/physical-capability-cloud/commit/a708c86a7a7ab6dde7204345c50d5147bbc6136d))
* **pcc-node:** the evidence builder never emits execution_completed without an observed success (OH-1 follow-up, stacked on [#454](https://github.com/LamaSu/physical-capability-cloud/issues/454)) ([7341a03](https://github.com/LamaSu/physical-capability-cloud/commit/7341a031dfafa9d48da241153bf66251ff8694cb))
* **pcc-node:** the lease deadline is checked immediately before a request's first socket write; under a lease the shell path is refused (N4b-gw r11) ([8a529d4](https://github.com/LamaSu/physical-capability-cloud/commit/8a529d478fe0472497dfbda0b773a32271229dfc))
* **relay:** a granted lease expires before actuation; a refused submit spends no budget (N4b-gw r8) ([6a6f8a4](https://github.com/LamaSu/physical-capability-cloud/commit/6a6f8a4aed0e11c6d22d383472ee32fc96e151bc))
* **relay:** the lease deadline is checked where each device command leaves the node; the budget is charged in one guarded transaction (N4b-gw r9) ([7d20923](https://github.com/LamaSu/physical-capability-cloud/commit/7d209236a669b28d03ecef629b7ab43ef0f2370a))
* **scripts:** consume OFF runs no job; a local mark is never the record that a job may run ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r5) ([87e5014](https://github.com/LamaSu/physical-capability-cloud/commit/87e5014d87644301357462852e71bc2b1571b5d7))
* **scripts:** every claim makes the whole state path durable, not only newly created directories ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r3) ([92e4130](https://github.com/LamaSu/physical-capability-cloud/commit/92e413007635a4d673f20936d276eaf3197e0547))
* **scripts:** ot2-agent refuses a job when its run-once mark can't be made durable and is the only record ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r2) ([5cde00e](https://github.com/LamaSu/physical-capability-cloud/commit/5cde00ed48b75282409756415f78663cb75d643f))
* **scripts:** ot2-agent runs each approved job at most once (local mark + gateway consume) ([847d548](https://github.com/LamaSu/physical-capability-cloud/commit/847d548b8f0b4e8587f58183383b47d47810349c))
* **scripts:** read PCC and oracle keys from env; CI fails on key literals (N44) ([11b4522](https://github.com/LamaSu/physical-capability-cloud/commit/11b452206844074bb60c2cd8e83666077f9c1886))
* **scripts:** with consume off, refuse a symlinked state path and sync the directories the mark is really in ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r4) ([40a1bbd](https://github.com/LamaSu/physical-capability-cloud/commit/40a1bbdd44778d982d5a921393315842030f59bc))
* **spec:** canonicalize refuses values that have no JSON form ([52cac95](https://github.com/LamaSu/physical-capability-cloud/commit/52cac95b551fb57c29d235b859df221521fd8817))
* **spec:** clamp normalized limits into the CSD range; add nm to the unit table ([6839948](https://github.com/LamaSu/physical-capability-cloud/commit/6839948e8055e33704dd0ceb3e8d1f5113901c83))
* **spec:** close astra 112d: canonical release order, no dropped requirement ([79a3330](https://github.com/LamaSu/physical-capability-cloud/commit/79a3330dcacbebc60a6216b787b2681fffa9e70b))
* **spec:** close astra 120d: numeric keys are keys, one contentHash rule everywhere ([09c7e7b](https://github.com/LamaSu/physical-capability-cloud/commit/09c7e7b532f8f05b9e9f18536dba3edf23663c45))
* **spec:** close astra 120e: a token never reproduces a raw key; exact contentHash in every dialect ([fbd7564](https://github.com/LamaSu/physical-capability-cloud/commit/fbd756402106086f75b72613b10d1421b6856fc1))
* **spec:** close astra 120f: arrays' named properties are keys; kept means in the vocabulary ([79205af](https://github.com/LamaSu/physical-capability-cloud/commit/79205af63e3e19e7b6137871192a2ce9e9bd61fc))
* **spec:** close astra 120g by ending the input-shape class: one exact plain-data copy at the boundary ([8596de2](https://github.com/LamaSu/physical-capability-cloud/commit/8596de29fd6fb40f509d1696ce429890a1c7628e))
* **spec:** close astra 120h under steward ruling [#5308](https://github.com/LamaSu/physical-capability-cloud/issues/5308): hostile data in, hostile in-process code out ([069f9df](https://github.com/LamaSu/physical-capability-cloud/commit/069f9dff5770433e2f25cf527bc76ee4d91fa3b8))
* **spec:** each economics adapter reads its input once, then validates, hashes and pays that copy (astra EC5) ([67fd0fa](https://github.com/LamaSu/physical-capability-cloud/commit/67fd0fa5f50bb18abc87089a5ed3ced865fc0cb3))
* **spec:** economics refuses, never throws, on a number the canonical form cannot write (D5, [#359](https://github.com/LamaSu/physical-capability-cloud/issues/359)) ([bdd6a3f](https://github.com/LamaSu/physical-capability-cloud/commit/bdd6a3f5cc05c92fa90adf802da34234447e5fca))
* **spec:** economics refuses, never throws, on a number the canonical form cannot write (D5) ([64652cc](https://github.com/LamaSu/physical-capability-cloud/commit/64652cccffdf600480e770a26f5285fa1f17d682))
* **spec:** evidence levels read payload.mock and source.simulated as own fields of objects only (pack 267) ([c4063b3](https://github.com/LamaSu/physical-capability-cloud/commit/c4063b35e7b38b937f0c350abb163dae6c075bb6))
* **spec:** fixer-whiskey: admitPlainArray + checkExactKeys snapshot once, never re-read (E12) ([a339305](https://github.com/LamaSu/physical-capability-cloud/commit/a339305a0bdc27cd4e76e00510cac6e7209c10bd))
* **spec:** fixer-whiskey: make computeSubjectBlockHash/computeBindingsRoot read-once doc comments literal (E12) ([530e664](https://github.com/LamaSu/physical-capability-cloud/commit/530e66416d24f65266725f55d463f1e9f9be6463))
* **spec:** intake hashing is total: refuse non-JSON numbers before canonicalize (steward [#6637](https://github.com/LamaSu/physical-capability-cloud/issues/6637)) ([508ff57](https://github.com/LamaSu/physical-capability-cloud/commit/508ff57dad27a05ea159e46faa9da72b97e1366b))
* **spec:** LO-EV-9 reads each field once, runs no caller code, never throws, and binds unit and challenge both ways (E11 F1-F3) ([6921482](https://github.com/LamaSu/physical-capability-cloud/commit/692148278eeca670eb2f7db9480b2f083a1bc3a6))
* **spec:** plainDataCopy reads descriptors through their own properties and calls only intrinsics captured at load; the proxy check must pass a trap probe (astra pack 162) ([fd12d89](https://github.com/LamaSu/physical-capability-cloud/commit/fd12d8977d5229c73b835188c2df23d49103c525))
* **spec:** R8 round 4. The safety envelope calls only intrinsics captured at load, so nothing replaced afterwards can change what it checks or emits (astra pack 164) ([b74d0c9](https://github.com/LamaSu/physical-capability-cloud/commit/b74d0c98c925ee35d8afac3a836394f073d5156d))
* **spec:** R8 round 5. No format is checked with a RegExp; every digest form is a structural predicate (astra pack 167) ([ad599f0](https://github.com/LamaSu/physical-capability-cloud/commit/ad599f04f67afe392cd9210f7c41a9534cc47f1f))
* **spec:** R8's canonical JSON refuses a number D5 has no form for (evidence [#6107](https://github.com/LamaSu/physical-capability-cloud/issues/6107)) ([cdc04a8](https://github.com/LamaSu/physical-capability-cloud/commit/cdc04a805c43dba161d4b7085250696234476a6e))
* **spec:** R8's canonical JSON refuses a number D5 has no form for, so an envelope digest is one the oracle can recompute ([3bf56d6](https://github.com/LamaSu/physical-capability-cloud/commit/3bf56d63d49437dcd01c05e235b642f9578a51ec))
* **spec:** the E12 snapshots use only load-time intrinsics (a null-prototype record, not a Map; installed, not assigned) ([8106ed1](https://github.com/LamaSu/physical-capability-cloud/commit/8106ed18ec0edf129cbd1fadaf89bc2109226e14))
* **spec:** the event-time path the LO-EV-9 leg calls uses only load-time intrinsics (no RegExp, no Date) ([e63e33a](https://github.com/LamaSu/physical-capability-cloud/commit/e63e33aa31c18716661f8624ff5c16aec8e01106))
* **spec:** the evidence levels hold under post-load realm mutation ([#345](https://github.com/LamaSu/physical-capability-cloud/issues/345)'s final file) ([54a6e0c](https://github.com/LamaSu/physical-capability-cloud/commit/54a6e0c62475cc3832fca7bc6ffaeaf754118df7))
* **spec:** the evidence levels hold under post-load realm mutation ([#345](https://github.com/LamaSu/physical-capability-cloud/issues/345)'s final file) ([e1d9e27](https://github.com/LamaSu/physical-capability-cloud/commit/e1d9e27229e11017d5363e322d3c3e33a2a8265c))
* **spec:** the inert-JSON boundary reads property descriptors by own keys only ([#5147](https://github.com/LamaSu/physical-capability-cloud/issues/5147)) ([93d00a9](https://github.com/LamaSu/physical-capability-cloud/commit/93d00a9e4b1cebccbf7b9b84599a1b2bcdc1a226))
* **spec:** the inert-JSON boundary reads property descriptors by own keys only ([#5147](https://github.com/LamaSu/physical-capability-cloud/issues/5147)) ([edf5b64](https://github.com/LamaSu/physical-capability-cloud/commit/edf5b6497c04cd839648ca3b85dc9b93aa7b6c2c))
* **spec:** the profile's canonicalization, validation, digest and freezing call only intrinsics captured at load; isProxy is bound by a static node:util import, never offered by the runtime (astra pack 170) ([8dc6ef2](https://github.com/LamaSu/physical-capability-cloud/commit/8dc6ef2bc90ff6fff2b24b22c8f614e37ea27e49))
* **ui-kit,dashboard,spec:** one canonical money-status map - no refund/allocated/unknown as settled-green ([748cb83](https://github.com/LamaSu/physical-capability-cloud/commit/748cb8359927430e8c7441d1519094cdb18d2704))
* **ui-kit:** authority needs the unprojected top-level read; secondary text is repainted under each read (astra r7 F13, F10 on [#313](https://github.com/LamaSu/physical-capability-cloud/issues/313)) ([27295ba](https://github.com/LamaSu/physical-capability-cloud/commit/27295ba9f1a90bc63ede91beabad11546770f123))
* **ui-kit:** harden the approval / money-action surface (port [#282](https://github.com/LamaSu/physical-capability-cloud/issues/282) + close 4 holes) ([cb4e18c](https://github.com/LamaSu/physical-capability-cloud/commit/cb4e18cddd4de7972443f6a91dd4840954bc5b50))
* **ui-kit:** one money request per view, no exceptions; chain Plan is an effect-reviewed non-money write (astra r5 F1-F3 on [#342](https://github.com/LamaSu/physical-capability-cloud/issues/342)) ([d60c356](https://github.com/LamaSu/physical-capability-cloud/commit/d60c3560bb219afa1213c78a7dd160786d378bf4))
* **ui-kit:** re-bake demo-snapshot.html from the current pcc-ui.js, pinned byte for byte (N140) ([150206a](https://github.com/LamaSu/physical-capability-cloud/commit/150206a6339eb942f7f3e4061c8cebcebff8a4ec))
* **ui-kit:** re-bake demo-snapshot.html from the current pcc-ui.js, pinned byte for byte (N140) ([efd2087](https://github.com/LamaSu/physical-capability-cloud/commit/efd2087cb82b16c468ebe4ea16920e3706bfaa3a))
* **verifier,gateway:** the assurance tier comes only from authenticated state, never a worker's bundle or proof (E11d HIGH, N118) ([ebf1186](https://github.com/LamaSu/physical-capability-cloud/commit/ebf1186bb17b1b86cefb3cc170bc3c33c68d4f7f))
* **verifier,gateway:** the tier and the pipeline come only from owner-bound task state; every pipeline enforces the tier or refuses; the verifier reads no unsigned field (E11e, N118) ([f87545b](https://github.com/LamaSu/physical-capability-cloud/commit/f87545b9822ae837d40cba15fcf4b550d29852f7))
* **verifier:** neither an event's unsigned id nor the events' order decides EvidenceVerifier's verdict (E11c HIGH) ([3b96586](https://github.com/LamaSu/physical-capability-cloud/commit/3b9658631f6e33a2c02df41cbfd92d541f608834))
* **verifier:** neither an event's unsigned id nor the events' order decides EvidenceVerifier's verdict; docs: they are uncommitted metadata (E11b/E11c, stacked on [#341](https://github.com/LamaSu/physical-capability-cloud/issues/341)) ([61926da](https://github.com/LamaSu/physical-capability-cloud/commit/61926da78ef0497b537ee5b143af0149f17f28d1))
* **verifier:** oracle and Bittensor see only a verified bundle's committed data; no worker tier is read (E11f HIGH 2, MEDIUM 3) ([3e77241](https://github.com/LamaSu/physical-capability-cloud/commit/3e77241c8edc99aea7f61d024b9ee509b6e0a046))


### Documentation

* **economics:** rule 5's real bound and the adapters' MANIFEST_INVALID for numbers with no canonical form (D5) ([2832a1c](https://github.com/LamaSu/physical-capability-cloud/commit/2832a1cdebdf3a8d6f7ea4fbd835ab663c2cfbae))
* **economics:** the adapters read their input once; state exactly when they refuse, and that they do not throw (astra EC5) ([8d0eec3](https://github.com/LamaSu/physical-capability-cloud/commit/8d0eec304becbc9fadfc330ab01c32e9c6c05407))
* every place that lists the adapter interface names quiesceEvidence() ([3f4240c](https://github.com/LamaSu/physical-capability-cloud/commit/3f4240cb55714c86b839cf8f3fdbffd624a040db))
* **gateway:** a TMP verdict proves integrity, not origin; nothing may move money on it before N124 ([85e09ba](https://github.com/LamaSu/physical-capability-cloud/commit/85e09baace75344177f65ad8c8426d1441c0a098))
* **gateway:** the mint guard's D1 notes name the ratified struct and the production verifier ([aa5c638](https://github.com/LamaSu/physical-capability-cloud/commit/aa5c63808f56ca40f4146d585238d5f2b31cbee9))
* **gateway:** the relay admin gate is the second onRequest hook, after the request-target guard ([fe78458](https://github.com/LamaSu/physical-capability-cloud/commit/fe784585ef685434b86aab2aa0e843735d917dc2))
* **gateway:** the request-target guard's refusals are gateway policy, not a claim about clients (astra n105m) ([e2b5fec](https://github.com/LamaSu/physical-capability-cloud/commit/e2b5fec740eae7967fd129359149e3c5c601cf63))
* **genui-b:** correct the stale /api/jobs fact in LIST_PROFILES (N110; comment only) ([2bc203c](https://github.com/LamaSu/physical-capability-cloud/commit/2bc203cb334495890d1b2e83c876cfa59adc9e88))
* **genui:** preserve the settlement read-surface contract + conformance matrix in-repo ([ce5a7ab](https://github.com/LamaSu/physical-capability-cloud/commit/ce5a7abcaeb8bfafe752b59c4302bd912b42cc1c))
* **relay:** state the lease's one residual exactly; regression for a pause after the final guard (N4b-gw r10) ([35ee3d6](https://github.com/LamaSu/physical-capability-cloud/commit/35ee3d6975800400660d3944edb6fad05e0e37c1))
* **spec:** an event's id and the events' order are uncommitted metadata of a verified bundle (E11b LOW) ([4ad48f4](https://github.com/LamaSu/physical-capability-cloud/commit/4ad48f4f0cb1fea5b888771bdcfc90acac5abf21))
* **verifier:** the bridge's routing table and the sensor comment say what E11e made true ([a387b07](https://github.com/LamaSu/physical-capability-cloud/commit/a387b0774ae3098dc6b95ff0e4823136de2ec151))


### Refactor

* **dashboard:** drop the key lint's fetch-by-name check, which the held rule already decides ([abcfb21](https://github.com/LamaSu/physical-capability-cloud/commit/abcfb2172e13eda41876100f417f5770f7e01fab))
* **dashboard:** drop the key lint's root check, which the mutation-target check now covers, and pin window.&lt;object&gt; on its own ([e34e767](https://github.com/LamaSu/physical-capability-cloud/commit/e34e767a3579bc27df9e10fcab12ab3f964b68c3))

## [Unreleased]

## [0.2.0] — 2026-02-10 to 2026-03-31 (PL Genesis Hackathon Period)

> 68 commits · 17 packages + 3 apps · 623 tests passing across 37 test files

This release represents the core sovereign infrastructure sprint built during the Protocol Labs Genesis hackathon period. The primary focus was replacing centralized infrastructure dependencies with open, verifiable alternatives aligned with Filecoin, IPFS, Lit Protocol, Bittensor, and the DePIN ecosystem.

### Wave 1A — IPFS Evidence Storage (Filecoin / Storacha alignment)

**Added**

- `EvidenceStorageService` backed by Helia — content-addressed evidence bundles pinned to IPFS on every job finalization
- `ipfsCid` and `ipfsMetadataCid` fields on `EncryptedEvidenceBundle` — permanent, verifiable pointers to job outputs
- `GET /api/evidence/:bundleId/ipfs` gateway endpoint — fetch evidence directly by IPFS CID
- `IPFS archival` wired into `EvidenceEmitter.finalizeBundle()` — every completed job produces an immutable IPFS record
- `IPFSLink` and `ChainTxLink` UI components in `@pcc/ui` — clickable links from evidence bundles to IPFS gateways and block explorers

### Wave 1B — W3C Decentralized Identities + Verifiable Credentials

**Added**

- `packages/spec/src/identity/` module — `did:key` (Ed25519) and `did:pcc` DID methods from scratch
- Ed25519 key generation with base58btc multibase encoding (W3C DID spec compliant)
- `CapabilityCredential` issuance with Ed25519 signatures — machines issue verifiable credentials for capabilities they offer
- Full round-trip identity pipeline: create DID → issue VC → verify signature (31 tests passing)
- `DIDBadge` UI component in `@pcc/ui` — renders a DID with copy, format, and chain badges
- New spec types: `depin.ts`, `identity/types.ts`, `identity/did.ts`, `identity/credentials.ts`

### Wave 2A — Lit Protocol Encryption

**Added**

- `LitEncryptionService` in `@pcc/kernel` — AES-256-GCM encryption with realistic Lit Protocol access condition types
- Access conditions tied to capability ownership — only the job requester and kernel can decrypt evidence bundles
- `EncryptionService` interface with both Lit (sovereign) and fallback implementations
- 28 encryption/decryption tests passing across the kernel package
- `/evidence` and `/evidence/:bundleId` dashboard routes — encrypted bundle explorer with decrypt-on-demand

### Wave 2B — Solana Agent Wallets

**Added**

- `SolanaAgentWallet` in `@pcc/agent-runtime` — `@solana/web3.js` v1 + SPL transfers, message signing, devnet airdrop
- `SpendingTracker` with rolling window budget enforcement — agents cannot exceed per-window spend limits
- Agent spending policy factories: `userAgentPolicy`, `brokerAgentPolicy`, `kernelAgentPolicy` presets
- 3 new A2A intents: `RequestFunding`, `DelegateBudget`, `ClaimRewards`
- Multi-chain wallet types: `"base-sepolia" | "base" | "solana-devnet" | "solana"`; `"SOL"` currency
- `UnifiedKeychain` — one BIP-39 mnemonic derives all chain wallets (EVM + Solana) + DID identity

### Wave 3 — Bittensor Verification Subnet

**Added**

- `BittensorSubnetBridge` in `@pcc/verifier` — routes evidence verification requests to the Bittensor network
- `MockMiner` with quality tiers (gold/silver/bronze/unverified) and realistic scoring distributions
- `MockValidator` implementing Yuma Consensus for subnet weight aggregation
- Bittensor subnet spec document for hackathon submission (`ebd3e46`)
- `/subnet` dashboard route — live subnet health, miner leaderboard, and consensus status
- 22 Bittensor-related tests passing

### Wave 4 — DePIN Economics + Soulbound Capability NFTs

**Added**

- `CapabilityCertificateService` in `@pcc/contracts` — soulbound cNFTs (non-transferable) issued per verified capability
- `RewardEngine` — DePIN epoch tracking with weighted scoring across uptime, quality, and throughput dimensions
- `FundingHandler` in `@pcc/agent-broker` — demand detection → Alkahest escrow bridge for milestone settlement
- Capability certificates migrated from Bubblegum to **Metaplex Core** (`mpl-core`) for Solana
- Reward epochs: configurable window, participant weighting, claimable on-chain rewards
- 41 DePIN/certificate tests passing
- `/depin` dashboard route — treasury overview, certificate registry, reward epoch status, claim history

### Wave 5 — Dashboard Integration + End-to-End Sovereign Simulation

**Added**

- 9-phase sovereign e2e simulation (`scripts/sovereign-e2e-simulation.ts`): DID creation → VC issuance → IPFS pinning → Lit encryption → Bittensor verification → ZK proof → milestone escrow → DePIN reward → full teardown
- `2354d75` — "Wire real sovereign infrastructure": all sovereign services activated end-to-end in a single simulation run
- Bioluminescent Solarpunk design system: teal/cyan palette, `BorderBeam`, `AnimatedNumber`, `GlowBadge`, `tw-animate-css`
- 18 biotech capability types + 3 San Francisco lab kernels as reference Shop Kernels
- Hackathon demo: multi-hop workflow with agent auction across multiple kernels

### Sovereign Infrastructure — Cross-Cutting

**Added**

- `@pcc/onboard-kit` (new package) — SDK for teams to onboard any device onto the PCC network autonomously
  - 800+ line `AGENT_INSTRUCTIONS.md` (12 steps, 4 appendices, full type reference) readable by AI agents
  - Generic adapters: HTTP REST, sensor, camera (with mock mode for testing without hardware)
  - Scaffolder: JSON config → complete kernel project (adapters, capabilities, agent, tests) in one command
  - Validator: checks 44 capability types, pricing models, assurance tiers, adapter references (10 tests)
  - CLI: `pcc-onboard scaffold` / `pcc-onboard validate` commands
  - `/onboard/kit` dashboard page with integration steps, protocol templates, capability browser

- `@pcc/mcp-server` (new package) — PCC as an MCP server; plug directly into Claude Code or Cursor
  - 14 tools: `pcc_list_capabilities`, `pcc_search_capabilities`, `pcc_build_contract`, `pcc_calculate_price`, `pcc_list_evidence`, `pcc_subnet_status`, `pcc_depin_stats`, and 7 more
  - Agents can discover, price, and book physical capabilities without leaving their IDE

- `@pcc/orchestrator` (new package) — intra-kernel instrument choreography
  - `TransferGraph`, `ResourcePool`, `SampleTracker`, `ProtocolEngine`, `AutomationTracker`, `ProtocolRunner`
  - `/orchestrator` and `/orchestrator/:kernelId` dashboard routes

- `@pcc/contracts` — Solidity: `MilestoneEscrow`, `MockUSDC`; Foundry test suite; TypeScript ABI exports
- `@pcc/payments` — x402 payment protocol middleware + client wired end-to-end through gateway
- Noir ZK circuits: `evidence_inclusion` (Pedersen Merkle proof) and `tier_compliance`
- `NoirProofService` — real ZK proof generation with transparent mock fallback
- `CommitmentService` in `@pcc/verifier` — Merkle commitment trees for evidence bundle inclusion proofs
- `ZKProofService` in `@pcc/verifier` — ZK proof generation and verification pipeline

- **Protocol system** — shareable, forkable multi-instrument workflows with progressive robot automation
  - `/protocols`, `/protocols/new`, `/protocols/:templateId`, `/protocols/:templateId/edit` routes
  - `/protocol-runs`, `/protocol-runs/:runId` — live DAG execution view with status-colored nodes

- **Persistence layer** — `@pcc/db` (SQLite + Drizzle ORM): 17 tables, 8 repositories, seed data
- **SIWE authentication** — Sign-In with Ethereum nonce/verify/session flow in gateway + dashboard
- **ERC-8004 registries** — identity, reputation, and validation registries as Solidity contracts

- **Full agent skills manifest** — 65+ REST endpoints + 13 A2A intents documented for agent consumption
- **BYOA model** — agents connect to PCC directly with no proxy; agent-package.json published alongside gateway
- **Agent-first chat dashboard** with Meteora DLMM capability pricing integration

### Infrastructure / DevOps

**Added**

- Railway deployment: Dockerfile (single-stage to preserve pnpm symlinks), `railway.toml`, startup error handling, healthcheck
- GitHub Actions CI/CD: build, test, Foundry tests, dashboard bundle size reporting
- `isMain` guard in kernel `server.ts` — prevents auto-start on import (fixes test isolation on Linux + Windows)
- Docker: cache-bust headers, `@fastify/static` version pin for Fastify 4 compatibility
- SSE mock data producers for live sensor, batch, and log streaming in development

**Fixed**

- DB schema mismatch and seed idempotency on Railway redeploy
- `isMain` detection on Linux — switched to `fileURLToPath` comparison
- SPA fallback: gateway reads `index.html` directly instead of `sendFile` (fixes 404 on deep routes)
- Static file serving for `agent-package.json`, `docs/`, `tools.json`

---

## [0.1.0] — 2026-02-10 to 2026-03-09 (Foundation)

> 14 commits · Initial MVP through first complete multi-package build

### Added

- `@pcc/spec` — canonical types, Zod schemas, ID generation, hashing
- `@pcc/kernel` — Shop Kernel runtime: device adapters (OctoPrint, Modbus TCP, OPC-UA), `EvidenceEmitter`, `JobRunner`, `SensorPipeline`, `BatchTracker`
- `@pcc/scheduler` — `WorkflowCompiler` (DAG topological sort), `CapabilityRouter`
- `@pcc/verifier` — `VerifierMarket`, `EvidenceVerifier`, `ZKProofService`
- `@pcc/agent-runtime` — `BaseAgent`, `AgentWallet` (viem/EVM), `SpendingPolicy`
- `@pcc/agent-user` — `UserAgent`: discover, negotiate, submit, build contracts
- `@pcc/agent-broker` — `BrokerAgent`: routing, escrow management, NLP intent parsing
- `@pcc/agent-kernel` — `KernelAgent`: wraps kernel runtime, manages jobs and evidence
- `@pcc/a2a` — 27+ typed intents, `MessageBus`, `Conversations`
- `@pcc/contract-builder` — schema-driven contract builder: templates, profiles, resolver, pricing, validator
- `@pcc/gateway` — Fastify REST/SSE: 20+ route files, `StreamHub`, SIWE auth, x402 payment gate
- `@pcc/ui` — Solarpunk component library: 64+ files, design tokens, all dashboard primitives
- `apps/dashboard` — Vite SPA: 44+ routes, React Flow DAG editors, 18-step onboarding tour
- Agent-to-agent interaction layer with `MessageBus` pub/sub
- Dashboard: Contract Builder, Workflow Builder, Sensor Dashboard, Batch Tracking, Evidence Explorer, Logistics Hub, Operator Dashboard, Space Finder, Equipment Marketplace, Escrow Dashboard
- Onboarding: 7-step Machine Onboarding Wizard with AI sidebar, Setup Wizard, Tutorial
- `@pcc/payments` x402 protocol wired end-to-end

---

## Architecture Overview

```
Shop Kernels = Availability Zones (physical sites with equipment)
Capabilities = Billable units (what machines CAN DO, not the machines themselves)
Assurance Tiers = SLAs (0-3, escalating evidence / bonds / challenge windows)
Settlement = Milestone escrow on-chain (MilestoneEscrow.sol)
Microservice payments = x402 protocol
Evidence = IPFS-pinned, Lit-encrypted, Bittensor-verified, ZK-proven
Identity = W3C DIDs (did:key + did:pcc), Verifiable Credentials
DePIN = Soulbound cNFTs per capability + epoch reward engine
```

**Stack:** pnpm monorepo · TypeScript (ES2022/NodeNext/strict) · Turbo · Vitest · Viem · Zod · Fastify · Solidity (Foundry) · React 19 · React Router v7 · TanStack Query v5 · Zustand v5 · Tailwind v4 · React Flow · Recharts

---

[Unreleased]: https://github.com/global-mysterysnailrevolution/physical-capability-cloud/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/global-mysterysnailrevolution/physical-capability-cloud/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/global-mysterysnailrevolution/physical-capability-cloud/commits/v0.1.0
