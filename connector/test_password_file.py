"""Password files for restic must not survive a stop that skips finally."""
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import agent


class PasswordFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runtime = self.tmp.name
        self._runtime = agent.RUNTIME
        self._config = agent.CONFIG
        self._files = list(getattr(agent, "_password_files", []))
        agent.RUNTIME = self.runtime
        agent.CONFIG = os.path.join(self.runtime, "no-real-config.json")

    def tearDown(self):
        agent.RUNTIME = self._runtime
        agent.CONFIG = self._config
        if hasattr(agent, "_password_files"):
            agent._password_files[:] = self._files

    def test_sweep_removes_leftover_backup_hex_only(self):
        leftover = os.path.join(self.runtime, "backup-aabbcc")
        with open(leftover, "w", encoding="utf-8") as f:
            f.write("secret-password")
        kept = [
            os.path.join(self.runtime, "vnc.sock"),
            os.path.join(self.runtime, "backup-not-hex"),
            os.path.join(self.runtime, "notes.txt"),
        ]
        for path in kept:
            with open(path, "w", encoding="utf-8") as f:
                f.write("keep")
        agent.cleanup_password_files(self.runtime)
        self.assertFalse(os.path.exists(leftover))
        for path in kept:
            self.assertTrue(os.path.exists(path), path)

    def test_restic_env_file_is_private_and_cleanup_removes_it(self):
        env, pw = agent._restic_env("rest:http://127.0.0.1/repo", "s3cret-value")
        self.assertTrue(os.path.isfile(pw))
        self.assertEqual(stat.S_IMODE(os.stat(pw).st_mode), 0o600)
        self.assertEqual(env["RESTIC_PASSWORD_FILE"], pw)
        agent.cleanup_password_files()
        self.assertFalse(os.path.exists(pw))

    def test_forget_removes_password_file_before_exit(self):
        _env, pw = agent._restic_env("rest:http://127.0.0.1/repo", "forget-secret")
        self.assertTrue(os.path.exists(pw))
        with mock.patch.object(agent.os, "_exit") as exit_fn, mock.patch.object(agent.subprocess, "run") as run_fn:
            agent.forget()
        self.assertFalse(os.path.exists(pw))
        exit_fn.assert_called_once_with(0)
        run_fn.assert_called_once_with(
            ["systemctl", "--user", "disable", "omarchy-connector.service"],
            capture_output=True,
            timeout=30,
        )


if __name__ == "__main__":
    unittest.main()
