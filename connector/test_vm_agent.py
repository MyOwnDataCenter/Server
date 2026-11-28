import json
import os
import unittest

from agent import ABILITY_NAMES, open_guest_vnc, supported_abilities, vm_call


class VmAgent(unittest.TestCase):
    def test_ability_and_dispatch(self):
        self.assertIn("vms", ABILITY_NAMES)
        win = supported_abilities({"vms": True, "terminal": True}, windows=True)
        self.assertFalse(win["vms"])
        mac = supported_abilities({"vms": True}, mac=True)
        self.assertFalse(mac["vms"])
        spawned = []

        def spawn(argv, stdin=None):
            spawned.append((argv, stdin))
            if argv[-3] == "fetch":
                return "PROGRESS 40\nPROGRESS 100\n", "/data/vm-images/debian-12"
            return "", "ok"

        progress = []
        with self.assertRaises(RuntimeError) as off:
            vm_call("vm-status", {}, allowed={"vms": False}, spawn=spawn, progress=progress.append)
        self.assertIn("doesn’t allow virtual machines", str(off.exception))
        self.assertEqual(spawned, [])
        out = vm_call("vm-fetch", {"imageId": "debian-12", "catalogUrl": "https://example.test/catalog.json"}, allowed={"vms": True}, spawn=spawn, progress=progress.append)
        self.assertEqual(out, "/data/vm-images/debian-12")
        self.assertEqual(progress, [0.4, 1.0])
        argv = spawned[-1][0]
        self.assertNotIn("sh", argv)
        self.assertNotIn("sudo", argv)
        self.assertEqual(argv[-3:], ["fetch", "debian-12", "https://example.test/catalog.json"])
        with self.assertRaises(RuntimeError):
            vm_call("vm-fetch", {"imageId": "debian-12", "catalogUrl": "https://evil.test/a b"}, allowed={"vms": True}, spawn=spawn)
        with self.assertRaises(RuntimeError):
            vm_call("vm-nope", {}, allowed={"vms": True}, spawn=spawn)

    def test_guest_vnc_uses_the_helper_socket_not_the_desktop(self):
        import socket
        import tempfile
        d = tempfile.mkdtemp()
        guest = "abcd1234"
        sock_dir = os.path.join(d, "vms", guest)
        os.makedirs(sock_dir)
        path = os.path.join(sock_dir, "vnc.sock")
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(path)
        srv.listen(1)
        seen = []

        def run(argv, stdin=None):
            seen.append(argv)
            return "", path + "\n"

        class Conn:
            sent = []
            def send(self, msg):
                self.sent.append(msg)

        conn = Conn()
        # open_guest_vnc returns the connected client socket or raises
        client = open_guest_vnc(conn, 7, "abcd1234", d, run)
        self.assertTrue(any(a[-2:] == ["vnc-path", "abcd1234"] for a in seen))
        self.assertFalse(any("wayvnc" in " ".join(a) for a in seen))
        with self.assertRaises(RuntimeError):
            open_guest_vnc(conn, 8, "../abcd1234", d, run)
        client.close()
        srv.close()


if __name__ == "__main__":
    unittest.main()
