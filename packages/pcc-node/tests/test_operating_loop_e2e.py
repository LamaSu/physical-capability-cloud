"""End-to-end: the operating loop drives a fake plate-reader HTTP device.

Proves R3 ("runs it end to end, takes inputs, produces outputs") against a
real (HTTP) device, and proves the device-untouched guarantee end to end: a
refused job never creates a run on the instrument.

The R0 sim script (rehearsal/sim/sim_plate_reader.py) is not vendored into
this package, so this test starts a minimal fake plate reader in-process
instead: an http.server.ThreadingHTTPServer on a daemon thread, speaking the
same JSON API SimRuntime (ported below from operating-agent/sim_runtime.py)
expects: GET /status, POST /runs, GET /runs/<id>, GET /runs/<id>/log, and
GET /runs (used here only to count runs before/after).
"""

from __future__ import annotations

import http.client
import json
import re
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any, Optional
from urllib.parse import urlparse

from pcc_node.operating.loop import Job, RuntimeResult, run_once
from pcc_node.operating.profile import build_r0_plate_reader_profile

#: The 96 valid well names for a 96-well plate, in row-major order.
ALL_WELLS = tuple(f"{row}{col}" for row in "ABCDEFGH" for col in range(1, 13))


def _well_reading(well: str) -> float:
    """A deterministic, well-dependent float reading.

    The value itself is never asserted by the tests -- only that every
    requested well gets exactly one reading, and it's a float.
    """
    row = ord(well[0]) - ord("A")
    col = int(well[1:])
    return round(row * 12 + col + 0.5, 3)


class _FakePlateReaderHandler(BaseHTTPRequestHandler):
    """A minimal in-process stand-in for the R0 plate-reader simulator's
    HTTP API -- just enough for SimRuntime to drive one operation."""

    def log_message(self, format, *args):
        pass  # silence the server's request logging

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Optional[dict]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw) if raw else None

    def do_GET(self):
        if self.path == "/status":
            self._send_json(200, {"state": "idle"})
            return
        if self.path == "/runs":
            self._send_json(200, {"runs": list(self.server.runs)})
            return
        m = re.match(r"^/runs/([^/]+)/log$", self.path)
        if m:
            self._send_json(200, {"entries": []})
            return
        m = re.match(r"^/runs/([^/]+)$", self.path)
        if m:
            run_id = m.group(1)
            record = self.server.runs_by_id.get(run_id)
            if record is None:
                self._send_json(404, {"error": "not_found"})
                return
            wells = record["wells"]
            well_names = list(ALL_WELLS) if wells == "all" else list(wells)
            readings = {w: _well_reading(w) for w in well_names}
            self._send_json(
                200,
                {"runId": run_id, "state": "succeeded", "result": {"readings": readings}},
            )
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/runs":
            body = self._read_json() or {}
            self.server.run_counter += 1
            run_id = f"run-{self.server.run_counter}"
            record = {
                "runId": run_id,
                "plateFormat": body.get("plateFormat"),
                "wavelengthNm": body.get("wavelengthNm"),
                "wells": body.get("wells"),
            }
            self.server.runs.append(record)
            self.server.runs_by_id[run_id] = record
            self._send_json(201, {"runId": run_id, "state": "queued"})
            return
        self._send_json(404, {"error": "not_found"})


class SimRuntime:
    """A DeviceRuntime over the fake plate reader's HTTP API.

    Ported from operating-agent/sim_runtime.py; keeps the same
    `run(self, operation, params, *, claim)` signature DeviceRuntime
    requires.

    run() is only ever called by the loop AFTER the params passed the type
    and envelope checks, so this adapter does no validation of its own --
    it maps one already-checked operation onto the device: POST /runs, poll
    until terminal, return the readings as evidence.
    """

    def __init__(self, base_url: str, *, poll_timeout_s: float = 15.0) -> None:
        u = urlparse(base_url)
        self._host = u.hostname or "127.0.0.1"
        self._port = u.port or 80
        self._timeout = poll_timeout_s

    def _req(self, method: str, path: str, body: Optional[dict] = None) -> tuple[int, Any]:
        conn = http.client.HTTPConnection(self._host, self._port, timeout=10)
        try:
            payload = json.dumps(body) if body is not None else None
            headers = {"Content-Type": "application/json"} if body is not None else {}
            conn.request(method, path, body=payload, headers=headers)
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8")
            try:
                data = json.loads(raw) if raw else None
            except ValueError:
                data = None
            return resp.status, data
        finally:
            conn.close()

    def is_idle(self) -> bool:
        status, data = self._req("GET", "/status")
        return status == 200 and isinstance(data, dict) and data.get("state") == "idle"

    def run(self, operation: str, params: dict, *, claim: Any) -> RuntimeResult:
        # One typed, already-checked operation -> one device run. The fake
        # server has no claims or leases, so ``claim`` is accepted and
        # unused (pcc-node's AdapterRuntime binds to it).
        status, data = self._req("POST", "/runs", {
            "plateFormat": params["plateFormat"],
            "wavelengthNm": params["wavelengthNm"],
            "wells": params["wells"],
        })
        if status != 201 or not isinstance(data, dict) or "runId" not in data:
            return RuntimeResult(ok=False, error=f"submit_failed:{status}")
        run_id = data["runId"]

        deadline = time.monotonic() + self._timeout
        while time.monotonic() < deadline:
            status, run = self._req("GET", f"/runs/{run_id}")
            if status != 200 or not isinstance(run, dict):
                return RuntimeResult(ok=False, error=f"poll_failed:{status}")
            state = run.get("state")
            if state == "succeeded":
                _, log = self._req("GET", f"/runs/{run_id}/log")
                evidence = {
                    "runId": run_id,
                    "operation": operation,
                    "params": params,
                    "result": run.get("result"),
                    "log": log,
                }
                return RuntimeResult(ok=True, output=run.get("result"), evidence=evidence)
            if state in ("failed", "stopped"):
                return RuntimeResult(ok=False, error=f"run_{state}", evidence={"runId": run_id})
            time.sleep(0.05)
        return RuntimeResult(ok=False, error="poll_timeout", evidence={"runId": run_id})


class _OpenGate:
    def allows_jobs(self):
        return True


OPEN = _OpenGate()


def _get(base, path):
    u = urlparse(base)
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=5)
    try:
        c.request("GET", path)
        r = c.getresponse()
        return r.status, json.loads(r.read().decode() or "null")
    finally:
        c.close()


class OneJobPort:
    """Serves a single scripted job's params, records report/complete."""
    def __init__(self, params):
        self._params = params
        self.reported = None
        self.completed = None
    def claim_next(self, kernel_id): return None
    def resolve_params(self, job): return self._params
    def report(self, job, evidence):
        self.reported = evidence
        return SimpleNamespace(stored=True, reason=None)
    def complete(self, job, *, passed, reason):
        self.completed = (passed, reason)
        return SimpleNamespace(status="completed" if passed else "failed", accepted=True, reason=None)


class OperatingLoopE2ETest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _FakePlateReaderHandler)
        cls.server.runs = []
        cls.server.runs_by_id = {}
        cls.server.run_counter = 0
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def _run_count(self):
        status, data = _get(self.base, "/runs")
        self.assertEqual(status, 200)
        return len(data["runs"])

    def test_valid_job_runs_on_the_fake_instrument_and_passes(self):
        before = self._run_count()
        profile = build_r0_plate_reader_profile()
        runtime = SimRuntime(self.base)
        jobs = OneJobPort({"plateFormat": "96-well", "wavelengthNm": 450, "wells": ["A1", "H12"]})
        outcome = run_once(profile, runtime, jobs, Job("job-ok", "runPlate"), gate=OPEN)
        self.assertTrue(outcome.ran)
        self.assertTrue(outcome.passed, outcome.reason)
        # Real readings came back from the (fake) instrument.
        readings = outcome.evidence["result"]["readings"]
        self.assertEqual(set(readings), {"A1", "H12"})
        for v in readings.values():
            self.assertIsInstance(v, float)
        self.assertEqual(jobs.completed, (True, None))
        self.assertIsNotNone(jobs.reported)
        # Exactly one new run was created on the device.
        self.assertEqual(self._run_count(), before + 1)

    def test_refused_job_never_creates_a_run_on_the_instrument(self):
        before = self._run_count()
        profile = build_r0_plate_reader_profile()
        runtime = SimRuntime(self.base)
        # wavelength 500 fails the envelope check -> the loop must never POST /runs.
        jobs = OneJobPort({"plateFormat": "96-well", "wavelengthNm": 500, "wells": "all"})
        outcome = run_once(profile, runtime, jobs, Job("job-bad", "runPlate"), gate=OPEN)
        self.assertFalse(outcome.ran)
        self.assertFalse(outcome.passed)
        self.assertTrue(outcome.reason.startswith("envelope_violation"), outcome.reason)
        self.assertEqual(jobs.completed, (False, outcome.reason))
        self.assertIsNone(jobs.reported)
        # The instrument saw NO new run.
        self.assertEqual(self._run_count(), before)


if __name__ == "__main__":
    unittest.main()
