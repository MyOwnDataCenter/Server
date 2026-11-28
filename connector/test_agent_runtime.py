import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import agent  # noqa: E402


class ReportHelloInterval(unittest.TestCase):
    # #432: refresh hello once every 5 minutes, not 3-4 times per 10s window.
    def test_hello_sent_once_per_300_seconds(self):
        conn = agent.Connection({"abilities": {}})
        conn._watched = True  # a server that already sent watch
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for step in range(1, 3001):
                t = float(step * 3)
                last_hello = conn._report_step(sampler, last_hello, t)
        hellos = [m for m in sent if m.get("op") == "hello"]
        self.assertEqual(len(hellos), 30)

    def test_no_burst_after_300_second_mark(self):
        conn = agent.Connection({"abilities": {}})
        conn._watched = True  # a server that already sent watch
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        last_hello = 0.0
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}):
            for t in (297.0, 300.0, 303.0, 306.0, 309.0):
                last_hello = conn._report_step(sampler, last_hello, t)
        self.assertEqual(len([m for m in sent if m.get("op") == "hello"]), 1)
        self.assertEqual(last_hello, 300.0)


class ServerConnectionKeepalive(unittest.TestCase):
    # A server that vanishes without closing the connection (power cut, a router that forgot the
    # connection) must be noticed in about a minute, not after the system's 15 minute retry limit.
    def test_the_connection_asks_the_system_to_probe_an_idle_server(self):
        import base64
        import hashlib
        import socket
        import threading

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        done = threading.Event()

        def serve():
            peer, _ = listener.accept()
            raw = b""
            while b"\r\n\r\n" not in raw:
                raw += peer.recv(4096)
            key = [l.split(b": ", 1)[1] for l in raw.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key")][0].decode()
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            peer.sendall(f"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode())
            done.wait(5)
            peer.close()

        threading.Thread(target=serve, daemon=True).start()

        class PlainContext:
            def wrap_socket(self, raw, server_hostname=None):
                return raw

        try:
            with mock.patch.object(agent, "_ssl_context", return_value=PlainContext()):
                ws = agent.WS("wss://127.0.0.1:%d/connector/ws" % listener.getsockname()[1], {}, None)
            try:
                self.assertTrue(ws.sock.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE))
                if hasattr(socket, "TCP_KEEPIDLE"):
                    self.assertLessEqual(ws.sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE), 60)
            finally:
                ws.close()
        finally:
            done.set()
            listener.close()


class ReportLoopSurvivesAnError(unittest.TestCase):
    def test_one_failed_report_does_not_end_the_reporting(self):
        import threading

        release = threading.Event()

        class FakeWs:
            def __init__(self, *args):
                pass

            def send_text(self, text):
                pass

            def recv(self):
                release.wait(5)
                raise ConnectionError("closed")

            def close(self):
                pass

        conn = agent.Connection({"server": "https://example.test", "id": "a", "key": "b", "abilities": {}})
        calls = []

        def step(sampler, last_hello, now):
            calls.append(now)
            if len(calls) == 1:
                raise OSError("the runtime folder went away")
            return last_hello

        with mock.patch.object(agent, "WS", FakeWs), mock.patch.object(agent, "REPORT_INTERVAL", 0.01), \
                mock.patch.object(agent, "log"), mock.patch.object(agent, "info", return_value={}), \
                mock.patch.object(conn, "_report_step", side_effect=step):
            runner = threading.Thread(target=lambda: self._run(conn), daemon=True)
            runner.start()
            deadline = time.time() + 3
            while len(calls) < 3 and time.time() < deadline:
                time.sleep(0.01)
            release.set()
            runner.join(3)
        self.assertGreaterEqual(len(calls), 3, "reporting stopped after the first error")

    @staticmethod
    def _run(conn):
        try:
            conn.run()
        except ConnectionError:
            pass


if __name__ == "__main__":
    unittest.main()


class DesktopSessionReported(unittest.TestCase):
    # Signing in to the desktop after the connector started is reported within seconds.
    def test_hello_when_the_desktop_appears(self):
        conn = agent.Connection({"abilities": {"desktop": True}})
        conn._watched = True  # a server that already sent watch
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        states = iter([{"kind": "none", "ok": False}] * 3 + [{"kind": "wlroots", "ok": True}] * 10)
        with mock.patch.object(agent, "info", return_value={"hostname": "box"}), mock.patch.object(agent, "desktop_kind", side_effect=lambda: next(states)):
            last = conn._report_step(sampler, 0.0, 400.0)  # the regular hello
            for t in (412.0, 424.0, 436.0, 448.0):
                last = conn._report_step(sampler, last, t)
        hellos = [m for m in sent if m.get("op") == "hello"]
        self.assertEqual(len(hellos), 2)

    def test_nothing_extra_without_the_desktop_ability(self):
        conn = agent.Connection({"abilities": {}})
        conn._watched = True  # a server that already sent watch
        sent = []
        conn.send = sent.append
        sampler = mock.Mock()
        sampler.active.return_value = False
        with mock.patch.object(agent, "info", return_value={}), mock.patch.object(agent, "desktop_kind", side_effect=AssertionError("not checked")):
            conn._report_step(sampler, 400.0, 412.0)
        self.assertEqual(sent, [])


class ScreenSharingStarts(unittest.TestCase):
    # wayvnc won't start while another one holds its default control socket (MODC's own desktop
    # sharing on the same desktop). The connector gives it its own, and says why when it fails.
    def _fake(self, d, body):
        path = os.path.join(d, "wayvnc")
        with open(path, "w") as f:
            f.write("#!/usr/bin/env python3\nimport sys, socket, time\nargs = sys.argv[1:]\n" + body)
        os.chmod(path, 0o755)

    def _start(self, d):
        runtime = os.path.join(d, "run")
        os.makedirs(runtime)
        sock = os.path.join(runtime, "omarchy-connector", "vnc.sock")
        env = dict(os.environ, PATH=d + os.pathsep + os.environ.get("PATH", ""))
        with mock.patch.dict(os.environ, env), mock.patch.object(agent, "RUNTIME", runtime), mock.patch.object(agent, "VNC_SOCK", sock), \
                mock.patch.object(agent, "desktop_kind", return_value={"kind": "wlroots", "ok": True, "why": ""}), \
                mock.patch.object(agent, "_wayland_display", return_value="wayland-1"), mock.patch.object(agent, "_hypr_signature", return_value=None):
            try:
                agent.vnc_start()
                return sock
            finally:
                p, agent._vnc["proc"] = agent._vnc["proc"], None
                agent._vnc["users"] = 0
                if p:
                    p.kill()

    def test_starts_with_its_own_control_socket(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            self._fake(d, (
                "if '-S' not in args:\n"
                "    print('ERROR: Another wayvnc process is already running.', file=sys.stderr); sys.exit(1)\n"
                "s = socket.socket(socket.AF_UNIX); s.bind(args[-1]); s.listen(1); time.sleep(30)\n"
            ))
            sock = self._start(d)
            self.assertTrue(sock.endswith("vnc.sock"))

    def test_says_why_it_stopped(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            self._fake(d, "print('ERROR: Failed to connect to the Wayland display', file=sys.stderr)\nprint(\"Use the '-S' option\", file=sys.stderr)\nsys.exit(1)\n")
            with self.assertRaisesRegex(RuntimeError, "wayvnc.*Failed to connect to the Wayland display"):
                self._start(d)


class FindsTheLiveDesktop(unittest.TestCase):
    # A stale Hyprland folder and an old wayland-0 (from before a restart) aren't picked over the
    # session that's running: that made Desktop fail on Omarchy.
    def test_live_hyprland_and_its_socket(self):
        import tempfile
        import time
        with tempfile.TemporaryDirectory() as run:
            for name in ("wayland-0", "wayland-1", "wayland-1.lock"):
                open(os.path.join(run, name), "w").close()
            old = os.path.join(run, "hypr", "old_sig")
            live = os.path.join(run, "hypr", "live_sig")
            os.makedirs(old)
            os.makedirs(live)
            with open(os.path.join(old, "hyprland.lock"), "w") as f:
                f.write("999999999\nwayland-0\n")
            with open(os.path.join(live, "hyprland.lock"), "w") as f:
                f.write(f"{os.getpid()}\nwayland-1\n")
            now = time.time()
            os.utime(old, (now, now))  # the stale one is even the newest folder
            os.utime(live, (now - 60, now - 60))
            with mock.patch.object(agent, "RUNTIME", run):
                self.assertEqual(agent._hypr_signature(), "live_sig")
                self.assertEqual(agent._wayland_display(), "wayland-1")
                self.assertEqual(agent.desktop_kind()["kind"], "wlroots")

    def test_without_hyprland_the_newest_locked_socket(self):
        import tempfile
        with tempfile.TemporaryDirectory() as run:
            for name in ("wayland-0", "wayland-2", "wayland-2.lock"):
                open(os.path.join(run, name), "w").close()
            with mock.patch.object(agent, "RUNTIME", run):
                self.assertEqual(agent._wayland_display(), "wayland-2")
                self.assertIsNone(agent._hypr_signature())

    def test_an_older_hyprland_without_a_lock_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as run:
            open(os.path.join(run, "wayland-1"), "w").close()
            os.makedirs(os.path.join(run, "hypr", "sig"))
            with mock.patch.object(agent, "RUNTIME", run):
                self.assertEqual(agent._hypr_signature(), "sig")
                self.assertEqual(agent._wayland_display(), "wayland-1")


class MacReadings(unittest.TestCase):
    """A Mac has no /proc or /sys: the connector reads sysctl, vm_stat, ifconfig and pmset."""

    def test_memory_matches_activity_monitor(self):
        vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10000.\nPages active:                            200000.\nPages inactive:                          150000.\nPages wired down:                        100000.\n"Translation faults":                   9.\nPages occupied by compressor:             50000.\n'
        mem, swap = agent._mac_meminfo(vm_stat=vm, memsize=str(16 * 1024**3), swap="total = 2048.00M  used = 512.50M  free = 1535.50M  (encrypted)")
        self.assertEqual(mem, {"total": 16 * 1024**3, "used": 350000 * 16384})
        self.assertEqual(swap, {"total": 2048 * 1024**2, "used": int(512.5 * 1024**2)})

    def test_wake_addresses_come_from_the_real_adapters(self):
        out = "lo0: flags=8049<UP>\n\tinet 127.0.0.1\nen0: flags=8863<UP>\n\tether a8:20:66:12:34:56\nawdl0: flags=8943<UP>\n\tether 3e:11:22:33:44:55\nbridge0: flags=8863\n\tether 36:00:00:00:00:01\nen1: flags=8963\n\tether a8:20:66:12:34:57\n"
        self.assertEqual(agent._mac_macs(out), ["a8:20:66:12:34:56", "a8:20:66:12:34:57"])

    def test_uptime_battery_and_cpu(self):
        now = int(agent.time.time())
        self.assertAlmostEqual(agent._mac_uptime(f"{{ sec = {now - 3600}, usec = 0 }} Mon Nov 23 09:00:00 2026"), 3600, delta=5)
        batt = agent._mac_batteries("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t82%; discharging; 4:31 remaining present: true\n")
        self.assertEqual((batt[0]["percent"], batt[0]["status"], batt[0]["secondsRemaining"]), (82, "discharging", 4 * 3600 + 31 * 60))
        self.assertEqual(agent._mac_batteries(" -InternalBattery-0\t100%; charged; 0:00 remaining\n")[0]["status"], "full")
        agent._mac_cpu_last = None
        self.assertIsNone(agent._mac_cpu_percent((100, 50, 850, 0)))
        self.assertEqual(agent._mac_cpu_percent((130, 70, 900, 0)), 50.0)

    def test_a_mac_offers_terminal_files_and_power(self):
        everything = {k: True for k in agent.ABILITY_NAMES}
        got = agent.supported_abilities(everything, windows=False, mac=True)
        self.assertEqual(sorted(k for k, v in got.items() if v), ["files", "manage", "terminal"])
        self.assertEqual(agent.supported_abilities(everything, windows=False, mac=False, lxc=False), everything)
