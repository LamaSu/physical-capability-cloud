# Changelog

All notable changes to **Physical Capability Cloud (PCC)** are documented here.

PCC is an open cloud control plane for physical manufacturing capabilities — "AWS for the physical world." Shop Kernels are Availability Zones. Capabilities are the billable unit (not machines — what machines *can do*). Settlement flows through milestone escrow on-chain. Verification is sovereign: IPFS-pinned evidence, Lit Protocol encrypted bundles, Bittensor-validated quality, W3C DIDs, and ZK Merkle proofs.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## 1.0.0 (2026-10-04)


### Features

* **adapter-pylabrobot:** quiesceEvidence() covers the run and every call in flight ([bf43140](https://github.com/LamaSu/physical-capability-cloud/commit/bf4314047f05ec4b64773dd814e944de80cb3892))
* **adk:** the operator runbook and starter kit, first cut (ADK item 5; R1, R2, R7) ([e33b49e](https://github.com/LamaSu/physical-capability-cloud/commit/e33b49ed2de699d6b12522647c57376ebfed2a88))
* **adk:** the operator runbook and starter kit, first cut (ADK item 5; R1, R2, R7) ([b1bf66d](https://github.com/LamaSu/physical-capability-cloud/commit/b1bf66ddba97e8441fc4a4328465757c159cbb87))
* **adk:** the runbook's event index (R6) ([61343d7](https://github.com/LamaSu/physical-capability-cloud/commit/61343d71811ddc5a9f427deae0f2035ceaafbeb6))
* **agent-pack:** report whole onboarding attempts in painpoints' contract v1 (item 2b) ([d74c5c3](https://github.com/LamaSu/physical-capability-cloud/commit/d74c5c37a74145a2a7cc6d48d1b68acc01f0295c))
* **contracts:** freeze the V-next settlement ABI + canonical compiler @pcc/contracts/vnext (R14) ([7d688ce](https://github.com/LamaSu/physical-capability-cloud/commit/7d688ce3de86ab84c6fe62541d45b4cef944ce48))
* **contracts:** funding preflight for the live half of the funding rules ([fbafa4c](https://github.com/LamaSu/physical-capability-cloud/commit/fbafa4c94226446411ccab041e11070a4d3cf7bf))
* **contracts:** read every unit's funded config back from a V-next escrow, provably ([c512096](https://github.com/LamaSu/physical-capability-cloud/commit/c512096ec5a09b4c05170df30050c00fb3d13df7))
* **contracts:** read every unit's funded config back from a V-next escrow, provably ([5c7a025](https://github.com/LamaSu/physical-capability-cloud/commit/5c7a025080ed49d7cc51bce11259689d3ace01bb))
* **contracts:** V3 ABI entries for the deadline reclaim, and an anvil fixture (N79) ([05303bd](https://github.com/LamaSu/physical-capability-cloud/commit/05303bd0a56cc9ff78008cdf26c298bbc94413a1))
* **evidence:** LO-EV-9 bind device evidence to the accepted job and kernel before settlement ([6f7877c](https://github.com/LamaSu/physical-capability-cloud/commit/6f7877c74edf22a6a27389c3c73cc89aa23bad02))
* **evidence:** LO-EV-9 binds the settlement unit and its challenge nonce, so one milestone's evidence cannot settle another ([d3309de](https://github.com/LamaSu/physical-capability-cloud/commit/d3309de8fb4e1a7d2595cd3c6f30859d199442a1))
* **gateway:** /api/health reports the served commit (N5) ([7ea377e](https://github.com/LamaSu/physical-capability-cloud/commit/7ea377ebd9dade8b51a5efbc798c0810c38bdd2f))
* **gateway:** add pure attempt-analysis module for onboarding observability ([5387a0d](https://github.com/LamaSu/physical-capability-cloud/commit/5387a0d17d02b1b2a2a7d82a161c8eb2cdb009b7))
* **gateway:** admin attempt-analysis view (ADK track item 10a) ([9fc6c1c](https://github.com/LamaSu/physical-capability-cloud/commit/9fc6c1c3ae2efab9e6615ad5feedf5a30df0a456))
* **gateway:** attempt analysis and admin view (ADK track item 10a) ([2e51897](https://github.com/LamaSu/physical-capability-cloud/commit/2e518975f7e2c9fe07955a8441ea9e2b5893105b))
* **gateway:** attempt reports on /api/feedback (ADK track item 3, contract attempt.v1) ([9e9fe4f](https://github.com/LamaSu/physical-capability-cloud/commit/9e9fe4f8aae20d92e171c0e2b265b9f48af9a0a7))
* **gateway:** attempt reports on /api/feedback (ADK track item 3) ([a5b3113](https://github.com/LamaSu/physical-capability-cloud/commit/a5b31135275c1eaf82d826501f09fab50f182612))
* **gateway:** legacy settlement reads carry why a linked payout is unknown ([a6bcfb7](https://github.com/LamaSu/physical-capability-cloud/commit/a6bcfb7c34f7851cb221610289d16d5608d7ae7d))
* **gateway:** live provider re-read for externally authored plans (R10) ([26cc0a9](https://github.com/LamaSu/physical-capability-cloud/commit/26cc0a90b266f1ded399096a170822a819833a7e))
* **gateway:** matched-capability snapshot digest v2 (board N20) ([3a74686](https://github.com/LamaSu/physical-capability-cloud/commit/3a746861b06f469ffa3e4b92f331ee1a05391064))
* **gateway:** matched-capability snapshot digest v2 (board N20) ([9fa3263](https://github.com/LamaSu/physical-capability-cloud/commit/9fa3263e3565f89a7a7295168a060b0c13b1b78c))
* **gateway:** operator-onboarding funnel stages (ADK track item 4) ([55ca54a](https://github.com/LamaSu/physical-capability-cloud/commit/55ca54a6561f79695b94a0647bfd878b718bced5))
* **gateway:** operator-onboarding funnel stages (ADK track item 4) ([dfed522](https://github.com/LamaSu/physical-capability-cloud/commit/dfed522979957b60582745902fc5092ecf6943fa))
* **gateway:** SDK and wizard adapter templates carry quiesceEvidence(), and so do the test adapters ([781d398](https://github.com/LamaSu/physical-capability-cloud/commit/781d39876d71d3480c2565c7311517778c077845))
* **gateway:** server-side unmet-demand capture behind PCC_UNMET_CAPTURE_ENABLED (R44 D2) ([98e8e49](https://github.com/LamaSu/physical-capability-cloud/commit/98e8e490109bb12876cc9a8191fca278e455ac6d))
* **gateway:** server-side unmet-demand capture, flag default OFF (R44 D2, stacked on [#365](https://github.com/LamaSu/physical-capability-cloud/issues/365)) ([7b83f71](https://github.com/LamaSu/physical-capability-cloud/commit/7b83f717653b6f660339a78662c1cbb50c64f493))
* **gateway:** the V3 deadline-reclaim primitive, wired to nothing (N79) ([e663951](https://github.com/LamaSu/physical-capability-cloud/commit/e6639513fc7354c0729ce24c6b8c6ec6e433e7e2))
* **gateway:** the V3 deadline-reclaim primitive, wired to nothing (N79) ([e78a254](https://github.com/LamaSu/physical-capability-cloud/commit/e78a254076b67f6b2e9e23025cf7301a447556a5))
* **gateway:** v2 digest treats {0,0}/null kernel location as no-location ([9d3913b](https://github.com/LamaSu/physical-capability-cloud/commit/9d3913b6e115075db7d71c142e8f903edcf23cbe))
* **genui-b:** closed render IR + promotion - modern-port of [#272](https://github.com/LamaSu/physical-capability-cloud/issues/272) and the 6 orphaned promotion commits ([7597978](https://github.com/LamaSu/physical-capability-cloud/commit/7597978b96edf1e9135a18da977e0520d3a345c3))
* **genui-b:** derived render-state provenance - source-assigned class, freshness, no regression (PX-4; depends on [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344)) ([455e610](https://github.com/LamaSu/physical-capability-cloud/commit/455e610a071763d9f89a2b04c8fd0c2a0e234125))
* JobExecutionDTO read model; job detail stops reading mock data (PX-6) ([48b6f75](https://github.com/LamaSu/physical-capability-cloud/commit/48b6f7523af616f244fa4df7a48399db876703d0))
* **kernel:** every kernel adapter has an honest quiesceEvidence() ([af52d70](https://github.com/LamaSu/physical-capability-cloud/commit/af52d7096e2b7ed703138dfea4b00b126783bf56))
* **kernel:** LO-SE-1 pull-based camera capture. The kernel acquires every frame itself, for a named job; push-fed capture is simulated-only ([a5e5ff1](https://github.com/LamaSu/physical-capability-cloud/commit/a5e5ff1dbb366257bd9d0df392db43cffddb3b47))
* **kernel:** LO-SE-1 pull-based camera. The kernel acquires every frame itself, for a named job, and the push-fed adapter is simulated-only ([72efe69](https://github.com/LamaSu/physical-capability-cloud/commit/72efe69efc80d38aeb43910f6825777e9cfee307))
* **onboard-kit:** templates, quick-start and generated adapters carry quiesceEvidence() ([4c69833](https://github.com/LamaSu/physical-capability-cloud/commit/4c6983342ff3d5058f6e5cfc5c1e778842985d63))
* **pcc-node:** the operating agent's device runtime and job port (ADK item 12, first cut) ([15161b6](https://github.com/LamaSu/physical-capability-cloud/commit/15161b6a4fa330dddd7f1022956dc4a6603bb432))
* **pcc-node:** the operating agent's device runtime and job port (ADK item 12, first cut) ([697c4c7](https://github.com/LamaSu/physical-capability-cloud/commit/697c4c7c6b3965f5bea1c27711006c57a37fa407))
* **scripts:** pcc.source-digest/v1 and a verifier for served source (N5) ([8df65cd](https://github.com/LamaSu/physical-capability-cloud/commit/8df65cd45999ef692c920e49c88bbb10ec5d5067))
* **spec,demand-intel:** kit-demand signal and fixed periodic public release layer (R44, PX-13) ([75fd440](https://github.com/LamaSu/physical-capability-cloud/commit/75fd440b992dd7dbcee3c18c4c11e5216e05a071))
* **spec:** accepted-plan compiler — composition half of MS-01 (R12) ([d4d167d](https://github.com/LamaSu/physical-capability-cloud/commit/d4d167d848c65c4f959ae5ac9808d3b0e42eb32b))
* **spec:** ADK R8 safety envelope: draft from intake and cited references, confirm once, compile to typed I/O and a strict runtime envelope ([e5f5de1](https://github.com/LamaSu/physical-capability-cloud/commit/e5f5de1bcce6938fc6f8f4cc46e9141a06f55c9c))
* **spec:** economic agreements v1, an exact compiler to V-next per-unit payouts ([0972247](https://github.com/LamaSu/physical-capability-cloud/commit/09722478f68404d9cf35f7423fdd0886ed74dbb5))
* **spec:** implementer-uniform: add public acceptedPolicyDigest producer ([bc0e0fb](https://github.com/LamaSu/physical-capability-cloud/commit/bc0e0fb5f5b73e64404af2fa47f403ac3e30cb64))
* **spec:** LO-EV-1 canonical signing byte contract + cross-language goldens ([2a79af6](https://github.com/LamaSu/physical-capability-cloud/commit/2a79af660cebd8b4815aa45cd4d6dcfae5f3fed5))
* **spec:** OperationalEnvelopeV1, the strict runtime envelope compiled from a confirmed safety envelope (ADK R8) ([7cbe0e5](https://github.com/LamaSu/physical-capability-cloud/commit/7cbe0e558e4cc99bb4edfa782e00a0a802a132fa))
* **spec:** pin FinalMilestonePackageV2 principal ids (pcc.evidence.principal-id.v1) ([afcb6a8](https://github.com/LamaSu/physical-capability-cloud/commit/afcb6a83d9a49ca08aff3d99f13e8e34dc4b92cd))
* **spec:** pin FinalMilestonePackageV2 principal ids, each bound to a checked signature (pcc.evidence.principal-id.v1) ([da4c985](https://github.com/LamaSu/physical-capability-cloud/commit/da4c9854e6233ebf0de0b9794b58f4536daf8a70))
* **spec:** port [#336](https://github.com/LamaSu/physical-capability-cloud/issues/336)'s plain-data boundary, load-time intrinsics and canonicalize (verbatim from 8dc6ef2b) ([9214733](https://github.com/LamaSu/physical-capability-cloud/commit/921473367b3eaa869d27796d44c73dc38bfd6b80))
* **spec:** R8 reads kits' intake field ids and R5 findings: one-sided bounds, supervision, hazards (ADK R8) ([431c1d7](https://github.com/LamaSu/physical-capability-cloud/commit/431c1d78b89f4cd91dc63b0051fd77d62b5d6a71))
* **spec:** R8 round 4, part 1: the deadline needs no command parameter, and list-valued parameters declare allowedItems ([5954703](https://github.com/LamaSu/physical-capability-cloud/commit/595470313077c0290480d91b45b371696ea9da23))
* **spec:** safety envelope for onboarding: draft from intake and cited references, confirm once, compile to CSD typed I/O (ADK R8) ([b734398](https://github.com/LamaSu/physical-capability-cloud/commit/b734398a406a35c5ec6ff35388ad391bd7372203))
* **spec:** seal economics' agreementHash in acceptedDealDigest (economics [#2755](https://github.com/LamaSu/physical-capability-cloud/issues/2755)) ([2de38d7](https://github.com/LamaSu/physical-capability-cloud/commit/2de38d73e5a712cc2bcaf741626972eed7478c0b))
* **spec:** the accepted deal seals each node's execution contract (N25): canonicalPlan + planHash ([6060331](https://github.com/LamaSu/physical-capability-cloud/commit/60603316843e97825685da8bf2bb1c7a9f2a1acf))
* **spec:** the authorizedTuples words: keccak256 of each pinned principal id (oracle [#3101](https://github.com/LamaSu/physical-capability-cloud/issues/3101) item 4) ([c4cc8f8](https://github.com/LamaSu/physical-capability-cloud/commit/c4cc8f8e7ccbe84738965b4a1d3d40a26542e384))
* **spec:** the operator's quote is its price; agreement add-ons go on top (seam floor) ([c28bd34](https://github.com/LamaSu/physical-capability-cloud/commit/c28bd34e759cfb24d56aaadb6e8b45e3af0ff7ae))
* **spec:** the operator's quote reaches the economics splitter (economics [#3025](https://github.com/LamaSu/physical-capability-cloud/issues/3025), option b) ([9be1e8b](https://github.com/LamaSu/physical-capability-cloud/commit/9be1e8bb43363a5e73655df0eaa032b95cb6dcfd))
* **spec:** the public acceptedPolicyDigest producer (subjectBlockHash, bindingsRoot, digest; goldens from [#270](https://github.com/LamaSu/physical-capability-cloud/issues/270)) ([4a371a9](https://github.com/LamaSu/physical-capability-cloud/commit/4a371a9299e67dd2355bb73e1f79ce8df447ae35))


### Bug Fixes

* **adapter-pylabrobot:** a failed barrier holds the adapter until a retried barrier answers, and only job-bound notifications are evidence ([20a4972](https://github.com/LamaSu/physical-capability-cloud/commit/20a4972f82234aaac130b540846e6153179653c3))
* **adapter-pylabrobot:** a failed evidence barrier fails the run and stops the sidecar before start returns ([a10bf94](https://github.com/LamaSu/physical-capability-cloud/commit/a10bf949b33a9f4b84275f9f0c2ecac4842205c6))
* **adapter-pylabrobot:** a sidecar crash is evidence only of the job recording, and a recycle's own stop is none ([d6f93cc](https://github.com/LamaSu/physical-capability-cloud/commit/d6f93ccaec3b52aab3c34a9d00decd17656002e0))
* **adapter-pylabrobot:** evidence.stopRecording is a notification barrier, and a late job-bound notification is dropped ([61e8eb9](https://github.com/LamaSu/physical-capability-cloud/commit/61e8eb9e8c5c1a6b64eba738f3ef2df7cdd2b014))
* **adapter-pylabrobot:** recording windows are attested by the sidecar process that holds them, and nothing runs or completes without that proof ([a3d8437](https://github.com/LamaSu/physical-capability-cloud/commit/a3d84374d5639092bf52f53e0868700e78006b30))
* **adk:** every runbook summary says it ends with the stop drilled and the test job waiting (verdict 115e) ([8333cac](https://github.com/LamaSu/physical-capability-cloud/commit/8333cac739dea842a85b13b552b1df27aedda84a))
* **adk:** pcc-report also scrubs PEM keys, base64 keys and secret-named fields ([f70604d](https://github.com/LamaSu/physical-capability-cloud/commit/f70604dd7da636bd18b4fd57cd624561adea7c9a))
* **adk:** pin pcc-node to the release commit with verdict 68b's fixes ([932c0ae](https://github.com/LamaSu/physical-capability-cloud/commit/932c0aef8d6943b314a870c31ceeaf57fbaf7d23))
* **adk:** provision with the node's own public key, so no private key travels (R0 P9) ([9b54a22](https://github.com/LamaSu/physical-capability-cloud/commit/9b54a223fe15227202af21ffea8993a7c7e01b15))
* **adk:** send the API key from a header file, never on a command line ([e2b09e1](https://github.com/LamaSu/physical-capability-cloud/commit/e2b09e1e27177fc9410543cb288e69a6ab3d290d))
* **adk:** the runbook never calls unverified work verified, and never defaults money ([cfc5605](https://github.com/LamaSu/physical-capability-cloud/commit/cfc5605bd267b42775136ddc3518be10b491aac3))
* **adk:** the runbook reads the stop before anything runs, and the gateway cannot run its test job (verdict 115d) ([487ab59](https://github.com/LamaSu/physical-capability-cloud/commit/487ab5975ca0d1c92df867bf5269e3a2db4766a6))
* **adk:** the runbook submits no test job until the gateway can queue one without running it (verdict 115e) ([685c838](https://github.com/LamaSu/physical-capability-cloud/commit/685c838b474a22ecd39f0afe91ad2484f1b3cb92))
* **adk:** the runbook's test job moves no money, completion is computed, and the stop reads clear only from a stored policy (verdict 115c) ([7b155b2](https://github.com/LamaSu/physical-capability-cloud/commit/7b155b24b888a7c2574aae9dbbeffa6d00ba2cf8))
* **adk:** the session roll-up says the attempt ends blocked on the current gateway (verdict 115e) ([9d4653b](https://github.com/LamaSu/physical-capability-cloud/commit/9d4653bccec1e45d273297e02cbb31ecef6d896d))
* **agent-package:** drop node-local pcc_generate_ui from the public package ([bd2f714](https://github.com/LamaSu/physical-capability-cloud/commit/bd2f7148f41293c094c73d0b8603d6192669bb7a))
* **agent-pack:** an offer's status is a claim, the report schema is contract v1, and claims are bound to the running gateway (verdict 102g) ([bf315c3](https://github.com/LamaSu/physical-capability-cloud/commit/bf315c3797f761fded38ca5feefdf449eb714375))
* **agent-pack:** an offer's verified flag is not outcome proof, consent may be null, and the bindings close their gaps (verdict 102h) ([4ca28ea](https://github.com/LamaSu/physical-capability-cloud/commit/4ca28ea2be1b29378c009abac90a3dba90058089))
* **agent-pack:** count evidence only when stored, enforce contract v1, bind claims to code ([f48d1cf](https://github.com/LamaSu/physical-capability-cloud/commit/f48d1cfa97a6ce9a5623d9bff7d6c8715f1b1b41))
* **agent-pack:** double-quote the pcc-node install lines so they work in cmd.exe ([46354b6](https://github.com/LamaSu/physical-capability-cloud/commit/46354b62661983d516a99ce0c4d664a0a9ee5249))
* **agent-pack:** install pcc-node with the crypto extra, or it can never sign evidence (item 2a) ([52015b2](https://github.com/LamaSu/physical-capability-cloud/commit/52015b2e3fb4198e099c06cce64bdc69523af8d0))
* **agent-pack:** match the gateway rehearsal R0 ran against (P1, P4-P8, G8, G9) ([6b04c23](https://github.com/LamaSu/physical-capability-cloud/commit/6b04c235f7b63058b8e9ba0faef5d6acea674736))
* **agent-pack:** only true statements, attempt reporting, [#427](https://github.com/LamaSu/physical-capability-cloud/issues/427) folded in, the operator's thesis (ADK item 2: N75, N76, rehearsal R0, contract v1) ([7a46271](https://github.com/LamaSu/physical-capability-cloud/commit/7a4627175d7940056a76f964cab50d34c75e1e9f))
* **agent-pack:** P7, the node path finishes a job with evidence then status completed ([419b3e0](https://github.com/LamaSu/physical-capability-cloud/commit/419b3e0f3ea2f7a62ba2a33889be95f21acd9c7b))
* **agent-pack:** tell agents only true things: route, packages, counts, announce, install (item 2a; N75, N76) ([fbc6b2b](https://github.com/LamaSu/physical-capability-cloud/commit/fbc6b2b4da8f7f1dc8fff6bc98cb481ea23adfb3))
* **contracts:** close the deploy-record path gaps from the [#339](https://github.com/LamaSu/physical-capability-cloud/issues/339) review ([d269000](https://github.com/LamaSu/physical-capability-cloud/commit/d269000ac6bf95015712a1ae415615ae8bf4aa7e))
* **contracts:** contain the deploy record root at, above and below it ([eba7fc5](https://github.com/LamaSu/physical-capability-cloud/commit/eba7fc5db256c38ae6de36b4c55a7746fe4c3dbd))
* **contracts:** detect a symlinked record root on forge 1.8.0 too ([4bd6e66](https://github.com/LamaSu/physical-capability-cloud/commit/4bd6e66570f1e02bbe3fd03677b6b8c34c9cfc65))
* **contracts:** grant the V-next deploy script its deployments/vnext file access ([6d0a895](https://github.com/LamaSu/physical-capability-cloud/commit/6d0a895abd1a1eaf1017d2c8ba508bf800b2abe4))
* **contracts:** guard the record tests' own writes; no silent skip of the symlink tests ([5246aa3](https://github.com/LamaSu/physical-capability-cloud/commit/5246aa37c7641a0a402a4a0255c2da5cd2e877e3))
* **contracts:** name every fund() revert in the ABI subset ([044a961](https://github.com/LamaSu/physical-capability-cloud/commit/044a96127c96e377f0adda654ef108dd2d1faf0f))
* **contracts:** pin the V-next funding preflight to one block and to the compiled expiry ([ad6a74b](https://github.com/LamaSu/physical-capability-cloud/commit/ad6a74b8783edfadca7e667d50be877f73094671))
* **contracts:** the preflight pins one block by hash and judges frozen inputs (R14 round 3) ([4b5d746](https://github.com/LamaSu/physical-capability-cloud/commit/4b5d746567b6d294ec7eed05af96fea2c10447b4))
* **contracts:** the preflight reads the requested block at the call, like every input (R14, 26d follow-up) ([0deffb0](https://github.com/LamaSu/physical-capability-cloud/commit/0deffb07eaf0ecdf05978c28de120d5da82f4e54))
* **contracts:** uint64 reclaimAt bound, plus compiler/contract boundary parity ([bfebb40](https://github.com/LamaSu/physical-capability-cloud/commit/bfebb40d38b0430a16b84a000a3f85a2646a492a))
* **contracts:** verify() re-derives the factory's CREATE2 address from this build (N38, LO-ES-2) ([68a56e6](https://github.com/LamaSu/physical-capability-cloud/commit/68a56e66e06aec5adc39004e8f157d6f1d74b84b))
* **contracts:** verify() re-derives the factory's CREATE2 address from this build (N38, LO-ES-2) ([08f24f1](https://github.com/LamaSu/physical-capability-cloud/commit/08f24f12ef5686c0395a453e1a9aee4f764edcf0))
* **copy:** align published copy with the public-beta status and add a claims check ([e47c2f6](https://github.com/LamaSu/physical-capability-cloud/commit/e47c2f65ac89e48ec1c73afee9947359da1aac55))
* **copy:** describe settlement as USDC escrow on the test network ([226b5fe](https://github.com/LamaSu/physical-capability-cloud/commit/226b5fe4856b10790892456928b87e0292febd42))
* **dashboard:** /discover and /leaderboard no longer crash on a cold load (React [#310](https://github.com/LamaSu/physical-capability-cloud/issues/310)) ([269f36e](https://github.com/LamaSu/physical-capability-cloud/commit/269f36ee3beafcb769105de615de8491e6729f90))
* **dashboard:** /discover, /leaderboard and /kernels no longer crash on a cold load (React [#310](https://github.com/LamaSu/physical-capability-cloud/issues/310)) ([ad42b2c](https://github.com/LamaSu/physical-capability-cloud/commit/ad42b2ca823ae479de32f1374ea68094c76d226d))
* **dashboard:** /go's quickstart scripts are text assets, and ?q= goes in as a string literal ([b082d93](https://github.com/LamaSu/physical-capability-cloud/commit/b082d93fe2bbadbefc9b4fa39c84a28494225203))
* **dashboard:** /onboard.html is operable by keyboard and screen reader (N74) ([138863a](https://github.com/LamaSu/physical-capability-cloud/commit/138863ac54b5b4cd2b7941f52b1a6ef53f678b0f))
* **dashboard:** /onboard.html is operable by keyboard and screen reader (N74) ([b0bc830](https://github.com/LamaSu/physical-capability-cloud/commit/b0bc8301a34533e0b4faa559d2ab9a9744a07bd8))
* **dashboard:** /onboard.html keeps focus on the current step and honours reduced motion (N74 follow-ups) ([3479cda](https://github.com/LamaSu/physical-capability-cloud/commit/3479cda40f3d7ff6ad6bf144da92c98b7fa71cfe))
* **dashboard:** /onboard.html keeps focus on the current step and honours reduced motion (N74 follow-ups) ([3c902a0](https://github.com/LamaSu/physical-capability-cloud/commit/3c902a03b755c60facfebf4fc4d6f49a4c70364b))
* **dashboard:** a key change that can't be told is refused before it lands, and the lint follows local aliases of protected targets (astra A03f N1, F1) ([ddc7fab](https://github.com/LamaSu/physical-capability-cloud/commit/ddc7fab7655f798d6fd7d8dd683c6c1937133ed9))
* **dashboard:** a protected object handed to any call counts, directly or through a local name holding it (self-found, A03f F1's family) ([00ca50c](https://github.com/LamaSu/physical-capability-cloud/commit/00ca50c726725c2830d7028ca386a2f017ca5461))
* **dashboard:** a refused job read hides cached money; a stale payout is never colored ([1a005b3](https://github.com/LamaSu/physical-capability-cloud/commit/1a005b35a299eafed57482513c7a137db79a08c5))
* **dashboard:** a throwing key listener can't skip the identity change, and the lint sees mutation-API writes (astra A03e N1, F1) ([5701d4e](https://github.com/LamaSu/physical-capability-cloud/commit/5701d4e394ba25dde4ddab497cf647a9a5d1ecf9))
* **dashboard:** an operator-bound passkey registration fails closed without the authorized fetch ([9fc7956](https://github.com/LamaSu/physical-capability-cloud/commit/9fc79565f3474e8ad99744300445d3c10aea53ac))
* **dashboard:** every key change is an identity change, and the key lint reads code, not lines (astra A03d N1, F1) ([0d5c389](https://github.com/LamaSu/physical-capability-cloud/commit/0d5c389115dc7f7004d1c04dd20a1e42ce437845))
* **dashboard:** label illustrative sections on the landing page ([b3351d7](https://github.com/LamaSu/physical-capability-cloud/commit/b3351d7f3f920c1ba6622dacbb20db86d1a98b83))
* **dashboard:** N50 — /setup and /setup/agent never send the API key to localhost:3200 ([a43ecb0](https://github.com/LamaSu/physical-capability-cloud/commit/a43ecb061ebff466c682716f12941f5da08cd18a))
* **dashboard:** no export returns the API key, sendBeacon is guarded, and the ratchet has no exemptions ([a8153f9](https://github.com/LamaSu/physical-capability-cloud/commit/a8153f9e641f80e269fcbc0f5b6fbbdac71ef934))
* **dashboard:** session recording never captures the key or recovery words (N50) ([cfe3ce9](https://github.com/LamaSu/physical-capability-cloud/commit/cfe3ce93dddc2052d9cc483ce28fb98671388cc3))
* **dashboard:** the API key goes only to one validated gateway origin (N50 review) ([74f758b](https://github.com/LamaSu/physical-capability-cloud/commit/74f758ba1781ceabdd9c6d1cfd5e3b57451656d4))
* **dashboard:** the API key has one reader and one sender (N50 round 2) ([abdae93](https://github.com/LamaSu/physical-capability-cloud/commit/abdae93f31e73d11773c9a436152eca60b1fb389))
* **dashboard:** the key lint reads x["y"] as x.y, refuses reads that hand back a protected object, and checks every change's target (astra A03g) ([57bdc18](https://github.com/LamaSu/physical-capability-cloud/commit/57bdc18cf48a6e83f115a8f401da4133fe370b5f))
* **dashboard:** the key lint rejects aliasing a protected object instead of chasing aliases (astra A03f F1, the whole family) ([426eb4b](https://github.com/LamaSu/physical-capability-cloud/commit/426eb4b72ae8c4d2fc66136ca7488506df7ddc29))
* **dashboard:** the lint's mutation check matches by method on any receiver, and any call handed a built-in's prototype (self-found, A03e F1's family) ([5396b25](https://github.com/LamaSu/physical-capability-cloud/commit/5396b25ffdb7e3e5927f64584a8aced1c2fbddb3))
* **dht-core:** endpoint URLs sort by code unit, never locale collation (E1 finding 2) ([011a737](https://github.com/LamaSu/physical-capability-cloud/commit/011a7379ba8e71d0bf06d7250643d283b81e2eae))
* **dht-core:** endpoints order totally, and serialize in one key order (review E1b) ([7621965](https://github.com/LamaSu/physical-capability-cloud/commit/762196590f208d4e288afa5dc0c8e5afbd821a1e))
* **dht-core:** refuse a non-finite endpoint priority (review E1c) ([7bc7251](https://github.com/LamaSu/physical-capability-cloud/commit/7bc7251489e6bc90d36085ec3779e48ea0e3c099))
* **evidence:** LO-EV-1 review R20 round 2 -- refuse an empty derivationPath, one number domain, shared accept/reject vectors ([92b4302](https://github.com/LamaSu/physical-capability-cloud/commit/92b4302b6aee8a267ccbaef857458033b841ec67))
* **evidence:** LO-EV-1 review R20 round 3 -- one strict JSON boundary in both languages, and a CI job where missing PyNaCl fails ([6cea24d](https://github.com/LamaSu/physical-capability-cloud/commit/6cea24da3159a2c6b33afdd4256fa808eb85ffcc))
* **evidence:** LO-EV-9 binds every event to the job (and unit), and kernel-sdk names the job on every event ([0a4836a](https://github.com/LamaSu/physical-capability-cloud/commit/0a4836a672a8e55fbd7dd05d86e71bbfda9aa81f))
* **evidence:** LO-EV-9 evaluates only what it hashed; the settlement anchor carries the canonical snapshots ([9835261](https://github.com/LamaSu/physical-capability-cloud/commit/983526191fe1ba2396956d0103f2449f428d1dc2))
* **evidence:** measure the signing-input depth limit on the JSON text (A01b-q1) ([20a37a5](https://github.com/LamaSu/physical-capability-cloud/commit/20a37a5fc930819b7622b17aea93e915c8c368c0))
* **federation:** LWW tie-break uses code-unit order, never locale collation (E1 finding 1) ([430d3fd](https://github.com/LamaSu/physical-capability-cloud/commit/430d3fd401598070564fd2706324a6d088d52d1e))
* **gateway,db:** operator funnel counts only real, attributable progress ([#469](https://github.com/LamaSu/physical-capability-cloud/issues/469) round 1) ([a9dbf24](https://github.com/LamaSu/physical-capability-cloud/commit/a9dbf245e18db0d53efdc80b03289f8fae573dcb))
* **gateway,payments:** bounty surfaces stop presenting unfunded or unverified state (kits K0 slice 1) ([26848e0](https://github.com/LamaSu/physical-capability-cloud/commit/26848e0620c2b4913c41a17be94ecae858edfd06))
* **gateway,payments:** no fabricated SWF accruals, distribution time or chain balance ([1c18aa8](https://github.com/LamaSu/physical-capability-cloud/commit/1c18aa8c36d50a1d3e475bcb500f99a02b999697))
* **gateway,payments:** no fabricated SWF accruals, distribution time or chain balance ([4e79258](https://github.com/LamaSu/physical-capability-cloud/commit/4e792587bc3bf61eb2406e7c994af72dfc7f4cfa))
* **gateway,payments:** SWF money mutations answer 501; the summary labels simulation totals ([2e50fea](https://github.com/LamaSu/physical-capability-cloud/commit/2e50fead729ef8d72ad42fa0f5f301a9d51bf568))
* **gateway,spec:** capture records only reason-consistent keys; ingest parses the caller schema (PX-13 round-1 F3, F5) ([991e635](https://github.com/LamaSu/physical-capability-cloud/commit/991e635b8c811930c383572c8582a43f55e1b0c7))
* **gateway:** [#440](https://github.com/LamaSu/physical-capability-cloud/issues/440) review follow-up: v2 digest tier and location handling (N20) ([6ef4b34](https://github.com/LamaSu/physical-capability-cloud/commit/6ef4b3407db08eb86d652a6831dd294e86771daf))
* **gateway:** /api/health reports the source digest; the commit is a build argument's claim (N5) ([472c621](https://github.com/LamaSu/physical-capability-cloud/commit/472c6218e783b698529084a050d6c597f305af1f))
* **gateway:** a busy refusal is not a device failure ([#5205](https://github.com/LamaSu/physical-capability-cloud/issues/5205)) ([f806a34](https://github.com/LamaSu/physical-capability-cloud/commit/f806a3411eb0ce737de4fb06136a1b409bff7926))
* **gateway:** a duplicate create reports kernelId/type conflicts as ignored (astra pack 111 MEDIUM 4) ([052ff70](https://github.com/LamaSu/physical-capability-cloud/commit/052ff70a6820d724c4c57459c550acfee2c1dc0f))
* **gateway:** a failed or cancelled job is terminal for every generic writer ([#475](https://github.com/LamaSu/physical-capability-cloud/issues/475), review round 3) ([f8d409a](https://github.com/LamaSu/physical-capability-cloud/commit/f8d409ab6421449e568072b4c16faa90c3caf09f))
* **gateway:** a legacy milestone is this job's only when the settlement axis attributed it (F1) ([cec7fce](https://github.com/LamaSu/physical-capability-cloud/commit/cec7fcee9e2e32d563417261a85def473de71394))
* **gateway:** a paid job is finished only by its settlement path (N85a) ([a9a05ac](https://github.com/LamaSu/physical-capability-cloud/commit/a9a05ac32d97950d5dc55c98d909ebb146ddb7c1))
* **gateway:** a paid job is finished only by its settlement path (N85a) ([5c34d2e](https://github.com/LamaSu/physical-capability-cloud/commit/5c34d2e033afbbb0c9c4e0097796b9b0afbbf5f6))
* **gateway:** a price headline is accepted only when the v1 digest writes exactly its value ([#439](https://github.com/LamaSu/physical-capability-cloud/issues/439) follow-up, astra 130) ([b02d197](https://github.com/LamaSu/physical-capability-cloud/commit/b02d197eb833910b369c8d6b5fe4d2917aede8d7))
* **gateway:** a security fingerprint is a closed schema, and no monitor log or payment row keeps a caller's value (N107 r2) ([b8a3b5c](https://github.com/LamaSu/physical-capability-cloud/commit/b8a3b5c04769d440e32033c0a833fdccb5f9b23f))
* **gateway:** a tier list whose length reads below one is refused ([#440](https://github.com/LamaSu/physical-capability-cloud/issues/440) follow-up, confirmation round) ([93cefa9](https://github.com/LamaSu/physical-capability-cloud/commit/93cefa96b537cbccd0e365469f3c15b7fa00f926))
* **gateway:** after PX-1, a milestone record's "released" is reported_released, never paid ([513b933](https://github.com/LamaSu/physical-capability-cloud/commit/513b933ad7d1aaa55647677ee7b20996d6869b35))
* **gateway:** allowlist operator-channel credentialRef (N84) ([4e333c7](https://github.com/LamaSu/physical-capability-cloud/commit/4e333c73e5502935a6984c212e5b6f892ab3f04a))
* **gateway:** an anonymous caller can no longer create a capability (N43) ([f9ab866](https://github.com/LamaSu/physical-capability-cloud/commit/f9ab866ef032f1515690ba0849a332b2f0c3d440))
* **gateway:** an anonymous caller can no longer create a capability (N43) ([ec5337c](https://github.com/LamaSu/physical-capability-cloud/commit/ec5337cddd0e6c4ae45e754e41283ab91043d2ee))
* **gateway:** an encoded sink prefix decodes even when a later escape is malformed ([#458](https://github.com/LamaSu/physical-capability-cloud/issues/458) round 4) ([ab2059d](https://github.com/LamaSu/physical-capability-cloud/commit/ab2059d8a68b7383e1854054457a7ae75517bb96))
* **gateway:** an event bundle must commit the job and its kernel in its hashed events (E4b) ([15ebb46](https://github.com/LamaSu/physical-capability-cloud/commit/15ebb4680098689a2d348a1e18f503182c962d89))
* **gateway:** approve and reject answer 409 already_decided when the update changed nothing ([eb0318e](https://github.com/LamaSu/physical-capability-cloud/commit/eb0318e42dc2acd26bc8a70b98daea5a95ac4ffe))
* **gateway:** attribute operator-funnel stages to the authenticated operator ([6cf7067](https://github.com/LamaSu/physical-capability-cloud/commit/6cf70672de6724984eb0b551e455ee5fc747a6df))
* **gateway:** availability accepts every IANA zone name; the pack-111 test accepts WP-A's provisioning refusal ([61a6183](https://github.com/LamaSu/physical-capability-cloud/commit/61a6183457f4d60833861c1c591ca7c866e240a1))
* **gateway:** availability writes need a SIWE-proven owner; EVM-only compare; real tz and cron (astra pack 111 HIGH 1, HIGH 2, MEDIUM 3) ([e7b29bd](https://github.com/LamaSu/physical-capability-cloud/commit/e7b29bd95cffdb1b3719c7e14350cf745e04299c))
* **gateway:** block all of IPv6 ::/8 and drop dead N84 guard code ([c52b0a5](https://github.com/LamaSu/physical-capability-cloud/commit/c52b0a52630e436871227d5f9b46086291f81e72))
* **gateway:** block SSRF through operator-channel webhook URLs (N84) ([e7608c1](https://github.com/LamaSu/physical-capability-cloud/commit/e7608c1a5f93bd21f29356b3120a25a786baf80d))
* **gateway:** bound outstanding DNS resolutions in the N84 outbound guard ([740ef23](https://github.com/LamaSu/physical-capability-cloud/commit/740ef23d2e411d3932011f66a4490d4b3e99b398))
* **gateway:** bound outstanding DNS resolutions in the N84 outbound guard (astra pack 144 MEDIUM) ([e49ac13](https://github.com/LamaSu/physical-capability-cloud/commit/e49ac13c9f7dc7dac0380c31f590bf59a080a857))
* **gateway:** bounty and type-level bounty routes stop claiming what they don't do ([cad433c](https://github.com/LamaSu/physical-capability-cloud/commit/cad433ce3885ce1f38e77938ae985de9ff8314a2))
* **gateway:** close [#458](https://github.com/LamaSu/physical-capability-cloud/issues/458) round-1 findings (secret/PII sinks, bounded anti-abuse state) ([6d29580](https://github.com/LamaSu/physical-capability-cloud/commit/6d295802d6987c39739d17e59afbd63b1da681c0))
* **gateway:** close four matchableTerms gaps from astra's [#439](https://github.com/LamaSu/physical-capability-cloud/issues/439) review ([3a7721e](https://github.com/LamaSu/physical-capability-cloud/commit/3a7721e81cdb01a4fcc0ce0ab6614ec530e83177))
* **gateway:** close four matchableTerms gaps from astra's [#439](https://github.com/LamaSu/physical-capability-cloud/issues/439) review ([#439](https://github.com/LamaSu/physical-capability-cloud/issues/439) follow-up) ([49a6c5f](https://github.com/LamaSu/physical-capability-cloud/commit/49a6c5fff0a12467ed530b151da1cdb7ae82cc3f))
* **gateway:** close v2 tier-iteration gap and pin v1 from astra's [#440](https://github.com/LamaSu/physical-capability-cloud/issues/440) review ([46f3d45](https://github.com/LamaSu/physical-capability-cloud/commit/46f3d45d997968738a88c0240bac5308763c3e14))
* **gateway:** create-capability reports ignored fields instead of dropping them (N83, R0 G12) ([4ce7b5c](https://github.com/LamaSu/physical-capability-cloud/commit/4ce7b5ce910e449edc556463dbf8373c243b5ba3))
* **gateway:** GET /api/jobs bounds and coerces offset and limit, so a page never exceeds its limit (N111) ([9ca75b4](https://github.com/LamaSu/physical-capability-cloud/commit/9ca75b40d54256bbdfabbc0c325bef7a53e4096d))
* **gateway:** GET /api/jobs bounds and coerces offset and limit, so a page never exceeds its limit (N111) ([a0f9ddf](https://github.com/LamaSu/physical-capability-cloud/commit/a0f9ddf95a1e415058808e054deb81179af627b0))
* **gateway:** job execution reads need a proven wallet; a shared milestone is not this job's ([c0b8068](https://github.com/LamaSu/physical-capability-cloud/commit/c0b80681dafa5e2be907ff6282e6f2438f066b6e))
* **gateway:** JobExecutionDTO scopes evidence through the job, not an unwritten tenant column ([938a180](https://github.com/LamaSu/physical-capability-cloud/commit/938a180e7db89afc9e802ffb66f44a4edd6a8259))
* **gateway:** key holders are volume, proven wallets are breadth; capture off the response path (gateway review [#2975](https://github.com/LamaSu/physical-capability-cloud/issues/2975)) ([ebf7c70](https://github.com/LamaSu/physical-capability-cloud/commit/ebf7c70a3e870e1af98e552a44ea6fa32062d11c))
* **gateway:** legacy settlement reads report a recorded release as reported_released ([9947a2a](https://github.com/LamaSu/physical-capability-cloud/commit/9947a2a680cd8ab15a1774d594931abfe708fea6))
* **gateway:** legacy settlement reads say only what the job's escrow records show ([5fcd851](https://github.com/LamaSu/physical-capability-cloud/commit/5fcd85122d71797bdaff862bebaf6db5d0c5292c))
* **gateway:** linear-time summary normalisation; roll-up signatures only when no phase failed ([abd13cc](https://github.com/LamaSu/physical-capability-cloud/commit/abd13cc4bb7cd34c9e114c006a7e3f998eedb878))
* **gateway:** N83 follow-ups: every IANA zone name; the pack-111 test accepts WP-A's provisioning refusals ([5702e98](https://github.com/LamaSu/physical-capability-cloud/commit/5702e984a43133e8a189240e8c74679e5f979928))
* **gateway:** N83 operator contracts — owner-set availability, no silent drops (R0 G8/G9/G11/G12) ([139922d](https://github.com/LamaSu/physical-capability-cloud/commit/139922dce5ed35d9ab7c8d00e559dbc947982778))
* **gateway:** no certificate is served or minted until minting is real (N80) ([48c7db9](https://github.com/LamaSu/physical-capability-cloud/commit/48c7db9d3f301b94591584084a9ce42b0e9cc43d))
* **gateway:** no generic status write moves a job out of evidence_stored or completed ([#475](https://github.com/LamaSu/physical-capability-cloud/issues/475), review round 2) ([e597687](https://github.com/LamaSu/physical-capability-cloud/commit/e597687b6f35490c9f2c32867147fc0852502a73))
* **gateway:** operator approval creation stores an omitted capabilityType as unknown, never liquid-handler ([668c9a2](https://github.com/LamaSu/physical-capability-cloud/commit/668c9a2ab9b6909cabc057e762fd46b619070ea6))
* **gateway:** operator approvals list answers 503 on a failed read, never an empty list ([597cc0e](https://github.com/LamaSu/physical-capability-cloud/commit/597cc0ec370146ccbc9879a35cc5a828b19b3d78))
* **gateway:** operator channels are no SSRF and no signing oracle (N84, LIVE) ([753feb4](https://github.com/LamaSu/physical-capability-cloud/commit/753feb43a0cdc6032e7879310bf018b296c1b03c))
* **gateway:** operator read routes stop fabricating earnings and fleet data ([670b3b8](https://github.com/LamaSu/physical-capability-cloud/commit/670b3b8b7818531c5e5b4b2cc9883abef8ff6817))
* **gateway:** R10 captures requested ids before its loaders; hidden duplicates look absent (astra, round 2 of [#355](https://github.com/LamaSu/physical-capability-cloud/issues/355)) ([478dd7c](https://github.com/LamaSu/physical-capability-cloud/commit/478dd7c001139406fba25d7119e87dc3b9cccb23))
* **gateway:** R10 kernel-status allowlist, tenant ids, duplicate live rows, one CSD mapping (ChatGPT review of c48af89c) ([d9a2185](https://github.com/LamaSu/physical-capability-cloud/commit/d9a2185ca322e8dbc02d3d4b1bab05644e0aafff))
* **gateway:** register-device names missing fields and keeps the reported firmware (N83, R0 G8) ([2dd8428](https://github.com/LamaSu/physical-capability-cloud/commit/2dd842847d95ca64da1bc05d2699b211520ff4b4))
* **gateway:** register-device with no body gets the missing-fields 400 (astra pack 111 MEDIUM 5) ([8b7c4ab](https://github.com/LamaSu/physical-capability-cloud/commit/8b7c4ab90b91f44bdbaa920120e8f22dcf82cdfe))
* **gateway:** sign each reclaim before broadcasting it; error text can never lose the record ([#477](https://github.com/LamaSu/physical-capability-cloud/issues/477) round 2) ([f6fa587](https://github.com/LamaSu/physical-capability-cloud/commit/f6fa5877e7e737f8fe21782b603900cb5e588ce3))
* **gateway:** statuses only the gateway writes take no generic write (N85a, review round 1) ([326fc0b](https://github.com/LamaSu/physical-capability-cloud/commit/326fc0b3cb6915d98666eb67e22a696f91763fa2))
* **gateway:** storage upload error tells callers to POST, not PUT (N83, R0 G9) ([2cc5358](https://github.com/LamaSu/physical-capability-cloud/commit/2cc535803883ad9ca11e46fbaf301c810cac1021))
* **gateway:** stored evidence and certificates tell the truth (N80) ([2c3d448](https://github.com/LamaSu/physical-capability-cloud/commit/2c3d4485d4e74f92218573ce02a449867566aaba))
* **gateway:** telemetry lookalikes and the request logger keep no caller URL ([#458](https://github.com/LamaSu/physical-capability-cloud/issues/458) round 3) ([e921867](https://github.com/LamaSu/physical-capability-cloud/commit/e921867ea9c3c10089a29e66402dfdd69f6c8ad9))
* **gateway:** the approvals list refuses a repeated parameter as 400, and the 404 says only "not found" (N32) ([c5304bf](https://github.com/LamaSu/physical-capability-cloud/commit/c5304bfe645385060ada63b9e057886cfcf0c8b0))
* **gateway:** the bounty demand list is suppressed like /top (astra pack 36 MEDIUM) ([f2015b8](https://github.com/LamaSu/physical-capability-cloud/commit/f2015b8b9bff33fc36a0378ea51d8806b8ecddf0))
* **gateway:** the legacy decomposer never matches on invented terms (board N23) ([25d2d16](https://github.com/LamaSu/physical-capability-cloud/commit/25d2d16b4f8148433a4b711a61ac9f3597d89744))
* **gateway:** the legacy decomposer never matches on invented terms (board N23) ([b2e211a](https://github.com/LamaSu/physical-capability-cloud/commit/b2e211a34e5d2e47f5a8180e5f86f993ce121a1f))
* **gateway:** the legacy settlement routes read behind [#353](https://github.com/LamaSu/physical-capability-cloud/issues/353)'s job-read gate (F1) ([d53286b](https://github.com/LamaSu/physical-capability-cloud/commit/d53286bb7e4bc00d73fb33ba5c65cab9a6f4d02b))
* **gateway:** the operator relay stores a true evidence hash, never sha256-&lt;bundleId&gt; (N80) ([a907c4c](https://github.com/LamaSu/physical-capability-cloud/commit/a907c4c7d55f0181aaac058408d0e1010b52e88a))
* **gateway:** the owner can set a capability's availability (N83, R0 G11) ([1374c2f](https://github.com/LamaSu/physical-capability-cloud/commit/1374c2fe726ed19c05ad88a0248f839e4fc653de))
* **gateway:** the reclaim never loses a partial record; fork tests skip for real ([#472](https://github.com/LamaSu/physical-capability-cloud/issues/472) follow-ups) ([49edcc2](https://github.com/LamaSu/physical-capability-cloud/commit/49edcc2f21afe92008a9df4868d0ea1f45c6029e))
* **gateway:** the reclaim never loses a partial record; unavailable fork tests skip for real ([#472](https://github.com/LamaSu/physical-capability-cloud/issues/472) follow-ups) ([992016e](https://github.com/LamaSu/physical-capability-cloud/commit/992016eeab178cb2db60cb303dbdf4497324dde6))
* **gateway:** the relay binds a signed document to its job and kernel (adk [#4322](https://github.com/LamaSu/physical-capability-cloud/issues/4322)) ([e415d95](https://github.com/LamaSu/physical-capability-cloud/commit/e415d9550f009a94e088ea3bac427a56ce183b42))
* **gateway:** the relay stores only what it can reproduce, atomically, from one envelope (review E4) ([103c747](https://github.com/LamaSu/physical-capability-cloud/commit/103c7478b8bd285697cf37ee25ac4a10da77f75e))
* **gateway:** the security monitor and payment stats keep no request content (N107) ([b75ff12](https://github.com/LamaSu/physical-capability-cloud/commit/b75ff123bc825507ef80140488708457385b8814))
* **gateway:** the security monitor and payment stats keep no request content (N107) ([081b0c4](https://github.com/LamaSu/physical-capability-cloud/commit/081b0c4908d23f707b8d64db3d91608b6290e67b))
* **gateway:** the served commit comes only from a file baked into the image ([017df1b](https://github.com/LamaSu/physical-capability-cloud/commit/017df1bb7496a4da1a140a8d5302ef54893a0461))
* **gateway:** write audit keeps only the route path for the telemetry sink ([#458](https://github.com/LamaSu/physical-capability-cloud/issues/458) round 2) ([729f545](https://github.com/LamaSu/physical-capability-cloud/commit/729f5452eee822989c8f01274d17256078ae7c7c))
* **genui-b:** absence, freshness and regression hardened per cross-family review ([6b4453f](https://github.com/LamaSu/physical-capability-cloud/commit/6b4453fb9311af8b92f8bd2dfb2e8c88e0e68e57))
* **genui-b:** keep [#348](https://github.com/LamaSu/physical-capability-cloud/issues/348)'s "not reported" absence marker through the [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) merge ([c2edf19](https://github.com/LamaSu/physical-capability-cloud/commit/c2edf196dd299e302e5be24836092b37650a2173))
* **genui-b:** the typed stat painter checks a status value with boundValueText ([#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) astra r2 F2) ([14f2f1c](https://github.com/LamaSu/physical-capability-cloud/commit/14f2f1c2bae5fcccabe59d0ca6468e818e0031db))
* **genui-b:** the typed stat painter qualifies a status metric too ([#3013](https://github.com/LamaSu/physical-capability-cloud/issues/3013)) ([cd9a592](https://github.com/LamaSu/physical-capability-cloud/commit/cd9a592dbfde3631918e9238cf3471e87ce92f83))
* **genui-ir:** a record's status word is never a payment fact (pcc-design [#3013](https://github.com/LamaSu/physical-capability-cloud/issues/3013)) ([fb8ebe8](https://github.com/LamaSu/physical-capability-cloud/commit/fb8ebe8f4282ff186e58c1b0babf99e4e2a818c5))
* **genui-ir:** an identifier cannot spell a claim the word window misses (review of [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r6) ([a3521ba](https://github.com/LamaSu/physical-capability-cloud/commit/a3521badc7e3e96a5d5077efcd8b01862b349b30))
* **genui-ir:** astra r2 F1-F4: claim detector hardened, split claims, bound values, structural notice ([cc570b0](https://github.com/LamaSu/physical-capability-cloud/commit/cc570b03684d58386718a077898f69f496170951))
* **genui-ir:** identifiers are attributed like free text; the backstop joins raw values of every attributed kind (steward [#5149](https://github.com/LamaSu/physical-capability-cloud/issues/5149) on [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r6) ([7f6d8d4](https://github.com/LamaSu/physical-capability-cloud/commit/7f6d8d433d62af710ffaf679c73636bfb8c82578))
* **genui-ir:** list rows are read by each route's own rows key; typed list fields pinned against the real producers (review of [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r5) ([c3e04dd](https://github.com/LamaSu/physical-capability-cloud/commit/c3e04dd93caaa05955a1b8f844ef4f89dac0e752))
* **genui-ir:** the list backstop also joins a status's raw value; pin the backstop and the currency type (review of [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344) r4) ([8c6d17f](https://github.com/LamaSu/physical-capability-cloud/commit/8c6d17f1738ad3742b5423f51d57c324a2bf8572))
* **genui-ir:** versions and percents are closed grammars (astra r6 on [#344](https://github.com/LamaSu/physical-capability-cloud/issues/344)) ([aafaa0a](https://github.com/LamaSu/physical-capability-cloud/commit/aafaa0a362cc4d422d7ea0ef23572e378102ac4f))
* **kernel:** a busy refusal says so (JobResult.busy), so a caller queues the job instead of counting a device failure ([c87eff4](https://github.com/LamaSu/physical-capability-cloud/commit/c87eff4798cfd122770db9fffe1a54d328d0b913))
* **kernel:** a camera event counts toward a tier only as a closed LO-SE-1 capture for this job ([f5ed362](https://github.com/LamaSu/physical-capability-cloud/commit/f5ed3621450d2a1e034dbba85b4617383880a88c))
* **kernel:** a real-mode IPP progress event names the printer's job as ippJobId, so it is recorded (LO-EV-9) ([ab23585](https://github.com/LamaSu/physical-capability-cloud/commit/ab23585de79f598252744e92442af71701e7c12e))
* **kernel:** a sensor stop that fails is made again on the failure path, and cannot abort its cleanup ([2b6ab6a](https://github.com/LamaSu/physical-capability-cloud/commit/2b6ab6ab404f93e9b092240239ee95244dc40462))
* **kernel:** an event the runner accepted but could not record fails the run ([9be4e5f](https://github.com/LamaSu/physical-capability-cloud/commit/9be4e5fbc2fbc2b715978e5d1f2e50e211508b3b))
* **kernel:** bind the camera identity to the device node that is opened, and re-check it after the grab ([6bf15c0](https://github.com/LamaSu/physical-capability-cloud/commit/6bf15c0584592dfd28be38e8655024c4a58f509e))
* **kernel:** export JobRunnerOptions with the other JobRunner types ([ddd1f0c](https://github.com/LamaSu/physical-capability-cloud/commit/ddd1f0cfbf13e9379743c5ebbc436da8173fdade))
* **kernel:** incumbent producers name the job on every event, so kernel bundles bind (LO-EV-9 per-event) ([6548576](https://github.com/LamaSu/physical-capability-cloud/commit/654857648147d49cdd67291f68ca0c2269dd2501))
* **kernel:** JobRunner evidence is bound to its job across handoffs, step keys and devices ([f7af668](https://github.com/LamaSu/physical-capability-cloud/commit/f7af6686cf6f5680b8370d7d66924c1488a3ad3a))
* **kernel:** JobRunner evidence sessions are job-scoped, closed and bounded ([7332bb4](https://github.com/LamaSu/physical-capability-cloud/commit/7332bb4f71e45f59d04af662d58919952ab8ee20))
* **kernel:** JobRunner passes its job's id to the machine at load and start ([99ec894](https://github.com/LamaSu/physical-capability-cloud/commit/99ec894d375eadf6d81972dbc8d4c918cbc31378))
* **kernel:** JobRunner records every evidence event before the tier check and the bundle ([cd9d877](https://github.com/LamaSu/physical-capability-cloud/commit/cd9d8770745384c3922a10bf892fbc1d17f02e64))
* **kernel:** JobRunner records every evidence event, in emission order, before the tier check and the bundle ([5a3386b](https://github.com/LamaSu/physical-capability-cloud/commit/5a3386b5f3fff31357b6cc355d02c42ba45fd0e8))
* **kernel:** PrinterLog's summary covers every entry of its job, and a failed first poll leaves nothing outstanding ([1b7c10d](https://github.com/LamaSu/physical-capability-cloud/commit/1b7c10da0a962388ac1bf5f8fe1d1440e42f1841))
* **kernel:** quiesceEvidence() is required, and a job's devices pass on only on its word ([a54be76](https://github.com/LamaSu/physical-capability-cloud/commit/a54be76e4e95fcfcc2f2f7dd0a3b35dabad850e6))
* **kernel:** the IPP mock refuses a page count that is not a positive integer ([147c57d](https://github.com/LamaSu/physical-capability-cloud/commit/147c57d4346f171c5c63b32d76513fbf59bdb9eb))
* **kernel:** the pull camera never claims CC1; a challenge is recorded only as an unverified declaration ([7c68ad1](https://github.com/LamaSu/physical-capability-cloud/commit/7c68ad13991abbb14742c5817511e7b94849a741))
* **kernel:** unit fields come only from the binding, and only as a pair ([799cea1](https://github.com/LamaSu/physical-capability-cloud/commit/799cea1d98c387aa73269bfc0e10210bdb542b9a))
* **mcp-server:** pcc_get_evidence asks the route that answers a bundle id ([#3341](https://github.com/LamaSu/physical-capability-cloud/issues/3341)) ([f3218ce](https://github.com/LamaSu/physical-capability-cloud/commit/f3218cecc68f45a9d85f5faf0fe0f9583ab92c41))
* **mcp-server:** pcc_get_evidence asks the route that answers a bundle id ([#3341](https://github.com/LamaSu/physical-capability-cloud/issues/3341)) ([4a8f6f9](https://github.com/LamaSu/physical-capability-cloud/commit/4a8f6f94409606b25cd5b31fda721634c70b80ff))
* **mcp:** the full /mcp surface obeys the prod domain gate for its MCP App views (D14) ([c9ff823](https://github.com/LamaSu/physical-capability-cloud/commit/c9ff823dcf7f1a35c236727018cc47fb2ce77115))
* **mcp:** the full /mcp surface obeys the prod domain gate for its MCP App views (D14) ([3c8d380](https://github.com/LamaSu/physical-capability-cloud/commit/3c8d3806c78f4802c4d03864bb71e5e23d55f655))
* **mcp:** the plain HTTP view mirror obeys D14 in production (astra r1 HIGH on [#495](https://github.com/LamaSu/physical-capability-cloud/issues/495)) ([6ea2c35](https://github.com/LamaSu/physical-capability-cloud/commit/6ea2c3556f21019e4f215a9e024924f9b08c03f3))
* **money-status:** accept /receipt's coming unitState; key 6-vs-7 off it (escrow ruling [#3163](https://github.com/LamaSu/physical-capability-cloud/issues/3163)) ([8f94649](https://github.com/LamaSu/physical-capability-cloud/commit/8f946499bf818dffd687c9840fbd7d50cb79b981))
* **money-status:** classify settlement reads by the routes' own isAllocated/phase semantics ([7061730](https://github.com/LamaSu/physical-capability-cloud/commit/7061730a9d3fa84bf60478d4e51ff2994b882c97))
* **onboard-kit:** a replaced sensor recording keeps nothing of the old one, in the template and the scaffolded adapter ([aaa405f](https://github.com/LamaSu/physical-capability-cloud/commit/aaa405fabca5f90133348cd88853175c72b469f9))
* **payments:** an unfunded bounty never becomes a treasury pool stake (astra pack 36 follow-up) ([0ff6ce6](https://github.com/LamaSu/physical-capability-cloud/commit/0ff6ce6d72e82f45ea29ae3981f742caa858c3f4))
* **payments:** bounty reads return frozen snapshots; verified/paid leave the type; pools refuse (astra pack 36b) ([697eabd](https://github.com/LamaSu/physical-capability-cloud/commit/697eabdc6b6620a8bc4a9420a694f0155e58ee4a))
* **payments:** bounty service state is runtime-private (astra pack 36c) ([4440b90](https://github.com/LamaSu/physical-capability-cloud/commit/4440b90b5c8b7b2a210b656c5dde20b9a8650d82))
* **payments:** retire bounty verification and payment; fundedBy becomes a proposal (astra pack 36 HIGH 1, HIGH 2) ([6f6e9be](https://github.com/LamaSu/physical-capability-cloud/commit/6f6e9bea5e3ca078c14c6604de34e589948b0097))
* **payments:** stop the bounty service advertising unfunded treasury bounties ([8f2e622](https://github.com/LamaSu/physical-capability-cloud/commit/8f2e6229bab4f41be352f2cfe36652ad32502abd))
* **pcc-node:** `pcc-node start` names its target gateway first (N57) ([e8d9cd7](https://github.com/LamaSu/physical-capability-cloud/commit/e8d9cd742de52453b5b60e2f1b894fe52b9619f9))
* **pcc-node:** a default public registration needs a yes; a config file's gateway is honoured (N57) ([3c0866e](https://github.com/LamaSu/physical-capability-cloud/commit/3c0866ed1318ee27077d894a9e1269b9550ada71))
* **pcc-node:** a polled job never becomes a device command, and the gateway's TLS is verified (68b F1-F3) ([7a225f6](https://github.com/LamaSu/physical-capability-cloud/commit/7a225f64d272875993d2c4eed35823d42ac82bff))
* **pcc-node:** a sent start is unknown unless refused by contract, and the lease is skew-free (verdict 117c) ([6a4a1ac](https://github.com/LamaSu/physical-capability-cloud/commit/6a4a1ac4f7e010196252dfad5fc1a405d0989541))
* **pcc-node:** bounded, cancellable device runs with one log chain per job ([d7bfb96](https://github.com/LamaSu/physical-capability-cloud/commit/d7bfb962b89993560a9bcabff0e7a96b959f1103))
* **pcc-node:** claim jobs atomically, sign only checked evidence, report acks ([dca6917](https://github.com/LamaSu/physical-capability-cloud/commit/dca6917838d06576f124a917b23099e818337dbe))
* **pcc-node:** fit the no-jobs node to master's start banner ([#457](https://github.com/LamaSu/physical-capability-cloud/issues/457)) ([4aacaef](https://github.com/LamaSu/physical-capability-cloud/commit/4aacaef8c98facba5cf01c79273d1fd2bf464fe3))
* **pcc-node:** fold in the independent review of the UI-server lockdown ([b12cf4c](https://github.com/LamaSu/physical-capability-cloud/commit/b12cf4c0ea3f61b081ee0fea156411f239674fcf))
* **pcc-node:** give the UI server's agent API a real per-process token (verdict 91) ([4b66834](https://github.com/LamaSu/physical-capability-cloud/commit/4b66834da00b3f98b8854608f5426dff1b853dcb))
* **pcc-node:** keys live under ~/.pcc-node, owner-only; the node honours the emergency stop (item 9) ([46783db](https://github.com/LamaSu/physical-capability-cloud/commit/46783db398fa4c234ff32fae34962610dd864d58))
* **pcc-node:** keys live under ~/.pcc-node, owner-only; the node honours the emergency stop (item 9) ([3d631b9](https://github.com/LamaSu/physical-capability-cloud/commit/3d631b93d6ed645270edb53f415045baf5276077))
* **pcc-node:** no automatic key adoption, no keys on Windows, atomic-or-nothing install, and checked configs (verdict 105c) ([1b10780](https://github.com/LamaSu/physical-capability-cloud/commit/1b107807375a2d03081bc98f8b2e5e5c2223e3ed))
* **pcc-node:** plain-http gateways only at literal loopback addresses, never via a proxy ([e78d58f](https://github.com/LamaSu/physical-capability-cloud/commit/e78d58f05c84e61ca1988be511cec08606fccdb9))
* **pcc-node:** read key and config files through checked no-follow descriptors ([58d7a0f](https://github.com/LamaSu/physical-capability-cloud/commit/58d7a0f05cb01562b5961b2f700850eb3856dd9f))
* **pcc-node:** refuse every config file on Windows, keyless ones included (verdict 105d) ([55ea2a9](https://github.com/LamaSu/physical-capability-cloud/commit/55ea2a9a2640f5b6b9fa5669ef14825316c9111f))
* **pcc-node:** remove the relay executor that ran commands in a shell (N66) ([afb9fb0](https://github.com/LamaSu/physical-capability-cloud/commit/afb9fb0b9a32375a6cc8f641c044e3d27dec2f17))
* **pcc-node:** remove the relay executor that ran commands in a shell (N66) ([9edefb5](https://github.com/LamaSu/physical-capability-cloud/commit/9edefb5fc4b56aef6bcfc7c0860f2a6aaf34e0a2))
* **pcc-node:** runs belong to a leased claim, device I/O is interruptible, and evidence is checked exactly (verdict 117b) ([a708c86](https://github.com/LamaSu/physical-capability-cloud/commit/a708c86a7a7ab6dde7204345c50d5147bbc6136d))
* **pcc-node:** start names its target gateway first; a default public registration needs a yes (N57) ([6bdb31a](https://github.com/LamaSu/physical-capability-cloud/commit/6bdb31a148b4648c2e1bf63071006e7a02d8be60))
* **pcc-node:** the daemon gives the UI server no key, and start announces nothing ([8859463](https://github.com/LamaSu/physical-capability-cloud/commit/8859463a0fa7ce10999adf591da2bff8b979f719))
* **pcc-node:** the daemon takes no jobs and announces no capabilities, and says so (68c F3) ([9b5fab4](https://github.com/LamaSu/physical-capability-cloud/commit/9b5fab4afd204a5214579d253c06da183493f37e))
* **pcc-node:** the daemon's heartbeat says the node takes no jobs ([314bacf](https://github.com/LamaSu/physical-capability-cloud/commit/314bacf5340c608a3c988b7cc2b1ca5691d86c32))
* **pcc-node:** the gateway key travels only over https or to this machine, never through a redirect (68c F1; 102f F1) ([b83c80f](https://github.com/LamaSu/physical-capability-cloud/commit/b83c80fdb478d9f89c3aaaf1ecd6b06276eef3c4))
* **pcc-node:** the local UI server holds no authority: origin lock, no key proxy (N11) ([053e3e5](https://github.com/LamaSu/physical-capability-cloud/commit/053e3e573e48cc9a1bbd25ef1ce02ce50ecc6208))
* **pcc-node:** write the config owner-only and atomically; warn on a readable one ([dcb06ae](https://github.com/LamaSu/physical-capability-cloud/commit/dcb06aea0862e1e9a273c9b1ef5c9985de8fdc74))
* **scripts:** consume OFF runs no job; a local mark is never the record that a job may run ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r5) ([87e5014](https://github.com/LamaSu/physical-capability-cloud/commit/87e5014d87644301357462852e71bc2b1571b5d7))
* **scripts:** every claim makes the whole state path durable, not only newly created directories ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r3) ([92e4130](https://github.com/LamaSu/physical-capability-cloud/commit/92e413007635a4d673f20936d276eaf3197e0547))
* **scripts:** guard the real dispatcher, fix the external origin to the Claude API, reject encoded separators (N4a r4) ([c448c19](https://github.com/LamaSu/physical-capability-cloud/commit/c448c19b570e90d27e1a0120e506d323b951a691))
* **scripts:** N4a guard checks every request at one transport, uploads included ([7f17068](https://github.com/LamaSu/physical-capability-cloud/commit/7f17068c9e46ddf1f3d6524ac9ed4fca5c0ecd6a))
* **scripts:** N4a guard checks the dialled address, ignores proxies and redirects, guards the loops ([1cc2bff](https://github.com/LamaSu/physical-capability-cloud/commit/1cc2bff4a54f7b9f154f72805e5cfe25e6d01266))
* **scripts:** OT-2 executor refuses to start without --unsafe-local (N4a) ([a6cd850](https://github.com/LamaSu/physical-capability-cloud/commit/a6cd850cf124a86fbfa26ce597243d99ae3d7245))
* **scripts:** ot2-agent refuses a job when its run-once mark can't be made durable and is the only record ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r2) ([5cde00e](https://github.com/LamaSu/physical-capability-cloud/commit/5cde00ed48b75282409756415f78663cb75d643f))
* **scripts:** ot2-agent runs each approved job at most once (local mark + gateway consume) ([847d548](https://github.com/LamaSu/physical-capability-cloud/commit/847d548b8f0b4e8587f58183383b47d47810349c))
* **scripts:** ot2-agent runs each approved job at most once (local mark + gateway consume) ([e36fab1](https://github.com/LamaSu/physical-capability-cloud/commit/e36fab135fb5d67912889d92d10831c35c039e65))
* **scripts:** the source digest covers the build recipe too (Dockerfile, .dockerignore) ([1c3bc27](https://github.com/LamaSu/physical-capability-cloud/commit/1c3bc277602939b9288f0f43a68847ce6c88605e))
* **scripts:** with consume off, refuse a symlinked state path and sync the directories the mark is really in ([#499](https://github.com/LamaSu/physical-capability-cloud/issues/499) r4) ([40a1bbd](https://github.com/LamaSu/physical-capability-cloud/commit/40a1bbdd44778d982d5a921393315842030f59bc))
* **spec,demand-intel:** fixed periodic public demand release (PX-13 round-1 F1-F5) ([6377dd5](https://github.com/LamaSu/physical-capability-cloud/commit/6377dd5dcd949b6a5accc391aa73680a71530f6a))
* **spec,gateway:** refuse schedule numbers that read differently; close clean-room round 3b ([6760a05](https://github.com/LamaSu/physical-capability-cloud/commit/6760a05032059610601c5db562a0c0011b95646f))
* **spec:** [#52](https://github.com/LamaSu/physical-capability-cloud/issues/52) carrier B visits each signed entry once; plainDataCopy refuses __proto__ keys and never formats a foreign thrown value (astra packs 73, 74) ([73ac0bb](https://github.com/LamaSu/physical-capability-cloud/commit/73ac0bb678ab298386894bd287e402cab8d66b68))
* **spec:** [#52](https://github.com/LamaSu/physical-capability-cloud/issues/52) verifies the kernel-signed bundle that carries the log; profile checks run on a one-pass copy ([3edb992](https://github.com/LamaSu/physical-capability-cloud/commit/3edb9927942f5a405ae747a815cdc3af06ab282e))
* **spec:** an omitted quote is held to the gross floor; plan JSON is bounded before it is read (astra round 6) ([59ee4ae](https://github.com/LamaSu/physical-capability-cloud/commit/59ee4aef895a539a673ecb3b1961972e2e12c54c))
* **spec:** close coord-watch's cross-family review of [#360](https://github.com/LamaSu/physical-capability-cloud/issues/360) (4 x P1) ([0ab9cdb](https://github.com/LamaSu/physical-capability-cloud/commit/0ab9cdbf78fc544d56925cd614596daee502ac6b))
* **spec:** close the clean-room round 2 findings (order-independent refusals on duplicate ids) ([2225ad5](https://github.com/LamaSu/physical-capability-cloud/commit/2225ad5ff56a3922b5aade17ce1d72b00c29b287))
* **spec:** co-funder order is total over the hashed entry (E1 finding 3) ([3c2a3dd](https://github.com/LamaSu/physical-capability-cloud/commit/3c2a3dd0638accbc03d2cc6335a2d05a0cc6e9c7))
* **spec:** content hashes sort by code unit, never by locale collation ([64fa02d](https://github.com/LamaSu/physical-capability-cloud/commit/64fa02d481d65f7685ef0337d6f4304928f5be12))
* **spec:** content hashes sort by code unit, never by locale collation ([bd048b2](https://github.com/LamaSu/physical-capability-cloud/commit/bd048b26b91916e4627d51c913b36569b1af4669))
* **spec:** fixer-kilo: read D1/D2 signers and the denylist through the registry's normalization (E6 F3) ([c121100](https://github.com/LamaSu/physical-capability-cloud/commit/c12110071f2cfb016d1ad72fb534a0bc3f1a9b9f))
* **spec:** fixer-kilo: reserve the kernel id namespace in principalTupleWord (E6 F2) ([161fabd](https://github.com/LamaSu/physical-capability-cloud/commit/161fabd613e6ed94b2fcd00bc8b1dbf7d9a8e7d6))
* **spec:** fixer-whiskey: admitPlainArray + checkExactKeys snapshot once, never re-read (E12) ([a339305](https://github.com/LamaSu/physical-capability-cloud/commit/a339305a0bdc27cd4e76e00510cac6e7209c10bd))
* **spec:** fixer-whiskey: make computeSubjectBlockHash/computeBindingsRoot read-once doc comments literal (E12) ([530e664](https://github.com/LamaSu/physical-capability-cloud/commit/530e66416d24f65266725f55d463f1e9f9be6463))
* **spec:** kernelPullCaptureIssue, the closed LO-SE-1 contract a camera event must meet to count toward a tier ([3b0253a](https://github.com/LamaSu/physical-capability-cloud/commit/3b0253af0b5d91dc09b6f6bfc0beefa6317530ed))
* **spec:** LO-EV-9 reads each field once, runs no caller code, never throws, and binds unit and challenge both ways (E11 F1-F3) ([6921482](https://github.com/LamaSu/physical-capability-cloud/commit/692148278eeca670eb2f7db9480b2f083a1bc3a6))
* **spec:** one approved-set snapshot for membership and digest (PX-13 round-2 F3) ([6203452](https://github.com/LamaSu/physical-capability-cloud/commit/620345228ffd543aa6997ebf4360b95a42086789))
* **spec:** plain-data copies have a null prototype and write -0 as 0, so a copy holds exactly what the hash covers (astra packs 124, 125) ([420b320](https://github.com/LamaSu/physical-capability-cloud/commit/420b3202f30145bc7d549020f0be081a2847b7fc))
* **spec:** plain-data copies never run supplied code: proxies, accessors, nonstandard array prototypes and inherited indices are refused (astra pack 154) ([1c6a91a](https://github.com/LamaSu/physical-capability-cloud/commit/1c6a91a0c62173b739db37cf74b18a3f2571b41e))
* **spec:** plainDataCopy reads descriptors through their own properties and calls only intrinsics captured at load; the proxy check must pass a trap probe (astra pack 162) ([fd12d89](https://github.com/LamaSu/physical-capability-cloud/commit/fd12d8977d5229c73b835188c2df23d49103c525))
* **spec:** principalTupleWord refuses a kind outside operator, kernel and device ([c029f99](https://github.com/LamaSu/physical-capability-cloud/commit/c029f994e18ace8385f6252d3eabc55947908de7))
* **spec:** profile validation fails closed on unknown terms, non-finite numbers and untyped list entries ([2df436b](https://github.com/LamaSu/physical-capability-cloud/commit/2df436bda5fabac590b54fc513e584bc242e768e))
* **spec:** R8 round 2. The registration's digest gates compile, the command surface is committed, references stay attached, and v1 refuses unattended moving or heating (astra pack 114b) ([78c745d](https://github.com/LamaSu/physical-capability-cloud/commit/78c745da540ac2f0ea284d47bf88db76f5d7788d))
* **spec:** R8 round 3. One observation is hashed, checked and compiled; compile needs the registry's signed registration; provenance holds on every body; no free-form parameter (astra pack 153) ([1938d97](https://github.com/LamaSu/physical-capability-cloud/commit/1938d971a07950f3ca9973fccd19c385ac5d4985))
* **spec:** R8 round 4. The safety envelope calls only intrinsics captured at load, so nothing replaced afterwards can change what it checks or emits (astra pack 164) ([b74d0c9](https://github.com/LamaSu/physical-capability-cloud/commit/b74d0c98c925ee35d8afac3a836394f073d5156d))
* **spec:** R8 round 5. No format is checked with a RegExp; every digest form is a structural predicate (astra pack 167) ([ad599f0](https://github.com/LamaSu/physical-capability-cloud/commit/ad599f04f67afe392cd9210f7c41a9534cc47f1f))
* **spec:** register document-print-and-mail in loadBuiltinCsds (board N64) ([5393655](https://github.com/LamaSu/physical-capability-cloud/commit/5393655dd256d03af59704d87ac474d85a0d7045))
* **spec:** register document-print-and-mail in loadBuiltinCsds (board N64) ([2d80818](https://github.com/LamaSu/physical-capability-cloud/commit/2d80818024765ed5d62c681b52ff8c33e1070985))
* **spec:** registry keys must be printable ASCII before lowercasing (E1 finding 4) ([5e69e32](https://github.com/LamaSu/physical-capability-cloud/commit/5e69e32b6361716570ae0983e7d7634c0ccf2237))
* **spec:** registry lookups refuse a non-ASCII candidate before lowercasing (review E1) ([7e64ccd](https://github.com/LamaSu/physical-capability-cloud/commit/7e64ccdcb26a477a4faf243baf60e3a7c9712646))
* **spec:** report an unchecked pin as unverified; close clean-room round 3 ([15208e3](https://github.com/LamaSu/physical-capability-cloud/commit/15208e3828b748a65f32fe3619ac9522ec90379d))
* **spec:** reviewer-alpha self-check on [#351](https://github.com/LamaSu/physical-capability-cloud/issues/351) (D5, evidence types and order, operator floor) ([9d7686a](https://github.com/LamaSu/physical-capability-cloud/commit/9d7686af8ddd47e3cacd54c4b79ee4ba0256d6b7))
* **spec:** rule 5 admits exactly the segments the schema admits ([c73d708](https://github.com/LamaSu/physical-capability-cloud/commit/c73d70897c4cbbf555bce98b965a5264b51ab130))
* **spec:** rule 5 checks a segment's known numeric fields only ([8dc089e](https://github.com/LamaSu/physical-capability-cloud/commit/8dc089e5ccea2ed9783592a8e7f5485caf24333b))
* **spec:** safety envelope confirm and compile re-check the committed e-stop and rate (ADK R8) ([3988fe0](https://github.com/LamaSu/physical-capability-cloud/commit/3988fe0735236e01e9a18eef64a4f7bc6a1f480c))
* **spec:** the E12 snapshots use only load-time intrinsics (a null-prototype record, not a Map; installed, not assigned) ([8106ed1](https://github.com/LamaSu/physical-capability-cloud/commit/8106ed18ec0edf129cbd1fadaf89bc2109226e14))
* **spec:** the inert-JSON boundary reads property descriptors by own keys only ([#5147](https://github.com/LamaSu/physical-capability-cloud/issues/5147)) ([93d00a9](https://github.com/LamaSu/physical-capability-cloud/commit/93d00a9e4b1cebccbf7b9b84599a1b2bcdc1a226))
* **spec:** the inert-JSON boundary reads property descriptors by own keys only ([#5147](https://github.com/LamaSu/physical-capability-cloud/issues/5147)) ([edf5b64](https://github.com/LamaSu/physical-capability-cloud/commit/edf5b6497c04cd839648ca3b85dc9b93aa7b6c2c))
* **spec:** the plain-data copy installs array elements as own data properties, so no inherited setter runs while it is built (astra pack 158) ([a36aeaf](https://github.com/LamaSu/physical-capability-cloud/commit/a36aeaf6f74dcc568f97d4c6a5b56a836dcb61bf))
* **spec:** the plain-data proxy check loads node:util at runtime, so the dashboard's browser build of @pcc/spec builds again ([d382255](https://github.com/LamaSu/physical-capability-cloud/commit/d382255e455ff21aafb6fe942eb1258ad464255e))
* **spec:** the profile's canonicalization, validation, digest and freezing call only intrinsics captured at load; isProxy is bound by a static node:util import, never offered by the runtime (astra pack 170) ([8dc6ef2](https://github.com/LamaSu/physical-capability-cloud/commit/8dc6ef2bc90ff6fff2b24b22c8f614e37ea27e49))
* **spec:** the seam reads plan units and its input once; rule 5 starts at 0 ([a3d3d76](https://github.com/LamaSu/physical-capability-cloud/commit/a3d3d76e619599b46f1b09abcf3996fcf5de68dc))
* **ui-kit:** a receipt's economics.amount is base units, never a display sum ([de3a973](https://github.com/LamaSu/physical-capability-cloud/commit/de3a973feb0ace288b5859b481c3ea15fd26ede0))
* **ui:** AmountDisplay closes astra pack-30 findings (className, unsafe numbers, Unicode codes) ([9d99cdd](https://github.com/LamaSu/physical-capability-cloud/commit/9d99cddfde8f1265c55720481e651973423b5d93))
* **ui:** AmountDisplay never prints $0.00 for a missing or unreadable amount ([5080147](https://github.com/LamaSu/physical-capability-cloud/commit/5080147cbbb174ef9bae3ea2f3e46affbc44ef28))
* **ui:** AmountDisplay never prints $0.00 for a missing or unreadable amount ([6290924](https://github.com/LamaSu/physical-capability-cloud/commit/6290924b646376b0317d7cc4adf0b90429c3a9a7))
* **ui:** AmountDisplay shows "$" only for dollar currencies ([050455a](https://github.com/LamaSu/physical-capability-cloud/commit/050455a3a38d107841dfd77e07bb99f21d32cfe6))
* **verifier:** the deterministic fallback orders by code units, not the host's collation (review E1) ([8a94121](https://github.com/LamaSu/physical-capability-cloud/commit/8a94121b37f2fc0b6f482b0a36d526aee2e51521))
* **verifier:** verifier choice is independent of pool order, with ASCII ids (review E1b) ([a65abf9](https://github.com/LamaSu/physical-capability-cloud/commit/a65abf912452efa849c70267fe912bb5001a0418))


### Documentation

* **adk:** register a manual channel, not a file channel ([19b566a](https://github.com/LamaSu/physical-capability-cloud/commit/19b566a55448d1e5e0ef1d2408e21c70283922c4))
* **adk:** say how to recover from a placeholder node key ([27f7346](https://github.com/LamaSu/physical-capability-cloud/commit/27f7346596f9dbea5599eb6cd59942be4d3d59d0))
* **adk:** say what the current gateway keeps from an attempt report ([0d3910b](https://github.com/LamaSu/physical-capability-cloud/commit/0d3910b077d48be551e3cfb4aa499cb120acc19b))
* **agent-package:** the operator tools say what their routes answer: 501, or no route (N32) ([7fccd04](https://github.com/LamaSu/physical-capability-cloud/commit/7fccd046d5ccab2ea00e3b9013f33ebb8950340f))
* **agent-pack:** lead with the operator's thesis and retire the old tagline ([f282e9e](https://github.com/LamaSu/physical-capability-cloud/commit/f282e9ef9d1c6ba850a923b45939b81b5e079572))
* **contracts:** correct the frozen ABI doc and commit the clean-room generator ([c00a50c](https://github.com/LamaSu/physical-capability-cloud/commit/c00a50c13c5bbd851860608789916368d87eab37))
* **contracts:** no caller-authentication exception for the operator (R14, 26e LOW) ([3891cc0](https://github.com/LamaSu/physical-capability-cloud/commit/3891cc0043f2fb9e7e6f9cb8c015e68765f7d1e2))
* **contracts:** record the two legacy deploy writers as retired ([a2a8ad0](https://github.com/LamaSu/physical-capability-cloud/commit/a2a8ad0e7a94f359cc1537d5a2ab547a7715d306))
* **contracts:** say which helper enforces each static rule, and what an encoding change moves ([4ad2ac7](https://github.com/LamaSu/physical-capability-cloud/commit/4ad2ac78d4e21ff959549b0f878758201e23fad7))
* **contracts:** state-3 appeal finality, state 4/5 guards, the max nonce, direct-payer auth (R14 round 3) ([fc930b2](https://github.com/LamaSu/physical-capability-cloud/commit/fc930b2ec3ae30f17fad4fe885a20fd27352085e))
* **contracts:** the expiry equality is a preflight-only consistency check, not a contract rule (R14, 26d LOW) ([ee7de79](https://github.com/LamaSu/physical-capability-cloud/commit/ee7de792aef3b519f20d8b0f51fa212439317efb))
* every place that lists the adapter interface names quiesceEvidence() ([3f4240c](https://github.com/LamaSu/physical-capability-cloud/commit/3f4240cb55714c86b839cf8f3fdbffd624a040db))
* **gateway,spec:** tool-catalog comments say the type-level bounty routes and notifies nothing (astra pack 36 follow-up) ([afd6752](https://github.com/LamaSu/physical-capability-cloud/commit/afd67525c9f16de17d57e329feb11fc457bbe6c6))
* **gateway:** describe the settlement reads by what their records can show ([8c04c5b](https://github.com/LamaSu/physical-capability-cloud/commit/8c04c5b5cd94af9e7e70abd93406ac0f21ba9582))
* **genui:** don't pin [#313](https://github.com/LamaSu/physical-capability-cloud/issues/313)'s moving SHA; add its live-read rule to the consumer rule ([4e8e732](https://github.com/LamaSu/physical-capability-cloud/commit/4e8e73211c79c4cea35b7527ade245f176f6a820))
* **genui:** golden matrix follows master's settlement routes (escrow ruling [#3163](https://github.com/LamaSu/physical-capability-cloud/issues/3163)) ([ed22984](https://github.com/LamaSu/physical-capability-cloud/commit/ed229845d60d58ded99052c0b9c1f8c0d43acf40))
* **genui:** preserve the settlement read-surface contract + conformance matrix in-repo ([ce5a7ab](https://github.com/LamaSu/physical-capability-cloud/commit/ce5a7abcaeb8bfafe752b59c4302bd912b42cc1c))
* **genui:** record the settlement routes' IMPLEMENTED shape next to the v1.5 design contract ([8080475](https://github.com/LamaSu/physical-capability-cloud/commit/8080475fb207e21742b5b7c1640776ec53a7db45))
* **site:** lead published descriptions with the product thesis ([5750797](https://github.com/LamaSu/physical-capability-cloud/commit/575079792c2dfcb71e0d609af5d9d3bbb64a0409))
* **site:** lead published descriptions with the product thesis (stacked on [#364](https://github.com/LamaSu/physical-capability-cloud/issues/364)) ([7a638a7](https://github.com/LamaSu/physical-capability-cloud/commit/7a638a72733ef127c2b736cf0055ce27eccf6fa3))
* the served commit is read from the image, and Railway's value is metadata ([e41c333](https://github.com/LamaSu/physical-capability-cloud/commit/e41c3339c4cb19480320c94087d619ba479f0f17))
* what /api/health's build fields prove, and what they cannot (N5) ([326f439](https://github.com/LamaSu/physical-capability-cloud/commit/326f439afdc7c5bb23a4e36006df6328cd1771a3))


### Refactor

* **dashboard:** drop the key lint's fetch-by-name check, which the held rule already decides ([abcfb21](https://github.com/LamaSu/physical-capability-cloud/commit/abcfb2172e13eda41876100f417f5770f7e01fab))
* **dashboard:** drop the key lint's root check, which the mutation-target check now covers, and pin window.&lt;object&gt; on its own ([e34e767](https://github.com/LamaSu/physical-capability-cloud/commit/e34e767a3579bc27df9e10fcab12ab3f964b68c3))
* **dashboard:** implementer-n50-mig-a: BatchTrackingPage.tsx, StartPage.tsx, routes/onboard/chat/index.tsx send the key only through authorizedFetch ([7f00db9](https://github.com/LamaSu/physical-capability-cloud/commit/7f00db96a24caa98181afb422aa962f6e0925136))
* **dashboard:** implementer-n50-mig-a: no-direct-auth-headers.test.ts KNOWN list drops the 12 files migrated to authorizedFetch ([37d18da](https://github.com/LamaSu/physical-capability-cloud/commit/37d18da6b674fd61a0f006409fce2b045bec87e6))
* **dashboard:** implementer-n50-mig-a: ProtocolRunPage.tsx, OrchestratorPage.tsx, OrchestratorDetailPage.tsx send the key only through authorizedFetch ([5a05d9e](https://github.com/LamaSu/physical-capability-cloud/commit/5a05d9e3157fae995dbad6891a6200c149ab732d))
* **dashboard:** implementer-n50-mig-a: SystemDashboardPage.tsx, SponsorTelemetryPage.tsx, EvidenceExplorerPage.tsx send the key only through authorizedFetch ([c24bc92](https://github.com/LamaSu/physical-capability-cloud/commit/c24bc924704194e9e63fd257d89d3d018934eab3))
* **dashboard:** implementer-n50-mig-a: WalletPage.tsx, TelemetryPage.tsx, SettlementPage.tsx send the key only through authorizedFetch ([38817b5](https://github.com/LamaSu/physical-capability-cloud/commit/38817b5ab800227e747679738f88d744996da821))
* **dashboard:** implementer-n50-mig-b: EditDeleteBar, RateSubmitForm, DiscoverabilityPanel, DisputeModal send the key only through authorizedFetch ([76131c6](https://github.com/LamaSu/physical-capability-cloud/commit/76131c663690f20bcacbc78d4e287390bb90ada0))
* **dashboard:** implementer-n50-mig-b: OperatorMobilePage, OperatorDashboardPage, AgentPackagePage, OperatorA2APage, ProtocolLibraryPage send the key only through authorizedFetch ([085646a](https://github.com/LamaSu/physical-capability-cloud/commit/085646a5df34c777344395d60d0f64b73981d2f2))
* **dashboard:** implementer-n50-mig-b: ProtocolDetailPage, BatchBoardPage, SensorDashboardPage, NegotiationSessionPage send the key only through authorizedFetch ([7a59206](https://github.com/LamaSu/physical-capability-cloud/commit/7a59206e409199e2ab3cb1ac787a86c45551b6f8))
* **gateway:** drop an unreachable tier check in the v2 digest ([bb742a2](https://github.com/LamaSu/physical-capability-cloud/commit/bb742a2767201b23165146ecea6778cafb191b36))
* **gateway:** drop the unreachable close handler from the N84 transport ([6480cc6](https://github.com/LamaSu/physical-capability-cloud/commit/6480cc6dcc181c469799b8cdef890a1f7ade9177))
* **gateway:** simplify the N84 DNS gate's start and abort wiring ([888b885](https://github.com/LamaSu/physical-capability-cloud/commit/888b885ffa6c287e092f7504ee2225a256c18f17))
* **pcc-node:** hold the emergency-stop hook out of 0.1.1 ([e0f9543](https://github.com/LamaSu/physical-capability-cloud/commit/e0f954335198cfe3a2c95d8cb624e4e38f0a0c78))
* **spec:** export acceptedDealPreimage, the canonical bytes acceptedDealDigest hashes (amendment [#3231](https://github.com/LamaSu/physical-capability-cloud/issues/3231)) ([79b6c1d](https://github.com/LamaSu/physical-capability-cloud/commit/79b6c1da9fcb263d67df978f76688b002f17929a))

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
