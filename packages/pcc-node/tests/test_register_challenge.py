"""The gateway's registration challenge, including restart state."""

import base64
import hashlib
import http.client
import json
import os
import random
import signal
import time
from copy import deepcopy
from unittest import mock
from urllib.error import HTTPError

import nacl.signing
import pytest
from click.testing import CliRunner

from pcc_node.config import NodeConfig
from pcc_node.register import RegistrationError

BASE = "https://gw.example.test"
CHALLENGES = "/api/kernels/registration-challenges"
KERNELS = "/api/kernels"
API_KEY = "self-service-test-key"
DEFAULT_404 = {"message": "Route POST:/api/kernels/registration-challenges not found",
               "error": "Not Found", "statusCode": 404}


def node_key_pair(seed_hex):
    key = nacl.signing.SigningKey(bytes.fromhex(seed_hex))
    return key.verify_key.encode().hex(), seed_hex


PAIR = node_key_pair("11" * 32)
OTHER_PAIR = node_key_pair("22" * 32)


class FakeGateway:
    def __init__(self, issues_challenges, domain="gw.example.test", env="test", chain_id=84532):
        self.issues_challenges = issues_challenges
        self.domain, self.env, self.chain_id = domain, env, chain_id
        self.calls = []
        self.script_challenge, self.script_kernel = [], []
        self.challenges, self.bound = {}, {}
        self.kernels = set()
        self.mutate_fields = lambda fields: None
        self.mutate_message = lambda raw: raw
        self.before_kernel = lambda: None
        self.events = []

    def paths(self):
        return [call[1] for call in self.calls]

    def posts(self):
        return [call[2] for call in self.calls if call[1] == KERNELS]

    def __call__(self, method, path, body=None, *, base_url, api_key="", **kwargs):
        self.calls.append((method, path, deepcopy(body), api_key))
        self.events.append(path)
        script = self.script_challenge if path == CHALLENGES else self.script_kernel
        if script:
            answer = script.pop(0)
            if isinstance(answer, BaseException):
                raise answer
            if answer is not None:
                return answer
        if path == CHALLENGES:
            if not self.issues_challenges:
                return 404, {"error": "not_found"}
            cid = f"{len(self.challenges) + 1:064x}"
            fields = {"challengeId": cid, "nonce": "ab" * 16, "kernelId": body["kernelId"],
                      "env": self.env, "chainId": self.chain_id, "domain": self.domain,
                      "issuedAt": "2026-10-16T12:00:00.000Z", "expiresAt": "2026-10-16T12:10:00.000Z",
                      "publicKey": body["signer"]["publicKey"]}
            self.mutate_fields(fields)
            raw = self.mutate_message(b"PCC-KERNEL-REG-V1\n" + json.dumps(
                fields, sort_keys=True, separators=(",", ":")).encode())
            answer = {"challengeId": cid, "message": base64.b64encode(raw).decode(),
                      "expiresAt": fields["expiresAt"]}
            self.challenges[cid] = {"fields": fields, "api_key": api_key, "spent": False,
                                    "raw": raw, "answer": answer}
            return 201, answer
        assert (method, path) == ("POST", KERNELS)
        self.before_kernel()
        kid, pub = body["id"], body.get("signingPublicKey")
        refused = 403, {"error": "FORBIDDEN", "message": "refused"}
        if self.issues_challenges:
            proof = body.get("registrationProof")
            if "signingProof" in body or not proof or body.get("signingKeyAlgorithm") != "ed25519":
                return refused
            record = self.challenges.get(proof["challengeId"])
            if not record or record["spent"] or record["api_key"] != api_key:
                return refused
            if record["fields"]["kernelId"] != kid or record["fields"]["publicKey"] != pub:
                return refused
            try:
                nacl.signing.VerifyKey(bytes.fromhex(pub[2:])).verify(record["raw"], bytes.fromhex(proof["signature"]))
            except Exception:
                return refused
            record["spent"] = True
            if kid in self.bound and self.bound[kid] != pub:
                return refused
            valid = True
        else:
            try:
                nacl.signing.VerifyKey(bytes.fromhex(pub[2:])).verify(
                    f"pcc-kernel-signing-key:{kid}".encode(), bytes.fromhex(body["signingProof"]))
                valid = body.get("signingKeyAlgorithm") == "ed25519"
            except Exception:
                valid = False
            if valid and kid in self.bound and self.bound[kid] != pub:
                return 409, {"error": "SIGNER_ALREADY_BOUND", "message": "conflict"}
        new = kid not in self.kernels
        self.kernels.add(kid)
        if valid:
            self.bound[kid] = pub
        key = {"algorithm": "ed25519", "publicKey": self.bound[kid]} if kid in self.bound else None
        return (201 if new else 200), {"kernel": {"id": kid, "signingKey": key}, "created": new}


@pytest.fixture(autouse=True)
def isolation(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    directory = tmp_path / "keys"
    directory.mkdir(mode=0o700)
    monkeypatch.setenv("PCC_NODE_KEY_PATH", str(directory / "keys.json"))


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    from pcc_node import register
    state = {"now": 1800000000.0, "sleeps": [], "events": []}

    def sleep(seconds):
        state["sleeps"].append(seconds)
        state["events"].append(("sleep", seconds))
        state["now"] += seconds

    monkeypatch.setattr(register, "_sleep", sleep, raising=False)
    try:
        from pcc_node import challenge_store
    except ImportError:
        pass
    else:
        monkeypatch.setattr(challenge_store, "_now", lambda: state["now"])
    return state


@pytest.fixture
def gateway(monkeypatch):
    gw = FakeGateway(True)
    monkeypatch.setattr("pcc_node.register.pcc_request", gw)
    return gw


def config(kid="kernel-test"):
    return NodeConfig(kernel_id=kid, kernel_name="test", pcc_base=BASE, pcc_api_key=API_KEY,
                      public_key=PAIR[0], devices=[], diagnostics_mode="off")


def signed(gw, *, kid="kernel-test", pair=PAIR, base=BASE, api_key=API_KEY, persist=True):
    from pcc_node.register import register_kernel_signed
    return register_kernel_signed(base, api_key, {"id": kid, "name": "test", "devices": [],
                                                "approvalMode": "auto", "pricing": {}}, *pair,
                                  persist_challenge=persist)


def separate_runner():
    try:
        return CliRunner(mix_stderr=False)
    except TypeError:
        return CliRunner()


def invoke_start(tmp_path, gw, *, patch_daemon=True, kid=None):
    from pcc_node.cli import main
    with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
         mock.patch("pcc_node.cli.detect_all", return_value=[]), \
         mock.patch("pcc_node.cli.load_or_create_keys", return_value=PAIR), \
         mock.patch("pcc_node.cli.register_devices"), \
         mock.patch("pcc_node.cli._interactive", return_value=False):
        args = ["start", "--yes", "-c", str(tmp_path / "node-config.json"),
                "--api-key", API_KEY, "--pcc-base", BASE]
        if kid:
            args += ["--kernel-id", kid]
        if patch_daemon:
            with mock.patch("pcc_node.cli.run_daemon") as daemon:
                result = separate_runner().invoke(main, args)
            return result, daemon
        return separate_runner().invoke(main, args), None


def test_start_registers_with_a_fresh_proof_when_the_gateway_issues_challenges(tmp_path, gateway):
    result, daemon = invoke_start(tmp_path, gateway)
    assert result.exit_code == 0, result.output + result.stderr
    daemon.assert_called_once()
    assert gateway.paths() == [CHALLENGES, KERNELS]
    assert "registrationProof" in gateway.posts()[0]
    assert all("signingProof" not in call[2] for call in gateway.calls)


def test_a_429_challenge_refusal_never_falls_back(gateway):
    gateway.script_challenge = [(429, {"error": "rate_limited"})] * 10
    with pytest.raises(RegistrationError) as error:
        signed(gateway)
    assert error.value.status == 429
    assert "limiting registration challenges" in error.value.hint
    assert not gateway.posts()


def test_the_challenge_request_is_tried_at_most_four_times_with_growing_delays(gateway, monkeypatch, clock):
    monkeypatch.setattr("pcc_node.register._jitter", lambda step: step)
    gateway.script_challenge = [(429, {})] * 10
    with pytest.raises(RegistrationError):
        signed(gateway)
    assert gateway.paths().count(CHALLENGES) == 4
    assert clock["sleeps"] == [5, 15, 45]


def test_a_503_challenge_refusal_is_retried(gateway):
    gateway.script_challenge = [(503, {}), (503, {})]
    signed(gateway)
    assert gateway.paths().count(CHALLENGES) == 3


def test_retry_delays_are_jittered_between_half_and_all_of_each_step(monkeypatch):
    from pcc_node import register
    monkeypatch.setattr(register, "_rng", random.Random(1234))
    for step in (5, 15, 45):
        draws = [register._jitter(step) for _ in range(1000)]
        assert all(step / 2 <= draw <= step for draw in draws)
        assert min(draws) < 0.6 * step and max(draws) > 0.9 * step


@pytest.mark.parametrize("body", [
    pytest.param({"error": "Not Found"}, id="wrong-error"), pytest.param("not found", id="text"),
    pytest.param({"error": "not_found", "message": "x"}, id="extra-key"), pytest.param({}, id="empty"),
    pytest.param(dict(DEFAULT_404, message="Route POST:/api/kernels/registration-challenges/x not found"), id="default-404-other-route"),
    pytest.param(dict(DEFAULT_404, code="x"), id="default-404-extra-key"),
    pytest.param(dict(DEFAULT_404, statusCode=404.0), id="default-404-float-status"),
    pytest.param(dict(DEFAULT_404, statusCode="404"), id="default-404-string-status"),
    pytest.param({k: v for k, v in DEFAULT_404.items() if k != "statusCode"}, id="default-404-missing-status"),
])
def test_a_404_that_is_not_exactly_an_older_gateways_fails_closed(gateway, body):
    gateway.script_challenge = [(404, body)]
    with pytest.raises(RegistrationError) as error:
        signed(gateway)
    assert error.value.status == 404
    assert gateway.paths() == [CHALLENGES]


@pytest.mark.parametrize("status", [401, 403, 400, 500, 502, 0])
def test_other_challenge_refusals_fail_closed_at_once(gateway, status):
    from pcc_node import challenge_store
    gateway.script_challenge = [(status, {"error": "refused"})] * 10
    with pytest.raises(RegistrationError) as error:
        signed(gateway)
    assert error.value.status == status
    assert gateway.paths() == [CHALLENGES]
    assert error.value.permanent is (status == 403)
    assert os.path.exists(challenge_store.refusal_path()) is (status == 403)
    if status in (401, 403):
        assert "self-service API key" in error.value.hint


def verify_static(gateway):
    body, = gateway.posts()
    nacl.signing.VerifyKey(bytes.fromhex(PAIR[0])).verify(
        f"pcc-kernel-signing-key:{body['id']}".encode(), bytes.fromhex(body["signingProof"]))


def test_the_frameworks_default_404_for_the_challenge_route_is_an_older_gateway(gateway):
    gateway.issues_challenges = False
    gateway.script_challenge = [(404, DEFAULT_404)]
    signed(gateway)
    assert gateway.paths() == [CHALLENGES, KERNELS]
    verify_static(gateway)


def test_the_challenge_registration_carries_no_static_proof(gateway):
    signed(gateway)
    body, = gateway.posts()
    assert "registrationProof" in body and body["signingKeyAlgorithm"] == "ed25519"
    assert "signingProof" not in body


def test_the_proof_signs_the_decoded_message_bytes(gateway):
    signed(gateway)
    proof = gateway.posts()[0]["registrationProof"]
    raw = base64.b64decode(gateway.challenges[proof["challengeId"]]["answer"]["message"])
    nacl.signing.VerifyKey(bytes.fromhex(PAIR[0])).verify(raw, bytes.fromhex(proof["signature"]))


@pytest.mark.parametrize("cell", ["prefix", "base64", "kernel", "signer", "challenge-id", "extra-field",
                                  "missing-field", "non-canonical", "not-utf8"])
def test_a_challenge_message_that_fails_a_check_is_never_signed(gateway, cell):
    from pcc_node.register import RegistrationChallengeError
    if cell == "prefix":
        gateway.mutate_message = lambda raw: raw.replace(b"REG-V1", b"REG-V2")
    elif cell == "base64":
        original = gateway.__call__
        def bad_base64(*args, **kwargs):
            status, answer = original(*args, **kwargs)
            if args[1] == CHALLENGES:
                answer["message"] = "!" + answer["message"]
            return status, answer
        with mock.patch("pcc_node.register.pcc_request", bad_base64):
            with pytest.raises(RegistrationChallengeError) as error:
                signed(gateway, persist=False)
        assert error.value.data["error"] == "registration_challenge_invalid"
        assert not gateway.posts()
        return
    elif cell == "kernel":
        gateway.mutate_fields = lambda fields: fields.update(kernelId="other")
    elif cell == "signer":
        gateway.mutate_fields = lambda fields: fields.update(publicKey="0x" + OTHER_PAIR[0])
    elif cell == "challenge-id":
        gateway.mutate_fields = lambda fields: fields.update(challengeId="ff" * 32)
    elif cell == "extra-field":
        gateway.mutate_fields = lambda fields: fields.update(extra=True)
    elif cell == "missing-field":
        gateway.mutate_fields = lambda fields: fields.pop("nonce")
    elif cell == "non-canonical":
        gateway.mutate_message = lambda raw: raw.replace(b'":', b'": ')
    else:
        gateway.mutate_message = lambda raw: raw.replace(b'"nonce":"ab', b'"nonce":"\xff')
    with pytest.raises(RegistrationChallengeError) as error:
        signed(gateway, persist=False)
    assert error.value.data["error"] == "registration_challenge_invalid"
    assert not gateway.posts()


def test_a_challenge_is_never_presented_twice(gateway):
    from pcc_node.register import register_kernel
    for _ in range(2):
        register_kernel(BASE, API_KEY, config(), signer=PAIR)
    assert gateway.paths().count(CHALLENGES) == 2
    assert gateway.posts()[1]["registrationProof"]["challengeId"] == f"{2:064x}"


def test_an_older_gateway_gets_one_call_with_the_static_proof(gateway):
    gateway.issues_challenges = False
    signed(gateway)
    assert gateway.paths() == [CHALLENGES, KERNELS]
    body, = gateway.posts()
    assert {"id", "name", "devices", "approvalMode", "pricing"} <= body.keys()
    assert body["signingKeyAlgorithm"] == "ed25519" and body["signingPublicKey"] == "0x" + PAIR[0]
    verify_static(gateway)


def test_a_key_that_cannot_sign_never_reaches_the_gateway(gateway):
    from pcc_node.register import RegistrationChallengeError
    with pytest.raises(RegistrationChallengeError) as error:
        signed(gateway, pair=(hashlib.sha256(bytes.fromhex(PAIR[1])).hexdigest(), PAIR[1]))
    assert error.value.data["error"] == "signing_key_unusable"
    assert gateway.calls == []


@pytest.mark.parametrize("base,domain,accepted", [
    pytest.param(BASE, "gw.example.test", True, id="same"),
    pytest.param("https://GW.Example.Test", "gw.example.test", True, id="base-uppercase"),
    pytest.param(BASE, "GW.example.test", True, id="message-uppercase"),
    pytest.param(BASE + ":443", "gw.example.test", True, id="https-default-port"),
    pytest.param("http://127.0.0.1:80", "127.0.0.1", True, id="http-default-port"),
    pytest.param(BASE + ":", "gw.example.test", True, id="empty-port"),
    pytest.param(BASE + ":08443", "gw.example.test:8443", True, id="leading-zero-port"),
    pytest.param("http://127.0.0.1:43200", "127.0.0.1:43200", True, id="non-default-port"),
    pytest.param("http://[0:0:0:0:0:0:0:1]:8080", "[::1]:8080", True, id="ipv6"),
    pytest.param(BASE + ".", "gw.example.test.", True, id="trailing-dot-both"),
    pytest.param("https://xn--bcher-kva.example", "xn--bcher-kva.example", True, id="punycode"),
    pytest.param(BASE + "/base", "gw.example.test", True, id="path"),
    pytest.param(BASE, "capability.example", False, id="other-host"),
    pytest.param("http://127.0.0.1:43200", "127.0.0.1", False, id="port-missing"),
    pytest.param(BASE, "gw.example.test:443", False, id="port-extra"),
    pytest.param(BASE + ".", "gw.example.test", False, id="base-trailing-dot"),
    pytest.param(BASE, "gw.example.test.", False, id="message-trailing-dot"),
    pytest.param(BASE, "evil.gw.example.test", False, id="subdomain"),
])
def test_the_challenge_domain_must_equal_the_configured_host(gateway, base, domain, accepted):
    from pcc_node.register import RegistrationChallengeError
    gateway.domain = domain
    if accepted:
        signed(gateway, base=base)
    else:
        with pytest.raises(RegistrationChallengeError) as error:
            signed(gateway, base=base)
        assert error.value.data["error"] == "registration_challenge_domain"
        assert not gateway.posts()


@pytest.mark.parametrize("base,kid,code", [
    pytest.param("https://u:p@gw.example.test", "k", "gateway_url_unusable", id="userinfo"),
    pytest.param("https://bücher.example", "k", "gateway_url_unusable", id="non-ascii"),
    pytest.param(BASE + ":65536", "k", "gateway_url_unusable", id="port-range"),
    pytest.param(BASE + ":4_43", "k", "gateway_url_unusable", id="port-underscore"),
    pytest.param(BASE + ":+443", "k", "gateway_url_unusable", id="port-sign"),
    pytest.param("https://[fe80::1%25eth0]:8080", "k", "gateway_url_unusable", id="ipv6-zone"),
    pytest.param("ftp://gw.example.test", "k", "gateway_url_unusable", id="scheme"),
    pytest.param(BASE, "", "kernel_id_missing", id="kernel-id"),
])
def test_a_registration_that_cannot_be_checked_is_refused_before_any_request(gateway, base, kid, code):
    from pcc_node.register import RegistrationChallengeError
    with pytest.raises(RegistrationChallengeError) as error:
        signed(gateway, base=base, kid=kid)
    assert error.value.data["error"] == code
    assert gateway.calls == []


def test_a_refused_proof_is_never_presented_again(gateway):
    from pcc_node import challenge_store
    gateway.script_kernel = [(403, {"error": "FORBIDDEN"})]
    with pytest.raises(RegistrationError):
        signed(gateway)
    assert not os.path.exists(challenge_store.store_path())
    signed(gateway)
    ids = [body["registrationProof"]["challengeId"] for body in gateway.posts()]
    assert len(ids) == len(set(ids)) == 2
    assert gateway.paths().count(CHALLENGES) == 2


@pytest.mark.parametrize("older,status,key,empty", [
    (False, 200, None, False), (False, 200, "other", False),
    (False, 201, None, True), (True, 201, None, False),
])
def test_a_2xx_without_this_nodes_signing_key_fails_closed(gateway, older, status, key, empty):
    from pcc_node.register import RegistrationChallengeError
    gateway.issues_challenges = not older
    gateway.script_kernel = [(status, {} if empty else {"kernel": {"signingKey": ({"algorithm": "ed25519", "publicKey": "0x" + OTHER_PAIR[0]} if key == "other" else key)}})]
    with pytest.raises(RegistrationChallengeError) as error:
        signed(gateway)
    assert error.value.data["error"] == "registration_not_bound"


def test_a_kernel_bound_to_another_key_stops_start_with_the_next_step(tmp_path, gateway):
    gateway.issues_challenges = False
    gateway.bound["kernel-bound"] = "0x" + OTHER_PAIR[0]
    result, _ = invoke_start(tmp_path, gateway, kid="kernel-bound")
    assert result.exit_code == 1, result.output
    assert "already bound to a different signing key" in result.stderr and "--kernel-id" in result.stderr
    assert not (tmp_path / "keys" / "registration-refusal.json").exists()


def test_a_refused_static_proof_exits_1_and_leaves_no_refusal_marker(tmp_path, gateway):
    gateway.issues_challenges = False
    gateway.script_kernel = [(403, {"error": "FORBIDDEN", "message": "refused"})]
    result, _ = invoke_start(tmp_path, gateway)
    assert result.exit_code == 1, result.output
    assert not (tmp_path / "keys" / "registration-refusal.json").exists()
    assert gateway.paths() == [CHALLENGES, KERNELS]


@pytest.mark.parametrize("cell", ["challenge-reset", "proof-incomplete", "proof-http-403", "proof-http-409",
                                  "older-reset", "proof-2xx-not-dict"])
def test_an_answer_the_node_cannot_read_is_never_permanent(gateway, cell):
    from pcc_node import challenge_store
    status = 0
    if cell == "challenge-reset":
        gateway.script_challenge = [ConnectionResetError()]
    elif cell == "older-reset":
        gateway.issues_challenges = False
        gateway.script_kernel = [ConnectionResetError()]
    elif cell == "proof-incomplete":
        gateway.script_kernel = [http.client.IncompleteRead(b"")]
    elif cell.startswith("proof-http"):
        status = int(cell[-3:])
        gateway.script_kernel = [HTTPError(BASE + KERNELS, status, "refused", {}, None)]
    else:
        gateway.script_kernel = [(201, [])]
    with pytest.raises(RegistrationError) as error:
        signed(gateway)
    assert error.value.status == status
    assert error.value.data == {"error": "malformed_registration_response" if cell == "proof-2xx-not-dict"
                                else "registration_response_unreadable"}
    assert not error.value.permanent
    assert not os.path.exists(challenge_store.refusal_path())
    assert not os.path.exists(challenge_store.store_path())
    assert os.path.exists(challenge_store.hold_path()) is (cell in ("proof-incomplete", "proof-http-403", "proof-http-409"))
    assert len(gateway.calls) == (1 if cell == "challenge-reset" else 2)


def crash_after_save(gateway):
    with mock.patch("pcc_node.register.sign_ed25519_bytes", side_effect=KeyboardInterrupt):
        with pytest.raises(KeyboardInterrupt):
            signed(gateway)


def test_a_stored_unsent_challenge_is_reused_after_a_restart(gateway, clock):
    crash_after_save(gateway)
    clock["now"] += 479
    signed(gateway)
    assert gateway.paths().count(CHALLENGES) == 1
    assert gateway.posts()[0]["registrationProof"]["challengeId"] == f"{1:064x}"


def test_the_stored_challenge_is_removed_before_the_proof_is_sent(gateway):
    from pcc_node import challenge_store
    def before():
        assert not os.path.exists(challenge_store.store_path())
        assert os.path.exists(challenge_store.hold_path())
    gateway.before_kernel = before
    signed(gateway)


@pytest.mark.parametrize("status", [pytest.param(0, id="lost"), pytest.param(400, id="refused-400")])
def test_a_lost_or_refused_send_holds_and_never_presents_its_challenge_again(gateway, clock, status):
    from pcc_node import challenge_store
    gateway.script_kernel = [(status, {"error": "bad_request"})]
    with pytest.raises(RegistrationError):
        signed(gateway)
    signed(gateway)
    assert clock["sleeps"] == [challenge_store.HOLD_SECONDS]
    assert gateway.paths().count(CHALLENGES) == 2
    assert gateway.posts()[1]["registrationProof"]["challengeId"] == f"{2:064x}"


def test_a_challenge_the_node_refused_stays_stored_and_no_new_one_is_requested(gateway):
    from pcc_node import challenge_store
    gateway.mutate_fields = lambda fields: fields.update(kernelId="other")
    for _ in range(2):
        with pytest.raises(RegistrationError) as error:
            signed(gateway)
        assert error.value.data["error"] == "registration_challenge_invalid"
        with open(challenge_store.store_path()) as stream:
            assert json.load(stream)["challengeId"] == f"{1:064x}"
    assert gateway.paths() == [CHALLENGES]


def test_a_store_that_cannot_be_cleared_stops_before_the_proof_is_sent(gateway, monkeypatch):
    from pcc_node import challenge_store
    def refused(*args, **kwargs):
        raise PermissionError("cannot remove")
    monkeypatch.setattr(challenge_store.os, "unlink", refused)
    with pytest.raises(RegistrationError) as error:
        signed(gateway)
    assert error.value.data["error"] == "registration_challenge_store"
    assert not gateway.posts()


def track_events(gateway, clock, monkeypatch):
    def request(*args, **kwargs):
        clock["events"].append(args[1])
        return gateway(*args, **kwargs)
    monkeypatch.setattr("pcc_node.register.pcc_request", request)


@pytest.mark.parametrize("age", [pytest.param(500, id="inside-hold"), pytest.param(661, id="after-hold")])
def test_a_stored_challenge_past_its_send_window_holds_new_requests_until_it_expires(gateway, clock, monkeypatch, age):
    from pcc_node import challenge_store
    crash_after_save(gateway)
    clock["now"] += age
    track_events(gateway, clock, monkeypatch)
    signed(gateway)
    expected = [challenge_store.HOLD_SECONDS - age] if age < challenge_store.HOLD_SECONDS else []
    assert clock["sleeps"] == expected
    assert clock["events"] == ([("sleep", expected[0])] if expected else []) + [CHALLENGES, KERNELS]
    assert gateway.paths().count(CHALLENGES) == 2
    assert gateway.posts()[0]["registrationProof"]["challengeId"] == f"{2:064x}"
    assert challenge_store.HOLD_SECONDS >= 600


@pytest.mark.parametrize("bound", [True, False], ids=["bound", "not-bound"])
def test_a_registration_right_after_a_successful_one_does_not_wait(gateway, clock, bound):
    from pcc_node import challenge_store
    if bound:
        signed(gateway)
    else:
        gateway.script_kernel = [(200, {"kernel": {"signingKey": None}})]
        with pytest.raises(RegistrationError) as error:
            signed(gateway)
        assert error.value.data["error"] == "registration_not_bound"
    assert not os.path.exists(challenge_store.hold_path())
    signed(gateway)
    assert clock["sleeps"] == []
    assert gateway.paths().count(CHALLENGES) == 2


def test_a_node_that_dies_while_saving_the_challenge_still_holds(gateway, clock, monkeypatch):
    from pcc_node import challenge_store
    with mock.patch("pcc_node.register.save_challenge", side_effect=KeyboardInterrupt):
        with pytest.raises(KeyboardInterrupt):
            signed(gateway)
    assert os.path.exists(challenge_store.hold_path())
    assert not os.path.exists(challenge_store.store_path())
    clock["now"] += 500
    track_events(gateway, clock, monkeypatch)
    signed(gateway)
    assert clock["sleeps"] == [challenge_store.HOLD_SECONDS - 500]
    assert clock["events"] == [("sleep", challenge_store.HOLD_SECONDS - 500), CHALLENGES, KERNELS]
    assert gateway.paths().count(CHALLENGES) == 2
    assert gateway.posts()[0]["registrationProof"]["challengeId"] == f"{2:064x}"


@pytest.mark.parametrize("first,second", [(True, True), (True, False), (False, True), (False, False)],
                         ids=["on-on", "on-off", "off-on", "off-off"])
def test_the_hold_covers_every_kernel_id_with_the_same_gateway_key_and_api_key(gateway, clock, monkeypatch, caplog, first, second):
    from pcc_node import challenge_store
    gateway.script_kernel = [(400, {"error": "bad_request"})]
    with pytest.raises(RegistrationError):
        signed(gateway, kid="kernel-a", persist=first)
    assert os.path.exists(challenge_store.hold_path())
    assert not os.path.exists(challenge_store.refusal_path())
    clock["now"] += 100
    track_events(gateway, clock, monkeypatch)
    signed(gateway, kid="kernel-b", persist=second)
    assert clock["sleeps"] == [challenge_store.HOLD_SECONDS - 100]
    assert clock["events"] == [("sleep", challenge_store.HOLD_SECONDS - 100), CHALLENGES, KERNELS]
    assert challenge_store.hold_path() in caplog.text
    assert gateway.paths().count(CHALLENGES) == 2
    assert gateway.calls[-2][2]["kernelId"] == "kernel-b"
    assert not os.path.exists(challenge_store.hold_path())


def refuse(gateway, cell):
    if cell == "challenge-403":
        gateway.script_challenge = [(403, {"error": "insufficient_scope"})]
        return "challenge_request_403"
    status = 403 if cell == "registration-403" else 409
    gateway.script_kernel = [(status, {"error": "FORBIDDEN" if status == 403 else "conflict"})]
    return "registration_" + str(status)


@pytest.mark.parametrize("cell", ["challenge-403", "registration-403", "registration-409"])
def test_a_permanent_refusal_leaves_a_refusal_marker(gateway, cell):
    from pcc_node import challenge_store
    reason = refuse(gateway, cell)
    with pytest.raises(RegistrationError) as error:
        signed(gateway)
    assert error.value.permanent
    path = challenge_store.refusal_path()
    assert os.path.dirname(path) == os.path.dirname(challenge_store.store_path())
    assert os.stat(path).st_mode & 0o777 == 0o600
    with open(path) as stream:
        assert json.load(stream)["reason"] == reason


def test_the_refusal_marker_holds_no_key_material(gateway):
    from pcc_node import challenge_store
    refuse(gateway, "registration-403")
    with pytest.raises(RegistrationError):
        signed(gateway)
    with open(challenge_store.refusal_path(), "rb") as stream:
        raw = stream.read()
    record = json.loads(raw)
    assert set(record) == {"version", "reason", "gateway", "kernelId", "publicKey", "apiKey", "refusedAt"}
    assert record["apiKey"] == challenge_store.binding(BASE, "kernel-test", PAIR[0], API_KEY)["apiKey"]
    assert len(record["apiKey"]) == 64 and all(c in "0123456789abcdef" for c in record["apiKey"])
    issued = next(iter(gateway.challenges.values()))["answer"]
    for value in [API_KEY, PAIR[1], issued["challengeId"], issued["message"], gateway.posts()[0]["registrationProof"]["signature"]]:
        assert value.encode() not in raw


@pytest.mark.parametrize("cell,age", [("d100", 100), ("d599", 599), ("after-cooldown", 661),
    ("other-api-key", 100), ("other-kernel", 100), ("other-signer", 100), ("other-gateway", 100)])
def test_a_start_inside_the_cooldown_waits_before_asking_again(gateway, clock, monkeypatch, caplog, cell, age):
    from pcc_node import challenge_store
    initial = clock["now"]
    refuse(gateway, "registration-409")
    with pytest.raises(RegistrationError):
        signed(gateway)
    clock["now"] += age
    track_events(gateway, clock, monkeypatch)
    kwargs = {"other-api-key": {"api_key": "another-key"}, "other-kernel": {"kid": "another-kernel"},
              "other-signer": {"pair": OTHER_PAIR}, "other-gateway": {"base": BASE + ":443"}}.get(cell, {})
    signed(gateway, **kwargs)
    expected = [challenge_store.HOLD_SECONDS - age] if cell in ("d100", "d599") else []
    assert clock["sleeps"] == expected
    assert clock["events"] == ([("sleep", expected[0])] if expected else []) + [CHALLENGES, KERNELS]
    assert challenge_store.HOLD_SECONDS >= 600
    if cell == "d100":
        assert "registration_409" in caplog.text
        assert time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(initial + challenge_store.HOLD_SECONDS)) in caplog.text


@pytest.mark.parametrize("older", [False, True], ids=["challenge", "older"])
def test_a_successful_registration_clears_the_refusal_marker(gateway, clock, older):
    from pcc_node import challenge_store
    now = clock["now"]
    clock["now"] -= challenge_store.HOLD_SECONDS + 1
    assert challenge_store.save_refusal(challenge_store.binding(BASE, "kernel-test", PAIR[0], API_KEY), "registration_409")
    clock["now"] = now
    gateway.issues_challenges = not older
    signed(gateway)
    assert not os.path.exists(challenge_store.refusal_path())


@pytest.mark.parametrize("cell", ["challenge-403", "registration-409", "help"])
def test_start_exits_78_after_a_permanent_refusal(tmp_path, gateway, cell):
    from pcc_node import register
    if cell == "help":
        from pcc_node.cli import main
        result = separate_runner().invoke(main, ["start", "--help"])
        assert result.exit_code == 0
        assert "RestartPreventExitStatus=78" in result.output
    else:
        refuse(gateway, cell)
        result, _ = invoke_start(tmp_path, gateway)
        assert result.exit_code == register.PERMANENT_REFUSAL_EXIT == 78, result.output + result.stderr
        assert ("self-service API key" if cell == "challenge-403" else "already bound to a different signing key") in result.stderr


def daemon_surroundings(tmp_path, monkeypatch):
    from pcc_node import daemon
    monkeypatch.setattr(daemon, "PID_FILE", str(tmp_path / "node.pid"))
    monkeypatch.setattr(daemon, "STATE_FILE", str(tmp_path / "node-state.json"))
    monkeypatch.setattr(daemon, "load_or_create_keys", lambda: PAIR)
    monkeypatch.setattr(daemon, "discover_network", lambda **kwargs: [])
    monkeypatch.setattr(daemon, "detect_camera_device", lambda: None)
    monkeypatch.setattr("pcc_node.ui_server.start_ui_server", mock.Mock())
    monkeypatch.setattr(daemon.signal, "signal", lambda *args: None)
    monkeypatch.setattr(daemon.time, "sleep", mock.Mock(side_effect=KeyboardInterrupt))
    client = mock.Mock()
    monkeypatch.setattr(daemon, "PCCGatewayClient", client)
    return daemon, client


@pytest.mark.parametrize("cell", ["direct", "start"])
def test_a_permanent_refusal_in_the_daemon_ends_start_with_78(tmp_path, monkeypatch, gateway, cell):
    from pcc_node import register
    daemon, client = daemon_surroundings(tmp_path, monkeypatch)
    gateway.script_kernel = ([None] if cell == "start" else []) + [(409, {"error": "SIGNER_ALREADY_BOUND", "message": "conflict"})]
    if cell == "direct":
        with pytest.raises(RegistrationError) as error:
            daemon.run_daemon(config())
        assert error.value.status == 409 and error.value.permanent
    else:
        result, _ = invoke_start(tmp_path, gateway, patch_daemon=False)
        assert result.exit_code == register.PERMANENT_REFUSAL_EXIT == 78, result.output + result.stderr
        assert "the daemon's own registration did not" in result.stderr
        assert "already bound to a different signing key" in result.stderr
    client.assert_not_called()
    assert not os.path.exists(daemon.PID_FILE) and not os.path.exists(daemon.STATE_FILE)


@pytest.mark.parametrize("status", [409, 403])
def test_a_409_to_the_proof_clears_the_hold_and_a_403_keeps_it(gateway, clock, monkeypatch, caplog, status):
    from pcc_node import challenge_store
    gateway.script_kernel = [(status, {"error": "conflict" if status == 409 else "FORBIDDEN"})]
    with pytest.raises(RegistrationError) as error:
        signed(gateway, kid="kernel-a")
    assert error.value.permanent
    assert os.path.exists(challenge_store.hold_path()) is (status == 403)
    with open(challenge_store.refusal_path()) as stream:
        assert json.load(stream)["reason"] == "registration_" + str(status)
    if status == 403:
        clock["now"] += 100
        track_events(gateway, clock, monkeypatch)
        signed(gateway, kid="kernel-b")
        assert clock["sleeps"] == [challenge_store.HOLD_SECONDS - 100]
        assert clock["events"] == [("sleep", challenge_store.HOLD_SECONDS - 100), CHALLENGES, KERNELS]
        assert challenge_store.hold_path() in caplog.text and "may still be open" in caplog.text


def test_the_bytes_signer_signs_bytes_and_refuses_other_types():
    from pcc_node.log_capture import sign_ed25519_bytes
    raw = b"\x00\xffthe gateway's registration challenge\x80"
    signature = sign_ed25519_bytes(raw, *PAIR)
    assert len(signature) == 128
    nacl.signing.VerifyKey(bytes.fromhex(PAIR[0])).verify(raw, bytes.fromhex(signature))
    for value in ("text", bytearray(raw), None):
        with pytest.raises(TypeError):
            sign_ed25519_bytes(value, *PAIR)


@pytest.mark.parametrize("body", [None, [], {}, {"challengeId": "", "message": "x", "expiresAt": "x"},
    {"challengeId": "x", "message": "x" * 4097, "expiresAt": "x"},
    {"challengeId": "x" * 257, "message": "x", "expiresAt": "x"},
    {"challengeId": "x", "message": "x", "expiresAt": 1}])
def test_a_malformed_challenge_answer_is_refused_without_signing(gateway, body):
    from pcc_node.register import request_registration_challenge, RegistrationChallengeError
    gateway.script_challenge = [(201, body)]
    with pytest.raises(RegistrationChallengeError) as error:
        request_registration_challenge(BASE, API_KEY, "k", PAIR[0])
    assert error.value.data["error"] == "registration_challenge_response"
    assert gateway.paths() == [CHALLENGES]
