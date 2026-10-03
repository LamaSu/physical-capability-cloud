"""Tests for the ported operating loop (pcc_node.operating).

Runnable via: pytest -q   (collected automatically from the package's tests/)

FakeRuntime records every run() call (and the idle state at call time) so
every refusal test can assert the central invariant: the device was never
touched. FakeJobPort serves scripted jobs/params and records report()/
complete() calls.
"""

from __future__ import annotations

import threading
import unittest

from pcc_node.operating.envelope import check_envelope, check_params
from pcc_node.operating.loop import (
    CompleteAck,
    DeviceRuntime,
    Job,
    JobPort,
    Outcome,
    ReportAck,
    RuntimeResult,
    run_loop,
    run_once,
)
from pcc_node.operating.profile import build_r0_plate_reader_profile


def valid_params(wells="all", wavelength_nm=450, plate_format="96-well"):
    return {"plateFormat": plate_format, "wavelengthNm": wavelength_nm, "wells": wells}


class FakeRuntime:
    """Records every run() call (operation, params, idle-at-call-time)."""

    def __init__(self, *, idle=True, result=None):
        self.idle = idle
        self.result = result
        self.run_calls = []
        self._in_run = False

    def is_idle(self):
        return self.idle

    def run(self, operation, params, *, claim):
        if self._in_run:
            raise AssertionError("overlapping run() calls for one device")
        self._in_run = True
        try:
            self.run_calls.append(
                {"operation": operation, "params": params, "idle_at_call": self.idle, "claim": claim}
            )
            return self.result
        finally:
            self._in_run = False


class FakeJobPort:
    """Serves scripted jobs/params; records report() and complete() calls."""

    def __init__(self, *, params_by_job=None, claim_queue=None, stop_event=None,
                 report_ack="default", complete_ack="default"):
        # The gateway's acks (adk #4813). "default" means the gateway stores the
        # evidence and accepts the final status as given; a test can script either.
        self.report_ack = report_ack
        self.complete_ack = complete_ack
        self.params_by_job = dict(params_by_job or {})
        self.claim_queue = list(claim_queue) if claim_queue is not None else None
        self._claim_index = 0
        self.stop_event = stop_event
        self.report_calls = []
        self.complete_calls = []
        self.claim_calls = []

    def claim_next(self, kernel_id):
        self.claim_calls.append(kernel_id)
        if self.claim_queue is None:
            return None
        if self._claim_index >= len(self.claim_queue):
            if self.stop_event is not None:
                self.stop_event.set()
            return None
        item = self.claim_queue[self._claim_index]
        self._claim_index += 1
        return item

    def resolve_params(self, job):
        return self.params_by_job.get(job.job_id)

    def report(self, job, evidence):
        self.report_calls.append((job.job_id, evidence))
        return ReportAck(stored=True) if self.report_ack == "default" else self.report_ack

    def complete(self, job, *, passed, reason):
        self.complete_calls.append((job.job_id, passed, reason))
        if self.complete_ack == "default":
            return CompleteAck(status="completed" if passed else "failed", accepted=True)
        return self.complete_ack


class FakeGate:
    """The emergency stop: answers scripted values in order, then repeats the last one."""

    def __init__(self, *answers):
        self.answers = list(answers) or [True]
        self.calls = 0

    def allows_jobs(self):
        i = min(self.calls, len(self.answers) - 1)
        self.calls += 1
        answer = self.answers[i]
        if isinstance(answer, BaseException):
            raise answer
        return answer


OPEN = FakeGate(True)


class ProtocolShapeTests(unittest.TestCase):
    """DeviceRuntime/JobPort are structural Protocols; fakes satisfy them
    without inheriting from them."""

    def test_fake_runtime_satisfies_protocol(self):
        self.assertIsInstance(FakeRuntime(), DeviceRuntime)

    def test_fake_jobport_satisfies_protocol(self):
        self.assertIsInstance(FakeJobPort(), JobPort)


class RunOnceTests(unittest.TestCase):
    def setUp(self):
        self.profile = build_r0_plate_reader_profile()
        self.op = "runPlate"

    def test_valid_all_wells_job_runs_and_passes(self):
        job = Job(job_id="j1", operation=self.op)
        params = valid_params(wells="all")
        jobs = FakeJobPort(params_by_job={"j1": params})
        evidence = {"readings": {"A1": 0.1}}
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence=evidence))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(len(runtime.run_calls), 1)
        self.assertEqual(runtime.run_calls[0]["operation"], self.op)
        self.assertEqual(runtime.run_calls[0]["params"], params)
        self.assertEqual(
            outcome, Outcome(ran=True, passed=True, reason=None, evidence=evidence)
        )
        self.assertEqual(jobs.report_calls, [("j1", evidence)])
        self.assertEqual(jobs.complete_calls, [("j1", True, None)])

    def test_params_unresolved_blocks_run(self):
        job = Job(job_id="j2", operation=self.op)
        jobs = FakeJobPort(params_by_job={})  # resolve_params -> None
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertEqual(outcome, Outcome(ran=False, passed=False, reason="params_unresolved", evidence=None))
        self.assertEqual(jobs.complete_calls, [("j2", False, "params_unresolved")])

    def test_params_invalid_wrong_plate_format(self):
        job = Job(job_id="j3", operation=self.op)
        params = valid_params()
        params["plateFormat"] = "384-well"
        jobs = FakeJobPort(params_by_job={"j3": params})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertFalse(outcome.ran)
        self.assertTrue(outcome.reason.startswith("params_invalid"))
        self.assertEqual(jobs.complete_calls, [("j3", False, outcome.reason)])

    def test_params_invalid_wavelength_not_int(self):
        job = Job(job_id="j4", operation=self.op)
        params = valid_params()
        params["wavelengthNm"] = "450"  # string, not int
        jobs = FakeJobPort(params_by_job={"j4": params})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertTrue(outcome.reason.startswith("params_invalid"))

    def test_params_invalid_wells_not_list_or_all(self):
        job = Job(job_id="j5", operation=self.op)
        params = valid_params()
        params["wells"] = 42  # not "all", not a list
        jobs = FakeJobPort(params_by_job={"j5": params})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertTrue(outcome.reason.startswith("params_invalid"))

    def test_params_invalid_bad_well_name(self):
        for bad_name in ("Z9", "A13", "I1"):
            with self.subTest(bad_name=bad_name):
                job = Job(job_id=f"j-bad-{bad_name}", operation=self.op)
                params = valid_params(wells=["A1", bad_name])
                jobs = FakeJobPort(params_by_job={job.job_id: params})
                runtime = FakeRuntime(
                    idle=True, result=RuntimeResult(ok=True, evidence={"x": 1})
                )

                outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

                self.assertEqual(runtime.run_calls, [])
                self.assertTrue(outcome.reason.startswith("params_invalid"))

    def test_params_invalid_duplicate_wells(self):
        job = Job(job_id="j6", operation=self.op)
        params = valid_params(wells=["A1", "A2", "A1"])
        jobs = FakeJobPort(params_by_job={"j6": params})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertTrue(outcome.reason.startswith("params_invalid"))

    def test_envelope_violation_wavelength_not_whitelisted(self):
        job = Job(job_id="j7", operation=self.op)
        params = valid_params(wavelength_nm=500)  # int, but not in {405,450,600}
        jobs = FakeJobPort(params_by_job={"j7": params})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertFalse(outcome.ran)
        self.assertTrue(outcome.reason.startswith("envelope_violation"))
        self.assertEqual(jobs.complete_calls, [("j7", False, outcome.reason)])

    def test_device_busy_blocks_run(self):
        job = Job(job_id="j8", operation=self.op)
        params = valid_params()
        jobs = FakeJobPort(params_by_job={"j8": params})
        runtime = FakeRuntime(idle=False, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertEqual(
            outcome, Outcome(ran=False, passed=False, reason="device_busy", evidence=None)
        )
        self.assertEqual(jobs.complete_calls, [("j8", False, "device_busy")])

    def test_no_evidence_blocks_pass(self):
        job = Job(job_id="j9", operation=self.op)
        params = valid_params()
        jobs = FakeJobPort(params_by_job={"j9": params})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence=None))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        # The device WAS touched (ran=True) -- it's the evidence that's
        # missing, and we refuse to fabricate it.
        self.assertEqual(len(runtime.run_calls), 1)
        self.assertEqual(
            outcome, Outcome(ran=True, passed=False, reason="no_evidence", evidence=None)
        )
        self.assertEqual(jobs.report_calls, [])  # nothing real to report
        self.assertEqual(jobs.complete_calls, [("j9", False, "no_evidence")])

    def test_failed_run_without_evidence(self):
        job = Job(job_id="j10", operation=self.op)
        params = valid_params()
        jobs = FakeJobPort(params_by_job={"j10": params})
        runtime = FakeRuntime(
            idle=True, result=RuntimeResult(ok=False, error="adapter_timeout")
        )

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(len(runtime.run_calls), 1)
        self.assertTrue(outcome.ran)
        self.assertFalse(outcome.passed)
        self.assertEqual(jobs.report_calls, [])
        self.assertEqual(jobs.complete_calls, [("j10", False, "adapter_timeout")])

    def test_failed_run_with_evidence_still_reports(self):
        job = Job(job_id="j10b", operation=self.op)
        params = valid_params()
        jobs = FakeJobPort(params_by_job={"j10b": params})
        partial_evidence = {"partial": True}
        runtime = FakeRuntime(
            idle=True,
            result=RuntimeResult(ok=False, evidence=partial_evidence, error="short_circuit"),
        )

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertTrue(outcome.ran)
        self.assertFalse(outcome.passed)
        self.assertEqual(jobs.report_calls, [("j10b", partial_evidence)])
        self.assertEqual(jobs.complete_calls, [("j10b", False, "short_circuit")])

    def test_order_params_invalid_wins_over_device_busy(self):
        job = Job(job_id="j11", operation=self.op)
        params = valid_params()
        params["plateFormat"] = "384-well"  # invalid
        jobs = FakeJobPort(params_by_job={"j11": params})
        runtime = FakeRuntime(
            idle=False, result=RuntimeResult(ok=True, evidence={"x": 1})
        )  # ALSO busy

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertTrue(outcome.reason.startswith("params_invalid"))
        self.assertNotEqual(outcome.reason, "device_busy")

    def test_unknown_operation_blocks_run(self):
        job = Job(job_id="j12", operation="not-a-real-op")
        jobs = FakeJobPort(params_by_job={"j12": valid_params()})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)

        self.assertEqual(runtime.run_calls, [])
        self.assertTrue(outcome.reason.startswith("params_invalid"))


class EnvelopeUnitTests(unittest.TestCase):
    """Direct unit tests of the pure check_params/check_envelope functions."""

    def setUp(self):
        self.profile = build_r0_plate_reader_profile()
        self.op_spec = self.profile.operations["runPlate"]

    def test_check_envelope_flags_too_many_wells(self):
        # check_envelope's job (the envelope's "at most 96 distinct wells") is a
        # pure count/bound check, independent of check_params. On the real
        # 96-well grid there are only 96 valid distinct well names, so a
        # list of 97+ VALID, DISTINCT names can never exist -- by the
        # pigeonhole principle, any 97-name list drawn from a 96-name
        # universe must contain either an invalid name or a repeat, both of
        # which check_params already refuses. That makes the ">96 wells"
        # envelope bound unreachable through run_once with real well names.
        # check_envelope itself doesn't care about grid membership though
        # (that's check_params's job) -- only the distinct count -- so it
        # is exercised directly here with 97 arbitrary distinct strings.
        # See the final report for this resolved ambiguity.
        many_wells = [f"well-{i}" for i in range(97)]
        params = {"plateFormat": "96-well", "wavelengthNm": 450, "wells": many_wells}

        problems = check_envelope(self.op_spec, params)

        self.assertTrue(any("wells" in p for p in problems), problems)

    def test_check_envelope_all_wells_within_bound(self):
        self.assertEqual(check_envelope(self.op_spec, valid_params(wells="all")), [])

    def test_check_envelope_exactly_96_wells_is_fine(self):
        grid = sorted(self.op_spec.params[2].grid)
        self.assertEqual(len(grid), 96)
        params = valid_params(wells=grid)
        self.assertEqual(check_envelope(self.op_spec, params), [])

    def test_check_params_ok_on_valid_input(self):
        params = valid_params(wells=["A1", "H12"])
        self.assertEqual(check_params(self.op_spec, params), [])

    def test_check_params_never_raises_on_garbage(self):
        for garbage in (None, [], "nope", 42, {"wells": object()}):
            with self.subTest(garbage=garbage):
                problems = check_params(self.op_spec, garbage)
                self.assertIsInstance(problems, list)

    def test_check_envelope_never_raises_on_garbage(self):
        for garbage in (None, [], "nope", 42, {"wavelengthNm": "not-an-int"}):
            with self.subTest(garbage=garbage):
                problems = check_envelope(self.op_spec, garbage)
                self.assertIsInstance(problems, list)

    def test_profile_declares_read_only(self):
        self.assertFalse(self.op_spec.envelope["actuates"])

    def test_wells_param_field_grid_is_96_names_a1_to_h12(self):
        grid = self.op_spec.params[2].grid
        self.assertEqual(len(grid), 96)
        self.assertIn("A1", grid)
        self.assertIn("H12", grid)
        self.assertNotIn("Z9", grid)
        self.assertNotIn("A13", grid)
        self.assertNotIn("I1", grid)


class RunLoopTests(unittest.TestCase):
    def test_processes_three_jobs_in_order_then_stops(self):
        profile = build_r0_plate_reader_profile()
        op = "runPlate"
        scripted_jobs = [
            Job(job_id="a", operation=op),
            Job(job_id="b", operation=op),
            Job(job_id="c", operation=op),
        ]
        params_by_job = {j.job_id: valid_params(wells="all") for j in scripted_jobs}

        stop_event = threading.Event()
        jobs = FakeJobPort(
            params_by_job=params_by_job, claim_queue=scripted_jobs, stop_event=stop_event
        )
        runtime = FakeRuntime(
            idle=True, result=RuntimeResult(ok=True, evidence={"readings": {}})
        )

        run_loop(profile, runtime, jobs, gate=OPEN, stop_event=stop_event, idle_sleep=0.001)

        self.assertEqual([c["operation"] for c in runtime.run_calls], [op, op, op])
        self.assertEqual([c[0] for c in jobs.complete_calls], ["a", "b", "c"])
        self.assertTrue(all(passed for (_, passed, _) in jobs.complete_calls))
        self.assertTrue(stop_event.is_set())
        # FakeRuntime.run() raises on overlap; reaching here with no
        # exception is itself proof no two jobs ran at once.

    def test_stop_event_set_before_start_runs_nothing(self):
        profile = build_r0_plate_reader_profile()
        stop_event = threading.Event()
        stop_event.set()
        jobs = FakeJobPort(claim_queue=[Job(job_id="never", operation="runPlate")])
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))

        run_loop(profile, runtime, jobs, gate=OPEN, stop_event=stop_event, idle_sleep=0.001)

        self.assertEqual(runtime.run_calls, [])
        self.assertEqual(jobs.claim_calls, [])


class GatewayAckTests(unittest.TestCase):
    """adk #4813: a pass needs the evidence STORED and the completion ACCEPTED as "completed"."""

    def _run(self, **port_kwargs):
        profile = build_r0_plate_reader_profile()
        job = Job(job_id="ack", operation="runPlate")
        jobs = FakeJobPort(params_by_job={"ack": valid_params()}, **port_kwargs)
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"readings": {"A1": 0.1}}))
        return run_once(profile, runtime, jobs, job, gate=OPEN), jobs, runtime

    def test_both_acks_good_is_a_pass(self):
        outcome, jobs, _ = self._run()
        self.assertTrue(outcome.passed)
        self.assertEqual(jobs.complete_calls, [("ack", True, None)])

    def test_evidence_not_stored_is_not_a_pass_and_completes_as_failed(self):
        outcome, jobs, runtime = self._run(report_ack=ReportAck(stored=False, reason="evidence_invalid:broken_chain"))
        self.assertEqual(len(runtime.run_calls), 1)
        self.assertFalse(outcome.passed)
        self.assertEqual(outcome.reason, "evidence_not_stored:evidence_invalid:broken_chain")
        self.assertEqual(jobs.complete_calls, [("ack", False, "evidence_not_stored:evidence_invalid:broken_chain")])

    def test_completion_not_accepted_is_not_a_pass(self):
        outcome, _, _ = self._run(complete_ack=CompleteAck(status="failed", accepted=False, reason="ignored"))
        self.assertFalse(outcome.passed)
        self.assertEqual(outcome.reason, "completion_not_accepted:failed:ignored")

    def test_accepted_but_not_completed_is_not_a_pass(self):
        outcome, _, _ = self._run(complete_ack=CompleteAck(status="disputed", accepted=True))
        self.assertFalse(outcome.passed)
        self.assertTrue(outcome.reason.startswith("completion_not_accepted:disputed:"))

    def test_a_port_that_returns_no_acks_never_passes(self):
        outcome, jobs, _ = self._run(report_ack=None, complete_ack=None)
        self.assertFalse(outcome.passed)
        self.assertEqual(outcome.reason, "evidence_not_stored:no_ack")
        self.assertEqual(jobs.complete_calls, [("ack", False, "evidence_not_stored:no_ack")])

    def test_acks_are_read_by_shape_so_the_ports_own_classes_work(self):
        from types import SimpleNamespace
        outcome, _, _ = self._run(
            report_ack=SimpleNamespace(stored=True, reason=None),
            complete_ack=SimpleNamespace(status="completed", accepted=True, reason=None),
        )
        self.assertTrue(outcome.passed)

    def test_truthy_but_not_true_acks_do_not_pass(self):
        from types import SimpleNamespace
        outcome, _, _ = self._run(report_ack=SimpleNamespace(stored="yes"))
        self.assertFalse(outcome.passed)


class DeviceStateUnknownTests(unittest.TestCase):
    """adk #4813: "*:device_state_unknown" means the device may still be running."""

    def test_a_timeout_with_unknown_device_state_is_flagged_and_not_a_pass(self):
        profile = build_r0_plate_reader_profile()
        job = Job(job_id="t", operation="runPlate")
        jobs = FakeJobPort(params_by_job={"t": valid_params()})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=False, error="timeout:device_state_unknown"))
        outcome = run_once(profile, runtime, jobs, job, gate=OPEN)
        self.assertFalse(outcome.passed)
        self.assertTrue(outcome.device_state_unknown)
        self.assertEqual(jobs.complete_calls, [("t", False, "timeout:device_state_unknown")])

    def test_an_ordinary_failure_is_not_flagged_unknown(self):
        profile = build_r0_plate_reader_profile()
        jobs = FakeJobPort(params_by_job={"f": valid_params()})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=False, error="bad_run_id"))
        outcome = run_once(profile, runtime, jobs, Job(job_id="f", operation="runPlate"), gate=OPEN)
        self.assertFalse(outcome.device_state_unknown)

    def test_run_loop_never_claims_while_the_device_is_not_idle(self):
        profile = build_r0_plate_reader_profile()

        class StopAfterWaits:
            def __init__(self, n):
                self.n = n
                self.waits = 0
            def is_set(self):
                return self.waits >= self.n
            def wait(self, _seconds):
                self.waits += 1
                return self.is_set()

        stop = StopAfterWaits(3)
        jobs = FakeJobPort(claim_queue=[Job(job_id="later", operation="runPlate")])
        runtime = FakeRuntime(idle=False, result=RuntimeResult(ok=True, evidence={"x": 1}))
        run_loop(profile, runtime, jobs, gate=OPEN, stop_event=stop, idle_sleep=0.001)
        self.assertEqual(jobs.claim_calls, [])
        self.assertEqual(runtime.run_calls, [])
        self.assertEqual(jobs.complete_calls, [])



class GateAndSeamTests(unittest.TestCase):
    """The emergency-stop gate (adk #4227), the claim pass-through, and seams that fail closed."""

    def setUp(self):
        self.profile = build_r0_plate_reader_profile()
        self.op = "runPlate"

    def _loop(self, gate, *, idle=True, waits=3, runtime=None):
        class StopAfterWaits:
            def __init__(self, n):
                self.n, self.waits = n, 0
            def is_set(self):
                return self.waits >= self.n
            def wait(self, _seconds):
                self.waits += 1
                return self.is_set()

        jobs = FakeJobPort(claim_queue=[Job(job_id="g", operation=self.op)], params_by_job={"g": valid_params()})
        runtime = runtime or FakeRuntime(idle=idle, result=RuntimeResult(ok=True, evidence={"x": 1}))
        run_loop(self.profile, runtime, jobs, gate=gate, stop_event=StopAfterWaits(waits), idle_sleep=0.001)
        return jobs, runtime

    def test_run_passes_the_claimed_job_to_the_runtime_as_its_claim(self):
        job = Job(job_id="c1", operation=self.op)
        jobs = FakeJobPort(params_by_job={"c1": valid_params()})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))
        run_once(self.profile, runtime, jobs, job, gate=OPEN)
        self.assertIs(runtime.run_calls[0]["claim"], job)

    def test_a_closed_gate_claims_nothing(self):
        jobs, runtime = self._loop(FakeGate(False))
        self.assertEqual((jobs.claim_calls, runtime.run_calls, jobs.complete_calls), ([], [], []))

    def test_a_gate_that_raises_claims_nothing(self):
        jobs, runtime = self._loop(FakeGate(RuntimeError("stop state unreadable")))
        self.assertEqual((jobs.claim_calls, runtime.run_calls), ([], []))

    def test_a_truthy_answer_that_is_not_true_claims_nothing(self):
        jobs, runtime = self._loop(FakeGate("yes"))
        self.assertEqual((jobs.claim_calls, runtime.run_calls), ([], []))

    def test_a_stop_after_the_claim_refuses_before_the_device_call(self):
        # Open for run_loop's check before the claim, shut for run_once's check before the run.
        gate = FakeGate(True, False)
        jobs, runtime = self._loop(gate, waits=1)
        self.assertEqual(jobs.claim_calls, [self.profile.kernel_id])
        self.assertEqual(runtime.run_calls, [])
        self.assertEqual(jobs.complete_calls, [("g", False, "emergency_stop")])

    def test_run_once_refuses_on_a_shut_gate_with_the_device_untouched(self):
        job = Job(job_id="s1", operation=self.op)
        jobs = FakeJobPort(params_by_job={"s1": valid_params()})
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))
        outcome = run_once(self.profile, runtime, jobs, job, gate=FakeGate(RuntimeError("down")))
        self.assertEqual(outcome, Outcome(ran=False, passed=False, reason="emergency_stop", evidence=None))
        self.assertEqual(runtime.run_calls, [])
        self.assertEqual(jobs.complete_calls, [("s1", False, "emergency_stop")])

    def test_a_run_that_raises_is_device_state_unknown_and_completes_failed(self):
        class RaisingRuntime(FakeRuntime):
            def run(self, operation, params, *, claim):
                super().run(operation, params, claim=claim)
                raise OSError("connection reset after the request was sent")

        job = Job(job_id="r1", operation=self.op)
        jobs = FakeJobPort(params_by_job={"r1": valid_params()})
        runtime = RaisingRuntime(idle=True)
        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)
        self.assertEqual(len(runtime.run_calls), 1)
        self.assertEqual(outcome, Outcome(ran=True, passed=False, reason="runtime_error:device_state_unknown",
                                          evidence=None, device_state_unknown=True))
        self.assertEqual(jobs.complete_calls, [("r1", False, "runtime_error:device_state_unknown")])
        self.assertEqual(jobs.report_calls, [])

    def test_a_run_without_a_usable_result_is_device_state_unknown(self):
        job = Job(job_id="r2", operation=self.op)
        jobs = FakeJobPort(params_by_job={"r2": valid_params()})
        runtime = FakeRuntime(idle=True, result=None)
        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)
        self.assertTrue(outcome.ran)
        self.assertFalse(outcome.passed)
        self.assertTrue(outcome.device_state_unknown)
        self.assertEqual(jobs.complete_calls, [("r2", False, "runtime_bad_result:device_state_unknown")])

    def test_an_is_idle_that_raises_is_a_busy_device(self):
        class Unreachable(FakeRuntime):
            def is_idle(self):
                raise OSError("no route to device")

        job = Job(job_id="i1", operation=self.op)
        jobs = FakeJobPort(params_by_job={"i1": valid_params()})
        runtime = Unreachable(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))
        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)
        self.assertEqual(outcome.reason, "device_busy")
        self.assertEqual(runtime.run_calls, [])
        looped_jobs, looped_runtime = self._loop(OPEN, runtime=Unreachable(idle=True))
        self.assertEqual((looped_jobs.claim_calls, looped_runtime.run_calls), ([], []))

    def test_a_resolve_params_that_raises_is_unresolved(self):
        class Flaky(FakeJobPort):
            def resolve_params(self, job):
                raise TimeoutError("gateway timed out")

        job = Job(job_id="p1", operation=self.op)
        jobs = Flaky()
        runtime = FakeRuntime(idle=True, result=RuntimeResult(ok=True, evidence={"x": 1}))
        outcome = run_once(self.profile, runtime, jobs, job, gate=OPEN)
        self.assertEqual(outcome.reason, "params_unresolved")
        self.assertEqual(runtime.run_calls, [])


if __name__ == "__main__":
    unittest.main()
