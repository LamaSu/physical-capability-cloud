"""FastAPI server tests — every endpoint exercised with the dlt bridge mocked.

Pattern follows voice-onboarder/test_tools.py: pytest-asyncio + httpx.AsyncClient
mounted on the FastAPI app via `httpx.ASGITransport`, with `dlt_bridge.make_source`
/ `make_destination` / `run_pipeline_async` patched so no real dlt code runs.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from connectors_runtime.config import ConnectorsRuntimeSettings
from connectors_runtime.registry import Registry
from connectors_runtime.server import create_app


def _make_settings(*, destroy: bool = False) -> ConnectorsRuntimeSettings:
    """Settings fixture — explicit values, bypasses .env loading."""
    return ConnectorsRuntimeSettings(
        listen_host="127.0.0.1",
        listen_port=18766,
        storage_path="/tmp/test-connectors",
        enable_destroy_endpoint=destroy,
    )  # type: ignore[call-arg]


@pytest.fixture
async def client_and_registry() -> AsyncIterator[tuple[httpx.AsyncClient, Registry]]:
    """Fresh app + registry per test for isolation."""
    settings = _make_settings()
    registry = Registry()
    app = create_app(settings, registry)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, registry


# ── /health ───────────────────────────────────────────────────────────────


async def test_health_ok(client_and_registry: tuple[httpx.AsyncClient, Registry]) -> None:
    client, _ = client_and_registry
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["service"] == "pcc-connectors-runtime"
    assert "dlt_version" in body
    assert body["n_pipelines"] == 0
    assert body["n_running"] == 0


# ── /sources ──────────────────────────────────────────────────────────────


async def test_create_source_postgres_happy_path(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, reg = client_and_registry
    with patch("connectors_runtime.server.dlt_bridge.make_source", return_value=MagicMock()):
        resp = await client.post(
            "/sources",
            json={
                "kind": "postgres",
                "config": {
                    "credentials": "postgresql://u:pw@h/db",
                    "schema": "public",
                    "table_names": ["users", "orders"],
                },
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["source_id"].startswith("src_")
    assert body["kind"] == "postgres"
    assert body["ready"] is True
    # secrets redacted
    assert body["config_summary"]["credentials"] == "<redacted>"
    # non-secret fields preserved
    assert body["config_summary"]["schema"] == "public"
    assert body["config_summary"]["table_names"] == ["users", "orders"]
    # registry contains the full config (with secret) for the runner to use
    rec = reg.get_source(body["source_id"])
    assert rec is not None
    assert rec.config["credentials"] == "postgresql://u:pw@h/db"


async def test_create_source_invalid_kind_returns_400(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry
    resp = await client.post("/sources", json={"kind": "not_a_kind", "config": {}})
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]["error"] == "invalid_kind"


async def test_create_source_vendor_not_wired_returns_501(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry
    # salesforce is recognised but not wired in v0.1 — should be 501.
    resp = await client.post("/sources", json={"kind": "salesforce", "config": {}})
    assert resp.status_code == 501
    body = resp.json()
    assert body["detail"]["error"] == "vendor_sdk_not_wired"


async def test_get_source_404_for_unknown(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry
    resp = await client.get("/sources/src_nope")
    assert resp.status_code == 404


# ── /destinations ─────────────────────────────────────────────────────────


async def test_create_destination_filesystem_happy_path(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry
    with patch("connectors_runtime.server.dlt_bridge.make_destination", return_value=MagicMock()):
        resp = await client.post(
            "/destinations",
            json={"kind": "filesystem", "config": {"bucket_url": "/var/lib/pcc/load"}},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["destination_id"].startswith("dst_")
    assert body["kind"] == "filesystem"


async def test_create_destination_insforge_not_wired(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry
    resp = await client.post("/destinations", json={"kind": "insforge", "config": {}})
    assert resp.status_code == 501


# ── /pipelines (create + list) ────────────────────────────────────────────


async def test_create_pipeline_happy_path(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry

    # Set up source + destination first.
    with patch("connectors_runtime.server.dlt_bridge.make_source", return_value=MagicMock()):
        s = await client.post("/sources", json={"kind": "postgres", "config": {}})
    with patch("connectors_runtime.server.dlt_bridge.make_destination", return_value=MagicMock()):
        d = await client.post("/destinations", json={"kind": "filesystem", "config": {}})

    src_id = s.json()["source_id"]
    dst_id = d.json()["destination_id"]

    resp = await client.post(
        "/pipelines",
        json={
            "name": "users_etl",
            "source_id": src_id,
            "destination_id": dst_id,
            "dataset_name": "staging",
            "table_name": "users",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["pipeline_id"].startswith("pl_")
    assert body["name"] == "users_etl"
    assert body["status"] == "created"
    assert body["dataset_name"] == "staging"
    assert body["table_name"] == "users"


async def test_create_pipeline_400_when_source_missing(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry
    resp = await client.post(
        "/pipelines",
        json={
            "name": "x",
            "source_id": "src_nope",
            "destination_id": "dst_nope",
            "dataset_name": "ds",
        },
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]["error"] == "source_not_found"


async def test_list_pipelines_returns_all(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, reg = client_and_registry
    # Seed the registry directly to avoid serialising 3 full create calls.
    src = reg.add_source("postgres", {}, {})
    dst = reg.add_destination("filesystem", {}, {})
    reg.add_pipeline("p1", src.id, dst.id, "ds")
    reg.add_pipeline("p2", src.id, dst.id, "ds")
    reg.add_pipeline("p3", src.id, dst.id, "ds")

    resp = await client.get("/pipelines")
    assert resp.status_code == 200
    pipelines = resp.json()["pipelines"]
    assert len(pipelines) == 3
    names = {p["name"] for p in pipelines}
    assert names == {"p1", "p2", "p3"}


# ── /pipelines/{id}/run ───────────────────────────────────────────────────


async def test_pipeline_run_kicks_off_runner(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, reg = client_and_registry
    src = reg.add_source("postgres", {}, {})
    dst = reg.add_destination("filesystem", {}, {})
    pl = reg.add_pipeline("etl", src.id, dst.id, "staging")

    fake_run_id = "run_fake12345"
    with patch(
        "connectors_runtime.server.dlt_bridge.make_source", return_value=MagicMock()
    ), patch(
        "connectors_runtime.server.dlt_bridge.make_destination", return_value=MagicMock()
    ), patch(
        "connectors_runtime.server.run_pipeline_async",
        new=AsyncMock(return_value=fake_run_id),
    ) as mock_runner:
        resp = await client.post(f"/pipelines/{pl.id}/run", json={"full_refresh": True})

    assert resp.status_code == 200
    body = resp.json()
    assert body["pipeline_id"] == pl.id
    assert body["run_id"] == fake_run_id
    assert body["status"] == "running"
    # Assert the runner was called with full_refresh=True passed through.
    mock_runner.assert_awaited_once()
    kwargs = mock_runner.await_args.kwargs
    assert kwargs["full_refresh"] is True
    assert kwargs["pipeline_id"] == pl.id
    assert kwargs["dataset"] == "staging"


async def test_pipeline_run_404_for_unknown_pipeline(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, _ = client_and_registry
    resp = await client.post("/pipelines/pl_nope/run", json={})
    assert resp.status_code == 404


async def test_pipeline_run_409_when_already_running(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, reg = client_and_registry
    src = reg.add_source("postgres", {}, {})
    dst = reg.add_destination("filesystem", {}, {})
    pl = reg.add_pipeline("etl", src.id, dst.id, "staging")
    # Mark as already running.
    reg.update_pipeline_status(pl.id, status="running", last_run_id="run_in_flight")

    resp = await client.post(f"/pipelines/{pl.id}/run", json={})
    assert resp.status_code == 409
    body = resp.json()
    assert body["detail"]["error"] == "pipeline_already_running"


# ── /pipelines/{id}/status ────────────────────────────────────────────────


async def test_pipeline_status_reflects_registry(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, reg = client_and_registry
    src = reg.add_source("postgres", {}, {})
    dst = reg.add_destination("filesystem", {}, {})
    pl = reg.add_pipeline("etl", src.id, dst.id, "staging")
    reg.update_pipeline_status(
        pl.id,
        status="completed",
        last_run_id="run_done",
        rows_loaded=100,
        mark_completed=True,
    )

    resp = await client.get(f"/pipelines/{pl.id}/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "completed"
    assert body["rows_loaded"] == 100
    assert body["last_run_id"] == "run_done"
    assert body["last_completed_at"] is not None


# ── DELETE /pipelines/{id} ────────────────────────────────────────────────


async def test_delete_pipeline_403_when_disabled(
    client_and_registry: tuple[httpx.AsyncClient, Registry],
) -> None:
    client, reg = client_and_registry
    src = reg.add_source("postgres", {}, {})
    dst = reg.add_destination("filesystem", {}, {})
    pl = reg.add_pipeline("etl", src.id, dst.id, "staging")

    resp = await client.delete(f"/pipelines/{pl.id}")
    assert resp.status_code == 403
    body = resp.json()
    assert body["detail"]["error"] == "destroy_endpoint_disabled"
    # Pipeline should still be there.
    assert reg.get_pipeline(pl.id) is not None


async def test_delete_pipeline_works_when_enabled() -> None:
    """Separate fixture set up because we need destroy=True."""
    settings = _make_settings(destroy=True)
    registry = Registry()
    app = create_app(settings, registry)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        src = registry.add_source("postgres", {}, {})
        dst = registry.add_destination("filesystem", {}, {})
        pl = registry.add_pipeline("etl", src.id, dst.id, "staging")

        resp = await client.delete(f"/pipelines/{pl.id}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["pipeline_id"] == pl.id
        assert body["deleted"] is True
        assert registry.get_pipeline(pl.id) is None

        # 404 second time
        resp = await client.delete(f"/pipelines/{pl.id}")
        assert resp.status_code == 404
