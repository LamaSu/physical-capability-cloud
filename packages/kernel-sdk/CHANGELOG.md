# Changelog

## [0.2.0](https://github.com/LamaSu/physical-capability-cloud/compare/kernel-sdk-v0.1.0...kernel-sdk-v0.2.0) (2026-10-04)


### Features

* **evidence:** LO-EV-9 bind device evidence to the accepted job and kernel before settlement ([6f7877c](https://github.com/LamaSu/physical-capability-cloud/commit/6f7877c74edf22a6a27389c3c73cc89aa23bad02))
* **evidence:** LO-EV-9 binds the settlement unit and its challenge nonce, so one milestone's evidence cannot settle another ([d3309de](https://github.com/LamaSu/physical-capability-cloud/commit/d3309de8fb4e1a7d2595cd3c6f30859d199442a1))
* **spec:** LO-EV-1 canonical signing byte contract + cross-language goldens ([2a79af6](https://github.com/LamaSu/physical-capability-cloud/commit/2a79af660cebd8b4815aa45cd4d6dcfae5f3fed5))


### Bug Fixes

* **evidence:** LO-EV-1 review R20 round 2 -- refuse an empty derivationPath, one number domain, shared accept/reject vectors ([92b4302](https://github.com/LamaSu/physical-capability-cloud/commit/92b4302b6aee8a267ccbaef857458033b841ec67))
* **evidence:** LO-EV-9 binds every event to the job (and unit), and kernel-sdk names the job on every event ([0a4836a](https://github.com/LamaSu/physical-capability-cloud/commit/0a4836a672a8e55fbd7dd05d86e71bbfda9aa81f))
* **kernel:** unit fields come only from the binding, and only as a pair ([799cea1](https://github.com/LamaSu/physical-capability-cloud/commit/799cea1d98c387aa73269bfc0e10210bdb542b9a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @pcc/spec bumped to 0.2.0
