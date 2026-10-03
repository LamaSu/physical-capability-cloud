"""The operating loop: run_once (the 6-step safety contract) and run_loop.

Pure orchestration + safety. DeviceRuntime and JobPort are injected seams
(Protocols) -- this module touches no hardware; it is fully testable with
fakes. pcc_node.operating.runtime's AdapterRuntime (adk, #471) implements
DeviceRuntime, and pcc_node.operating.jobport's GatewayJobPort implements
JobPort; this module imports neither (structural typing).

The invariants, in order:

  1. resolve params        -- JobPort.resolve_params
  2. type-check             -- envelope.check_params
  3. envelope-check         -- envelope.check_envelope (fails closed)
  4. readiness              -- DeviceRuntime.is_idle()
  4b. emergency stop        -- Gate.allows_jobs(), re-read just before the device call
  5. run exactly one op     -- DeviceRuntime.run()   <- only step that touches hardware
  6. report + complete      -- JobPort.report / JobPort.complete

On ANY refusal (steps 1-4b), run_once returns without ever calling
DeviceRuntime.run -- the device is untouched.

The Gate is the emergency stop as the loop sees it (adk #4227): run_loop reads
it before every claim and run_once reads it again just before the device call,
because a stop can arrive while a claimed job's params are being resolved.
Only an answer of exactly True opens it; False, any other value or an
exception keeps it shut. pcc-node's stop guard implements it (wired in once
#454 is certified); stopping a run already in progress is the runtime's job
(AdapterRuntime.cancel), not the loop's.

The loop also fails closed on its seams: a resolve_params that raises is an
unresolved job, an is_idle that raises is a busy device, and a run that raises
(or returns something without ok/evidence/error) is a run whose device state is
unknown, so the job is completed as failed and nothing new is claimed until the
device reports idle.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Protocol, runtime_checkable

from .envelope import check_envelope, check_params


@dataclass(frozen=True)
class Job:
    """The minimal loop-visible shape of a claimed job.

    The job itself is gateway-owned; pcc_node.operating.jobport's ClaimedJob is
    one shape of it. This is the minimal contract the loop itself
    needs: an id (for report/complete) and the operation name (to select
    the OperationSpec out of the profile). Everything the buyer actually
    selected is opaque to the loop and lives behind
    JobPort.resolve_params(job).
    """

    job_id: str
    operation: str


@dataclass(frozen=True)
class RuntimeResult:
    """What DeviceRuntime.run returns: {ok, output, evidence, error}."""

    ok: bool
    output: Any = None
    evidence: Optional[dict] = None
    error: Optional[str] = None


@dataclass(frozen=True)
class ReportAck:
    """What JobPort.report returns (adk #471 round 2, #4813).

    stored: the gateway stored the evidence. False with a reason such as
            "evidence_invalid:<why>" when the port could not check it.
    """

    stored: bool
    reason: Optional[str] = None


@dataclass(frozen=True)
class CompleteAck:
    """What JobPort.complete returns (adk #471 round 2, #4813).

    accepted: the gateway accepted the final status.
    status:   the job's status as the gateway now records it.
    """

    status: Optional[str]
    accepted: bool
    reason: Optional[str] = None


#: The suffix of a RuntimeResult.error after which the device may still be
#: running ("timeout:device_state_unknown", "cancelled:device_state_unknown").
DEVICE_STATE_UNKNOWN = ":device_state_unknown"


@dataclass(frozen=True)
class Outcome:
    """What run_once returns.

    ran:    True only if DeviceRuntime.run() was actually called.
    passed: True only after a real run whose evidence was present and ok,
            whose evidence the gateway STORED, and whose completion the
            gateway ACCEPTED with status "completed" (adk #4813). Mirrors
            #450's ran/passed split: ran = we called run(); passed = the run
            succeeded and the gateway agreed.
    device_state_unknown: the run ended without knowing whether the device
            stopped (adk #4813): the device may still be running.
    """

    ran: bool
    passed: bool
    reason: Optional[str]
    evidence: Optional[dict]
    device_state_unknown: bool = False


def _stored(ack: Any) -> bool:
    """The port stored the evidence. Read by shape, not class: adk's port has its own ack types."""
    return getattr(ack, "stored", None) is True


def _accepted_completed(ack: Any) -> bool:
    """The port accepted the completion and records the job as completed."""
    return getattr(ack, "accepted", None) is True and getattr(ack, "status", None) == "completed"


@runtime_checkable
class DeviceRuntime(Protocol):
    """The deterministic executor. Implemented by adk with pcc-node + adapter."""

    def is_idle(self) -> bool: ...

    def run(self, operation: str, params: dict, *, claim: Any) -> RuntimeResult:
        """Run ONE typed, already-envelope-checked operation for a claimed job.

        ``claim`` is the job exactly as JobPort.claim_next returned it. pcc-node's
        AdapterRuntime binds the request and the evidence to its job, kernel and
        claim token, and stops the run when its lease is lost.
        Never called by this module otherwise.
        """
        ...


@runtime_checkable
class Gate(Protocol):
    """The emergency stop, as the loop sees it (adk #4227)."""

    def allows_jobs(self) -> bool:
        """True only while the kernel is not emergency-stopped and the stop state is known."""
        ...


def _gate_open(gate: Any) -> bool:
    """Only an answer of exactly True opens the gate; anything else, or an exception, keeps it shut."""
    try:
        return gate.allows_jobs() is True
    except Exception:
        return False


def _idle(runtime: Any) -> bool:
    """A device that can't answer is busy."""
    try:
        return runtime.is_idle() is True
    except Exception:
        return False


@runtime_checkable
class JobPort(Protocol):
    """The work source + sink. Implemented by a gateway client."""

    def claim_next(self, kernel_id: str) -> Optional[Job]:
        """An accepted/funded job for this kernel, or None if none is ready."""
        ...

    def resolve_params(self, job: Job) -> Optional[dict]:
        """The buyer's typed selections, or None if they can't be resolved."""
        ...

    def report(self, job: Job, evidence: dict) -> ReportAck: ...

    def complete(self, job: Job, *, passed: bool, reason: Optional[str]) -> CompleteAck: ...


def run_once(profile: Any, runtime: DeviceRuntime, jobs: JobPort, job: Job, *, gate: Gate) -> Outcome:
    """Run the 6-step contract exactly once, in order, for one job.

    Refuses (steps 1-4b) without ever calling runtime.run -- the device is
    untouched on any refusal. Evidence is never fabricated: a run with no
    evidence is passed=False, reason="no_evidence", even though ran=True.
    """

    def refuse(reason: str) -> Outcome:
        jobs.complete(job, passed=False, reason=reason)
        return Outcome(ran=False, passed=False, reason=reason, evidence=None)

    # Step 1: resolve the buyer's typed parameters. A port that raises has resolved nothing.
    try:
        params = jobs.resolve_params(job)
    except Exception:
        params = None
    if params is None:
        return refuse("params_unresolved")

    # Look up the operation's schema (needed for steps 2-3). A profile
    # declares every operation it knows about; an
    # operation name the profile doesn't recognize has no schema to check
    # against, so it is refused the same way a shape problem would be --
    # before ever touching the device.
    op_spec = profile.operations.get(job.operation)
    if op_spec is None:
        return refuse(f"params_invalid:unknown_operation:{job.operation}")

    # Step 2: type-check.
    param_problems = check_params(op_spec, params)
    if param_problems:
        return refuse("params_invalid:" + "; ".join(param_problems))

    # Step 3: envelope-check. Fails closed; runs before any call to runtime.run.
    envelope_problems = check_envelope(op_spec, params)
    if envelope_problems:
        return refuse("envelope_violation:" + "; ".join(envelope_problems))

    # Step 4: readiness -- never queue over a running job.
    if not _idle(runtime):
        return refuse("device_busy")

    # Step 4b: the emergency stop, read again as late as possible: it can
    # arrive while the params are resolved or the device is asked if it is idle.
    if not _gate_open(gate):
        return refuse("emergency_stop")

    # Step 5: run exactly one operation. Only now does the device move. The
    # job goes to the runtime as the claim it is. A run that raises, or that
    # returns no usable result, may have reached the device: its state is unknown.
    try:
        result = runtime.run(job.operation, params, claim=job)
        ok = getattr(result, "ok", None)
        evidence = getattr(result, "evidence", None)
        error = getattr(result, "error", None)
    except Exception:
        ok, evidence, error = False, None, "runtime_error" + DEVICE_STATE_UNKNOWN
    if not isinstance(ok, bool):
        ok, evidence, error = False, None, "runtime_bad_result" + DEVICE_STATE_UNKNOWN

    # Step 6: report the evidence, then complete. Evidence is never
    # fabricated -- we only report what the runtime actually returned, and
    # only when there is something real to report. The outcome follows the
    # gateway's own acknowledgements (adk #4813): a pass needs the evidence
    # STORED and the completion ACCEPTED as "completed". A missing or
    # unrecognized ack is not a pass (fail closed).
    if not ok:
        if evidence:
            jobs.report(job, evidence)  # no ack can turn a failed run into a pass
        reason = error or "run_failed"
        jobs.complete(job, passed=False, reason=reason)
        unknown = isinstance(error, str) and error.endswith(DEVICE_STATE_UNKNOWN)
        return Outcome(ran=True, passed=False, reason=reason, evidence=evidence, device_state_unknown=unknown)

    if not evidence:
        jobs.complete(job, passed=False, reason="no_evidence")
        return Outcome(ran=True, passed=False, reason="no_evidence", evidence=None)

    report_ack = jobs.report(job, evidence)
    if not _stored(report_ack):
        reason = "evidence_not_stored:" + str(getattr(report_ack, "reason", None) or "no_ack")
        jobs.complete(job, passed=False, reason=reason)
        return Outcome(ran=True, passed=False, reason=reason, evidence=evidence)

    complete_ack = jobs.complete(job, passed=True, reason=None)
    if not _accepted_completed(complete_ack):
        reason = "completion_not_accepted:{}:{}".format(
            getattr(complete_ack, "status", None), getattr(complete_ack, "reason", None) or "no_ack"
        )
        return Outcome(ran=True, passed=False, reason=reason, evidence=evidence)
    return Outcome(ran=True, passed=True, reason=None, evidence=evidence)


def run_loop(
    profile: Any,
    runtime: DeviceRuntime,
    jobs: JobPort,
    *,
    gate: Gate,
    stop_event: Any,
    idle_sleep: float = 0.2,
) -> None:
    """claim_next -> run_once, repeat.

    Backs off `idle_sleep` (via stop_event.wait, so a set stop_event
    interrupts the backoff immediately) when claim_next finds no job.
    Stops cleanly as soon as stop_event is set. Strictly synchronous --
    each run_once call fully completes before the next claim_next, so it
    never runs two jobs at once for one device. It never CLAIMS while the
    emergency stop is engaged (or its state is unknown): the gate is read
    before every claim. Nor while the device is not idle: after a
    "*:device_state_unknown" run the device may still be running (adk #4813),
    and a claimed job would only be refused as device_busy. So the loop waits
    until the gate opens and the runtime reports idle.
    """
    while not stop_event.is_set():
        if not _gate_open(gate) or not _idle(runtime):
            stop_event.wait(idle_sleep)
            continue
        job = jobs.claim_next(profile.kernel_id)
        if job is None:
            stop_event.wait(idle_sleep)
            continue
        run_once(profile, runtime, jobs, job, gate=gate)
