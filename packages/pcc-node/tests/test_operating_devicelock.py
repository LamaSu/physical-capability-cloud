"""HostDeviceLock: one hold per device across processes, and a durable one-shot record per job (astra 554 F1)."""

import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

from pcc_node.operating.devicelock import DeviceLockError, HostDeviceLock, device_key

KEY = "http://127.0.0.1:8765"


class HostDeviceLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "device-locks")

    def _lock(self, key=KEY, directory=None):
        lock = HostDeviceLock(key, directory or self.dir)
        self.addCleanup(lock.close)
        return lock

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
                HostDeviceLock(KEY, path)

    def test_a_symlinked_directory_is_refused(self):
        real = os.path.join(self.tmp.name, "real")
        os.mkdir(real, 0o700)
        os.chmod(real, 0o700)
        link = os.path.join(self.tmp.name, "link")
        os.symlink(real, link)
        with self.assertRaises(DeviceLockError):
            HostDeviceLock(KEY, link)

    def test_a_symlink_planted_at_the_lock_file_is_refused(self):
        lock = self._lock()
        target = os.path.join(self.tmp.name, "elsewhere")
        open(target, "w").close()
        name = lock._lock_name
        os.symlink(target, os.path.join(self.dir, name))
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

    def test_different_devices_are_held_independently(self):
        a, b = self._lock("http://127.0.0.1:8765"), self._lock("http://127.0.0.1:8766")
        self.assertTrue(a.acquire())
        self.assertTrue(b.acquire())
        a.release()
        b.release()

    def test_a_job_is_recorded_once_and_the_record_outlives_the_process_state(self):
        lock = self._lock()
        self.assertTrue(lock.consume("job-1:claim-a"))
        self.assertFalse(lock.consume("job-1:claim-a"))
        self.assertTrue(lock.consume("job-1:claim-b"))
        restarted = self._lock()
        self.assertFalse(restarted.consume("job-1:claim-a"))

    def test_another_process_holding_the_device_excludes_this_one_until_it_exits(self):
        script = textwrap.dedent(
            """
            import sys, time
            from pcc_node.operating.devicelock import HostDeviceLock
            lock = HostDeviceLock(sys.argv[1], sys.argv[2])
            assert lock.acquire()
            print("HELD", flush=True)
            time.sleep(30)
            """
        )
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        env["PYTHONPATH"] = os.pathsep.join(p for p in sys.path if p)
        child = subprocess.Popen([sys.executable, "-c", script, KEY, self.dir], stdout=subprocess.PIPE, env=env,
                                 text=True)
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


class DeviceKeyTests(unittest.TestCase):
    def test_one_device_has_one_key(self):
        self.assertEqual(device_key("HTTP://Host.Local"), "http://host.local:80")
        self.assertEqual(device_key("http://host.local:80/status"), "http://host.local:80")
        self.assertEqual(device_key("https://robot"), "https://robot:443")
        self.assertEqual(device_key("http://[::1]:8765"), "http://[::1]:8765")

    def test_a_url_without_a_host_is_refused(self):
        for url in ("", "relative/path", "ftp://host", "http://"):
            with self.assertRaises(ValueError, msg=url):
                device_key(url)


if __name__ == "__main__":
    unittest.main()
