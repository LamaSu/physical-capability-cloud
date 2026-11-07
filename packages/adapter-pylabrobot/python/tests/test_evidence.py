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


# ── the evidence.stopRecording barrier (astra pack 186) ─────────────────────
# Plain tests (asyncio.run), so they run without pytest-asyncio.


def test_a_notification_for_a_window_closed_before_it_was_scheduled_is_dropped():
    """A logging thread can read a window just before evidence.stopRecording closes it. Its
    notification would then be written after the barrier, so it is dropped. The private
    scheduler is called directly to make that interleaving deterministic."""

    async def scenario() -> list[str]:
        sent: list[str] = []

        async def writer(method: str, params: dict) -> None:
            sent.append(params["type"])

        handler = EvidenceHandler(writer=writer, loop=asyncio.get_running_loop())
        window = handler.start_recording("dev-1", "job-1")
        handler.emit_atomic_op("dev-1", "aspirate", {})
        handler.stop_recording("dev-1", "job-1")
        handler._schedule_notify("evidence", {"type": "late"}, window)
        await handler.drain_through(handler.watermark())
        await asyncio.sleep(0.01)
        return sent

    assert asyncio.run(scenario()) == ["aspirate"]


def test_drain_through_waits_for_notifications_up_to_the_watermark_only():
    """The barrier waits for what was scheduled before it, not for what a busy logger
    schedules afterwards."""

    async def scenario() -> tuple[list[str], list[str]]:
        release_b = asyncio.Event()
        sent: list[str] = []

        async def writer(method: str, params: dict) -> None:
            if params["type"] == "B":
                await release_b.wait()
            sent.append(params["type"])

        handler = EvidenceHandler(writer=writer, loop=asyncio.get_running_loop())
        handler.start_recording("dev-1", "job-1")
        handler.emit_atomic_op("dev-1", "A", {})
        mark = handler.watermark()
        handler.emit_atomic_op("dev-1", "B", {})
        await asyncio.wait_for(handler.drain_through(mark), timeout=1)
        by_drain = list(sent)
        release_b.set()
        await asyncio.wait_for(handler.drain_through(handler.watermark()), timeout=1)
        return by_drain, sent

    by_drain, sent = asyncio.run(scenario())
    assert by_drain == ["A"]
    assert sent == ["A", "B"]
