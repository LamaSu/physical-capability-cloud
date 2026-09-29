"""Tests for the declared-terms feature (board N23, #3560): a capability is
announced only with terms the operator declared in their own device config
-- never an invented default.

Section 1 (TestDeclaredTiers / TestDeclaredPricing) mirrors gateway PR #437's
`declaredTiers`/`declaredPricing` tests
(packages/gateway/src/__tests__/heartbeat-declared-terms.test.ts, commit
b930e9f1) one-for-one against pcc_node.declared_terms.declared_tiers /
declared_pricing: same inputs, same reason codes, plus Python-only cases the
JS type system can't express. The remaining sections cover
validate_device_terms, announceable_types, announcement_plan, and how
declared terms flow end-to-end through register.py, daemon.py, ws_client.py,
config.py and cli.py.
"""

import itertools
import json
import time
from unittest import mock

import pytest
from click.testing import CliRunner

from pcc_node.cli import main
from pcc_node.config import NodeConfig, load_config, merge_detected_devices
from pcc_node.declared_terms import (
    DeclaredTermsError,
    INVALID_PRICING,
    INVALID_TIERS,
    NO_DECLARED_PRICING,
    NO_DECLARED_TIERS,
    ZERO_PRICE,
    announceable_types,
    announcement_plan,
    declared_pricing,
    declared_tiers,
    validate_device_terms,
)
from pcc_node.job_executor import CAPABILITY_PROTOCOL_MAP
from pcc_node.log_capture import _HAS_NACL
from pcc_node.register import announce_capabilities, register_devices, register_kernel
from pcc_node.ws_client import PCCGatewayClient


def _terms(tiers, base_cost="5", minimum="5", currency="USDC"):
    """A fresh, valid declared-terms dict pair -- new list/dict objects on
    every call, so tests can never accidentally share (and corrupt) mutable
    state through what would otherwise be a shared fixture."""
    return {
        "assuranceTiers": list(tiers),
        "pricing": {"currency": currency, "baseCost": base_cost, "minimum": minimum},
    }


def _increasing_clock():
    """A monotonically increasing fake ``time.time()``: every call returns
    1000s more than the previous one, no matter how many calls happen or who
    makes them. Used to force run_daemon's ``elapsed > announce_interval``
    (60s) periodic-path check to fire deterministically without a real
    60-second wait, while also making the interruptible sleep loop's
    ``time.time() < sleep_end`` check resolve to False immediately (so no
    real ``time.sleep()`` ever executes)."""
    counter = itertools.count()
    base = 1_700_000_000.0

    def _time():
        return base + next(counter) * 1000

    return _time


# ---------------------------------------------------------------------------
# 1. declared_tiers / declared_pricing -- mirrors #437's tests exactly, plus
#    Python-only cases.
# ---------------------------------------------------------------------------

class TestDeclaredTiers:
    """Mirrors #437's `declaredTiers` describe block
    (heartbeat-declared-terms.test.ts) against declared_tiers: same inputs,
    same reason codes."""

    def test_absent_is_no_declared_tiers(self):
        assert declared_tiers(None) == (None, NO_DECLARED_TIERS)

    @pytest.mark.parametrize(
        "bad",
        [
            [],
            [4],
            [-1],
            [1.5],
            ["1"],
            [float("nan")],
            [None],
            "0,1",
            {0: 0},
            [0] * 17,
        ],
        ids=[
            "empty", "out-of-range-4", "negative", "non-integral-float",
            "string-digit", "nan", "none-entry", "csv-string", "dict-not-list",
            "seventeen-entries",
        ],
    )
    def test_invalid_shapes(self, bad):
        assert declared_tiers(bad) == (None, INVALID_TIERS)

    def test_kept_as_a_sorted_deduped_set(self):
        assert declared_tiers([3, 0, 3, 1]) == ([0, 1, 3], None)

    def test_sixteen_entries_is_the_max_allowed(self):
        assert declared_tiers([2] * 16) == ([2], None)

    # -- Python-only cases (no JS equivalent: JS has no bool/int distinct
    # from number, and Python's re "$" vs fullmatch() differ on trailing
    # newlines where JS's ^...$ (no /m/ flag) does not) --

    def test_bool_is_not_a_tier(self):
        """JS `typeof true !== "number"`. A Python bool is an int subclass,
        so declared_tiers excludes it explicitly."""
        assert declared_tiers([True]) == (None, INVALID_TIERS)
        assert declared_tiers([False]) == (None, INVALID_TIERS)

    def test_integral_float_is_accepted_as_its_integer(self):
        """JS reads 1.0 as the number 1."""
        assert declared_tiers([1.0]) == ([1], None)

    def test_nan_is_invalid(self):
        assert declared_tiers([float("nan")]) == (None, INVALID_TIERS)


class TestDeclaredPricing:
    """Mirrors #437's `declaredPricing` describe block against
    declared_pricing: same inputs, same reason codes."""

    def test_absent_is_no_declared_pricing(self):
        assert declared_pricing(None) == (None, NO_DECLARED_PRICING)

    @pytest.mark.parametrize(
        "bad",
        [
            "USDC 5",
            [],
            {"baseCost": "5", "minimum": "5"},
            {"currency": "", "baseCost": "5", "minimum": "5"},
            {"currency": "US DC", "baseCost": "5", "minimum": "5"},
            {"currency": "USDC", "baseCost": "5"},
            {"currency": "USDC", "minimum": "5"},
            {"currency": "USDC", "baseCost": 5, "minimum": "5"},
            {"currency": "USDC", "baseCost": "-5", "minimum": "5"},
            {"currency": "USDC", "baseCost": "1e3", "minimum": "5"},
            {"currency": "USDC", "baseCost": "5.", "minimum": "5"},
            {"currency": "USDC", "baseCost": "5", "minimum": "5", "perGram": "abc"},
        ],
        ids=[
            "string-not-object", "array-not-object", "no-currency",
            "empty-currency", "currency-has-space", "no-minimum", "no-baseCost",
            "baseCost-not-string", "negative-baseCost", "exponent-baseCost",
            "trailing-dot-baseCost", "non-decimal-perGram",
        ],
    )
    def test_invalid_shapes(self, bad):
        assert declared_pricing(bad) == (None, INVALID_PRICING)

    def test_zero_across_every_component_is_not_a_price(self):
        assert declared_pricing(
            {"currency": "USDC", "baseCost": "0", "minimum": "0.000", "perMinute": "0"}
        ) == (None, ZERO_PRICE)

    def test_only_known_components_are_kept(self):
        assert declared_pricing(
            {"currency": "USDC", "baseCost": "0", "minimum": "0", "perMinute": "0.25", "note": "x"}
        ) == ({"currency": "USDC", "baseCost": "0", "minimum": "0", "perMinute": "0.25"}, None)

    # -- Python-only cases --

    def test_trailing_newline_in_a_decimal_is_invalid(self):
        """declared_terms.py matches with fullmatch() specifically so a
        trailing newline is refused, matching JS's ^...$ (no /m/ flag) --
        a bare Python `$`-anchored match would have accepted it."""
        assert declared_pricing(
            {"currency": "USDC", "baseCost": "5\n", "minimum": "5"}
        ) == (None, INVALID_PRICING)

    def test_trailing_newline_in_currency_is_invalid(self):
        assert declared_pricing(
            {"currency": "USDC\n", "baseCost": "5", "minimum": "5"}
        ) == (None, INVALID_PRICING)

    def test_full_width_digits_are_invalid(self):
        """[0-9] is an explicit ASCII range; U+FF10.. full-width digits are
        outside it regardless of the (default, for str patterns) unicode
        flag -- unlike `\\d`, an explicit range doesn't grow to match them."""
        assert declared_pricing(
            {"currency": "USDC", "baseCost": "５", "minimum": "5"}
        ) == (None, INVALID_PRICING)


# ---------------------------------------------------------------------------
# 2. validate_device_terms
# ---------------------------------------------------------------------------

class TestValidateDeviceTerms:
    def test_no_terms_declared_returns_none(self):
        assert validate_device_terms({"id": "d1", "type": "camera"}) is None

    def test_tiers_without_pricing_is_an_error_naming_the_device_and_field(self):
        with pytest.raises(DeclaredTermsError) as exc:
            validate_device_terms({"id": "printer-1", "assuranceTiers": [0]})
        assert "printer-1" in str(exc.value)
        assert "pricing" in str(exc.value)

    def test_pricing_without_tiers_is_an_error_naming_the_device_and_field(self):
        with pytest.raises(DeclaredTermsError) as exc:
            validate_device_terms({
                "id": "printer-2",
                "pricing": {"currency": "USDC", "baseCost": "5", "minimum": "5"},
            })
        assert "printer-2" in str(exc.value)
        assert "assuranceTiers" in str(exc.value)

    def test_unknown_pricing_key_is_an_error(self):
        with pytest.raises(DeclaredTermsError) as exc:
            validate_device_terms({
                "id": "printer-3",
                "assuranceTiers": [0],
                "pricing": {"currency": "USDC", "baseCost": "5", "minimum": "5", "perGrams": "1"},
            })
        assert "printer-3" in str(exc.value)
        assert "perGrams" in str(exc.value)

    def test_zero_price_is_an_error(self):
        with pytest.raises(DeclaredTermsError) as exc:
            validate_device_terms({
                "id": "printer-4",
                "assuranceTiers": [0],
                "pricing": {"currency": "USDC", "baseCost": "0", "minimum": "0"},
            })
        assert "printer-4" in str(exc.value)

    def test_invalid_tiers_is_an_error(self):
        with pytest.raises(DeclaredTermsError) as exc:
            validate_device_terms({
                "id": "printer-6",
                "assuranceTiers": [7],
                "pricing": {"currency": "USDC", "baseCost": "5", "minimum": "5"},
            })
        assert "printer-6" in str(exc.value)

    def test_every_message_names_the_device_by_host_when_no_id(self):
        with pytest.raises(DeclaredTermsError) as exc:
            validate_device_terms({"host": "10.0.0.5", "assuranceTiers": [0]})
        assert "10.0.0.5" in str(exc.value)

    def test_valid_terms_are_returned_sorted_and_deduped(self):
        terms = validate_device_terms({
            "id": "printer-5",
            "assuranceTiers": [2, 0, 2],
            "pricing": {"currency": "USDC", "baseCost": "12.50", "minimum": "10"},
        })
        assert terms == {
            "assuranceTiers": [0, 2],
            "pricing": {"currency": "USDC", "baseCost": "12.50", "minimum": "10"},
        }


# ---------------------------------------------------------------------------
# 3. announceable_types -- the inverse of job_executor.CAPABILITY_PROTOCOL_MAP
# ---------------------------------------------------------------------------

class TestAnnounceableTypes:
    @pytest.mark.parametrize(
        "protocol,expected_types",
        [
            ("ipp", ["document-printing"]),
            ("printer", ["document-printing"]),
            ("opentrons", ["liquid-handler", "pipette-transfer"]),
            ("octoprint", ["3d-print", "fdm-fabrication"]),
            ("http", ["generic", "network-instrument"]),
            ("generic", ["generic", "network-instrument"]),
            ("unknown", ["generic"]),
            ("camera", []),
            ("serial", []),
        ],
    )
    def test_inverts_the_capability_protocol_map(self, protocol, expected_types):
        assert announceable_types({"protocol": protocol}) == expected_types

    def test_falls_back_to_type_when_no_protocol(self):
        assert announceable_types({"type": "octoprint"}) == ["3d-print", "fdm-fabrication"]

    def test_falls_back_to_generic_when_neither_protocol_nor_type(self):
        assert announceable_types({}) == ["generic", "network-instrument"]

    def test_every_capability_protocol_map_value_is_covered_above(self):
        """A completeness guard on THIS test suite, not on announceable_types
        itself: if job_executor.py ever routes a new protocol, this fails
        and says so, rather than the map silently drifting out of sync with
        the parametrized cases above."""
        all_routed_protocols = {p for protocols in CAPABILITY_PROTOCOL_MAP.values() for p in protocols}
        assert all_routed_protocols == {"ipp", "printer", "opentrons", "octoprint", "http", "generic", "unknown"}


# ---------------------------------------------------------------------------
# 4. announcement_plan
# ---------------------------------------------------------------------------

class TestAnnouncementPlan:
    def test_declared_ipp_printer_announces_document_printing_with_its_terms(self):
        device = {"id": "printer-1", "protocol": "ipp", **_terms([0])}
        capabilities, not_announced = announcement_plan([device])
        assert capabilities == [{
            "type": "document-printing",
            "assuranceTiers": [0],
            "pricing": {"currency": "USDC", "baseCost": "5", "minimum": "5"},
        }]
        assert not_announced == []

    def test_undeclared_device_is_not_announced_with_a_reason_and_no_capability(self):
        device = {"id": "printer-2", "protocol": "ipp"}
        capabilities, not_announced = announcement_plan([device])
        assert capabilities == []
        assert not_announced == [{
            "device": "printer-2",
            "reason": "no declared terms: add assuranceTiers and pricing to this device in the node config",
        }]

    def test_camera_with_terms_is_not_announced_no_executable_type(self):
        device = {"id": "cam-1", "protocol": "camera", **_terms([0])}
        capabilities, not_announced = announcement_plan([device])
        assert capabilities == []
        assert not_announced == [{
            "device": "cam-1",
            "reason": "this node executes no capability on protocol 'camera'",
        }]

    def test_two_devices_same_type_same_terms_produce_one_capability(self):
        d1 = {"id": "printer-1", "protocol": "ipp", **_terms([0])}
        d2 = {"id": "printer-2", "protocol": "printer", **_terms([0])}
        capabilities, not_announced = announcement_plan([d1, d2])
        assert len(capabilities) == 1
        assert capabilities[0]["type"] == "document-printing"
        assert not_announced == []

    def test_two_devices_same_type_different_terms_raises(self):
        d1 = {"id": "printer-1", "protocol": "ipp", **_terms([0])}
        d2 = {"id": "printer-2", "protocol": "printer", **_terms([1], base_cost="99", minimum="99")}
        with pytest.raises(DeclaredTermsError) as exc:
            announcement_plan([d1, d2])
        assert "printer-1" in str(exc.value)
        assert "printer-2" in str(exc.value)
        assert "document-printing" in str(exc.value)

    def test_output_sorted_by_type(self):
        devices = [
            {"id": "ot", "protocol": "opentrons", **_terms([0])},
            {"id": "printer", "protocol": "ipp", **_terms([0])},
        ]
        capabilities, _ = announcement_plan(devices)
        types = [c["type"] for c in capabilities]
        assert types == sorted(types)
        assert types == ["document-printing", "liquid-handler", "pipette-transfer"]

    def test_returned_capabilities_are_copies_not_shared_with_the_device(self):
        device = {"id": "printer-1", "protocol": "ipp", **_terms([0])}
        capabilities, _ = announcement_plan([device])
        capabilities[0]["assuranceTiers"].append(99)
        capabilities[0]["pricing"]["baseCost"] = "MUTATED"
        assert device["assuranceTiers"] == [0]
        assert device["pricing"]["baseCost"] == "5"


# ---------------------------------------------------------------------------
# 5. The property under test: unless a device declares BOTH assuranceTiers
#    and pricing (those exact keys), nothing about it is ever announced --
#    register.announce_capabilities makes no HTTP call at all, and the
#    daemon's periodic path only ever sends a plain heartbeat, never
#    gateway_client.announce_capabilities.
# ---------------------------------------------------------------------------

class TestNothingDeclaredMeansNothingSent:
    NO_TERMS_DEVICE_LISTS = [
        [],
        [{"type": "opentrons"}],
        [{"type": "octoprint", "url": "http://10.0.0.5:5000"}],
        [{"protocol": "ipp", "host": "10.0.0.9"}],
        [{"type": "opentrons"}, {"type": "octoprint"}, {"protocol": "ipp"}],
        # Detected-looking dicts with stray, near-miss keys that must NOT be
        # mistaken for a declaration -- only the exact keys "assuranceTiers"
        # and "pricing" count (validate_device_terms checks presence of
        # those two keys only).
        [{"type": "octoprint", "tier": 1, "price": "10"}],
        [{"type": "octoprint", "tiers": [0, 1], "prices": {"base": 10}}],
        [{"type": "octoprint", "assurance_tiers": [0], "pricing_info": {"a": 1}}],
        [{"type": "octoprint", "cost": "10", "assuranceTier": 0}],  # singular, wrong key
        [{"type": "ipp", "price": {"currency": "USDC", "baseCost": "5", "minimum": "5"}}],
    ]
    NO_TERMS_IDS = [
        "empty", "opentrons-bare", "octoprint-with-url", "ipp-with-host",
        "three-mixed-bare", "near-miss-tier-price", "near-miss-tiers-prices",
        "near-miss-snake-case", "near-miss-singular-assuranceTier",
        "near-miss-price-shaped-like-pricing",
    ]

    @pytest.fixture(autouse=True)
    def _clean_daemon_files(self):
        """The daemon test below runs the real run_daemon(), which writes
        the real PID/state files (~/.pcc-node.pid, ~/.pcc-node-state.json)
        at the very top before any mock takes effect, and (since the loop
        exits via KeyboardInterrupt, bypassing the clean-shutdown removal
        at the bottom of run_daemon) never cleans them up itself."""
        from pcc_node.daemon import PID_FILE, STATE_FILE
        import os
        for f in (PID_FILE, STATE_FILE):
            try:
                os.remove(f)
            except OSError:
                pass
        yield
        for f in (PID_FILE, STATE_FILE):
            try:
                os.remove(f)
            except OSError:
                pass

    @pytest.mark.parametrize("devices", NO_TERMS_DEVICE_LISTS, ids=NO_TERMS_IDS)
    def test_register_sends_no_request(self, devices):
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            summary = announce_capabilities("http://pcc", "key", "k1", devices)
        mock_pcc.assert_not_called()
        assert summary["announced"] == []

    @pytest.mark.parametrize("devices", NO_TERMS_DEVICE_LISTS, ids=NO_TERMS_IDS)
    def test_daemon_periodic_path_only_ever_heartbeats(self, devices):
        from pcc_node import daemon as daemon_module

        with mock.patch.object(daemon_module, "load_or_create_keys", return_value=("pub", "sec")), \
             mock.patch.object(daemon_module, "discover_network", return_value=[]), \
             mock.patch.object(daemon_module, "register_kernel", return_value={}), \
             mock.patch.object(daemon_module, "announce_capabilities") as mock_startup_announce, \
             mock.patch.object(daemon_module, "detect_camera_device", return_value=None), \
             mock.patch("pcc_node.daemon.PCCGatewayClient") as MockClient, \
             mock.patch("pcc_node.daemon.JobExecutor"), \
             mock.patch("pcc_node.daemon.start_ui_server", create=True), \
             mock.patch("pcc_node.daemon.time.time", side_effect=_increasing_clock()):

            mock_client = mock.MagicMock()
            MockClient.return_value = mock_client
            mock_client.send_heartbeat.return_value = True

            poll_count = {"n": 0}

            def fake_poll():
                poll_count["n"] += 1
                if poll_count["n"] == 1:
                    return []
                raise KeyboardInterrupt
            mock_client.poll_for_jobs.side_effect = fake_poll

            config = NodeConfig(
                kernel_id="k-test", pcc_base="http://pcc-test", pcc_api_key="key",
                poll_interval=0, devices=devices,
            )
            try:
                daemon_module.run_daemon(config)
            except (KeyboardInterrupt, SystemExit):
                pass

        # No capability was ever built (no device declared terms), so
        # neither the startup announce nor the client's periodic announce
        # is ever called -- only plain liveness heartbeats.
        mock_startup_announce.assert_not_called()
        mock_client.announce_capabilities.assert_not_called()
        assert mock_client.send_heartbeat.call_count >= 2  # initial + periodic


class TestAnnouncePayloadCarriesExactTerms:
    """For a device that DOES declare terms, every capability in the sent
    payload carries exactly that device's declared tiers (as a sorted,
    deduped set) and pricing (known keys only) -- nothing else, and nothing
    invented (no stray "deviceId" or similar, unlike the old
    _build_capabilities_from_devices-derived payloads)."""

    def test_payload_capability_carries_exactly_the_declared_terms(self):
        device = {
            "id": "printer-1", "type": "octoprint",
            "assuranceTiers": [2, 0, 2, 1],
            "pricing": {"currency": "USDC", "baseCost": "12.50", "minimum": "10", "perMinute": "0.25"},
        }
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {"capabilitiesReceived": 2})
            announce_capabilities("http://pcc", "key", "k1", [device])
        body = mock_pcc.call_args[1]["body"]
        caps = body["capabilities"]
        assert len(caps) == 2  # 3d-print, fdm-fabrication
        for cap in caps:
            assert cap["assuranceTiers"] == [0, 1, 2]  # sorted, deduped
            assert cap["pricing"] == {
                "currency": "USDC", "baseCost": "12.50", "minimum": "10", "perMinute": "0.25",
            }
            assert set(cap.keys()) == {"type", "assuranceTiers", "pricing"}


# ---------------------------------------------------------------------------
# 6. Signature -- with PyNaCl, verifies over canonical JSON of {kernelId,
#    capabilities (with terms), timestamp} taken from the sent request body.
# ---------------------------------------------------------------------------

class TestSignatureCoversTerms:
    @pytest.mark.skipif(not _HAS_NACL, reason="pynacl required")
    def test_signature_verifies_over_capabilities_with_terms(self):
        import nacl.signing

        seed = "ab" * 32
        verify_key = nacl.signing.SigningKey(bytes.fromhex(seed)).verify_key
        device = {"id": "printer-1", "type": "octoprint", **_terms([0, 1])}
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (200, {})
            announce_capabilities("http://pcc", "key", "k1", [device], secret_key=seed)
        body = mock_pcc.call_args[1]["body"]
        rebuilt = {
            "kernelId": "k1",
            "capabilities": body["capabilities"],
            "timestamp": body["timestamp"],
        }
        message = json.dumps(rebuilt, sort_keys=True, separators=(",", ":")).encode("utf-8")
        verify_key.verify(message, bytes.fromhex(body["signature"]))
        # The terms are IN the signed content, not just the bare type slug.
        assert body["capabilities"][0]["pricing"]["baseCost"] == "5"
        assert body["capabilities"][0]["assuranceTiers"] == [0, 1]


# ---------------------------------------------------------------------------
# 7. merge_detected_devices
# ---------------------------------------------------------------------------

class TestMergeDetectedDevices:
    def test_configured_entries_kept_whole_even_when_not_detected(self):
        configured = [{"id": "printer-1", "type": "octoprint", "url": "http://10.0.0.5:5000", **_terms([0])}]
        merged = merge_detected_devices(configured, [])
        assert merged == configured
        assert merged[0]["assuranceTiers"] == [0]

    def test_detected_device_matching_by_id_is_not_duplicated(self):
        configured = [{"id": "printer-1", "type": "octoprint", **_terms([0])}]
        detected = [{"id": "printer-1", "type": "octoprint", "url": "http://10.0.0.5:5000"}]
        merged = merge_detected_devices(configured, detected)
        assert len(merged) == 1
        assert merged[0]["assuranceTiers"] == [0]  # the configured entry wins, terms intact

    def test_detected_device_matching_by_url_is_not_duplicated(self):
        configured = [{"url": "http://10.0.0.5:5000", "type": "octoprint"}]
        detected = [{"url": "http://10.0.0.5:5000", "type": "octoprint", "name": "different-name"}]
        merged = merge_detected_devices(configured, detected)
        assert len(merged) == 1

    def test_detected_device_matching_by_host_is_not_duplicated(self):
        configured = [{"host": "10.0.0.5", "type": "generic"}]
        detected = [{"host": "10.0.0.5", "type": "generic", "port": 80}]
        merged = merge_detected_devices(configured, detected)
        assert len(merged) == 1

    def test_a_genuinely_new_detected_device_is_appended(self):
        configured = [{"id": "printer-1", "type": "octoprint"}]
        detected = [{"id": "cam-1", "type": "camera", "path": "/dev/video0"}]
        merged = merge_detected_devices(configured, detected)
        assert len(merged) == 2
        assert merged[1] == detected[0]

    def test_returns_a_new_list_the_configured_list_itself_is_untouched(self):
        configured = [{"id": "printer-1", "type": "octoprint"}]
        merge_detected_devices(configured, [{"id": "cam-1", "type": "camera"}])
        assert len(configured) == 1  # merge_detected_devices never appends in place


# ---------------------------------------------------------------------------
# 8. load_config rejects a malformed declaration
# ---------------------------------------------------------------------------

class TestLoadConfigRejectsMalformedDeclarations:
    def test_raises_naming_the_device(self, tmp_path):
        path = tmp_path / "bad-config.json"
        path.write_text(json.dumps({
            "kernel_id": "k1", "kernel_name": "bad",
            "devices": [{"id": "printer-1", "type": "octoprint", "assuranceTiers": [0]}],  # no pricing
        }))
        with pytest.raises(DeclaredTermsError) as exc:
            load_config(str(path))
        assert "printer-1" in str(exc.value)

    def test_cli_start_exits_nonzero_and_leaves_the_file_byte_identical(self, tmp_path):
        config_path = tmp_path / "node-config.json"
        original_bytes = json.dumps({
            "kernel_id": "k1", "kernel_name": "bad",
            "devices": [{"id": "printer-1", "type": "octoprint", "assuranceTiers": [0]}],
        }, indent=2).encode("utf-8")
        config_path.write_bytes(original_bytes)

        runner = CliRunner()
        with mock.patch("pcc_node.cli.is_running", return_value=(False, None)):
            result = runner.invoke(main, ["start", "-c", str(config_path)])

        assert result.exit_code != 0
        assert "printer-1" in result.output
        assert config_path.read_bytes() == original_bytes


# ---------------------------------------------------------------------------
# 9. register_kernel / register_devices never leak devices, pricing or
#    credentials.
# ---------------------------------------------------------------------------

class TestRegisterNeverLeaksSecrets:
    def test_register_kernel_payload_has_no_devices_or_pricing(self):
        cfg = NodeConfig(
            kernel_id="k1", kernel_name="test",
            devices=[{"id": "d1", "type": "octoprint", "api_key": "OCTO-SECRET"}],
        )
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (201, {"id": "k1"})
            register_kernel("http://pcc", "key", cfg)
        body = mock_pcc.call_args[1]["body"]
        assert "devices" not in body
        assert "pricing" not in body
        assert "OCTO-SECRET" not in repr(body)

    def test_register_devices_never_sends_api_key_snake_case(self):
        devices = [{"id": "d1", "type": "octoprint", "url": "http://10.0.0.5:5000", "api_key": "OCTO-SECRET"}]
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (201, {"id": "d1"})
            register_devices("http://pcc", "key", "k1", devices)
        body = mock_pcc.call_args[1]["body"]
        assert "api_key" not in body["adapterConfig"]
        assert "OCTO-SECRET" not in repr(body)

    def test_register_devices_never_sends_apiKey_camel_case(self):
        devices = [{"id": "d1", "type": "octoprint", "url": "http://10.0.0.5:5000", "apiKey": "OCTO-SECRET"}]
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (201, {"id": "d1"})
            register_devices("http://pcc", "key", "k1", devices)
        body = mock_pcc.call_args[1]["body"]
        assert "apiKey" not in body["adapterConfig"]
        assert "OCTO-SECRET" not in repr(body)

    def test_register_devices_drops_a_url_carrying_user_info(self):
        devices = [{"id": "d1", "type": "octoprint", "url": "http://user:OCTO-SECRET@10.0.0.5:5000"}]
        with mock.patch("pcc_node.register.pcc_request") as mock_pcc:
            mock_pcc.return_value = (201, {"id": "d1"})
            register_devices("http://pcc", "key", "k1", devices)
        body = mock_pcc.call_args[1]["body"]
        assert "url" not in body["adapterConfig"]
        assert "OCTO-SECRET" not in repr(body)


# ---------------------------------------------------------------------------
# 10a. ws_client: capabilities_skipped is set from the gateway's answer and
#      each entry is logged.
# ---------------------------------------------------------------------------

class TestWsClientCapabilitiesSkipped:
    def test_capabilities_skipped_is_set_from_the_answer_and_logged(self, caplog):
        client = PCCGatewayClient(gateway_url="http://pcc-test", api_key="k", kernel_id="k1")
        answer = {
            "acknowledged": True,
            "capabilitiesSkipped": [{"type": "3d-print", "reason": "zero-price"}],
        }
        with mock.patch("pcc_node.ws_client._http") as mock_h, caplog.at_level("WARNING"):
            mock_h.return_value = (200, answer)
            client.announce_capabilities([{"type": "3d-print", **_terms([0])}])
        assert client.capabilities_skipped == [{"type": "3d-print", "reason": "zero-price"}]
        assert "3d-print" in caplog.text
        assert "zero-price" in caplog.text

    def test_no_skipped_entries_when_the_answer_has_none(self):
        client = PCCGatewayClient(gateway_url="http://pcc-test", api_key="k", kernel_id="k1")
        with mock.patch("pcc_node.ws_client._http") as mock_h:
            mock_h.return_value = (200, {"acknowledged": True})
            client.announce_capabilities([{"type": "3d-print", **_terms([0])}])
        assert client.capabilities_skipped == []


# ---------------------------------------------------------------------------
# 10b. cli status prints the announcement lines from a state file.
# ---------------------------------------------------------------------------

class TestCliStatusPrintsAnnouncement:
    def _state(self, **announcement):
        return {
            "kernel_id": "kernel-abc123",
            "started_at": time.time() - 60,
            "jobs_completed": 0,
            "camera_device": "",
            "pcc_base": "https://capability.network",
            "announcement": announcement,
        }

    def test_prints_announced_not_announced_and_skipped(self):
        runner = CliRunner()
        state = self._state(
            announced=["3d-print"],
            notAnnounced=[{"device": "cam-1", "reason": "this node executes no capability on protocol 'camera'"}],
            skipped=[{"type": "3d-print", "reason": "zero-price"}],
        )
        with mock.patch("pcc_node.cli.is_running", return_value=(True, 123)), \
             mock.patch("pcc_node.cli.read_state", return_value=state):
            result = runner.invoke(main, ["status"])
        assert result.exit_code == 0
        assert "Announced: 3d-print" in result.output
        assert "not announced: cam-1: this node executes no capability on protocol 'camera'" in result.output
        assert "refused by the gateway: 3d-print: zero-price" in result.output
        assert "the gateway keeps a capability's terms from its first announcement" in result.output

    def test_prints_nothing_announced_when_announcement_is_empty(self):
        runner = CliRunner()
        state = self._state()
        with mock.patch("pcc_node.cli.is_running", return_value=(True, 1)), \
             mock.patch("pcc_node.cli.read_state", return_value=state):
            result = runner.invoke(main, ["status"])
        assert result.exit_code == 0
        assert "Announced: nothing" in result.output
        assert "refused by the gateway" not in result.output
        assert "not announced:" not in result.output
