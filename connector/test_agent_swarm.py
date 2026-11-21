import hashlib
import json
import os
import tempfile
import threading
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

    def test_power_actions_registered(self):
        self.assertIn("shutdown", agent.ACTIONS)
        self.assertIn("suspend", agent.ACTIONS)


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


class WindowsConnectorTests(unittest.TestCase):
    def test_windows_os_release_and_rdp_channel_gating(self):
        with mock.patch.object(agent, "IS_WINDOWS", True):
            rel = agent.os_release()
            self.assertEqual(rel["ID"], "windows")
            self.assertEqual(agent.update_command("winget", False), "winget upgrade --all")

        # __rdp__ port 3389 requires desktop ability, not apps ability
        conn = agent.Connection.__new__(agent.Connection)
        conn.allowed = {"desktop": False, "apps": True}
        conn.channels = {}
        sent = []
        conn.send = sent.append
        conn.handle({"op": "open", "ch": 9, "kind": "tcp", "appId": "__rdp__", "port": 3389})
        self.assertEqual(sent[0]["op"], "closed")
        self.assertIn("desktop", sent[0]["reason"].lower())

        # Any other port with __rdp__ is refused even if desktop is on
        conn.allowed = {"desktop": True, "apps": False}
        sent.clear()
        conn.handle({"op": "open", "ch": 10, "kind": "tcp", "appId": "__rdp__", "port": 22})
        self.assertEqual(sent[0]["op"], "closed")


class RemoteAppsAndMacOSTests(unittest.TestCase):
    def test_apps_install_list_control_and_port_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            ran = []

            def fake_run(cmd, cwd=None):
                ran.append(cmd)
                return "mock output"

            res = agent.apps_install(
                {
                    "id": "ollama",
                    "name": "Ollama",
                    "port": 11434,
                    "compose": (
                        "services:\n"
                        "  app:\n"
                        "    image: ollama/ollama\n"
                        "    restart: unless-stopped\n"
                        "    environment:\n"
                        "      OLLAMA_HOST: 0.0.0.0\n"
                        "      LITERAL: $SECRET\n"
                        "    ports:\n"
                        "      - '127.0.0.1:11434:11434'\n"
                        "    volumes:\n"
                        "      - ollama_data:/root/.ollama\n"
                        "      - ./cache:/tmp/cache:rw\n"
                        "volumes:\n"
                        "  ollama_data: {}\n"
                    ),
                },
                data_dir=tmp,
                run_cmd=fake_run,
            )
            self.assertEqual(res["id"], "ollama")
            self.assertEqual(res["port"], 11434)
            self.assertEqual(agent._allowed_app_ports(tmp), {"ollama": 11434})

            # Canonical re-emitted compose file escapes '$' to '$$' and is mode 0600.
            compose_path = os.path.join(tmp, "apps", "ollama", "docker-compose.yml")
            with open(compose_path, encoding="utf-8") as f:
                emitted = f.read()
            self.assertIn("$$SECRET", emitted)
            self.assertIn('"127.0.0.1:11434:11434"', emitted)
            if not agent.IS_WINDOWS:
                self.assertEqual(os.stat(compose_path).st_mode & 0o777, 0o600)

            listed = agent.apps_list({}, data_dir=tmp)
            self.assertEqual(len(listed), 1)
            self.assertEqual(listed[0]["name"], "Ollama")

            logs = agent.apps_control({"id": "ollama", "action": "logs", "lines": 50}, data_dir=tmp, run_cmd=fake_run)
            self.assertEqual(logs["logs"], "mock output")

            agent.apps_control({"id": "ollama", "action": "uninstall"}, data_dir=tmp, run_cmd=fake_run)
            self.assertEqual(agent._allowed_app_ports(tmp), {})

    def test_apps_install_rejects_dangerous_compose_options(self):
        cases = [
            ("privileged", "services:\n  app:\n    image: alpine\n    privileged: true\n"),
            ("cap_add", "services:\n  app:\n    image: alpine\n    cap_add:\n      - SYS_ADMIN\n"),
            ("devices", "services:\n  app:\n    image: alpine\n    devices:\n      - /dev/sda:/dev/sda\n"),
            ("host network", "services:\n  app:\n    image: alpine\n    network_mode: host\n"),
            ("host pid", "services:\n  app:\n    image: alpine\n    pid: host\n"),
            ("host ipc", "services:\n  app:\n    image: alpine\n    ipc: host\n"),
            ("security_opt", "services:\n  app:\n    image: alpine\n    security_opt:\n      - apparmor:unconfined\n"),
            ("docker.sock mount", "services:\n  app:\n    image: alpine\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n"),
            ("root host mount", "services:\n  app:\n    image: alpine\n    volumes:\n      - /:/host\n"),
            ("parent traversal mount", "services:\n  app:\n    image: alpine\n    volumes:\n      - ./../escape:/escape\n"),
            ("home tilde mount", "services:\n  app:\n    image: alpine\n    volumes:\n      - ~/secrets:/secrets\n"),
            ("var interpolation mount", "services:\n  app:\n    image: alpine\n    volumes:\n      - ${HOME}:/host\n"),
            ("undeclared named volume", "services:\n  app:\n    image: alpine\n    volumes:\n      - ghost:/data\n"),
            ("driver_opts volume smuggling", "services:\n  app:\n    image: alpine\n    volumes:\n      - sneaky:/data\nvolumes:\n  sneaky:\n    driver_opts:\n      device: /\n"),
            ("all-interface port", "services:\n  app:\n    image: alpine\n    ports:\n      - '8080:80'\n"),
            ("0.0.0.0 port", "services:\n  app:\n    image: alpine\n    ports:\n      - '0.0.0.0:8080:80'\n"),
            ("low host port", "services:\n  app:\n    image: alpine\n    ports:\n      - '127.0.0.1:80:80'\n"),
            ("yaml anchor/alias", "services:\n  app: &a\n    image: alpine\n"),
            ("build directive", "services:\n  app:\n    image: alpine\n    build: .\n"),
            ("env_file directive", "services:\n  app:\n    image: alpine\n    env_file: .env\n"),
            ("top-level include", "include:\n  - other.yml\nservices:\n  app:\n    image: alpine\n"),
            ("mount meta.json", "services:\n  app:\n    image: alpine\n    volumes:\n      - ./meta.json:/meta.json\n"),
            ("case-variant docker-compose.yml", "services:\n  app:\n    image: alpine\n    volumes:\n      - ./Docker-Compose.yml:/c\n"),
            ("case-variant META.JSON", "services:\n  app:\n    image: alpine\n    volumes:\n      - ./META.JSON:/m\n"),
            ("nested bind mounts", "services:\n  app:\n    image: alpine\n    volumes:\n      - ./data:/data\n      - ./data/x:/host\n"),
            ("case-folded nested bind mounts", "services:\n  app:\n    image: alpine\n    volumes:\n      - ./data:/data\n      - ./DATA/x:/host\n"),
            ("duplicate bind mounts across services", "services:\n  a:\n    image: alpine\n    volumes:\n      - ./shared:/a\n  b:\n    image: alpine\n    volumes:\n      - ./shared:/b\n"),
            ("object-form relative bind with colon", "services:\n  app:\n    image: alpine\n    volumes:\n      - type: bind\n        source: ./a:/b\n        target: /c\n"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            called = []
            for label, compose in cases:
                with self.assertRaises(RuntimeError, msg=f"should reject {label}"):
                    agent.apps_install({"id": "badapp", "compose": compose, "port": 0}, data_dir=tmp, run_cmd=lambda c, cwd=None: called.append(c))
            # Long >80-char JSON-encoded values and apostrophes in plain scalars must pass.
            long_val = "it's " + ("x" * 120)
            ok_json = json.dumps({"services": {"on": {"image": "alpine", "environment": {"NOTE": long_val}}}})
            emitted, _ = agent.validate_app_compose(ok_json, os.path.join(tmp, "apps", "okjson"), port=0)
            self.assertIn('"on":', emitted)
            self.assertIn('"NOTE":', emitted)
            # Re-validation on start catches tampered docker-compose.yml on disk.
            tamper_dir = os.path.join(tmp, "apps", "tampered")
            os.makedirs(tamper_dir, exist_ok=True)
            with open(os.path.join(tamper_dir, "docker-compose.yml"), "w", encoding="utf-8") as f:
                f.write("services:\n  app:\n    image: alpine\n    privileged: true\n")
            with self.assertRaises(RuntimeError):
                agent.apps_control({"id": "tampered", "action": "start"}, data_dir=tmp, run_cmd=lambda c, cwd=None: called.append(c))
            # Declared web port not published in compose must also be refused.
            with self.assertRaises(RuntimeError):
                agent.apps_install(
                    {
                        "id": "portmismatch",
                        "port": 9999,
                        "compose": "services:\n  app:\n    image: nginx:alpine\n    ports:\n      - '127.0.0.1:8080:80'\n",
                    },
                    data_dir=tmp,
                    run_cmd=lambda c, cwd=None: called.append(c),
                )
            self.assertEqual(called, [])
            self.assertEqual(agent._allowed_app_ports(tmp), {})

            # Symlink inside app_dir escaping outside must be rejected.
            if not agent.IS_WINDOWS:
                app_dir = os.path.join(tmp, "apps", "symapp")
                os.makedirs(app_dir, exist_ok=True)
                os.symlink("/tmp", os.path.join(app_dir, "escape"))
                with self.assertRaises(RuntimeError):
                    agent.apps_install(
                        {
                            "id": "symapp",
                            "port": 0,
                            "compose": "services:\n  app:\n    image: alpine\n    volumes:\n      - ./escape:/host\n",
                        },
                        data_dir=tmp,
                        run_cmd=lambda c, cwd=None: called.append(c),
                    )
                self.assertEqual(called, [])

    def test_tcp_channel_refuses_uninstalled_ports_and_requires_apps_ability(self):
        conn = agent.Connection.__new__(agent.Connection)
        conn.allowed = {"apps": False}
        conn.channels = {}
        sent = []
        conn.send = sent.append
        conn.handle({"op": "open", "ch": 5, "kind": "tcp", "appId": "ollama", "port": 11434})
        self.assertEqual(sent[0]["op"], "closed")
        self.assertIn("apps", sent[0]["reason"].lower())

        # Even with apps allowed, an unknown port/appId is rejected.
        conn.allowed = {"apps": True}
        sent.clear()
        with mock.patch.object(agent, "_allowed_app_ports", return_value={"ollama": 11434}):
            conn.handle({"op": "open", "ch": 6, "kind": "tcp", "appId": "ollama", "port": 22})
        self.assertEqual(sent[0]["op"], "closed")
        self.assertIn("installed app", sent[0]["reason"].lower())

    def test_macos_info_and_metrics_paths(self):
        if agent.IS_MACOS:
            rel = agent.os_release()
            self.assertEqual(rel["ID"], "macos")
            mem, _swap = agent.meminfo()
            self.assertGreater(mem["total"], 0)
            self.assertGreaterEqual(len(agent.disks()), 1)
            self.assertEqual(agent.desktop_kind()["ok"], False)


if __name__ == "__main__":
    unittest.main()
