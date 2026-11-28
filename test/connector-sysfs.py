#!/usr/bin/env python3
"""Fake sysfs for the connector's GPU and battery collectors."""
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "connector"))
import agent  # noqa: E402


def from_files(files, names):
    def list_dir(path):
        if path.rstrip("/") == "/sys/class/power_supply":
            return names
        return []

    def read_file(path, default=""):
        return files.get(path, default)

    return list_dir, read_file


class Batteries(unittest.TestCase):
    def test_no_supplies(self):
        list_dir, read_file = from_files({}, [])
        self.assertEqual(agent.batteries(list_dir=list_dir, read_file=read_file), [])

    def test_skips_mains_and_device_scope(self):
        files = {
            "/sys/class/power_supply/AC/type": "Mains",
            "/sys/class/power_supply/hid-mouse/type": "Battery",
            "/sys/class/power_supply/hid-mouse/present": "1",
            "/sys/class/power_supply/hid-mouse/scope": "Device",
            "/sys/class/power_supply/hid-mouse/capacity": "90",
            "/sys/class/power_supply/hid-mouse/status": "Discharging",
        }
        list_dir, read_file = from_files(files, ["AC", "hid-mouse"])
        self.assertEqual(agent.batteries(list_dir=list_dir, read_file=read_file), [])

    def test_laptop_pack_charging(self):
        files = {
            "/sys/class/power_supply/BAT0/type": "Battery",
            "/sys/class/power_supply/BAT0/present": "1",
            "/sys/class/power_supply/BAT0/scope": "System",
            "/sys/class/power_supply/BAT0/status": "Charging",
            "/sys/class/power_supply/BAT0/capacity": "64",
            "/sys/class/power_supply/BAT0/model_name": "Internal",
            "/sys/class/power_supply/BAT0/energy_now": "32000000",
            "/sys/class/power_supply/BAT0/energy_full": "50000000",
            "/sys/class/power_supply/BAT0/power_now": "10000000",
        }
        list_dir, read_file = from_files(files, ["BAT0"])
        self.assertEqual(
            agent.batteries(list_dir=list_dir, read_file=read_file),
            [
                {
                    "id": "BAT0",
                    "index": 0,
                    "name": "Internal",
                    "percent": 64,
                    "status": "charging",
                    "secondsRemaining": 6480,
                    "power": 10,
                    "energyNow": 32000000,
                    "energyFull": 50000000,
                }
            ],
        )


class Gpus(unittest.TestCase):
    def setUp(self):
        agent._last_nvidia = None
        agent._last_engine = {}
        agent._last_rc6 = {}

    def test_nvidia_csv(self):
        csv = "0, NVIDIA GeForce RTX 3060, GPU-aaa, 32, 1477, 12288, 39\n1, NVIDIA GeForce RTX 3060, GPU-bbb, 0, 2, 12288, 36\n"

        def run(cmd, args):
            return csv if cmd == "nvidia-smi" else ""

        gpus = agent.gpus(run=run, list_dir=lambda p: [], read_file=lambda p, d="": d)
        self.assertEqual(len(gpus), 2)
        self.assertEqual(
            gpus[0],
            {
                "id": "GPU-aaa",
                "index": 0,
                "name": "NVIDIA GeForce RTX 3060",
                "used": 32,
                "vramUsed": 1477 * 1024 * 1024,
                "vramTotal": 12288 * 1024 * 1024,
                "temp": 39.0,
            },
        )
        self.assertEqual(gpus[1]["id"], "GPU-bbb")
        self.assertEqual(gpus[1]["used"], 0)

    def test_nvidia_missing_falls_back_to_drm(self):
        files = {
            "/sys/class/drm/card0/device/gpu_busy_percent": "41\n",
            "/sys/class/drm/card0/device/product_name": "AMD Radeon RX 7900 XTX\n",
        }

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card0", "card0-DP-1", "renderD128"]
            return []

        def read_file(path, default=""):
            return files.get(path, default)

        def run(cmd, args):
            raise FileNotFoundError(cmd)

        gpus = agent.gpus(run=run, list_dir=list_dir, read_file=read_file)
        self.assertEqual(len(gpus), 1)
        self.assertEqual(gpus[0]["id"], "drm-card0")
        self.assertEqual(gpus[0]["name"], "AMD Radeon RX 7900 XTX")
        self.assertEqual(gpus[0]["used"], 41)

    def test_sleeping_nvidia_not_woken(self):
        calls = []
        state = {"status": "active"}
        csv = "0, NVIDIA GeForce RTX 4060 Laptop GPU, GPU-x, 12, 300, 8188, 44\n"

        def run(cmd, args):
            calls.append(cmd)
            return csv

        def list_dir(path):
            return ["0000:01:00.0"] if path == "/sys/bus/pci/devices" else []

        def read_file(path, default=""):
            if path.endswith("/vendor"):
                return "0x10de\n"
            if path.endswith("/class"):
                return "0x030200\n"
            if path.endswith("runtime_status"):
                return state["status"]
            return default

        self.assertEqual(agent.gpus(run=run, list_dir=list_dir, read_file=read_file)[0]["used"], 12)
        state["status"] = "suspended"
        asleep = agent.gpus(run=run, list_dir=list_dir, read_file=read_file)
        self.assertEqual(len(calls), 1)
        self.assertEqual((asleep[0]["id"], asleep[0]["used"]), ("GPU-x", 0))
        state["status"] = "active"
        agent.gpus(run=run, list_dir=list_dir, read_file=read_file)
        self.assertEqual(len(calls), 2)
        agent._last_nvidia = None

    def test_intel_listed_without_busy_percent(self):
        files = {
            "/sys/class/drm/card0/device/vendor": "0x8086\n",
            "/sys/class/drm/card0/device/product_name": "Intel Arc Graphics\n",
        }

        def list_dir(path):
            return ["card0", "card0-eDP-1"] if path == "/sys/class/drm" else []

        def run(cmd, args):
            return ""

        gpus = agent.gpus(run=run, list_dir=list_dir, read_file=lambda p, d="": files.get(p, d))
        self.assertEqual(len(gpus), 1)
        self.assertEqual(gpus[0]["id"], "drm-card0")
        self.assertEqual(gpus[0]["name"], "Intel Arc Graphics")
        self.assertIsNone(gpus[0]["used"])

    def test_intel_engine_busy_not_stuck_gpu_busy_percent(self):
        # i915 often exposes gpu_busy_percent as 0. Utilization is rcs0 busy-ns over wall time.
        files = {
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/device/gpu_busy_percent": "0\n",
            "/sys/class/drm/card1/engine/rcs0/busy": "0\n",
            "/sys/class/drm/card1/engine/bcs0/busy": "0\n",
        }
        clock = {"t": 10.0}

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card1", "card1-eDP-1"]
            if path == "/sys/class/drm/card1/engine":
                return ["rcs0", "bcs0"]
            return []

        def read_file(path, default=""):
            return files.get(path, default)

        first = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(first[0]["id"], "drm-card1")
        self.assertEqual(first[0]["name"], "Intel Graphics")
        self.assertIsNone(first[0]["used"])
        files["/sys/class/drm/card1/engine/rcs0/busy"] = str(int(0.4 * 1e9)) + "\n"
        clock["t"] = 11.0
        second = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(second[0]["used"], 40)

    def test_intel_compute_busy_not_hidden_by_idle_render(self):
        files = {
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/engine/rcs0/busy": "0\n",
            "/sys/class/drm/card1/engine/ccs0/busy": "0\n",
        }
        clock = {"t": 10.0}

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card1"]
            if path == "/sys/class/drm/card1/engine":
                return ["rcs0", "ccs0"]
            return []

        first = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=lambda p, d="": files.get(p, d), now=lambda: clock["t"])
        self.assertIsNone(first[0]["used"])
        files["/sys/class/drm/card1/engine/ccs0/busy"] = str(int(0.4 * 1e9)) + "\n"
        clock["t"] = 11.0
        second = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=lambda p, d="": files.get(p, d), now=lambda: clock["t"])
        self.assertEqual(second[0]["used"], 40)

    def test_bmc_and_virtio_without_busy_percent_are_not_listed(self):
        files = {
            "/sys/class/drm/card0/device/vendor": "0x1a03\n",
            "/sys/class/drm/card0/device/product_name": "ASPEED Graphics Family\n",
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/device/product_name": "Intel Graphics\n",
        }

        def list_dir(path):
            return ["card0", "card1"] if path == "/sys/class/drm" else []

        gpus = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=lambda p, d="": files.get(p, d))
        self.assertEqual([g["id"] for g in gpus], ["drm-card1"])
        self.assertIsNone(gpus[0]["used"])

    def test_intel_rc6_when_engine_has_no_busy_file(self):
        # Broadwell i915: engine dirs exist, no busy files, no gpu_busy_percent.
        # RC6 residency is idle time; GPU use is the wall time not spent in RC6.
        files = {
            "/sys/class/drm/card1/device/vendor": "0x8086\n",
            "/sys/class/drm/card1/gt/gt0/rc6_enable": "1\n",
            "/sys/class/drm/card1/gt/gt0/rc6_residency_ms": "0\n",
        }
        clock = {"t": 10.0}

        def list_dir(path):
            if path == "/sys/class/drm":
                return ["card1", "card1-eDP-1"]
            if path == "/sys/class/drm/card1/engine":
                return ["rcs0", "bcs0", "vcs0", "vecs0"]
            return []

        def read_file(path, default=""):
            return files.get(path, default)

        first = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(first[0]["id"], "drm-card1")
        self.assertIsNone(first[0]["used"])
        files["/sys/class/drm/card1/gt/gt0/rc6_residency_ms"] = "600\n"
        clock["t"] = 11.0
        second = agent.gpus(run=lambda c, a: "", list_dir=list_dir, read_file=read_file, now=lambda: clock["t"])
        self.assertEqual(second[0]["used"], 40)

    def test_hybrid_nvidia_and_amd(self):
        files = {
            "/sys/class/drm/card0/device/vendor": "0x1002\n",
            "/sys/class/drm/card0/device/gpu_busy_percent": "41\n",
            "/sys/class/drm/card0/device/product_name": "AMD Radeon RX 7900 XTX\n",
        }
        csv = "0, NVIDIA GeForce RTX 3060, GPU-aaa, 32, 1477, 12288, 39\n"

        def run(cmd, args):
            return csv if cmd == "nvidia-smi" else ""

        def list_dir(path):
            return ["card0"] if path == "/sys/class/drm" else []

        gpus = agent.gpus(run=run, list_dir=list_dir, read_file=lambda p, d="": files.get(p, d))
        self.assertEqual([g["id"] for g in gpus], ["GPU-aaa", "drm-card0"])
        self.assertEqual([g["index"] for g in gpus], [0, 1])
        self.assertEqual(gpus[1]["used"], 41)

    def test_no_gpus(self):
        def run(cmd, args):
            return ""

        self.assertEqual(agent.gpus(run=run, list_dir=lambda p: [], read_file=lambda p, d="": d), [])


class RejectKey(unittest.TestCase):
    def test_classifier(self):
        self.assertFalse(issubclass(agent.Rejected, PermissionError))
        self.assertEqual(agent.reconnect_action(agent.Rejected("HTTP/1.1 401 Unauthorized")), "forget")
        for exc in (PermissionError(13, "Permission denied"), ConnectionError("closed"), OSError(13, "Permission denied")):
            self.assertEqual(agent.reconnect_action(exc), "retry", type(exc).__name__)

    def test_handshake_status(self):
        with self.assertRaises(agent.Rejected) as caught:
            agent.raise_for_handshake("HTTP/1.1 401 Unauthorized")
        self.assertEqual(agent.reconnect_action(caught.exception), "forget")
        with self.assertRaises(ConnectionError):
            agent.raise_for_handshake("HTTP/1.1 500 Internal Server Error")
        agent.raise_for_handshake("HTTP/1.1 101 Switching Protocols")


class Sampler(unittest.TestCase):
    def readers(self):
        counts = {k: 0 for k in ("cpu", "memory", "gpu", "temp", "battery", "disk", "uptime")}

        def bump(key, value):
            def read():
                counts[key] += 1
                return value(counts[key])

            return read

        read = {
            "cpu": bump("cpu", lambda n: n * 1.5),
            "memory": bump("memory", lambda n: ({"total": 16e9, "used": n * 1e9}, {"total": 0, "used": 0})),
            "gpu": bump("gpu", lambda n: [{"id": "g0", "index": 0, "name": "GPU", "used": n}]),
            "temp": bump("temp", lambda n: 40 + n),
            "battery": bump("battery", lambda n: []),
            "disk": bump("disk", lambda n: [{"mount": "/", "total": 1e12, "used": n * 1e9}]),
            "uptime": bump("uptime", lambda n: n * 60.0),
        }
        return counts, read

    def test_first_tick_samples_every_field(self):
        counts, read = self.readers()
        s = agent.create_sampler(now=lambda: 0, read=read)
        s.tick()
        self.assertEqual(counts["cpu"], 1)
        self.assertEqual(counts["gpu"], 1)
        self.assertEqual(counts["disk"], 1)
        self.assertEqual(s.snapshot()["cpu"], 1.5)
        self.assertEqual(s.snapshot()["gpus"][0]["used"], 1)
        self.assertEqual(s.snapshot()["uptime"], 60.0)

    def test_each_field_is_resampled_only_when_its_interval_has_elapsed(self):
        counts, read = self.readers()
        t = {"n": 0}
        s = agent.create_sampler(now=lambda: t["n"], intervals={**agent.DEFAULT_INTERVALS, "cpu": 1, "memory": 1, "gpu": 3, "temp": 5, "disk": 30, "uptime": 60}, read=read)
        s.tick()
        t["n"] = 1
        s.tick()
        self.assertEqual(counts["cpu"], 2)
        self.assertEqual(counts["gpu"], 1)
        t["n"] = 3
        s.tick()
        self.assertEqual(counts["gpu"], 2)
        self.assertEqual(counts["cpu"], 3)
        self.assertEqual(counts["temp"], 1)
        t["n"] = 5
        s.tick()
        self.assertEqual(counts["temp"], 2)

    def test_snapshot_does_not_read_hardware(self):
        counts, read = self.readers()
        s = agent.create_sampler(now=lambda: 0, read=read)
        s.tick()
        s.snapshot()
        s.snapshot()
        self.assertEqual(counts["cpu"], 1)

    def test_get_returns_cpu_without_waiting_for_slow_gpu(self):
        started = {"gpu": False}
        release = threading.Event()

        def gpu():
            started["gpu"] = True
            release.wait(1)
            return [{"id": "g0", "index": 0, "name": "GPU", "used": 9}]

        s = agent.create_sampler(now=lambda: 0, read={"cpu": lambda: 7.0, "memory": lambda: ({"total": 1, "used": 1}, {"total": 0, "used": 0}), "gpu": gpu})
        t0 = time.monotonic()
        got = s.get()
        # get() returns before the GPU read. The first sample runs on the timer, not this thread.
        self.assertLess(time.monotonic() - t0, 0.3)
        self.assertIsNone(got["cpu"])
        self.assertEqual(got["gpus"], [])
        deadline = time.monotonic() + 1
        while not started["gpu"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(started["gpu"])
        release.set()
        s.stop()

    def test_memory_is_published_with_the_disk_sample(self):
        started = threading.Event()
        release = threading.Event()

        def disk():
            started.set()
            release.wait(2)
            return [{"mount": "/", "total": 10, "used": 1}]

        s = agent.create_sampler(now=lambda: 0, read={"cpu": lambda: 1.0, "memory": lambda: ({"total": 5, "used": 1}, {"total": 0, "used": 0}), "disk": disk, "gpu": lambda: []})
        thread = threading.Thread(target=s.tick)
        thread.start()
        self.assertTrue(started.wait(1))
        self.assertEqual(s.peek()["mem"], {})
        release.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(s.peek()["mem"]["total"], 5)
        self.assertEqual(s.peek()["disks"][0]["mount"], "/")
        s.stop()

    def test_metrics_uses_the_last_snapshot(self):
        n = {"cpu": 0}

        def cpu():
            n["cpu"] += 1
            return n["cpu"]

        s = agent.create_sampler(now=lambda: 0, read={"cpu": cpu})
        s.tick()
        first = agent.metrics("pacman", sampler=s)
        second = agent.metrics("pacman", sampler=s)
        self.assertEqual(first["cpu"], 1)
        self.assertEqual(second["cpu"], 1)
        self.assertEqual(n["cpu"], 1)

    def test_idle_stops_sampling_until_the_next_read(self):
        counts, read = self.readers()
        t = {"n": 0}
        spawned = []

        def spawn(target):
            spawned.append(target)
            return object()

        s = agent.create_sampler(now=lambda: t["n"], intervals={**agent.DEFAULT_INTERVALS, "cpu": 1}, read=read, spawn=spawn)
        self.assertFalse(s.active())
        first = s.get()
        # One throwaway cpu read. The real sample waits until the next tick.
        self.assertEqual(counts["cpu"], 1)
        self.assertIsNone(first["cpu"])
        self.assertTrue(s.active())
        # The timer, and one sample that is not run on the caller.
        self.assertEqual(len(spawned), 2)
        t["n"] = 1
        self.assertTrue(s.service())
        self.assertEqual(counts["cpu"], 2)
        self.assertEqual(s.peek()["cpu"], 3.0)
        t["n"] = 1 + agent.IDLE_S
        self.assertFalse(s.service())
        self.assertFalse(s.active())
        self.assertEqual(counts["cpu"], 2)
        again = s.get()
        self.assertEqual(again["cpu"], 3.0)
        self.assertEqual(counts["cpu"], 2)
        self.assertEqual(len(spawned), 4)
        spawned[-1]()
        self.assertEqual(counts["cpu"], 3)
        s.stop()
        self.assertFalse(s.active())

    def test_watch_sends_the_last_snapshot_without_sampling_again(self):
        n = {"cpu": 0}

        def cpu():
            n["cpu"] += 1
            return float(n["cpu"])

        s = agent.create_sampler(now=lambda: 0, read={"cpu": cpu}, spawn=lambda target: object())
        s.tick()
        conn = agent.Connection({"abilities": {}})
        conn.sampler = s
        conn.pkg = "pacman"
        sent = []
        conn.send = sent.append
        conn.handle({"op": "watch"})
        self.assertEqual(sent[0]["op"], "metrics")
        self.assertEqual(sent[0]["metrics"]["cpu"], 1.0)
        self.assertEqual(n["cpu"], 1)
        self.assertTrue(s.active())

    def test_metrics_are_pushed_until_the_server_first_sends_watch(self):
        # A server older than 0.9.52 never sends watch; the connector must still report.
        s = agent.create_sampler(now=lambda: 0, read={"cpu": lambda: 1.0}, spawn=lambda target: object())
        conn = agent.Connection({"abilities": {}})
        conn.pkg = "pacman"
        sent = []
        conn.send = sent.append
        conn._report_step(s, 0, 1)
        self.assertEqual([m["op"] for m in sent], ["metrics"])
        self.assertTrue(s.active())
        # Once the server has asked with watch, pushing is driven by its reads again.
        conn.sampler = s
        conn.handle({"op": "watch"})
        sent.clear()
        s.stop()
        conn._report_step(s, 0, 1)
        self.assertEqual(sent, [])

    def test_failing_read_waits_for_its_interval(self):
        n = {"temp": 0}

        def temp():
            n["temp"] += 1
            raise RuntimeError("sensor")

        t = {"n": 0}
        s = agent.create_sampler(now=lambda: t["n"], intervals={**agent.DEFAULT_INTERVALS, "temp": 5}, read={"temp": temp, "cpu": lambda: 1.0})
        s.tick()
        self.assertEqual(n["temp"], 1)
        t["n"] = 1
        s.tick()
        self.assertEqual(n["temp"], 1)
        t["n"] = 5
        s.tick()
        self.assertEqual(n["temp"], 2)

    def test_slow_gpu_does_not_pile_up(self):
        current = {"n": 0}
        peak = {"n": 0}
        lock = threading.Lock()

        def gpu():
            with lock:
                current["n"] += 1
                peak["n"] = max(peak["n"], current["n"])
            time.sleep(0.05)
            with lock:
                current["n"] -= 1
            return []

        clock = {"n": 0.0}
        s = agent.Sampler(now=lambda: clock["n"], read={"cpu": lambda: 1.0, "gpu": gpu})
        for _ in range(8):
            clock["n"] += 1.0
            s.tick(wait_gpu=False)
        time.sleep(0.2)
        self.assertEqual(peak["n"], 1)

    def test_clock_step_back_does_not_freeze_samples(self):
        clock = {"n": 1_000_000.0}
        n = {"cpu": 0}

        def cpu():
            n["cpu"] += 1
            return float(n["cpu"])

        s = agent.Sampler(now=lambda: clock["n"], read={"cpu": cpu})
        s.tick()
        clock["n"] -= 3600
        for _ in range(5):
            clock["n"] += 1
            s.tick()
        self.assertEqual(n["cpu"], 6)

    def test_default_clock_is_monotonic(self):
        mono = {"n": 0.0}
        wall = {"n": 10_000.0}
        n = {"cpu": 0}
        real_mono, real_time = time.monotonic, time.time
        time.monotonic = lambda: mono["n"]
        time.time = lambda: wall["n"]
        try:
            s = agent.create_sampler(read={"cpu": lambda: n.__setitem__("cpu", n["cpu"] + 1) or float(n["cpu"])})
            s.tick()
            wall["n"] -= 3600
            s.tick()
            self.assertEqual(n["cpu"], 1)
            mono["n"] += 1
            s.tick()
            self.assertEqual(n["cpu"], 2)
        finally:
            time.monotonic = real_mono
            time.time = real_time


class CpuPercent(unittest.TestCase):
    def tearDown(self):
        agent._cpu_last = None

    def test_guest_time_is_not_counted_twice(self):
        agent._cpu_last = None
        lines = iter(["cpu 0 0 0 0 0 0 0 0 0 0\n", "cpu 50 0 0 50 0 0 0 0 50 0\n"])
        orig = agent.read

        def read(path, default=""):
            if path == "/proc/stat":
                return next(lines)
            return orig(path, default)

        agent.read = read
        try:
            self.assertIsNone(agent.cpu_percent())
            self.assertEqual(agent.cpu_percent(), 50.0)
        finally:
            agent.read = orig

    def test_a_falling_iowait_counter_cannot_push_it_past_100(self):
        agent._cpu_last = None
        lines = iter(["cpu  1000 0 500 8000 200 0 0 0 0 0\n", "cpu  1700 0 600 8000 170 0 0 0 0 0\n"])
        orig = agent.read

        def read(path, default=""):
            if path == "/proc/stat":
                return next(lines)
            return orig(path, default)

        agent.read = read
        try:
            self.assertIsNone(agent.cpu_percent())
            self.assertEqual(agent.cpu_percent(), 100.0)
        finally:
            agent.read = orig


if __name__ == "__main__":
    unittest.main(verbosity=2)
