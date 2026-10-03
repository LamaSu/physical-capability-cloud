"""The operating loop: run_once (the job contract) and run_loop.

Pure orchestration + safety. DeviceRuntime, JobPort, Gate and DeviceLock are
injected seams (Protocols) -- this module touches no hardware; it is fully
testable with fakes. pcc_node.operating.runtime's AdapterRuntime (adk, #471)
implements DeviceRuntime, pcc_node.operating.jobport's GatewayJobPort
implements JobPort, and pcc_node.operating.devicelock's HostDeviceLock
implements DeviceLock. This module imports none of them (structural typing).

The invariants, in order:

  1. resolve params        -- JobPort.resolve_params
  2. type-check             -- envelope.check_params
  3. envelope-check         -- envelope.check_envelope (fails closed)
  4. the device, held       -- DeviceLock.acquire(): this host's exclusive hold
  4a. readiness             -- DeviceRuntime.is_idle()
  4b. emergency stop        -- Gate.allows_jobs(), re-read just before the device call
  4c. one-shot record       -- DeviceLock.consume(job): never run a job twice
  5. run exactly one op     -- DeviceRuntime.run()   <- only step that touches hardware
  6. report + complete      -- JobPort.report / JobPort.complete

On ANY refusal (steps 1-4c), run_once returns without ever calling
DeviceRuntime.run -- the device is untouched -- and completes the job as
failed with the reason.

**One device, one run at a time, each job once** (astra 554 F1). Checking that
the device is idle and then running it are two steps, so two loops (threads or
processes) could both see it idle. The hold closes that: it is taken before the
idle check and kept until run() returns, and every loop on the host that drives
the device takes the same hold. The one-shot record is made durable before the
device is driven, so a job is never run twice on this host, even after a crash.
Two HOSTS pointed at one device are outside what a host can enforce; see
devicelock.py for that boundary.

The Gate is the emergency stop as the loop sees it (adk #4227): run_loop reads
it before every claim and run_once reads it again just before the device call,
because a stop can arrive while a claimed job's params are being resolved.
Only an answer of exactly True opens it; False, any other value or an
exception keeps it shut. pcc-node's stop guard implements it (wired in once
#454 is certified); stopping a run already in progress is the runtime's job
(AdapterRuntime.cancel), not the loop's.

The loop also fails closed on its seams:
- a resolve_params that raises is an unresolved job;
- a type or envelope check that raises is an invalid job;
- an is_idle that raises (or answers anything but True) is a busy device;
- a lock that raises refuses the job;
- a run that raises, or returns no bool ``ok``, is a run whose device state is
  unknown: the job is completed as failed, and nothing new is claimed until the
  device reports idle;
- a report that raises means the evidence was not stored: the job is completed
  as failed (a port such as GatewayJobPort ends the claim's lease there);
- a complete that raises stops the loop, after ending the claim's lease by
  shape (``job.lease.release()``), so a claim is never left renewing.
Every Outcome says whether the gateway accepted the job's completion, and
run_loop stops (CompletionNotAccepted) the first time it did not: a node that
cannot record its outcomes must not keep driving the device.
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
    JobPort.resolve_params(job). A ``claim_token``, when the job has one,
    is part of its one-shot key.
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
    completion_accepted: the gateway acknowledged the job's completion, as
            passed or as failed (an ack whose ``accepted`` is exactly True).
            False when it refused or didn't answer: the job's final state is
            then not recorded, and run_loop stops.
    """

    ran: bool
    passed: bool
    reason: Optional[str]
    evidence: Optional[dict]
    device_state_unknown: bool = False
    completion_accepted: bool = False


class CompletionNotAccepted(RuntimeError):
    """run_loop stopped: the gateway did not accept a job's completion (see ``outcome``)."""

    def __init__(self, outcome: Outcome) -> None:
        super().__init__(f"the gateway did not accept the completion: {outcome.reason}")
        self.outcome = outcome


def _stored(ack: Any) -> bool:
    """The port stored the evidence. Read by shape, not class: adk's port has its own ack types."""
    return getattr(ack, "stored", None) is True


def _accepted(ack: Any) -> bool:
    """The port accepted the completion, whatever it recorded."""
    return getattr(ack, "accepted", None) is True


def _accepted_completed(ack: Any) -> bool:
    """The port accepted the completion and records the job as completed."""
    return _accepted(ack) and getattr(ack, "status", None) == "completed"


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


@runtime_checkable
class DeviceLock(Protocol):
    """This host's exclusive hold on the device, and its record of the jobs run on it.

    Implemented by pcc_node.operating.devicelock.HostDeviceLock.
    """

    def acquire(self) -> bool:
        """Take the hold without waiting: True if held now, False if anything else holds it."""
        ...

    def release(self) -> None: ...

    def consume(self, job_key: str) -> bool:
        """Record durably that this job runs now: True the first time, False ever after."""
        ...


def _gate_open(gate: Any) -> bool:
    """Only an answer of exactly True opens the gate; anything else, or an exception, keeps it shut."""
    try:
        return gate.allows_jobs() is True
    except Exception:
        return False


def _idle(runtime: Any) -> bool:
    """A device that can't answer, or answers anything but True, is busy."""
    try:
        return runtime.is_idle() is True
    except Exception:
        return False


def _acquire(lock: Any) -> Optional[bool]:
    """True: held. False: held by something else. None: the lock itself failed."""
    try:
        held = lock.acquire()
    except Exception:
        return None
    return True if held is True else False


def _release(lock: Any) -> None:
    try:
        lock.release()
    except Exception:
        pass  # the kernel releases a dead holder's lock; nothing more to do here


def _probe(lock: Any) -> bool:
    """Whether the device is free to hold now: taken and let go at once."""
    if _acquire(lock) is True:
        _release(lock)
        return True
    return False


def _consume(lock: Any, key: str) -> Optional[bool]:
    """True: recorded now. False: this job was already run. None: no record could be made."""
    try:
        first = lock.consume(key)
    except Exception:
        return None
    return True if first is True else False


def _job_key(job: Any) -> Optional[str]:
    """The job's one-shot key: its id and claim token, length-prefixed so no two collide."""
    job_id = getattr(job, "job_id", None)
    if not isinstance(job_id, str) or not job_id:
        return None
    token = getattr(job, "claim_token", "")
    token = token if isinstance(token, str) else ""
    return f"{len(job_id)}:{job_id}{token}"


def _end_lease(job: Any) -> None:
    """End the claim's lease, by shape (ClaimedJob.lease.release()), if the job has one."""
    release = getattr(getattr(job, "lease", None), "release", None)
    if callable(release):
        try:
            release()
        except Exception:
            pass


def _complete(jobs: Any, job: Any, *, passed: bool, reason: Optional[str]) -> Any:
    """Complete the job. If the port raises, end the claim's lease first, then let the
    exception stop the loop: a crashed completion never leaves a claim renewing."""
    try:
        return jobs.complete(job, passed=passed, reason=reason)
    except BaseException:
        _end_lease(job)
        raise


def _run(runtime: Any, job: Any, operation: str, params: dict):
    """Step 5. A run that raises, or returns no bool ok, may have reached the device."""
    try:
        result = runtime.run(operation, params, claim=job)
        ok = getattr(result, "ok", None)
        evidence = getattr(result, "evidence", None)
        error = getattr(result, "error", None)
    except Exception:
        return False, None, "runtime_error" + DEVICE_STATE_UNKNOWN
    if not isinstance(ok, bool):
        return False, None, "runtime_bad_result" + DEVICE_STATE_UNKNOWN
    return ok, evidence, error


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


def run_once(profile: Any, runtime: DeviceRuntime, jobs: JobPort, job: Job, *, gate: Gate,
             lock: DeviceLock) -> Outcome:
    """Run the job contract exactly once, in order, for one job.

    Refuses (steps 1-4c) without ever calling runtime.run -- the device is
    untouched on any refusal. Evidence is never fabricated: a run with no
    evidence is passed=False, reason="no_evidence", even though ran=True.
    """

    def fail(reason: str, *, ran: bool = False, evidence: Optional[dict] = None, unknown: bool = False) -> Outcome:
        ack = _complete(jobs, job, passed=False, reason=reason)
        return Outcome(ran=ran, passed=False, reason=reason, evidence=evidence, device_state_unknown=unknown,
                       completion_accepted=_accepted(ack))

    # Step 1: resolve the buyer's typed parameters. A port that raises has resolved nothing.
    try:
        params = jobs.resolve_params(job)
    except Exception:
        params = None
    if params is None:
        return fail("params_unresolved")

    # Look up the operation's schema (needed for steps 2-3). A profile declares
    # every operation it knows about; an operation name the profile doesn't
    # recognize has no schema to check against, so it is refused the same way
    # a shape problem would be -- before ever touching the device.
    operation = getattr(job, "operation", None)
    op_spec = profile.operations.get(operation) if isinstance(operation, str) else None
    if op_spec is None:
        return fail(f"params_invalid:unknown_operation:{operation}")

    # Step 2: type-check. A check that raises has passed nothing.
    try:
        param_problems = check_params(op_spec, params)
    except Exception:
        param_problems = ["unchecked"]
    if param_problems:
        return fail("params_invalid:" + "; ".join(param_problems))

    # Step 3: envelope-check. Fails closed; runs before any call to runtime.run.
    try:
        envelope_problems = check_envelope(op_spec, params)
    except Exception:
        envelope_problems = ["unchecked"]
    if envelope_problems:
        return fail("envelope_violation:" + "; ".join(envelope_problems))

    key = _job_key(job)
    if key is None:
        return fail("job_unidentified")

    # Step 4: this host's hold on the device, kept from the idle check until run()
    # returns, so no other loop can drive the device in between (astra 554 F1).
    held = _acquire(lock)
    if held is None:
        return fail("device_lock_unavailable")
    if not held:
        return fail("device_locked")
    refusal: Optional[str] = None
    try:
        if not _idle(runtime):
            # Step 4a: readiness -- never queue over a running job.
            refusal = "device_busy"
        elif not _gate_open(gate):
            # Step 4b: the emergency stop, read again as late as possible: it can
            # arrive while the params are resolved or the device is asked if it is idle.
            refusal = "emergency_stop"
        else:
            # Step 4c: the one-shot record, made durable before the device moves.
            first = _consume(lock, key)
            if first is None:
                refusal = "run_record_unavailable"
            elif not first:
                refusal = "job_already_run"
            else:
                # Step 5: run exactly one operation. Only now does the device move.
                # The job goes to the runtime as the claim it is.
                ok, evidence, error = _run(runtime, job, operation, params)
    finally:
        _release(lock)
    if refusal is not None:
        return fail(refusal)

    # Step 6: report the evidence, then complete. Evidence is never
    # fabricated -- we only report what the runtime actually returned, and
    # only when there is something real to report. The outcome follows the
    # gateway's own acknowledgements (adk #4813): a pass needs the evidence
    # STORED and the completion ACCEPTED as "completed". A missing or
    # unrecognized ack is not a pass (fail closed).
    if not ok:
        if evidence:
            try:
                jobs.report(job, evidence)  # no ack can turn a failed run into a pass
            except Exception:
                pass  # the run failed either way; the completion below still ends the claim
        reason = error if isinstance(error, str) and error else "run_failed"
        return fail(reason, ran=True, evidence=evidence, unknown=reason.endswith(DEVICE_STATE_UNKNOWN))

    if not evidence:
        return fail("no_evidence", ran=True)

    try:
        report_ack = jobs.report(job, evidence)
    except Exception:
        return fail("evidence_not_stored:report_error", ran=True, evidence=evidence)
    if not _stored(report_ack):
        return fail("evidence_not_stored:" + str(getattr(report_ack, "reason", None) or "no_ack"), ran=True,
                    evidence=evidence)

    complete_ack = _complete(jobs, job, passed=True, reason=None)
    if not _accepted_completed(complete_ack):
        reason = "completion_not_accepted:{}:{}".format(
            getattr(complete_ack, "status", None), getattr(complete_ack, "reason", None) or "no_ack"
        )
        return Outcome(ran=True, passed=False, reason=reason, evidence=evidence, completion_accepted=False)
    return Outcome(ran=True, passed=True, reason=None, evidence=evidence, completion_accepted=True)


def run_loop(
    profile: Any,
    runtime: DeviceRuntime,
    jobs: JobPort,
    *,
    gate: Gate,
    lock: DeviceLock,
    stop_event: Any,
    idle_sleep: float = 0.2,
) -> None:
    """claim_next -> run_once, repeat.

    Backs off `idle_sleep` (via stop_event.wait, so a set stop_event
    interrupts the backoff immediately) when claim_next finds no job.
    Stops cleanly as soon as stop_event is set. Strictly synchronous --
    each run_once call fully completes before the next claim_next. It never
    CLAIMS while the emergency stop is engaged (or its state is unknown), while
    another loop holds the device, or while the device is not idle: after a
    "*:device_state_unknown" run the device may still be running (adk #4813),
    and a claimed job would only be refused. So the loop waits until all three
    allow it. run_once still takes the hold itself; the check here only avoids
    claiming a job another loop would make it refuse.

    Raises CompletionNotAccepted, and stops, the first time the gateway does not
    accept a job's completion. Exceptions from claim_next, report or complete
    propagate and stop it too.
    """
    while not stop_event.is_set():
        if not _gate_open(gate) or not _probe(lock) or not _idle(runtime):
            stop_event.wait(idle_sleep)
            continue
        job = jobs.claim_next(profile.kernel_id)
        if job is None:
            stop_event.wait(idle_sleep)
            continue
        outcome = run_once(profile, runtime, jobs, job, gate=gate, lock=lock)
        if not outcome.completion_accepted:
            raise CompletionNotAccepted(outcome)
