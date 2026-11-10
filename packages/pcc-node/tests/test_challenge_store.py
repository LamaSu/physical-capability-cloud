"""Owner-only storage for the gateway's registration challenge."""

import base64
import json
import os

import pytest

from tests.test_register_challenge import BASE, API_KEY, PAIR, OTHER_PAIR, FakeGateway, CHALLENGES


@pytest.fixture(autouse=True)
def isolation(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    directory = tmp_path / "keys"
    directory.mkdir(mode=0o700)
    monkeypatch.setenv("PCC_NODE_KEY_PATH", str(directory / "keys.json"))


@pytest.fixture
def state(monkeypatch):
    from pcc_node import challenge_store
    clock = [1800000000.0]
    monkeypatch.setattr(challenge_store, "_now", lambda: clock[0])
    bound = challenge_store.binding(BASE, "kernel-a", PAIR[0], API_KEY)
    return challenge_store, clock, bound


def challenge(lifetime=600):
    gw = FakeGateway(True)
    if lifetime == 300:
        gw.mutate_fields = lambda fields: fields.update(expiresAt="2026-10-16T12:05:00.000Z")
    return gw("POST", CHALLENGES, {"kernelId": "kernel-a", "signer": {"publicKey": "0x" + PAIR[0]}},
              base_url=BASE, api_key=API_KEY)[1]


@pytest.mark.parametrize("lifetime,inside,outside", [(600, 479, 481), (300, 179, 181)], ids=["margin", "lifetime"])
def test_a_stored_challenge_past_its_reuse_window_is_not_reused(state, lifetime, inside, outside):
    store, clock, bound = state
    answer = challenge(lifetime)
    assert store.save(bound, answer)
    start = clock[0]
    clock[0] = start + inside
    assert store.load(bound) == answer
    clock[0] = start + outside
    assert store.load(bound) is None


def test_a_stored_challenge_is_not_reused_after_the_clock_moved_back(state):
    store, clock, bound = state
    assert store.save(bound, challenge()) and store.save_hold(bound)
    clock[0] -= 1
    assert store.load(bound) is None
    assert store.hold_remaining(bound) == 0.0


@pytest.mark.parametrize("field", ["gateway", "kernel", "key", "api-key"])
def test_a_stored_challenge_is_reused_only_under_its_own_binding(state, field):
    store, clock, bound = state
    assert store.save(bound, challenge())
    inputs = [BASE, "kernel-a", PAIR[0], API_KEY]
    inputs[["gateway", "kernel", "key", "api-key"].index(field)] = {
        "gateway": BASE + ":443", "kernel": "kernel-b", "key": OTHER_PAIR[0], "api-key": "another-key"}[field]
    assert store.load(store.binding(*inputs)) is None


@pytest.mark.parametrize("cell", ["mode", "symlink"])
def test_the_store_file_is_owner_only_and_replaced_atomically(state, tmp_path, cell):
    store, clock, bound = state
    target = tmp_path / "untouched.json"
    target.write_text("untouched")
    if cell == "symlink":
        os.symlink(str(target), store.store_path())
    assert store.save(bound, challenge())
    assert os.stat(store.store_path()).st_mode & 0o777 == 0o600
    assert not os.path.islink(store.store_path())
    assert target.read_text() == "untouched"
    assert not list((tmp_path / "keys").glob("*.tmp"))


@pytest.mark.parametrize("cell", ["missing-dir", "group-writable-dir", "under-a-checkout"])
def test_a_store_that_cannot_be_written_is_skipped(state, tmp_path, monkeypatch, cell):
    store, clock, bound = state
    if cell == "missing-dir":
        monkeypatch.setenv("PCC_NODE_KEY_PATH", str(tmp_path / "missing" / "keys.json"))
    elif cell == "group-writable-dir":
        (tmp_path / "keys").chmod(0o770)
    else:
        (tmp_path / ".git").mkdir()
    assert store.save(bound, challenge()) is False
    assert store.save_hold(bound) is False
    assert store.save_refusal(bound, "registration_403") is False
    assert not os.path.lexists(store.store_path())
    assert not os.path.lexists(store.hold_path())
    assert not os.path.lexists(store.refusal_path())


@pytest.mark.parametrize("cell", ["not-json", "wrong-keys", "oversize", "readable-by-others", "symlink",
                                  "readable-by-group", "readable-by-others-only",
                                  "marker-readable-by-others", "marker-symlink"])
def test_an_unsafe_or_malformed_record_is_ignored(state, tmp_path, cell):
    store, clock, bound = state
    assert store.save(bound, challenge())
    path = store.store_path()
    if cell.startswith("marker"):
        assert store.save_refusal(bound, "registration_403")
        store.remove()
        path = store.refusal_path()
    if cell == "not-json":
        with open(path, "w") as stream:
            stream.write("{")
    elif cell == "wrong-keys":
        with open(path, "w") as stream:
            json.dump({"version": 1}, stream)
    elif cell == "oversize":
        with open(path, "w") as stream:
            stream.write(" " * 16385)
    elif cell.endswith("readable-by-others"):
        os.chmod(path, 0o644)
    elif cell == "readable-by-group":
        os.chmod(path, 0o640)
    elif cell == "readable-by-others-only":
        os.chmod(path, 0o604)
    else:
        target = tmp_path / "record.json"
        os.replace(path, target)
        os.symlink(str(target), path)
    assert store.load(bound) is None
    if cell.startswith("marker"):
        assert store.refusal_wait(bound) == (0.0, None)


@pytest.mark.parametrize("field", ["kernel", "gateway", "key", "api-key"])
def test_the_hold_ignores_the_kernel_id_but_not_the_gateway_key_or_api_key(state, field):
    store, clock, bound = state
    assert store.save_hold(bound)
    clock[0] += 100
    inputs = [BASE, "kernel-a", PAIR[0], API_KEY]
    inputs[["gateway", "kernel", "key", "api-key"].index(field)] = {
        "gateway": BASE + ":443", "kernel": "kernel-b", "key": OTHER_PAIR[0], "api-key": "another-key"}[field]
    assert store.hold_remaining(bound) == store.HOLD_SECONDS - 100
    assert store.hold_remaining(store.binding(*inputs)) == (store.HOLD_SECONDS - 100 if field == "kernel" else 0.0)


def test_a_message_nested_too_deeply_to_read_gets_the_fallback_reuse_window(state):
    store, clock, bound = state
    assert store._reuse_seconds({"message": base64.b64encode(
        b"PCC-KERNEL-REG-V1\n" + b"[" * 100000 + b"]" * 100000).decode("ascii")}) == 480
