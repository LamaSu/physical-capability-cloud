"""Registry unit tests — pure data structure, no FastAPI involved."""

from __future__ import annotations

import threading

from connectors_runtime.registry import Registry


def test_add_and_get_source() -> None:
    reg = Registry()
    rec = reg.add_source(
        kind="postgres",
        config={"credentials": "postgresql://user:pw@host/db"},
        config_summary={"credentials": "<redacted>"},
    )
    assert rec.id.startswith("src_")
    fetched = reg.get_source(rec.id)
    assert fetched is rec
    assert fetched.kind == "postgres"
    assert fetched.config_summary == {"credentials": "<redacted>"}


def test_get_unknown_returns_none() -> None:
    reg = Registry()
    assert reg.get_source("src_does_not_exist") is None
    assert reg.get_destination("dst_does_not_exist") is None
    assert reg.get_pipeline("pl_does_not_exist") is None


def test_pipeline_lifecycle_status_transitions() -> None:
    reg = Registry()
    src = reg.add_source("postgres", {}, {})
    dst = reg.add_destination("filesystem", {}, {})
    pl = reg.add_pipeline(
        name="users_load",
        source_id=src.id,
        destination_id=dst.id,
        dataset_name="staging",
    )
    assert pl.status == "created"
    assert pl.last_run_id is None

    # transition to running
    updated = reg.update_pipeline_status(pl.id, status="running", last_run_id="run_abc")
    assert updated is not None
    assert updated.status == "running"
    assert updated.last_run_id == "run_abc"

    # transition to completed
    updated = reg.update_pipeline_status(
        pl.id,
        status="completed",
        rows_loaded=42,
        mark_completed=True,
    )
    assert updated is not None
    assert updated.status == "completed"
    assert updated.rows_loaded == 42
    assert updated.last_completed_at is not None

    # delete works and is idempotent on missing
    assert reg.delete_pipeline(pl.id) is True
    assert reg.delete_pipeline(pl.id) is False
    assert reg.get_pipeline(pl.id) is None


def test_concurrent_writes_dont_lose_records() -> None:
    """Hammer add_source from multiple threads; assert no records lost.

    Python's GIL doesn't make dict mutation thread-safe across coroutines/
    threads — the registry uses a real threading.Lock. This test is a
    smoke check that the lock works.
    """
    reg = Registry()
    n_threads = 8
    n_per_thread = 50
    barrier = threading.Barrier(n_threads)

    def worker() -> None:
        barrier.wait()  # release all threads at once for max contention
        for _ in range(n_per_thread):
            reg.add_source("postgres", {}, {})

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(reg.list_sources()) == n_threads * n_per_thread


def test_n_running_counts_correctly() -> None:
    reg = Registry()
    src = reg.add_source("postgres", {}, {})
    dst = reg.add_destination("filesystem", {}, {})

    p1 = reg.add_pipeline("a", src.id, dst.id, "ds")
    p2 = reg.add_pipeline("b", src.id, dst.id, "ds")
    p3 = reg.add_pipeline("c", src.id, dst.id, "ds")

    assert reg.n_running() == 0
    reg.update_pipeline_status(p1.id, status="running")
    reg.update_pipeline_status(p2.id, status="running")
    reg.update_pipeline_status(p3.id, status="completed")

    assert reg.n_running() == 2
    assert reg.n_pipelines() == 3
