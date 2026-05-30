"""Backend loader tests — stub backend + factory contract.

These tests exercise the loader without requiring pylabrobot to be
installed. The ``stub`` backend is the canonical no-PLR path.
"""

from __future__ import annotations
import pytest

from pcc_plr_sidecar.backend_loader import BackendLoader, BackendHandle


@pytest.mark.asyncio
async def test_load_stub_backend_returns_handle():
    loader = BackendLoader()
    handle = await loader.load("stub", "dev-1", {"deckSlots": 11})
    assert isinstance(handle, BackendHandle)
    assert handle.device_id == "dev-1"
    assert handle.plr_backend == "stub"
    assert handle.setup_done is False  # setup is separate
    assert loader.has("dev-1") is True


@pytest.mark.asyncio
async def test_load_is_idempotent_per_device_id():
    loader = BackendLoader()
    h1 = await loader.load("stub", "dev-1", {})
    h2 = await loader.load("stub", "dev-1", {})
    assert h1 is h2


@pytest.mark.asyncio
async def test_load_rejects_backend_mismatch_for_existing_device():
    loader = BackendLoader()
    await loader.load("stub", "dev-1", {})
    with pytest.raises(ValueError):
        await loader.load("chatterbox", "dev-1", {})


@pytest.mark.asyncio
async def test_unknown_backend_raises_value_error():
    loader = BackendLoader()
    with pytest.raises(ValueError):
        await loader.load("not-a-real-backend", "dev-1", {})


@pytest.mark.asyncio
async def test_unload_removes_device():
    loader = BackendLoader()
    await loader.load("stub", "dev-1", {})
    assert loader.has("dev-1")
    await loader.unload("dev-1")
    assert not loader.has("dev-1")


@pytest.mark.asyncio
async def test_unload_noop_on_unknown_device():
    loader = BackendLoader()
    await loader.unload("never-loaded")  # should not raise


@pytest.mark.asyncio
async def test_list_returns_all_loaded_handles():
    loader = BackendLoader()
    await loader.load("stub", "dev-1", {})
    await loader.load("stub", "dev-2", {})
    assert {h.device_id for h in loader.list()} == {"dev-1", "dev-2"}


@pytest.mark.asyncio
async def test_stub_machine_setup_marks_setup_done():
    loader = BackendLoader()
    handle = await loader.load("stub", "dev-1", {"deckSlots": 22})
    assert handle.machine.setup_done is False
    meta = await handle.machine.setup()
    assert handle.machine.setup_done is True
    assert meta["stub"] is True
    assert meta["deckSlots"] == 22


@pytest.mark.asyncio
async def test_stub_machine_run_protocol_records_ops_from_list():
    loader = BackendLoader()
    handle = await loader.load("stub", "dev-1", {})
    await handle.machine.setup()
    result = await handle.machine.run_protocol(
        [{"op": "pickUpTips"}, {"op": "aspirate"}, {"op": "dispense"}],
    )
    assert result["opCount"] == 3


@pytest.mark.asyncio
async def test_stub_machine_run_protocol_synthetic_default_when_payload_not_list():
    loader = BackendLoader()
    handle = await loader.load("stub", "dev-1", {})
    await handle.machine.setup()
    result = await handle.machine.run_protocol({"some": "payload"})
    assert result["opCount"] == 3
