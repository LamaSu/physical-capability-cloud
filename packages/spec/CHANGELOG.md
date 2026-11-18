# Changelog

## [0.2.0](https://github.com/LamaSu/physical-capability-cloud/compare/spec-v0.1.0...spec-v0.2.0) (2026-11-18)


### Features

* **dashboard:** the runtime empty-state lines are marked ephemeral ([2ce4e7d](https://github.com/LamaSu/physical-capability-cloud/commit/2ce4e7d7a6afa62e8bcc25181e202f70bd5a7775))
* **dashboard:** the runtime empty-state lines are marked ephemeral ([c1f8f91](https://github.com/LamaSu/physical-capability-cloud/commit/c1f8f910f424b337205171f0c799dde247331140))
* **economics:** versioned, hashed agreement templates and an origin check ([63c6d75](https://github.com/LamaSu/physical-capability-cloud/commit/63c6d75a35139f27c05b487ce54795b06ad15b1d))
* **economics:** versioned, hashed agreement templates and an origin check (R17 CC5) ([f91b148](https://github.com/LamaSu/physical-capability-cloud/commit/f91b148e78a8ec92f5339732bfc2a5746730b6b1))
* **gateway,spec,contracts:** N266 P1 run 1: settlement re-check kit data (field-to-call map, ABI, deployments; amount = the recipient's net), per-unit deployment identity in the settlement DTOs, the kit's reads frozen in VNextAbiFreeze and ABI doc §7; /.well-known/pcc-settlement-recheck.json ([8b72b0d](https://github.com/LamaSu/physical-capability-cloud/commit/8b72b0da11e0f33d27dc8c93f8807fb877bef5cb))
* **gateway,spec,contracts:** N266 P1 run 1: settlement re-check kit data and per-unit deployment identity ([f88c7de](https://github.com/LamaSu/physical-capability-cloud/commit/f88c7deecb94c19883b1860e4e62126e6231c3b6))
* **genui:** typed display text in both UI kits, with a closed brand guard and a fail-closed sink lint (item 122 A1) ([26b70ad](https://github.com/LamaSu/physical-capability-cloud/commit/26b70ad5c9faf3ec04aa9fb339c0d4611098c513))
* **spec,contracts:** N266 P1 run 2: pcc-settlement-recheck replay CLI, run from a clone ([eb04771](https://github.com/LamaSu/physical-capability-cloud/commit/eb047718f8096b46dbcbe51a7c0cf3f405e52afd))
* **spec,contracts:** N266 P1 run 2: pcc-settlement-recheck replay CLI, run from a clone (EIP-1898-pinned re-check of settlement replies against the user's RPC; opt-in anvil suite) ([63338b1](https://github.com/LamaSu/physical-capability-cloud/commit/63338b1636bf9ec2d16af797bfa02f2bd482a883))
* **spec:** buyer reclaim for V-next escrows (N268-2) (Sol) ([8fb2a31](https://github.com/LamaSu/physical-capability-cloud/commit/8fb2a3129db5346dedd9b3c84bcfe97dafea5cb3))
* **spec:** buyer reclaim for V-next escrows (N268-2) (Sol) ([ff087ea](https://github.com/LamaSu/physical-capability-cloud/commit/ff087ea3835c771c53ab9d5afb5be93557f72c03))
* **spec:** CompositionTemplateV1, the republishable shape of an accepted plan ([523f3d1](https://github.com/LamaSu/physical-capability-cloud/commit/523f3d1094aaa06c3c8323966800e26956510c3b))
* **spec:** CompositionTemplateV1, the republishable shape of an accepted plan (N41) ([6c08d68](https://github.com/LamaSu/physical-capability-cloud/commit/6c08d68de3f10bb299f5edd7a239c538a310859d))
* **spec:** move the discovery quote's registered-price rule into @pcc/spec (N281 PR-B) (Sol) ([5a81ae3](https://github.com/LamaSu/physical-capability-cloud/commit/5a81ae327909ce6dcaef036aa7ea22429472f86e))
* **spec:** move the discovery quote's registered-price rule into @pcc/spec (N281 PR-B) (Sol) ([2b074fa](https://github.com/LamaSu/physical-capability-cloud/commit/2b074fa22279c0bc9a56825084cdee0c29d862db))
* **spec:** N145 NS-5: the buyer's SDK creates the V-next clone, builds in the Base Sepolia factory, and pins NS-3's v1 identity with a golden payload (Sol) ([8eae191](https://github.com/LamaSu/physical-capability-cloud/commit/8eae191d49031447d5d77af5d7a78c9deda98ad1))
* **spec:** N145 NS-5: the buyer's SDK creates the V-next clone, builds in the Base Sepolia factory, and pins NS-3's v1 identity with a golden payload (Sol) ([8beb27b](https://github.com/LamaSu/physical-capability-cloud/commit/8beb27b1fcc18f48a2c87f2f468b994f79726632))
* **spec:** N150 dry-run unit pin and a per-chain V-next reclaim window ([7645fba](https://github.com/LamaSu/physical-capability-cloud/commit/7645fba5abb4dbeebafb1adb1e68334a4a1cd9f6))
* **spec:** N150 dry-run unit pin and a per-chain V-next reclaim window (N145 NS-6) ([7ae06f2](https://github.com/LamaSu/physical-capability-cloud/commit/7ae06f27ee111de3f6d22a990fb80daf56849e3b))
* **spec:** run the funding send path where Node's Proxy check is missing ([0c61a74](https://github.com/LamaSu/physical-capability-cloud/commit/0c61a74e161c71b47f4afc4ef8283db5d71b4d48))
* **spec:** run the funding send path where Node's Proxy check is missing ([8049720](https://github.com/LamaSu/physical-capability-cloud/commit/8049720255b622f04b2ba756f4129b4a4a5ba202))


### Bug Fixes

* **contracts:** Story-to-DATA value corrections (Aeneid is chain 1315; DATA currency; datarpc and datanetscan hosts) ([408ff0c](https://github.com/LamaSu/physical-capability-cloud/commit/408ff0cfe47319bc0546901c9efb7319fa9f1d86))
* **contracts:** Story-to-DATA value corrections (Aeneid is chain 1315; DATA currency; datarpc and datanetscan hosts) (N239) ([a08ef23](https://github.com/LamaSu/physical-capability-cloud/commit/a08ef23f290ac51d783d6f79883d5f8fadb58ccb))
* **economics:** template rebinding unbinds the slot's own rows; catalog entries are read once under the guard ([ada6330](https://github.com/LamaSu/physical-capability-cloud/commit/ada6330ab24ba9123886183a923d4a3f1756fe19))
* **gateway,spec:** N266 P1 run 1: review follow-ups F1-F7 ([#751](https://github.com/LamaSu/physical-capability-cloud/issues/751) verdict) ([de99bcf](https://github.com/LamaSu/physical-capability-cloud/commit/de99bcf417419025ecd30b5d1147591989ba6d0f))
* **gateway:** N266-E4: align settlement money fields with escrow witnesses ([9770e5c](https://github.com/LamaSu/physical-capability-cloud/commit/9770e5cdd0c1d09987f2eab0a9f3b07fd936de16))
* **gateway:** N266-E4: align settlement money fields with escrow witnesses ([9b3c838](https://github.com/LamaSu/physical-capability-cloud/commit/9b3c838a73d3c3260407c11c36427db91ef4c9b5))
* **gateway:** W5 merge-up (N160) ([1f6d55c](https://github.com/LamaSu/physical-capability-cloud/commit/1f6d55cc279805835e3870979da0621174d05fda))
* **genui:** a location valueOf alias is a navigation finding, and the Intl constructor branch has its own Programs ([0941662](https://github.com/LamaSu/physical-capability-cloud/commit/094166253a010dd28afef45fe1686ab4004c08c8))
* **genui:** confine the plain kit's brand stores, capture its brand primitives, and shard the IR guard ([c5bca92](https://github.com/LamaSu/physical-capability-cloud/commit/c5bca92877e673f78344e0bdfd04c9d7cc90a25e))
* **genui:** the plain-kit lint pins its brand stores and module function bindings, and the guard checks its shard wiring ([430919a](https://github.com/LamaSu/physical-capability-cloud/commit/430919adafb9f88a638404253617577ccfa8f82c))
* **spec:** economics entry points stop running or re-reading caller data ([6a4a038](https://github.com/LamaSu/physical-capability-cloud/commit/6a4a038ede50fbdd77a24460040ae53f263bec78))
* **spec:** economics entry points stop running or re-reading caller data ([36eb453](https://github.com/LamaSu/physical-capability-cloud/commit/36eb453b7afa658279ccb263b7b4fb64fd5aa8a0))
* **spec:** N266 P1 run 2: review follow-ups F1-F7 ([#754](https://github.com/LamaSu/physical-capability-cloud/issues/754) verdict) ([5ea82fa](https://github.com/LamaSu/physical-capability-cloud/commit/5ea82faa5f6ad146a59b6acc45a33eef5db7ffaf))
* **spec:** N266 P1 run 2: second-round follow-ups G1-G4 ([#754](https://github.com/LamaSu/physical-capability-cloud/issues/754) r2 verdict) ([12fb34d](https://github.com/LamaSu/physical-capability-cloud/commit/12fb34dde7f38f183eb1ea0f23d94d6995a69a79))
* **spec:** snapshotJson refuses, never throws, when a trap throws a proxy ([42ad1b7](https://github.com/LamaSu/physical-capability-cloud/commit/42ad1b7dd0e6d8e4577e6beb14992fc8c7f95a97))
* **spec:** snapshotJson refuses, never throws, when a trap throws a proxy ([b6eaf3c](https://github.com/LamaSu/physical-capability-cloud/commit/b6eaf3ca744a4683dc897b77ac6cce4501e76db9))
