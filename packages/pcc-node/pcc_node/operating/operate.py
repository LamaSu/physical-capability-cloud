"""Construct and run one device's operating loop."""

import threading
import time

from ..http_util import pcc_request
from ..ws_client import PCCGatewayClient
from .devicelock import HostDeviceLock
from .gate import CircuitBreaker, GatedRuntime, OPERATE_POLL_S, StopReader
from .jobport import GatewayJobPort
from .loop import run_loop
from .profile import build_r0_plate_reader_profile
from .runtime import AdapterRuntime, BindingError, DeviceStatus, DeviceStop, OperationBinding, _check_base_url

FAILURE_STATUS = "error"


def validate_binding(binding):
    if not isinstance(binding, dict) or not isinstance(binding.get("device"), dict):
        raise BindingError("invalid binding")
    device = binding["device"]
    try:
        DeviceStop.from_dict(device.get("stop"))
    except BindingError:
        raise BindingError("device_stop_undeclared") from None
    if any(not isinstance(binding.get(key), str) or not binding[key] for key in ("deviceId", "serial")):
        raise BindingError("invalid binding identity")
    types = binding.get("capabilityTypes")
    if (not isinstance(types, dict) or not types
            or any(not isinstance(key, str) or not key or not isinstance(value, str) or not value
                   for key, value in types.items())):
        raise BindingError("invalid capabilityTypes")
    operations = device.get("operations")
    if (not isinstance(operations, dict) or not operations
            or any(not isinstance(name, str) or not isinstance(value, dict) for name, value in operations.items())
            or any(operation not in operations for operation in types.values())):
        raise BindingError("invalid device operations")
    _check_base_url(device.get("url"))
    if not isinstance(device.get("status"), dict):
        raise BindingError("invalid device status")
    DeviceStatus.from_dict(device["status"])
    for name, value in operations.items():
        OperationBinding.from_dict(name, value)
    return binding


class _Heartbeats:
    def __init__(self, client, breaker, clock):
        self.client = client
        self.breaker = breaker
        self.clock = clock
        self.result = None
        self.last_sent = None
        self._mutex = threading.Lock()

    def send(self, *, force=False):
        with self._mutex:
            now = self.clock()
            if not force and self.last_sent is not None and now - self.last_sent < 60.0:
                return
            reason = None
            status = "online"
            if self.result is not None and self.result.ok is not True:
                status, reason = FAILURE_STATUS, self.result.error
            if self.breaker.is_open():
                status, reason = FAILURE_STATUS, "circuit_open"
            self.client.send_heartbeat(status, accepting_jobs=False, reason=reason)
            self.last_sent = now


def watch_once(runtime, reader):
    if runtime.running and reader.refresh() != "clear":
        if runtime.running:
            runtime.cancel()


def run(binding, gateway_base, api_key, kernel_id, public_hex, secret_hex, stop_event, *,
        request=None, heartbeat_client=None, process_stop=None, clock=time.monotonic,
        unix_clock=time.time, watch_wait=None, message=print):
    finished = threading.Event()
    watcher = None
    lock = None
    errors = []
    try:
        validate_binding(binding)
        if not api_key or not kernel_id:
            raise ValueError("API key and kernel id are required")
        profile = build_r0_plate_reader_profile(kernel_id=kernel_id, device_id=binding["deviceId"])
        inner = AdapterRuntime.from_profile(binding["device"], public_hex, secret_hex, clock=clock)

        def observe(status, body, sent_at):
            reader.observe(status, body, sent_at)

        port = GatewayJobPort(gateway_base, api_key, kernel_id, binding["capabilityTypes"], public_hex, secret_hex,
                              request=pcc_request if request is None else request, observer=observe, clock=clock)
        lock = HostDeviceLock(binding["device"]["url"], serial=binding["serial"])
        reader = StopReader(process_stop if process_stop is not None else stop_event, clock=clock, unix_clock=unix_clock)
        reader.refresh_poll = port.refresh_stop
        breaker = CircuitBreaker(binding["serial"], clock=clock, unix_clock=unix_clock)
        client = heartbeat_client if heartbeat_client is not None else PCCGatewayClient(gateway_base, api_key, kernel_id)
        heartbeats = _Heartbeats(client, breaker, clock)

        def ended(result):
            heartbeats.result = result
            try:
                heartbeats.send(force=True)
            except Exception as exc:
                errors.append(exc)
                stop_event.set()

        gated = GatedRuntime(profile, inner, reader, breaker, clock=clock, unix_clock=unix_clock,
                             result_observer=ended)
        heartbeats.send(force=True)
        wait = watch_wait if watch_wait is not None else finished.wait

        def watch():
            try:
                while not finished.is_set():
                    watch_once(gated, reader)
                    heartbeats.send()
                    if wait(OPERATE_POLL_S):
                        return
            except Exception as exc:
                errors.append(exc)
                if gated.running:
                    gated.cancel()
                stop_event.set()

        watcher = threading.Thread(target=watch, name="pcc-operate-watch", daemon=True)
        watcher.start()
        run_loop(profile, gated, port, gate=gated, lock=lock, stop_event=stop_event, idle_sleep=OPERATE_POLL_S)
        if errors:
            raise errors[0]
        return 0
    except Exception as exc:
        message(str(exc))
        return 1
    finally:
        finished.set()
        if watcher is not None:
            watcher.join(timeout=OPERATE_POLL_S)
        if lock is not None:
            lock.close()
