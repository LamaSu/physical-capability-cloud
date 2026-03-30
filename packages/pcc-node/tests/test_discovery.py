"""Tests for network device discovery (all mocked -- no real network calls)."""

import ipaddress
import socket
from unittest import mock

import pytest

from pcc_node.discovery import (
    DiscoveredDevice,
    discover_network,
    fingerprint_device,
    format_discovery_report,
    get_local_subnet,
    scan_host,
    device_to_adapter_config,
    _parse_arp_table,
    _port_open,
    KNOWN_PORTS,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_device(ip="192.168.1.10", ports=None, protocol="unknown", device_type="unknown",
                 confidence=0.1, hostname=None, mac=None, details=None):
    return DiscoveredDevice(
        ip=ip,
        hostname=hostname,
        mac=mac,
        open_ports=ports or [],
        protocol=protocol,
        device_type=device_type,
        confidence=confidence,
        details=details or {},
    )


# ---------------------------------------------------------------------------
# get_local_subnet
# ---------------------------------------------------------------------------

class TestGetLocalSubnet:
    def test_returns_cidr_string(self):
        """Returns a valid CIDR notation string."""
        with mock.patch("socket.socket") as mock_sock_cls:
            mock_sock = mock.MagicMock()
            mock_sock.__enter__ = lambda s: s
            mock_sock.__exit__ = mock.Mock(return_value=False)
            mock_sock.getsockname.return_value = ("192.168.1.42", 0)
            mock_sock_cls.return_value = mock_sock

            result = get_local_subnet()

        # Must be parseable as a network
        net = ipaddress.IPv4Network(result, strict=False)
        assert net.prefixlen == 24
        assert result.endswith("/24")

    def test_falls_back_on_error(self):
        """Returns a fallback subnet when socket fails."""
        with mock.patch("socket.socket", side_effect=OSError("no route")):
            result = get_local_subnet()

        # Must still be valid CIDR
        ipaddress.IPv4Network(result, strict=False)
        assert "/24" in result

    def test_derives_correct_subnet(self):
        """Derives /24 network from the local IP correctly."""
        with mock.patch("socket.socket") as mock_sock_cls:
            mock_sock = mock.MagicMock()
            mock_sock.__enter__ = lambda s: s
            mock_sock.__exit__ = mock.Mock(return_value=False)
            mock_sock.getsockname.return_value = ("10.0.0.55", 0)
            mock_sock_cls.return_value = mock_sock

            result = get_local_subnet()

        assert result == "10.0.0.0/24"


# ---------------------------------------------------------------------------
# _port_open
# ---------------------------------------------------------------------------

class TestPortOpen:
    def test_open_port(self):
        """connect_ex returning 0 means port is open."""
        with mock.patch("socket.socket") as mock_sock_cls:
            mock_sock = mock.MagicMock()
            mock_sock.__enter__ = lambda s: s
            mock_sock.__exit__ = mock.Mock(return_value=False)
            mock_sock.connect_ex.return_value = 0
            mock_sock_cls.return_value = mock_sock

            assert _port_open("192.168.1.1", 80, 0.5) is True

    def test_closed_port(self):
        """connect_ex returning non-zero means port is closed."""
        with mock.patch("socket.socket") as mock_sock_cls:
            mock_sock = mock.MagicMock()
            mock_sock.__enter__ = lambda s: s
            mock_sock.__exit__ = mock.Mock(return_value=False)
            mock_sock.connect_ex.return_value = 111  # ECONNREFUSED
            mock_sock_cls.return_value = mock_sock

            assert _port_open("192.168.1.1", 80, 0.5) is False

    def test_os_error_returns_false(self):
        """OSError during connect means port unreachable."""
        with mock.patch("socket.socket", side_effect=OSError):
            assert _port_open("192.168.1.1", 80, 0.5) is False


# ---------------------------------------------------------------------------
# scan_host
# ---------------------------------------------------------------------------

class TestScanHost:
    def test_returns_none_when_no_ports_open(self):
        """Returns None when no known ports respond."""
        with mock.patch("pcc_node.discovery._port_open", return_value=False), \
             mock.patch("pcc_node.discovery._get_arp_cache", return_value={}):
            result = scan_host("192.168.1.100", timeout=0.1)

        assert result is None

    def test_returns_device_when_port_open(self):
        """Returns DiscoveredDevice when at least one port responds."""
        def fake_port_open(ip, port, timeout):
            return port == 31950

        with mock.patch("pcc_node.discovery._port_open", side_effect=fake_port_open), \
             mock.patch("pcc_node.discovery._resolve_hostname", return_value="ot2.local"), \
             mock.patch("pcc_node.discovery._get_arp_cache", return_value={"192.168.1.50": "aa:bb:cc:dd:ee:ff"}):
            result = scan_host("192.168.1.50", timeout=0.1)

        assert result is not None
        assert result.ip == "192.168.1.50"
        assert 31950 in result.open_ports
        assert result.hostname == "ot2.local"
        assert result.mac == "aa:bb:cc:dd:ee:ff"

    def test_protocol_hint_from_port(self):
        """Protocol is inferred from the first recognized open port."""
        def fake_port_open(ip, port, timeout):
            return port == 502

        with mock.patch("pcc_node.discovery._port_open", side_effect=fake_port_open), \
             mock.patch("pcc_node.discovery._resolve_hostname", return_value=None), \
             mock.patch("pcc_node.discovery._get_arp_cache", return_value={}):
            result = scan_host("10.0.0.5", timeout=0.1)

        assert result is not None
        assert result.protocol == "modbus"
        assert result.device_type == "plc"

    def test_multiple_open_ports(self):
        """All open ports are recorded."""
        def fake_port_open(ip, port, timeout):
            return port in (80, 443)

        with mock.patch("pcc_node.discovery._port_open", side_effect=fake_port_open), \
             mock.patch("pcc_node.discovery._resolve_hostname", return_value=None), \
             mock.patch("pcc_node.discovery._get_arp_cache", return_value={}):
            result = scan_host("10.0.0.6", timeout=0.1)

        assert result is not None
        assert 80 in result.open_ports
        assert 443 in result.open_ports


# ---------------------------------------------------------------------------
# fingerprint_device
# ---------------------------------------------------------------------------

class TestFingerprintDevice:
    def test_opentrons_health_response(self):
        """Recognises Opentrons via /health endpoint."""
        device = _make_device(ip="192.168.1.50", ports=[31950])

        with mock.patch("pcc_node.discovery.http") as mock_http:
            mock_http.return_value = (200, {
                "name": "falling-bush",
                "api_version": "8.8.1",
                "fw_version": "2.19.0",
                "robot_model": "OT-2 Standard",
            })
            result = fingerprint_device(device)

        assert result.protocol == "opentrons"
        assert result.device_type == "liquid-handler"
        assert result.confidence == 0.95
        assert result.details["name"] == "falling-bush"

    def test_opentrons_port_open_but_no_json(self):
        """Port 31950 open but /health returns garbage → lower confidence."""
        device = _make_device(ip="192.168.1.51", ports=[31950])

        with mock.patch("pcc_node.discovery.http") as mock_http:
            mock_http.return_value = (0, {"error": "refused"})
            result = fingerprint_device(device)

        assert result.protocol == "opentrons"
        assert result.confidence == 0.5

    def test_octoprint_via_api_version(self):
        """Recognises OctoPrint via /api/version response."""
        device = _make_device(ip="192.168.1.60", ports=[5000])

        with mock.patch("pcc_node.discovery.http") as mock_http:
            mock_http.return_value = (200, {
                "server": "1.10.0",
                "api": "0.1",
                "text": "OctoPrint 1.10.0",
            })
            result = fingerprint_device(device)

        assert result.protocol == "octoprint"
        assert result.device_type == "3d-printer"
        assert result.confidence == 0.9
        assert result.details["server"] == "1.10.0"

    def test_octoprint_fallback_to_connection_endpoint(self):
        """Falls back to /api/connection if /api/version fails."""
        device = _make_device(ip="192.168.1.61", ports=[5000])

        call_count = [0]

        def fake_http(method, url, **kwargs):
            call_count[0] += 1
            if "/api/version" in url:
                return (404, "not found")
            if "/api/connection" in url:
                return (200, {"current": {"state": "Closed"}})
            return (0, {})

        with mock.patch("pcc_node.discovery.http", side_effect=fake_http):
            result = fingerprint_device(device)

        assert result.protocol == "octoprint"
        assert result.device_type == "3d-printer"

    def test_modbus_port_open(self):
        """Port 502 open → modbus/plc with medium confidence."""
        device = _make_device(ip="10.0.0.5", ports=[502])
        result = fingerprint_device(device)

        assert result.protocol == "modbus"
        assert result.device_type == "plc"
        assert result.confidence == 0.6

    def test_ipp_port_open(self):
        """Port 631 open → IPP printer."""
        device = _make_device(ip="10.0.0.20", ports=[631])
        result = fingerprint_device(device)

        assert result.protocol == "ipp"
        assert result.device_type == "printer"
        assert result.confidence == 0.7

    def test_opcua_port_open(self):
        """Port 4840 open → OPC-UA / CNC."""
        device = _make_device(ip="10.0.0.30", ports=[4840])
        result = fingerprint_device(device)

        assert result.protocol == "opcua"
        assert result.device_type == "cnc"
        assert result.confidence == 0.6

    def test_generic_http_fallback(self):
        """Only port 80 open → generic HTTP, low confidence."""
        device = _make_device(ip="10.0.0.99", ports=[80])

        with mock.patch("pcc_node.discovery.http") as mock_http:
            mock_http.return_value = (200, "<html>Some device</html>")
            result = fingerprint_device(device)

        assert result.protocol == "http"
        assert result.device_type == "unknown"
        assert result.confidence == 0.3

    def test_no_known_ports_unknown(self):
        """No recognized ports → unknown."""
        # Use a port not in KNOWN_PORTS that won't trigger any probe
        device = _make_device(ip="10.0.0.77", ports=[9999])
        # No http calls should be made for unknown ports
        result = fingerprint_device(device)

        assert result.protocol == "unknown"
        assert result.device_type == "unknown"
        assert result.confidence == 0.1


# ---------------------------------------------------------------------------
# discover_network
# ---------------------------------------------------------------------------

class TestDiscoverNetwork:
    def test_returns_empty_for_no_live_hosts(self):
        """Returns [] when no hosts respond."""
        with mock.patch("pcc_node.discovery.scan_host", return_value=None), \
             mock.patch("pcc_node.discovery.get_local_subnet", return_value="10.0.0.0/30"):
            result = discover_network()

        assert result == []

    def test_scans_all_hosts_in_subnet(self):
        """Every host in the subnet is scanned."""
        scanned = []

        def fake_scan(ip, timeout):
            scanned.append(ip)
            return None

        with mock.patch("pcc_node.discovery.scan_host", side_effect=fake_scan), \
             mock.patch("pcc_node.discovery.get_local_subnet", return_value="10.0.0.0/30"):
            discover_network()

        # /30 has 2 host addresses: 10.0.0.1 and 10.0.0.2
        assert "10.0.0.1" in scanned
        assert "10.0.0.2" in scanned

    def test_returns_fingerprinted_devices(self):
        """Devices returned from scan_host are fingerprinted."""
        raw = _make_device(ip="192.168.1.50", ports=[31950])
        fingerprinted = _make_device(
            ip="192.168.1.50", ports=[31950],
            protocol="opentrons", device_type="liquid-handler",
            confidence=0.95, details={"name": "ot2"},
        )

        with mock.patch("pcc_node.discovery.scan_host", return_value=raw), \
             mock.patch("pcc_node.discovery.fingerprint_device", return_value=fingerprinted), \
             mock.patch("pcc_node.discovery.get_local_subnet", return_value="192.168.1.0/30"):
            result = discover_network()

        assert len(result) >= 1
        assert result[0].protocol == "opentrons"
        assert result[0].confidence == 0.95

    def test_accepts_explicit_subnet(self):
        """Accepts a caller-supplied subnet without calling get_local_subnet."""
        with mock.patch("pcc_node.discovery.scan_host", return_value=None) as mock_scan, \
             mock.patch("pcc_node.discovery.get_local_subnet") as mock_subnet:
            discover_network(subnet="172.16.0.0/30")

        mock_subnet.assert_not_called()

    def test_sorted_by_confidence_descending(self):
        """Result list is sorted by confidence, highest first."""
        low = _make_device(ip="10.0.0.1", confidence=0.3)
        high = _make_device(ip="10.0.0.2", confidence=0.9)

        scan_results = {"10.0.0.1": low, "10.0.0.2": high}

        def fake_scan(ip, timeout):
            return scan_results.get(ip)

        with mock.patch("pcc_node.discovery.scan_host", side_effect=fake_scan), \
             mock.patch("pcc_node.discovery.fingerprint_device", side_effect=lambda d: d), \
             mock.patch("pcc_node.discovery.get_local_subnet", return_value="10.0.0.0/30"):
            result = discover_network()

        assert result[0].confidence >= result[-1].confidence

    def test_invalid_subnet_returns_empty(self):
        """An invalid subnet string returns an empty list without crashing."""
        result = discover_network(subnet="not-a-subnet")
        assert result == []


# ---------------------------------------------------------------------------
# format_discovery_report
# ---------------------------------------------------------------------------

class TestFormatDiscoveryReport:
    def test_empty_list(self):
        """Empty device list produces a 'no devices' message."""
        report = format_discovery_report([])
        assert "No devices" in report

    def test_single_device(self):
        """Report contains IP, device type, and confidence."""
        device = _make_device(
            ip="192.168.1.50",
            ports=[31950],
            protocol="opentrons",
            device_type="liquid-handler",
            confidence=0.95,
            hostname="ot2.local",
        )
        report = format_discovery_report([device])

        assert "192.168.1.50" in report
        assert "liquid-handler" in report
        assert "opentrons" in report
        assert "95%" in report
        assert "ot2.local" in report

    def test_multiple_devices_numbered(self):
        """Each device gets an index number."""
        devices = [
            _make_device(ip="10.0.0.1", confidence=0.9),
            _make_device(ip="10.0.0.2", confidence=0.3),
        ]
        report = format_discovery_report(devices)

        assert "[1]" in report
        assert "[2]" in report
        assert "10.0.0.1" in report
        assert "10.0.0.2" in report

    def test_mac_shown_when_available(self):
        """MAC address is included when known."""
        device = _make_device(ip="10.0.0.5", mac="aa:bb:cc:dd:ee:ff")
        report = format_discovery_report([device])
        assert "aa:bb:cc:dd:ee:ff" in report

    def test_detail_fields_shown(self):
        """Protocol-specific details are shown in the report."""
        device = _make_device(
            ip="192.168.1.60",
            protocol="octoprint",
            device_type="3d-printer",
            confidence=0.9,
            details={"server": "1.10.0", "url": "http://192.168.1.60:5000"},
        )
        report = format_discovery_report([device])
        assert "server=1.10.0" in report

    def test_open_ports_listed(self):
        """Open ports are shown in the report."""
        device = _make_device(ip="10.0.0.7", ports=[80, 443])
        report = format_discovery_report([device])
        assert "80" in report
        assert "443" in report


# ---------------------------------------------------------------------------
# device_to_adapter_config
# ---------------------------------------------------------------------------

class TestDeviceToAdapterConfig:
    def test_opentrons_config(self):
        device = _make_device(
            ip="192.168.1.50",
            protocol="opentrons",
            device_type="liquid-handler",
            confidence=0.95,
            details={"name": "ot2", "api_version": "8.8.1", "fw_version": "2.19", "robot_model": "OT-2 Standard"},
        )
        cfg = device_to_adapter_config(device)

        assert cfg is not None
        assert cfg["type"] == "opentrons"
        assert cfg["url"] == "http://192.168.1.50:31950"
        assert cfg["name"] == "ot2"

    def test_octoprint_config(self):
        device = _make_device(
            ip="192.168.1.60",
            protocol="octoprint",
            device_type="3d-printer",
            confidence=0.9,
            details={"url": "http://192.168.1.60:5000", "server": "1.10.0"},
        )
        cfg = device_to_adapter_config(device)

        assert cfg is not None
        assert cfg["type"] == "octoprint"
        assert cfg["url"] == "http://192.168.1.60:5000"

    def test_modbus_config(self):
        device = _make_device(
            ip="10.0.0.5",
            protocol="modbus",
            device_type="plc",
            confidence=0.6,
        )
        cfg = device_to_adapter_config(device)

        assert cfg is not None
        assert cfg["type"] == "modbus"
        assert cfg["host"] == "10.0.0.5"
        assert cfg["port"] == 502

    def test_ipp_config(self):
        device = _make_device(
            ip="10.0.0.20",
            protocol="ipp",
            device_type="printer",
            confidence=0.7,
        )
        cfg = device_to_adapter_config(device)

        assert cfg is not None
        assert cfg["type"] == "printer"
        assert cfg["host"] == "10.0.0.20"

    def test_opcua_config(self):
        device = _make_device(
            ip="10.0.0.30",
            protocol="opcua",
            device_type="cnc",
            confidence=0.6,
        )
        cfg = device_to_adapter_config(device)

        assert cfg is not None
        assert cfg["type"] == "opcua"
        assert "opc.tcp://10.0.0.30:4840" in cfg["endpoint"]

    def test_low_confidence_returns_none(self):
        """Devices with confidence < 0.5 produce no config."""
        device = _make_device(
            ip="10.0.0.99",
            protocol="http",
            device_type="unknown",
            confidence=0.3,
        )
        assert device_to_adapter_config(device) is None

    def test_unknown_device_type_returns_none(self):
        """Unknown device type → no adapter config."""
        device = _make_device(
            ip="10.0.0.88",
            protocol="unknown",
            device_type="unknown",
            confidence=0.8,
        )
        assert device_to_adapter_config(device) is None


# ---------------------------------------------------------------------------
# CLI discover command
# ---------------------------------------------------------------------------

class TestDiscoverCommand:
    def test_discover_no_devices(self):
        """discover command with no results prints a no-devices message."""
        from click.testing import CliRunner
        from pcc_node.cli import main

        runner = CliRunner()
        with mock.patch("pcc_node.cli.discover_network", return_value=[]):
            result = runner.invoke(main, ["discover"])

        assert result.exit_code == 0
        assert "No devices" in result.output

    def test_discover_with_devices(self):
        """discover command displays found devices."""
        from click.testing import CliRunner
        from pcc_node.cli import main

        runner = CliRunner()
        devices = [
            _make_device(
                ip="192.168.1.50",
                ports=[31950],
                protocol="opentrons",
                device_type="liquid-handler",
                confidence=0.95,
            )
        ]
        with mock.patch("pcc_node.cli.discover_network", return_value=devices):
            result = runner.invoke(main, ["discover"])

        assert result.exit_code == 0
        assert "192.168.1.50" in result.output

    def test_discover_subnet_flag(self):
        """--subnet flag is passed through to discover_network."""
        from click.testing import CliRunner
        from pcc_node.cli import main

        runner = CliRunner()
        with mock.patch("pcc_node.cli.discover_network", return_value=[]) as mock_disc:
            runner.invoke(main, ["discover", "--subnet", "10.0.0.0/24"])

        mock_disc.assert_called_once_with(subnet="10.0.0.0/24")

    def test_discover_register_flag(self):
        """--register flag triggers registration of compatible devices."""
        from click.testing import CliRunner
        from pcc_node.cli import main

        runner = CliRunner()
        devices = [
            _make_device(
                ip="192.168.1.50",
                ports=[31950],
                protocol="opentrons",
                device_type="liquid-handler",
                confidence=0.95,
                details={"name": "ot2", "api_version": "8", "fw_version": "2", "robot_model": "OT-2"},
            )
        ]
        with mock.patch("pcc_node.cli.discover_network", return_value=devices), \
             mock.patch("pcc_node.cli.register_kernel") as mock_reg, \
             mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)):
            result = runner.invoke(main, ["discover", "--register", "--api-key", "test-key"])

        assert result.exit_code == 0
        assert "registered" in result.output
        mock_reg.assert_called_once()

    def test_start_with_discover_flag(self):
        """start --discover runs discovery before hardware detection."""
        from click.testing import CliRunner
        from pcc_node.cli import main
        import tempfile, os

        runner = CliRunner()
        with tempfile.TemporaryDirectory() as tmp:
            config_path = os.path.join(tmp, "node-config.json")

            with mock.patch("pcc_node.cli.is_running", return_value=(False, None)), \
                 mock.patch("pcc_node.cli.discover_network", return_value=[]) as mock_disc, \
                 mock.patch("pcc_node.cli.detect_all", return_value=[]), \
                 mock.patch("pcc_node.cli.load_or_create_keys", return_value=("ab" * 16, "cd" * 16)), \
                 mock.patch("pcc_node.cli.provision_api_key", return_value="test-key"), \
                 mock.patch("pcc_node.cli.register_kernel", return_value={"ok": True}), \
                 mock.patch("pcc_node.cli.announce_capabilities"), \
                 mock.patch("pcc_node.cli.run_daemon"):
                result = runner.invoke(
                    main,
                    ["start", "-c", config_path, "--api-key", "k", "--discover"],
                )

            assert result.exit_code == 0
            assert "Scanning network" in result.output
            mock_disc.assert_called_once()
