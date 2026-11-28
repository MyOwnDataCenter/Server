import os
import tempfile
import unittest

from agent import in_lxc, info, supported_abilities


class LxcAbilities(unittest.TestCase):
    def test_lxc_strips_desktop_storage_vms(self):
        raw = {k: True for k in ("terminal", "desktop", "manage", "storage", "backup", "services", "files", "vms")}
        out = supported_abilities(raw, windows=False, mac=False, lxc=True)
        self.assertTrue(out["terminal"])
        self.assertTrue(out["files"])
        self.assertTrue(out["backup"])
        self.assertTrue(out["manage"])
        self.assertTrue(out["services"])
        self.assertFalse(out["desktop"])
        self.assertFalse(out["storage"])
        self.assertFalse(out["vms"])

    def test_in_lxc_reads_environ_sock_and_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            flag = os.path.join(tmp, "lxc")
            self.assertFalse(in_lxc(environ=b"", exists=lambda p: False, data_dir=tmp))
            self.assertTrue(in_lxc(environ=b"PATH=/bin\0container=lxc\0HOME=/\0", exists=lambda p: False, data_dir=tmp))
            self.assertTrue(in_lxc(environ=b"", exists=lambda p: p == "/dev/incus/sock", data_dir=tmp))
            open(flag, "w").close()
            self.assertTrue(in_lxc(environ=b"", exists=lambda p: False, data_dir=tmp))

    def test_info_reports_lxc_environment(self):
        got = info(abilities={}, environment="lxc")
        self.assertEqual(got.get("environment"), "lxc")
        plain = info(abilities={}, environment="")
        self.assertNotIn("environment", plain)


if __name__ == "__main__":
    unittest.main()
