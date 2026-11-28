#!/usr/bin/env python3
"""Physical NICs and Wake-on-LAN relay on the connector."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "connector"))
import agent  # noqa: E402


def files_for(layout):
    """layout: name -> {entries: [sysfs names], address: mac}"""

    def list_dir(path):
        path = path.rstrip("/")
        if path == "/sys/class/net":
            return list(layout)
        name = path.rsplit("/", 1)[-1]
        if name in layout:
            return layout[name]["entries"]
        return []

    def read_file(path, default=""):
        name = path.split("/")[4] if path.startswith("/sys/class/net/") else ""
        if path.endswith("/address") and name in layout:
            return layout[name].get("address", "")
        return default

    return list_dir, read_file


class Nics(unittest.TestCase):
    def test_physical_ethernet_and_wifi_only(self):
        layout = {
            "lo": {"entries": ["address"], "address": "00:00:00:00:00:00"},
            "enp3s0": {"entries": ["address", "device"], "address": "AA:BB:CC:DD:EE:01\n"},
            "wlan0": {"entries": ["address", "wireless"], "address": "aa:bb:cc:dd:ee:02\n"},
            "docker0": {"entries": ["address", "bridge"], "address": "02:42:00:00:00:01\n"},
            "tailscale0": {"entries": ["address"], "address": "00:00:00:00:00:00\n"},
            "br-lan": {"entries": ["address", "bridge"], "address": "aa:aa:aa:aa:aa:01\n"},
            "vethabc": {"entries": ["address"], "address": "ee:ee:ee:ee:ee:01\n"},
            "wg0": {"entries": ["address"], "address": "00:00:00:00:00:00\n"},
        }
        list_dir, read_file = files_for(layout)
        ip = json.dumps([
            {"ifname": "enp3s0", "addr_info": [{"family": "inet", "local": "192.168.84.10", "prefixlen": 24}]},
            {"ifname": "wlan0", "addr_info": [{"family": "inet", "local": "10.0.1.20", "prefixlen": 24}]},
            {"ifname": "docker0", "addr_info": [{"family": "inet", "local": "172.17.0.1", "prefixlen": 16}]},
        ])
        nics = agent.collect_nics(list_dir, read_file, ip)
        self.assertEqual([n["mac"] for n in nics], ["aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"])
        self.assertEqual(nics[0]["broadcasts"], ["192.168.84.255"])
        self.assertEqual(nics[1]["broadcasts"], ["10.0.1.255"])

    def test_send_one_packet_per_mac_per_subnet(self):
        sent = []
        n = agent.send_wol(
            ["aa:bb:cc:dd:ee:0f", "11:22:33:44:55:66"],
            [{"broadcasts": ["192.168.84.255", "10.0.1.255"]}],
            lambda packet, dest: sent.append((len(packet), dest)),
        )
        self.assertEqual(n, 4)
        self.assertEqual(sent[0][0], 102)
        self.assertEqual({d for _, d in sent}, {("192.168.84.255", 9), ("10.0.1.255", 9)})

    def test_wol_does_not_need_manage(self):
        conn = agent.Connection({"abilities": {}})
        sent = []
        conn.send = lambda msg: sent.append(msg)
        orig = agent.wol_action
        agent.wol_action = lambda args: {"sent": 1}
        try:
            conn.call({"name": "wol", "id": 7, "args": {"macs": ["aa:bb:cc:dd:ee:01"]}})
        finally:
            agent.wol_action = orig
        self.assertEqual(sent[0]["ok"], True)
        self.assertEqual(sent[0]["id"], 7)
        sent.clear()
        conn.call({"name": "reboot", "id": 8, "args": {}})
        self.assertEqual(sent[0]["ok"], False)
        self.assertIn("managing", sent[0]["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
