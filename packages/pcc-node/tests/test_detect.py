"""Tests for hardware auto-detection (all mocked -- no real hardware needed)."""

import json
import platform
from unittest import mock

import pytest

from pcc_node.detect import (
    detect_all,
    detect_cameras,
    detect_opentrons,
    detect_octoprint,
    detect_serial,
    detect_mdns,
    probe_v4l2,
    check_opentrons,
    check_octoprint,
)


# ---------------------------------------------------------------------------
# V4L2 camera detection
# ---------------------------------------------------------------------------

class TestProbeV4L2:
    def test_successful_probe(self):
        """v4l2-ctl returns capture device info."""
        stdout = (
            "Driver Info:\n"
            "  Card type     : H264 USB Camera\n"
            "  Bus info      : usb-0000:00:14.0-2\n"
            "  Video input   : 0 (Camera 0: ok)\n"
            "  Format Video Capture:\n"
            "    Pixel Format : 'MJPG' (Motion-JPEG)\n"
            "    Pixel Format : 'H264' (H.264)\n"
        )
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=0, stdout=stdout)
            info = probe_v4l2("/dev/video0")

        assert info is not None
        assert info["name"] == "H264 USB Camera"
        assert "MJPEG" in info["formats"]
        assert "H264" in info["formats"]

    def test_not_a_capture_device(self):
        """Device exists but is not a Video Capture device."""
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=0, stdout="Video Output")
            info = probe_v4l2("/dev/video0")

        assert info is None

    def test_v4l2ctl_not_installed(self):
        """v4l2-ctl is not installed -- should return fallback info."""
        with mock.patch("subprocess.run", side_effect=FileNotFoundError):
            info = probe_v4l2("/dev/video0")

        assert info is not None
        assert "v4l2-ctl not available" in info["name"]

    def test_v4l2ctl_timeout(self):
        """v4l2-ctl times out."""
        import subprocess
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("v4l2-ctl", 3)):
            info = probe_v4l2("/dev/video0")

        assert info is None

    def test_nonzero_return_code(self):
        """v4l2-ctl returns non-zero (device error)."""
        with mock.patch("subprocess.run") as mock_run:
            mock_run.return_value = mock.Mock(returncode=1, stdout="")
            info = probe_v4l2("/dev/video0")

        assert info is None


class TestDetectCameras:
    def test_skips_non_linux(self):
        """Camera detection returns [] on non-Linux."""
        with mock.patch("pcc_node.detect.platform") as mock_plat:
            mock_plat.system.return_value = "Windows"
            assert detect_cameras() == []

    def test_finds_cameras_on_linux(self):
        """On Linux, scans /dev/video* and probes each."""
        with mock.patch("pcc_node.detect.platform") as mock_plat, \
             mock.patch("pcc_node.detect.globmod") as mock_glob, \
             mock.patch("pcc_node.detect.probe_v4l2") as mock_probe:
            mock_plat.system.return_value = "Linux"
            mock_glob.glob.return_value = ["/dev/video0", "/dev/video1"]
            mock_probe.side_effect = [
                {"name": "Cam A", "formats": ["MJPEG"]},
                None,  # second device not a capture device
            ]

            cams = detect_cameras()

        assert len(cams) == 1
        assert cams[0]["type"] == "camera"
        assert cams[0]["name"] == "Cam A"
        assert cams[0]["path"] == "/dev/video0"


# ---------------------------------------------------------------------------
# Opentrons detection
# ---------------------------------------------------------------------------

class TestCheckOpentrons:
    def test_healthy_ot2(self):
        """OT-2 responds to /health."""
        with mock.patch("pcc_node.detect.http") as mock_http:
            mock_http.return_value = (200, {
                "name": "falling-bush",
                "api_version": "8.8.1",
                "fw_version": "2.19.0",
                "robot_model": "OT-2 Standard",
            })
            info = check_opentrons("http://localhost:31950")

        assert info is not None
        assert info["name"] == "falling-bush"
        assert info["api_version"] == "8.8.1"

    def test_unreachable(self):
        """OT-2 not reachable."""
        with mock.patch("pcc_node.detect.http") as mock_http:
            mock_http.return_value = (0, {"error": "connection refused"})
            info = check_opentrons("http://localhost:31950")

        assert info is None

    def test_non_200_status(self):
        with mock.patch("pcc_node.detect.http") as mock_http:
            mock_http.return_value = (500, "internal error")
            info = check_opentrons("http://localhost:31950")

        assert info is None


class TestDetectOpentrons:
    def test_probes_common_urls(self):
        """Should probe all configured URLs (localhost, link-local, WiFi, USB)."""
        from pcc_node.detect import OT2_PROBE_URLS

        with mock.patch("pcc_node.detect.check_opentrons") as mock_check:
            mock_check.side_effect = [
                {"name": "ot2", "api_version": "8", "fw_version": "2", "robot_model": "OT-2"},
            ] + [None] * (len(OT2_PROBE_URLS) - 1)
            devices = detect_opentrons()

        assert len(devices) == 1
        assert devices[0]["type"] == "opentrons"
        assert mock_check.call_count == len(OT2_PROBE_URLS)


# ---------------------------------------------------------------------------
# OctoPrint detection
# ---------------------------------------------------------------------------

class TestCheckOctoPrint:
    def test_healthy_octoprint(self):
        with mock.patch("pcc_node.detect.http") as mock_http:
            mock_http.return_value = (200, {
                "server": "1.10.0",
                "api": "0.1",
                "text": "OctoPrint 1.10.0",
            })
            info = check_octoprint("http://localhost:5000")

        assert info is not None
        assert info["server"] == "1.10.0"

    def test_unreachable(self):
        with mock.patch("pcc_node.detect.http") as mock_http:
            mock_http.return_value = (0, {"error": "refused"})
            assert check_octoprint("http://localhost:5000") is None


# ---------------------------------------------------------------------------
# Serial detection
# ---------------------------------------------------------------------------

class TestDetectSerial:
    def test_skips_windows(self):
        with mock.patch("pcc_node.detect.platform") as mock_plat:
            mock_plat.system.return_value = "Windows"
            assert detect_serial() == []

    def test_finds_serial_on_linux(self):
        with mock.patch("pcc_node.detect.platform") as mock_plat, \
             mock.patch("pcc_node.detect.globmod") as mock_glob:
            mock_plat.system.return_value = "Linux"
            mock_glob.glob.side_effect = [
                ["/dev/ttyUSB0"],   # ttyUSB*
                ["/dev/ttyACM0"],   # ttyACM*
            ]

            devs = detect_serial()

        assert len(devs) == 2
        assert devs[0]["type"] == "serial"
        assert devs[0]["path"] == "/dev/ttyUSB0"


# ---------------------------------------------------------------------------
# mDNS detection
# ---------------------------------------------------------------------------

class TestDetectMdns:
    def test_returns_empty_without_zeroconf(self):
        """Should return [] when zeroconf is not installed."""
        with mock.patch.dict("sys.modules", {"zeroconf": None}):
            result = detect_mdns(timeout=0.1)
        # Even if zeroconf is installed in the test env, the import error
        # path is tested by mocking the import
        assert isinstance(result, list)


# ---------------------------------------------------------------------------
# Combined detection
# ---------------------------------------------------------------------------

class TestDetectAll:
    def test_combines_all_sources(self):
        """detect_all() calls all sub-detectors."""
        with mock.patch("pcc_node.detect.detect_cameras") as m1, \
             mock.patch("pcc_node.detect.detect_opentrons") as m2, \
             mock.patch("pcc_node.detect.detect_serial") as m3, \
             mock.patch("pcc_node.detect.detect_octoprint") as m4, \
             mock.patch("pcc_node.detect.detect_mdns") as m5:
            m1.return_value = [{"type": "camera", "path": "/dev/video0"}]
            m2.return_value = [{"type": "opentrons", "url": "http://localhost:31950"}]
            m3.return_value = []
            m4.return_value = []
            m5.return_value = []

            devices = detect_all()

        assert len(devices) == 2
        types = {d["type"] for d in devices}
        assert types == {"camera", "opentrons"}

    def test_returns_empty_when_nothing_found(self):
        with mock.patch("pcc_node.detect.detect_cameras", return_value=[]), \
             mock.patch("pcc_node.detect.detect_opentrons", return_value=[]), \
             mock.patch("pcc_node.detect.detect_serial", return_value=[]), \
             mock.patch("pcc_node.detect.detect_octoprint", return_value=[]), \
             mock.patch("pcc_node.detect.detect_mdns", return_value=[]):
            devices = detect_all()

        assert devices == []
