"""Evidence handler tests — recording window lifecycle + notification emission."""

from __future__ import annotations
import asyncio
import logging

import pytest

from pcc_plr_sidecar.evidence import EvidenceHandler


@pytest.fixture
def captured():
    """Return (writer, captured_list) — writer pushes (method, params) tuples."""
    sent: list[tuple[str, dict]] = []

    async def writer(method: str, params: dict) -> None:
        sent.append((method, params))

    return writer, sent


@pytest.mark.asyncio
async def test_start_recording_creates_window(captured):
    writer, _ = captured
    handler = EvidenceHandler(writer=writer)
    w = handler.start_recording("dev-1", "job-1")
    assert w.device_id == "dev-1"
    assert w.job_id == "job-1"
    assert handler.is_recording("dev-1")


@pytest.mark.asyncio
async def test_stop_recording_removes_window(captured):
    writer, _ = captured
    handler = EvidenceHandler(writer=writer)
    handler.start_recording("dev-1", "job-1")
    handler.stop_recording("dev-1", "job-1")
    assert not handler.is_recording("dev-1")


@pytest.mark.asyncio
async def test_emit_atomic_op_pushes_evidence_notification(captured):
    writer, sent = captured
    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    handler.start_recording("dev-1", "job-1")
    handler.emit_atomic_op("dev-1", "aspirate", {"volume_uL": 100, "well": "A1"})
    await asyncio.sleep(0.05)  # let the call_soon_threadsafe task run
    assert len(sent) == 1
    method, params = sent[0]
    assert method == "evidence"
    assert params["type"] == "aspirate"
    assert params["deviceId"] == "dev-1"
    assert params["jobId"] == "job-1"
    assert params["payload"]["volume_uL"] == 100


@pytest.mark.asyncio
async def test_emit_atomic_op_outside_window_drops(captured):
    writer, sent = captured
    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    # No start_recording — should silently drop
    handler.emit_atomic_op("dev-1", "aspirate", {})
    await asyncio.sleep(0.05)
    assert len(sent) == 0


@pytest.mark.asyncio
async def test_emit_atomic_op_increments_op_count(captured):
    writer, _ = captured
    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    window = handler.start_recording("dev-1", "job-1")
    handler.emit_atomic_op("dev-1", "aspirate", {})
    handler.emit_atomic_op("dev-1", "dispense", {})
    handler.emit_atomic_op("dev-1", "dropTips", {})
    assert window.op_count == 3


@pytest.mark.asyncio
async def test_plr_log_record_becomes_evidence_notification(captured):
    writer, sent = captured
    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    handler.start_recording("dev-1", "job-1")
    logger = logging.getLogger("pylabrobot.test")
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    try:
        logger.info("aspirated 100uL from A1")
        await asyncio.sleep(0.05)
        # Should have produced exactly one notification (type=log)
        log_notes = [p for m, p in sent if p.get("type") == "log"]
        assert len(log_notes) == 1
        assert log_notes[0]["deviceId"] == "dev-1"
        assert log_notes[0]["payload"]["level"] == "INFO"
        assert "aspirated 100uL" in log_notes[0]["payload"]["line"]
    finally:
        logger.removeHandler(handler)


@pytest.mark.asyncio
async def test_drain_awaits_all_pending_notifications_for_a_device(captured):
    # R39 HIGH5: emit_atomic_op is fire-and-forget (threadsafe scheduling for
    # logging.Handler.emit's sake); drain is the explicit rendezvous backend.run
    # uses before it reports success.
    writer, sent = captured
    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    handler.start_recording("dev-1", "job-1")
    handler.emit_atomic_op("dev-1", "aspirate", {})
    handler.emit_atomic_op("dev-1", "dispense", {})
    await handler.drain("dev-1")
    assert len(sent) == 2  # both writes completed -- no sleep needed to prove it


@pytest.mark.asyncio
async def test_drain_surfaces_a_write_failure_instead_of_swallowing_it():
    async def failing_writer(method, params):
        raise RuntimeError("stdout pipe broken")

    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=failing_writer, loop=loop)
    handler.start_recording("dev-1", "job-1")
    handler.emit_atomic_op("dev-1", "aspirate", {})
    with pytest.raises(RuntimeError, match="stdout pipe broken"):
        await handler.drain("dev-1")


@pytest.mark.asyncio
async def test_drain_is_a_noop_with_nothing_pending(captured):
    writer, sent = captured
    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    await handler.drain("dev-1")  # must not hang or raise
    assert sent == []


@pytest.mark.asyncio
async def test_emit_event_outside_window_emits_with_null_job_id(captured):
    writer, sent = captured
    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    handler.emit_event("dev-1", "camera_snapshot", {"imageHash": "sha256:abc"})
    await asyncio.sleep(0.05)
    assert len(sent) == 1
    _, params = sent[0]
    assert params["jobId"] is None
    assert params["type"] == "camera_snapshot"


@pytest.mark.asyncio
async def test_drain_surfaces_a_write_that_failed_before_drain_was_called():
    # R39 r3 review: a write that fails BEFORE backend.run reaches drain() (the run awaited its
    # ops in between) must still void the run's success, not vanish with its finished task.
    async def failing_writer(method, params):
        raise RuntimeError("stdout pipe broken")

    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=failing_writer, loop=loop)
    handler.start_recording("dev-1", "job-1")
    handler.emit_atomic_op("dev-1", "aspirate", {})
    for _ in range(5):
        await asyncio.sleep(0)  # the write runs and fails before anyone drains
    with pytest.raises(RuntimeError, match="stdout pipe broken"):
        await handler.drain("dev-1")
    await handler.drain("dev-1")  # reported once, then consumed


@pytest.mark.asyncio
async def test_drain_waits_for_a_write_queued_from_another_thread():
    # R39 r4 (HIGH5): a write a worker thread queued with call_soon_threadsafe is drained too,
    # even though its task does not exist yet when drain() starts.
    import threading

    written = []

    async def writer(method, params):
        written.append(params)

    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=writer, loop=loop)
    handler.start_recording("dev-1", "job-1")
    worker = threading.Thread(target=lambda: handler.emit_event("dev-1", "log_line", {"line": "x"}))
    worker.start()
    worker.join()  # the event loop is blocked here: the queued callback has not run
    await handler.drain("dev-1")
    assert len(written) == 1, written


@pytest.mark.asyncio
async def test_no_write_from_another_thread_is_left_pending_after_the_final_drain():
    # R39 r5 (HIGH5): once backend.run's final drain has returned, a write a worker thread queues
    # for that run must not be left pending (or fail) after the run reported success.
    import threading

    async def failing_writer(method, params):
        raise RuntimeError("stdout pipe broken")

    loop = asyncio.get_running_loop()
    handler = EvidenceHandler(writer=failing_writer, loop=loop)
    handler.start_recording("dev-1", "job-1")
    finish = getattr(handler, "seal_and_drain", None) or handler.drain
    await finish("dev-1")  # the run's final drain: nothing pending, it returns
    worker = threading.Thread(target=lambda: handler.emit_event("dev-1", "log_line", {"line": "late"}))
    worker.start()
    worker.join()
    for _ in range(5):
        await asyncio.sleep(0)
    pending = [t for t in handler._pending.get("dev-1", []) if not t.cancelled()]
    assert pending == [], "a write was accepted for the run after its final drain"
