"""HostDeviceLock: one hold per physical device across processes, keyed by the device's own
identity, and a durable one-shot record per job (astra 554 F1, 565 F1-F2)."""

import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

from pcc_node.operating.devicelock import DeviceLockError, HostDeviceLock, read_device_identity

from tests.operating_identity import IdentityServer


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "device-locks")
        self.device = IdentityServer("PR-0001")
        self.addCleanup(self.device.close)

    def _lock(self, url=None, directory=None):
        lock = HostDeviceLock(url or self.device.url, identity_path="/identity", identity_field="serial",
                              directory=directory or self.dir)
        self.addCleanup(lock.close)
        return lock


class DeviceIdentityTests(_Base):
    def test_the_hold_is_keyed_by_the_identity_the_device_reports(self):
        self.assertEqual(self._lock().identity, "PR-0001")

    def test_two_urls_for_one_device_share_one_hold(self):
        # astra 565 F2's reproduction: localhost and 127.0.0.1 reach the same device.
        by_name = self._lock("http://localhost:%d" % self.device.port)
        by_address = self._lock("http://127.0.0.1:%d" % self.device.port)
        self.assertTrue(by_name.acquire())
        self.assertFalse(by_address.acquire())
        by_name.release()
        self.assertTrue(by_address.acquire())
        by_address.release()

    def test_two_devices_are_held_independently(self):
        other = IdentityServer("PR-0002")
        self.addCleanup(other.close)
        a, b = self._lock(), self._lock(other.url)
        self.assertTrue(a.acquire())
        self.assertTrue(b.acquire())
        a.release()
        b.release()

    def test_a_device_that_now_reports_another_identity_is_refused_inside_the_hold(self):
        lock = self._lock()
        self.device.serial = "PR-9999"  # the URL now reaches another device
        with self.assertRaises(DeviceLockError):
            lock.acquire()
        self.device.serial = "PR-0001"
        self.assertTrue(self._lock().acquire())  # the refused acquire let go of the hold

    def test_a_device_that_cannot_say_who_it_is_has_no_lock(self):
        for setup in (
            lambda d: setattr(d, "status", 500),
            lambda d: setattr(d, "raw", b"not json"),
            lambda d: setattr(d, "raw", b'["PR-0001"]'),
            lambda d: setattr(d, "raw", b'{"serial": true}'),
            lambda d: setattr(d, "raw", b'{"serial": ""}'),
            lambda d: setattr(d, "raw", b'{"serial": "has space"}'),
            lambda d: setattr(d, "raw", b'{"serial": "' + b"x" * 129 + b'"}'),
            lambda d: setattr(d, "raw", b'{"other": "PR-0001"}'),
        ):
            device = IdentityServer("PR-0001")
            self.addCleanup(device.close)
            setup(device)
            with self.assertRaises(DeviceLockError):
                HostDeviceLock(device.url, identity_path="/identity", identity_field="serial", directory=self.dir)

    def test_a_redirect_to_a_device_that_would_answer_is_still_refused(self):
        elsewhere = IdentityServer("PR-ELSEWHERE")
        self.addCleanup(elsewhere.close)
        self.device.redirect_to = elsewhere.url + "/identity"
        with self.assertRaises(DeviceLockError):
            self._lock()
        self.assertEqual(elsewhere.requests, 0)  # the redirect was never followed

    def test_an_unreachable_device_has_no_lock(self):
        with self.assertRaises(DeviceLockError):
            read_device_identity("http://127.0.0.1:9", "/identity", "serial", timeout_s=2)

    def test_the_identity_read_ignores_proxy_settings(self):
        # A fresh process, so the module's opener is built with the proxy already in the
        # environment: a proxy could answer for any device, so it must never be used.
        script = textwrap.dedent(
            """
            import sys
            from pcc_node.operating.devicelock import read_device_identity
            print(read_device_identity(sys.argv[1], "/identity", "serial", timeout_s=3))
            """
        )
        env = {k: v for k, v in os.environ.items() if k.lower() not in ("no_proxy",)}
        env.update(PYTHONDONTWRITEBYTECODE="1", http_proxy="http://127.0.0.1:9", HTTP_PROXY="http://127.0.0.1:9")
        env["PYTHONPATH"] = os.pathsep.join(p for p in sys.path if p)
        done = subprocess.run([sys.executable, "-c", script, self.device.url], capture_output=True, text=True,
                              env=env, timeout=30)
        self.assertEqual((done.returncode, done.stdout.strip()), (0, "PR-0001"), done.stderr[-300:])

    def test_an_integer_identity_is_read_as_its_digits(self):
        self.device.raw = b'{"serial": 12345}'
        self.assertEqual(self._lock().identity, "12345")


class LockDirectoryTests(_Base):
    def test_the_directory_and_its_record_are_created_private(self):
        self._lock()
        for path in (self.dir, os.path.join(self.dir, "consumed")):
            info = os.lstat(path)
            self.assertTrue(stat.S_ISDIR(info.st_mode))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o700)

    def test_a_directory_that_is_not_exactly_0700_is_refused(self):
        for mode in (0o755, 0o750, 0o711, 0o770, 0o1700):
            path = os.path.join(self.tmp.name, "locks-%o" % mode)
            os.mkdir(path)
            os.chmod(path, mode)
            with self.assertRaises(DeviceLockError, msg=oct(mode)):
                self._lock(directory=path)

    def test_a_symlinked_directory_is_refused(self):
        real = os.path.join(self.tmp.name, "real")
        os.mkdir(real, 0o700)
        os.chmod(real, 0o700)
        link = os.path.join(self.tmp.name, "link")
        os.symlink(real, link)
        with self.assertRaises(DeviceLockError):
            self._lock(directory=link)

    def test_a_symlink_planted_at_the_lock_file_is_refused(self):
        lock = self._lock()
        target = os.path.join(self.tmp.name, "elsewhere")
        open(target, "w").close()
        os.symlink(target, os.path.join(self.dir, lock._lock_name))
        with self.assertRaises(DeviceLockError):
            lock.acquire()

    def test_one_hold_per_device(self):
        first, second = self._lock(), self._lock()
        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())
        self.assertFalse(first.acquire())  # one object holds it at most once
        first.release()
        self.assertTrue(second.acquire())
        second.release()

    def test_a_job_is_recorded_once_and_the_record_outlives_the_process_state(self):
        lock = self._lock()
        self.assertTrue(lock.consume("job:1"))
        self.assertFalse(lock.consume("job:1"))
        self.assertTrue(lock.consume("job:2"))
        restarted = self._lock()
        self.assertFalse(restarted.consume("job:1"))

    def test_another_process_holding_the_device_excludes_this_one_until_it_exits(self):
        script = textwrap.dedent(
            """
            import sys, time
            from pcc_node.operating.devicelock import HostDeviceLock
            lock = HostDeviceLock(sys.argv[1], identity_path="/identity", identity_field="serial", directory=sys.argv[2])
            assert lock.acquire()
            print("HELD", flush=True)
            time.sleep(30)
            """
        )
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        env["PYTHONPATH"] = os.pathsep.join(p for p in sys.path if p)
        child = subprocess.Popen([sys.executable, "-c", script, self.device.url, self.dir], stdout=subprocess.PIPE,
                                 env=env, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "HELD")
            lock = self._lock()
            self.assertFalse(lock.acquire())
        finally:
            child.kill()
            child.wait(timeout=10)
        deadline = time.monotonic() + 5
        acquired = False
        while time.monotonic() < deadline and not acquired:
            acquired = lock.acquire()
            if not acquired:
                time.sleep(0.05)
        self.assertTrue(acquired)  # the kernel let go when the holder died
        lock.release()


if __name__ == "__main__":
    unittest.main()
