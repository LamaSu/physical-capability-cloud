"""AwaitingStore: accepted jobs survive a daemon restart, credentials never
reach disk, and a corrupt file never becomes a report."""

import json
import os

import pytest

from pcc_node.awaiting_store import AwaitingStore, valid_record


def record(job_id="job-1", **overrides):
    base = {
        "jobId": job_id,
        "binding": {"jobId": job_id},
        "deviceId": "printer-1",
        "kind": "octoprint",
        "handle": {"base_url": "http://10.0.0.20:5000", "path": f"pcc-{job_id}/part.gcode",
                   "baseline": {"success": 0, "failure": 0}},
        "acceptedAt": 1000.0,
        "deadline": 4600.0,
    }
    base.update(overrides)
    return base


@pytest.fixture
def path(tmp_path):
    return str(tmp_path / "state" / "awaiting.json")


def test_nothing_is_written_until_there_is_something_to_store(path):
    store = AwaitingStore(path)
    assert store.records() == []
    assert not os.path.exists(path)


def test_a_record_survives_a_new_store_on_the_same_file(path):
    AwaitingStore(path).put(record())
    assert AwaitingStore(path).records() == [record()]


def test_put_replaces_the_record_for_the_same_job(path):
    store = AwaitingStore(path)
    store.put(record(deadline=5000.0))
    store.put(record(deadline=6000.0))
    assert [r["deadline"] for r in AwaitingStore(path).records()] == [6000.0]


def test_remove_forgets_only_that_job(path):
    store = AwaitingStore(path)
    store.put(record("job-1"))
    store.put(record("job-2"))
    store.remove("job-1")
    assert [r["jobId"] for r in AwaitingStore(path).records()] == ["job-2"]
    store.remove("job-unknown")  # no-op
    assert [r["jobId"] for r in AwaitingStore(path).records()] == ["job-2"]


@pytest.mark.parametrize("bad", [
    pytest.param(record(apiKey="SECRET"), id="extra-field-such-as-a-credential"),
    pytest.param({k: v for k, v in record().items() if k != "deviceId"}, id="no-device-id"),
    pytest.param(record(kind="generic"), id="unknown-kind"),
    pytest.param(record(binding={"jobId": "job-OTHER"}), id="binding-for-another-job"),
    pytest.param(record(binding={"jobId": "job-1", "settlementUnitId": 7}), id="non-string-binding"),
    pytest.param(record(deadline=True), id="bool-deadline"),
    pytest.param(record(jobId=""), id="empty-job-id"),
    pytest.param(record(handle="pcc-job-1/part.gcode"), id="handle-not-an-object"),
])
def test_a_malformed_record_is_refused_and_nothing_is_written(path, bad):
    store = AwaitingStore(path)
    with pytest.raises(ValueError):
        store.put(bad)
    assert not os.path.exists(path)
    assert not valid_record(bad)


def test_the_file_never_holds_a_device_record_or_credential(path):
    AwaitingStore(path).put(record())
    text = open(path, encoding="utf-8").read()
    assert "api_key" not in text and "apiKey" not in text and "X-Api-Key" not in text


def test_a_corrupt_file_is_set_aside_and_the_store_starts_empty(path, caplog):
    os.makedirs(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("{not json")
    store = AwaitingStore(path, clock=lambda: 1234.0)
    assert store.records() == []
    assert os.path.exists(f"{path}.corrupt-1234")
    assert not os.path.exists(path)
    assert "unreadable" in caplog.text


def test_a_malformed_stored_record_is_dropped_on_load(path, caplog):
    os.makedirs(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump([record("job-good"), {"jobId": "job-bad"}], fh)
    assert [r["jobId"] for r in AwaitingStore(path).records()] == ["job-good"]
    assert "malformed" in caplog.text


def test_the_write_is_atomic_and_leaves_no_temp_file(path):
    store = AwaitingStore(path)
    store.put(record("job-1"))
    store.put(record("job-2"))
    leftovers = [n for n in os.listdir(os.path.dirname(path)) if n.startswith(".awaiting-")]
    assert leftovers == []
