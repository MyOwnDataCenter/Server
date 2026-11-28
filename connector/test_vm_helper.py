import importlib.util
import json
import os
import sys
import tempfile
import unittest

# vm-helper.py cannot be imported by name. Register it as vm_helper first.
_helper_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vm-helper.py")
if os.path.exists(_helper_path):
    _spec = importlib.util.spec_from_file_location("vm_helper", _helper_path)
    _module = importlib.util.module_from_spec(_spec)
    sys.modules["vm_helper"] = _module
    _spec.loader.exec_module(_module)

from vm_helper import HelperError, handle


class Status(unittest.TestCase):
    def test_status_and_rejections(self):
        log = []

        def run(cmd, args, input=None):
            log.append([cmd, *args])
            if cmd == "virsh" and args == ["--version"]:
                return "10.0.0\n"
            if cmd == "qemu-img" and args == ["--version"]:
                return "qemu-img version 9.0.0\n"
            if cmd == "qemu-system-x86_64":
                return '"bochs-display"\n'
            return ""

        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "vm-images"))
            out = handle("status", [], run=run, data_dir=d, kvm_path=os.path.join(d, "no-kvm"), uid=1000, uname="x86_64", meminfo="MemTotal: 8000000 kB\n")
        body = json.loads(out)
        self.assertEqual(body["libvirt"], True)
        self.assertEqual(body["kvm"], False)
        self.assertEqual(body["arch"], "amd64")
        self.assertIn("vga", body["videoModels"])
        self.assertIn("bochs", body["videoModels"])
        self.assertTrue(all(c[0] != "sh" for c in log))

        with self.assertRaises(HelperError):
            handle("status", [], uid=0)
        with self.assertRaises(HelperError) as unk:
            handle("rm", ["-rf", "/"])
        self.assertIn("Unknown action", str(unk.exception))
        with self.assertRaises(HelperError):
            handle("fetch", ["../etc/passwd", "https://example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("fetch", ["debian-12", "http://example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("fetch", ["debian-12", "https://user:pw@example.test/c.json"], uid=1000)
        with self.assertRaises(HelperError):
            handle("start", ["not-an-id"], uid=1000)


class Lifecycle(unittest.TestCase):
    def test_fetch_disk_seed_define_power_and_ga(self):
        log = []
        files = {}

        def run(cmd, args, input=None):
            log.append([cmd, *args])
            if cmd == "virsh" and args[:2] == ["-c", "qemu:///session"] and args[2] == "list":
                return " Id   Name              State\n---------------------------------\n -    omarchy-abcd1234   shut off\n -    win11             shut off\n"
            if cmd == "virsh" and "domuuid" in args:
                raise HelperError("no domain")
            if cmd == "virsh" and "qemu-agent-command" in args:
                return args[-1]
            return ""

        with tempfile.TemporaryDirectory() as d:
            # checksum of b"image-bytes"
            import hashlib
            digest = hashlib.sha256(b"image-bytes").hexdigest()
            catalog = json.dumps({"version": 1, "images": [{"id": "debian-12", "arch": "amd64", "kind": "cloud", "url": "https://example.test/os.qcow2", "sha256": digest}]}).encode()

            def fetch_ok(url):
                if url.endswith("catalog.json"):
                    return catalog
                return b"image-bytes"

            path = handle("fetch", ["debian-12", "https://example.test/catalog.json"], run=run, fetch=fetch_ok, data_dir=d, uid=1000, uname="x86_64")
            self.assertTrue(path.endswith("/vm-images/debian-12"))
            bad = json.dumps({"version": 1, "images": [{"id": "debian-12", "arch": "amd64", "kind": "cloud", "url": "https://example.test/os.qcow2", "sha256": "00" * 32}]}).encode()
            with self.assertRaises(HelperError) as mismatch:
                handle("fetch", ["debian-12", "https://example.test/catalog.json"], run=run, fetch=lambda url: bad if url.endswith("catalog.json") else b"image-bytes", data_dir=d, uid=1000)
            self.assertIn("checksum", str(mismatch.exception))

            handle("disk-create", ["abcd1234", "8", "debian-12"], run=run, data_dir=d, uid=1000)
            self.assertTrue(any(c[0] == "qemu-img" and "convert" in c for c in log))
            self.assertTrue(os.path.exists(os.path.join(d, "vms", "abcd1234", "disk.qcow2")))
            seed = json.dumps({"label": "cidata", "files": {"user-data": "#cloud-config\n", "meta-data": "instance-id: abcd1234\n"}})
            handle("seed", ["abcd1234", "seed"], stdin=seed, run=run, data_dir=d, uid=1000)
            self.assertTrue(any(c[0] == "xorriso" and "cidata" in c for c in log))
            spec = {
                "id": "abcd1234", "name": "Box", "memoryMb": 2048, "sockets": 1, "cores": 2,
                "cpuType": "host", "mac": "52:54:00:11:22:33", "firmware": "bios", "arch": "amd64",
                "machineType": "q35", "nic": "virtio", "video": "vga", "kvm": False, "tablet": True,
                "acpi": True, "agent": True, "bootMenu": False, "notes": "", "linkDown": False,
                "boot": ["disk0"],
                "disks": [
                    {"id": "disk0", "device": "disk", "bus": "virtio", "format": "qcow2", "file": "disk.qcow2"},
                    {"id": "seed", "device": "cdrom", "bus": "sata", "format": "raw", "role": "seed", "file": "seed.iso"},
                ],
                "portForwards": [{"protocol": "tcp", "hostPort": 40022, "guestPort": 22}],
            }
            # seed.iso is the xorriso output; fake run doesn't write it
            open(os.path.join(d, "vms", "abcd1234", "seed.iso"), "wb").close()
            handle("define", ["abcd1234"], stdin=json.dumps(spec), run=run, data_dir=d, uid=1000, uname="x86_64", kvm_path=os.path.join(d, "no-kvm"))
            with open(os.path.join(d, "vms", "abcd1234", "domain.xml"), encoding="utf-8") as xml_file:
                xml = xml_file.read()
            self.assertIn("<backend type='passt'/>", xml)
            self.assertIn("vnc.sock", xml)
            self.assertNotIn("port=", xml.split("<graphics")[1].split("/>")[0])
            self.assertIn("org.qemu.guest_agent.0", xml)
            define = [c for c in log if c[0] == "virsh" and "define" in c][-1]
            self.assertEqual(define[1:3], ["-c", "qemu:///session"])
            listed = json.loads(handle("state", [], run=run, data_dir=d, uid=1000))
            self.assertEqual(listed, {"omarchy-abcd1234": "shut off"})
            self.assertNotIn("win11", listed)
            secret = "sudo-secret"
            payload = json.dumps({"path": "/usr/bin/sudo", "args": ["-S", "true"], "input": secret, "capture": True})
            out = handle("ga-exec", ["abcd1234"], stdin=payload, run=run, data_dir=d, uid=1000)
            ga = [c for c in log if "qemu-agent-command" in c][-1]
            blob = ga[-1]
            self.assertNotIn(secret, " ".join(ga[:-1]))
            self.assertNotIn(secret, blob)
            body = json.loads(blob)
            self.assertEqual(body["execute"], "guest-exec")
            import base64
            self.assertEqual(base64.b64decode(body["arguments"]["input-data"]).decode(), secret)


class BadBootList(unittest.TestCase):
    def test_boot_entries_that_are_not_text_get_a_plain_error(self):
        spec = {
            "id": "abcd1234", "name": "Box", "memoryMb": 2048, "sockets": 1, "cores": 2,
            "cpuType": "host", "mac": "52:54:00:11:22:33", "firmware": "bios", "arch": "amd64",
            "machineType": "q35", "nic": "virtio", "video": "vga", "kvm": False, "tablet": True,
            "acpi": True, "agent": False, "bootMenu": False, "notes": "",
            "disks": [{"id": "disk0", "device": "disk", "bus": "virtio", "format": "qcow2", "file": "disk.qcow2"}],
        }
        for boot in ([["disk0"]], [{"a": 1}], [1], [None]):
            with self.subTest(boot=boot):
                with self.assertRaises(HelperError) as err:
                    handle("define", ["abcd1234"], stdin=json.dumps(dict(spec, boot=boot)), uid=1000, uname="x86_64")
                self.assertIn("Invalid boot", str(err.exception))


class SeedFileNames(unittest.TestCase):
    def test_a_seed_file_name_that_starts_with_a_dash_is_refused(self):
        # The names are handed to xorriso as arguments, where a leading dash is an option.
        calls = []

        def run(cmd, args, input=None):
            calls.append([cmd, *args])
            return ""

        with tempfile.TemporaryDirectory() as d:
            for name in ("-quiet", "-o", "--help"):
                body = json.dumps({"label": "cidata", "files": {"user-data": "#cloud-config\n", name: "x"}})
                with self.assertRaises(HelperError) as err:
                    handle("seed", ["abcd1234", "seed"], stdin=body, run=run, data_dir=d, uid=1000)
                self.assertIn("Invalid seed", str(err.exception))
        self.assertEqual(calls, [])


class GuestExecPath(unittest.TestCase):
    def test_basename_commands_and_rejections(self):
        log = []

        def run(cmd, args, input=None):
            log.append(args[-1] if args else "")
            if cmd == "virsh" and "qemu-agent-command" in args:
                return '{"return":{"pid":7}}'
            return ""

        with tempfile.TemporaryDirectory() as d:
            for path in ("loginctl", "bash", "runuser", "powershell.exe", "/usr/bin/sudo"):
                out = handle(
                    "ga-exec",
                    ["abcd1234"],
                    stdin=json.dumps({"path": path, "args": ["-n"]}),
                    run=run,
                    data_dir=d,
                    uid=1000,
                )
                self.assertEqual(json.loads(out)["pid"], 7)
                body = json.loads(log[-1])
                self.assertEqual(body["arguments"]["path"], path)
            for path in ("../bin/sh", "bash -c", "", "/tmp/foo bar", ".", "..", "C:\\Windows\\System32\\powershell.exe"):
                with self.assertRaises(HelperError) as err:
                    handle("ga-exec", ["abcd1234"], stdin=json.dumps({"path": path}), run=run, data_dir=d, uid=1000)
                self.assertIn("Invalid path", str(err.exception))


if __name__ == "__main__":
    unittest.main()
