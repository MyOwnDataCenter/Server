import hashlib
import os
import tempfile
import threading
import shutil
import subprocess
import unittest
from pathlib import Path
from unittest import mock

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import agent


class SelfUpdateTests(unittest.TestCase):
    def test_info_includes_agent_sha(self):
        facts = agent.info()
        self.assertRegex(facts["agentSha"], r"^[0-9a-f]{64}$")
        self.assertIn("helperSha", facts)

    def test_update_self_verifies_sha_and_ast_and_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "agent.py")
            with open(target, "wb") as f:
                f.write(b"#!/usr/bin/env python3\nOLD = 1\n")
            new_code = b"#!/usr/bin/env python3\nNEW = 2\n"
            good_sha = hashlib.sha256(new_code).hexdigest()

            # Wrong checksum is rejected and leaves file untouched.
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                agent.update_self({"sha256": "0" * 64}, {}, target_path=target, fetch=lambda: new_code)
            with open(target, "rb") as f:
                self.assertIn(b"OLD = 1", f.read())

            # Invalid Python syntax is rejected even if checksum matches.
            bad_py = b"def broken(:\n"
            bad_sha = hashlib.sha256(bad_py).hexdigest()
            with self.assertRaisesRegex(RuntimeError, "valid Python"):
                agent.update_self({"sha256": bad_sha}, {}, target_path=target, fetch=lambda: bad_py)
            with open(target, "rb") as f:
                self.assertIn(b"OLD = 1", f.read())

            # Valid update replaces file atomically with 0o700 and schedules restart.
            restarted = threading.Event()
            res = agent.update_self({"sha256": good_sha}, {}, target_path=target, on_restart=restarted.set, fetch=lambda: new_code)
            self.assertEqual(res["sha256"], good_sha)
            self.assertTrue(res["restarting"])
            with open(target, "rb") as f:
                self.assertEqual(f.read(), new_code)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o700)
            self.assertTrue(restarted.wait(2.0))

    def test_update_self_requires_manage_ability(self):
        conn = agent.Connection.__new__(agent.Connection)
        conn.allowed = {"manage": False}
        conn.cfg = {"server": "https://127.0.0.1:7780", "id": "a" * 12, "key": "k" * 43}
        sent = []
        conn.send = sent.append
        conn.call({"id": 7, "name": "update-self", "args": {"sha256": "0" * 64}})
        self.assertEqual(len(sent), 1)
        self.assertFalse(sent[0]["ok"])
        self.assertIn("managing", sent[0]["error"].lower())


class TelemetryPowerAndSessionsTests(unittest.TestCase):
    def test_nvidia_gpus_parses_vram_temp_and_power(self):
        sample = "0, NVIDIA GeForce RTX 4090, GPU-123, 55, 8192, 24576, 67, 210.5\n"
        rows = agent._nvidia_gpus(lambda _cmd, _args: sample)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["used"], 55)
        self.assertEqual(rows[0]["vramUsed"], 8192 * 1024 * 1024)
        self.assertEqual(rows[0]["vramTotal"], 24576 * 1024 * 1024)
        self.assertEqual(rows[0]["temp"], 67.0)
        self.assertEqual(rows[0]["power"], 210.5)

    def test_net_io_calculates_rates_and_skips_virtual(self):
        agent._net_last = None
        proc1 = (
            "Inter-|   Receive\n"
            " face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n"
            "    lo: 1000 10 0 0 0 0 0 0 1000 10\n"
            "docker0: 5000 10 0 0 0 0 0 0 5000 10\n"
            "  eth0: 10000 10 0 0 0 0 0 0 20000 10\n"
        )
        proc2 = (
            "Inter-|   Receive\n"
            " face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n"
            "    lo: 9000 10 0 0 0 0 0 0 9000 10\n"
            "docker0: 99999 10 0 0 0 0 0 0 99999 10\n"
            "  eth0: 12000 10 0 0 0 0 0 0 26000 10\n"
        )
        first = agent.net_io(read_file=lambda _p: proc1, now=lambda: 100.0)
        self.assertEqual(first, {"rx": 0, "tx": 0})
        second = agent.net_io(read_file=lambda _p: proc2, now=lambda: 102.0)
        self.assertEqual(second, {"rx": 1000, "tx": 3000})

    def test_lan_macs_filters_virtual_and_zero(self):
        files = {
            "/sys/class/net/lo/address": "00:00:00:00:00:00\n",
            "/sys/class/net/docker0/address": "02:42:ac:11:00:01\n",
            "/sys/class/net/enp3s0/address": "AA:BB:CC:DD:EE:FF\n",
            "/sys/class/net/wlan0/address": "11:22:33:44:55:66\n",
        }
        macs = agent.lan_macs(list_dir=lambda _r: ["lo", "docker0", "enp3s0", "wlan0"], read_file=lambda p: files.get(p, ""))
        self.assertEqual(macs, ["aa:bb:cc:dd:ee:ff", "11:22:33:44:55:66"])

    def test_trim_scrollback_preserves_utf8_boundaries(self):
        # 3-byte UTF-8 character '€' = b'\xe2\x82\xac'
        buf = bytearray(b"a" * 5 + "€".encode("utf-8") + b"b" * 5)
        agent._trim_scrollback(buf, limit=7)
        # Should drop partial leading continuation bytes and decode cleanly as UTF-8.
        decoded = buf.decode("utf-8")
        self.assertTrue(decoded.endswith("bbbbb"))

    def test_shell_session_resumes_and_replays_scrollback(self):
        class FakeWS:
            def __init__(self):
                self.bin = bytearray()

            def send_binary(self, payload):
                self.bin += payload[4:]

        conn = agent.Connection.__new__(agent.Connection)
        conn.allowed = {"terminal": True}
        conn.ws = FakeWS()
        sent = []
        conn.send = sent.append
        saved = agent._tmux_ready
        agent._tmux_ready = False  # the in-process path; tmux is covered below
        self.addCleanup(setattr, agent, "_tmux_ready", saved)
        try:
            ch1 = agent.open_shell_session(conn, 1, 80, 24, name="test-resume", fresh=True)
            self.assertTrue(any(m.get("op") == "attached" and m.get("resumed") is False for m in sent))
            ch1.write(b"echo SWARM_PERSIST_OK\n")
            deadline = __import__("time").time() + 5
            while __import__("time").time() < deadline and b"SWARM_PERSIST_OK" not in conn.ws.bin:
                __import__("time").sleep(0.05)
            self.assertIn(b"SWARM_PERSIST_OK", conn.ws.bin)
            # Detach ch1 (does not kill the shell).
            ch1.close()
            # Reattach on ch2: should report resumed=True and replay buffered output.
            conn.ws = FakeWS()
            sent.clear()
            ch2 = agent.open_shell_session(conn, 2, 80, 24, name="test-resume", fresh=False)
            self.assertTrue(any(m.get("op") == "attached" and m.get("resumed") is True for m in sent))
            self.assertIn(b"SWARM_PERSIST_OK", conn.ws.bin)
            ch2.close()
        finally:
            agent.kill_shell_session("test-resume")

    @unittest.skipUnless(shutil.which("tmux"), "tmux isn't installed")
    def test_shell_outlives_the_connector_with_tmux(self):
        import tempfile
        import time

        class FakeWS:
            def __init__(self):
                self.bin = bytearray()

            def send_binary(self, payload):
                self.bin += payload[4:]

        def wait_for(needle):
            deadline = time.time() + 8
            while time.time() < deadline and needle not in conn.ws.bin:
                time.sleep(0.05)
            self.assertIn(needle, conn.ws.bin)

        tmp = tempfile.mkdtemp()
        socket_name = f"omarchy-test-{os.getpid()}"
        patches = [mock.patch.object(agent, "TMUX_SOCKET", socket_name), mock.patch.object(agent, "CONFIG_DIR", tmp), mock.patch.object(agent, "_tmux_ready", None)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(lambda: subprocess.run(["tmux", "-L", socket_name, "kill-server"], stderr=subprocess.DEVNULL))
        conn = agent.Connection.__new__(agent.Connection)
        conn.allowed = {"terminal": True}
        conn.ws = FakeWS()
        sent = []
        conn.send = sent.append
        ch = agent.open_shell_session(conn, 1, 80, 24, name="tmux-keep", fresh=True)
        self.assertTrue(agent._shell_sessions["tmux-keep"].tmux)
        time.sleep(0.5)
        ch.write(b"export KEPT=still-$((20+3)); echo set-$KEPT\r")
        wait_for(b"set-still-23")
        with open(os.path.join(tmp, "tmux.conf"), encoding="utf-8") as f:
            self.assertIn("status off", f.read())
        # The connector restarts: its own sessions go (the attached client ends), tmux's stays.
        old = agent._shell_sessions.pop("tmux-keep")
        old.kill("restart", end_shell=False)
        time.sleep(0.5)
        self.assertTrue(agent.tmux_has("tmux-keep"))
        conn.ws = FakeWS()
        sent.clear()
        ch = agent.open_shell_session(conn, 2, 80, 24, name="tmux-keep")
        self.assertTrue(any(m.get("op") == "attached" and m.get("resumed") is True for m in sent))
        time.sleep(0.5)
        ch.write(b"echo got-$KEPT\r")
        wait_for(b"got-still-23")
        # Ending it on purpose ends the tmux session too.
        agent.kill_shell_session("tmux-keep")
        time.sleep(0.3)
        self.assertFalse(agent.tmux_has("tmux-keep"))

    def test_power_actions_registered(self):
        self.assertIn("shutdown", agent.ACTIONS)
        self.assertIn("suspend", agent.ACTIONS)

    def test_reboot_uses_reboot_when_systemctl_is_missing(self):
        ran = []
        with mock.patch.object(agent, "IS_WINDOWS", False), mock.patch.object(agent, "IS_MAC", False), mock.patch("shutil.which", lambda name: None if name == "systemctl" else "/bin/" + name), mock.patch.object(agent, "run", lambda cmd, **kw: ran.append(cmd) or ""):
            self.assertTrue(agent.reboot({}))
        self.assertEqual(ran, [["reboot"]])

    def test_shutdown_uses_poweroff_when_systemctl_is_missing(self):
        ran = []
        with mock.patch.object(agent, "IS_WINDOWS", False), mock.patch.object(agent, "IS_MAC", False), mock.patch("shutil.which", lambda name: None if name == "systemctl" else "/bin/" + name), mock.patch.object(agent, "run", lambda cmd, **kw: ran.append(cmd) or ""):
            self.assertTrue(agent.shutdown({}))
        self.assertEqual(ran, [["poweroff"]])

    def test_forget_stops_openrc_when_systemctl_is_missing(self):
        ran = []
        def which(name):
            return "/sbin/rc-service" if name == "rc-service" else None
        with mock.patch.object(agent, "IS_WINDOWS", False), mock.patch.object(agent, "IS_MAC", False), mock.patch("shutil.which", which), mock.patch("subprocess.run", lambda cmd, **kw: ran.append(cmd) or mock.Mock()), mock.patch.object(agent, "_backup_password_dir"), mock.patch("os.unlink"), mock.patch("os._exit") as exited:
            agent.forget()
        self.assertTrue(any(cmd[:3] == ["rc-service", "omarchy-connector", "stop"] for cmd in ran))
        exited.assert_called_with(0)


class ServicesAndFilesTests(unittest.TestCase):
    def test_parse_systemd_and_containers(self):
        units = agent._parse_systemd_units("omarchy-connector.service loaded active running Omarchy connector\n", "user")
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["name"], "omarchy-connector.service")
        self.assertEqual(units[0]["sub"], "running")

        # Podman JSON array format
        pod = agent._parse_containers_json('[{"Id":"1234567890abcdef","Names":["/ollama"],"Image":"ollama/ollama","State":"running","Status":"Up 2h"}]', "podman")
        self.assertEqual(pod[0]["name"], "ollama")
        # Docker NDJSON format
        doc = agent._parse_containers_json('{"ID":"abcdef1234","Names":"redis","Image":"redis:7","State":"exited","Status":"Exited (0)"}\n', "docker")
        self.assertEqual(doc[0]["name"], "redis")
        self.assertEqual(doc[0]["state"], "exited")

    def test_services_control_blocks_system_units_and_bad_names(self):
        with self.assertRaisesRegex(RuntimeError, "read-only"):
            agent.services_control({"kind": "system", "name": "sshd.service", "action": "restart"})
        with self.assertRaisesRegex(RuntimeError, "Invalid service name"):
            agent.services_control({"kind": "user", "name": "bad;rm -rf /", "action": "restart"})
        with self.assertRaisesRegex(RuntimeError, "Choose start"):
            agent.services_control({"kind": "user", "name": "demo.service", "action": "mask"})

    def test_files_jail_keeps_credentials_private(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".ssh"))
            with open(os.path.join(home, ".ssh", "id_ed25519"), "w") as f:
                f.write("key")
            os.makedirs(os.path.join(home, ".local", "share", "keyrings"))
            os.makedirs(os.path.join(home, "Documents"))
            names = [i["name"] for i in agent.files_list({"path": "/Home"}, home=home)["items"]]
            self.assertIn("Documents", names)
            self.assertNotIn(".ssh", names)
            for p in ("/Home/.ssh/id_ed25519", "/Home/.ssh"):
                with self.assertRaises(RuntimeError):
                    agent.files_read({"path": p}, home=home)
            with self.assertRaises(RuntimeError):
                agent.files_write({"path": "/Home/.ssh/authorized_keys", "data": "eA=="}, home=home)
            with self.assertRaises(RuntimeError):
                agent.files_list({"path": "/Home/.local/share/keyrings"}, home=home)

    def test_renaming_or_trashing_a_link_acts_on_the_link_not_what_it_points_to(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, "docs"))
            real = os.path.join(home, "docs", "report.txt")
            with open(real, "w") as f:
                f.write("report")
            os.symlink(real, os.path.join(home, "shortcut"))
            res = agent.files_rename({"path": "/Home/shortcut", "newName": "renamed"}, home=home)
            self.assertEqual(res["path"], "/Home/renamed")
            self.assertTrue(os.path.islink(os.path.join(home, "renamed")))
            self.assertFalse(os.path.lexists(os.path.join(home, "shortcut")))
            self.assertTrue(os.path.isfile(real), "the file the link points to must stay where it was")
            agent.files_trash({"path": "/Home/renamed"}, home=home)
            self.assertFalse(os.path.lexists(os.path.join(home, "renamed")))
            self.assertTrue(os.path.islink(os.path.join(home, ".local", "share", "Trash", "files", "renamed")))
            self.assertTrue(os.path.isfile(real))

    def test_files_jail_blocks_traversal_symlink_escape_and_connector_config(self):
        with tempfile.TemporaryDirectory() as outer:
            home = os.path.join(outer, "home")
            outside = os.path.join(outer, "secret.txt")
            os.makedirs(home)
            with open(outside, "w") as f:
                f.write("top secret")
            os.symlink(outside, os.path.join(home, "escape.txt"))
            os.symlink(outer, os.path.join(home, "escape_dir"))

            # Basic write, list, read, rename, mkdir, trash inside /Home work.
            agent.files_mkdir({"path": "/Home/docs"}, home=home)
            b64 = __import__("base64").b64encode(b"hello world").decode("ascii")
            agent.files_write({"path": "/Home/docs/a.txt", "data": b64}, home=home)
            listed = agent.files_list({"path": "/Home/docs"}, home=home)
            self.assertEqual([i["name"] for i in listed["items"]], ["a.txt"])
            read_res = agent.files_read({"path": "/Home/docs/a.txt"}, home=home)
            self.assertEqual(__import__("base64").b64decode(read_res["data"]), b"hello world")
            agent.files_rename({"path": "/Home/docs/a.txt", "newName": "b.txt"}, home=home)
            agent.files_trash({"path": "/Home/docs/b.txt"}, home=home)
            self.assertTrue(os.path.exists(os.path.join(home, ".local", "share", "Trash", "files", "b.txt")))

            # Traversal and symlink escapes are strictly refused.
            with self.assertRaises(RuntimeError):
                agent.files_read({"path": "/Home/../secret.txt"}, home=home)
            with self.assertRaises(RuntimeError):
                agent.files_read({"path": "/Home/escape.txt"}, home=home)
            with self.assertRaises(RuntimeError):
                agent.files_write({"path": "/Home/escape_dir/pwn.txt", "data": b64}, home=home)
            with self.assertRaises(RuntimeError):
                agent.files_list({"path": "/etc"}, home=home)

            # Listing /Home skips escaping symlinks.
            top = agent.files_list({"path": "/Home"}, home=home)
            names = [i["name"] for i in top["items"]]
            self.assertNotIn("escape.txt", names)
            self.assertNotIn("escape_dir", names)

            # Connector's own CONFIG_DIR is never readable even if inside home.
            cfg_dir = os.path.join(home, ".config", "omarchy-connector")
            os.makedirs(cfg_dir)
            with open(os.path.join(cfg_dir, "config.json"), "w") as f:
                f.write('{"key":"secret"}')
            with mock.patch.object(agent, "CONFIG_DIR", cfg_dir):
                with self.assertRaises(RuntimeError):
                    agent.files_read({"path": "/Home/.config/omarchy-connector/config.json"}, home=home)


class PostureTests(unittest.TestCase):
    def test_listening_ports_filters_loopback_and_non_listen(self):
        proc_tcp = (
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
            "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1\n"
            "   1: 0100007F:07E5 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 2\n"
            "   2: 00000000:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000 0 3\n"
        )
        ports = agent._listening_ports(read_file=lambda p: proc_tcp if p.endswith("/tcp") else "")
        self.assertEqual(ports, [{"port": 8080, "proto": "tcp", "addr": "0.0.0.0"}])

    def test_reboot_required_detects_debian_stamp_and_arch_kernel_mismatch(self):
        needed, _ = agent._reboot_required(exists=lambda p: p == "/var/run/reboot-required", list_dir=lambda _: [], kernel="6.8.0")
        self.assertTrue(needed)
        needed2, reason2 = agent._reboot_required(exists=lambda p: p == "/usr/lib/modules", list_dir=lambda _: ["7.3.0-omarchy"], kernel="7.2.15-omarchy")
        self.assertTrue(needed2)
        self.assertIn("7.2.15-omarchy", reason2)
        needed3, _ = agent._reboot_required(exists=lambda p: p == "/usr/lib/modules", list_dir=lambda _: ["7.2.15-omarchy"], kernel="7.2.15-omarchy")
        self.assertFalse(needed3)


if __name__ == "__main__":
    unittest.main()


class WindowsConnectorTests(unittest.TestCase):
    def test_windows_keeps_only_terminal_files_and_power(self):
        got = agent.supported_abilities({k: True for k in agent.ABILITY_NAMES}, windows=True)
        self.assertEqual({k for k, v in got.items() if v}, {"terminal", "files", "manage"})
        self.assertTrue(agent.supported_abilities({"desktop": True}, windows=False)["desktop"])

    def test_loads_and_reads_as_windows(self):
        # Load the connector as Windows would (no pty, pwd, fcntl or termios) and use it.
        home = tempfile.mkdtemp()
        os.makedirs(os.path.join(home, "Docs"))
        with open(os.path.join(home, "Docs", "a.txt"), "w") as f:
            f.write("hi\n")
        script = f"""
import sys, os, json
import http.server, http.client, shutil, subprocess, ssl, socket, select, signal, urllib.request, ctypes, getpass, platform
for m in ("fcntl", "pty", "pwd", "termios"):
    sys.modules[m] = None
real, sys.platform = sys.platform, "win32"
os.environ["LOCALAPPDATA"] = {home!r} + "/AppData/Local"
sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})
import agent
sys.platform = real
assert agent.IS_WINDOWS and agent.pty is None
assert agent.CONFIG_DIR.endswith("AppData/Local/omarchy-connector")
i = agent.info()
assert i["osId"] == "windows" and i["desktop"]["ok"] is False
agent.metrics(agent.package_manager())
assert agent.clip_files_list({{"path": "Docs"}}, home={home!r})["entries"][0]["name"] == "a.txt"
assert agent.files_stat({{"path": "Docs/a.txt"}}, home={home!r})["size"] == 3
for bad in ("../", "Docs/../../x"):
    try:
        agent.clip_files_list({{"path": bad}}, home={home!r})
        raise SystemExit("escaped " + bad)
    except RuntimeError:
        pass
# Uploads work on Windows too (a temporary file, then a rename that never replaces).
prep = agent.prepare_write("Docs/b.txt", 3, home={home!r})
os.write(prep["fd"], b"new")
agent.commit_write(prep)
assert open(os.path.join({home!r}, "Docs", "b.txt"), "rb").read() == b"new"
try:
    agent.prepare_write("Docs/a.txt", 3, home={home!r})
    raise SystemExit("an existing file was about to be replaced")
except RuntimeError:
    pass
print("ok")
"""
        r = subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.stdout.strip(), "ok", r.stderr)
