import copy
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

LSBLK = {
    "blockdevices": [
        {"name": "nvme0n1", "path": "/dev/nvme0n1", "type": "disk", "size": 512000000000, "children": [
            {"name": "nvme0n1p2", "path": "/dev/nvme0n1p2", "type": "part", "fstype": "btrfs", "uuid": "11111111-1111-1111-1111-111111111111", "mountpoints": ["/", "/home"]}
        ]},
        {"name": "sda", "path": "/dev/sda", "type": "disk", "size": 4000000000000, "rota": True, "serial": "WD-A", "children": []},
        {"name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 4000000000000, "rota": True, "serial": "WD-B", "children": []},
        {"name": "sdc", "path": "/dev/sdc", "type": "disk", "size": 2000000000000, "model": "WDC  ", "serial": "WD123", "rota": True, "tran": "sata", "children": [
            {"name": "sdc1", "path": "/dev/sdc1", "type": "part", "fstype": "ntfs", "mountpoints": [None]}
        ]},
        {"name": "sdd", "path": "/dev/sdd", "type": "disk", "size": 500000000000, "rota": False, "serial": "SSD-1", "children": []},
        {"name": "sde", "path": "/dev/sde", "type": "disk", "size": 1000000000000, "rota": True, "serial": "WD-E", "children": [
            {"name": "sde1", "path": "/dev/sde1", "type": "part", "fstype": "btrfs", "uuid": "44444444-4444-4444-4444-444444444444", "label": "old", "mountpoints": [None]}
        ]},
        {"name": "loop0", "path": "/dev/loop0", "type": "disk", "size": 1000000, "children": []},
    ]
}


class Fake:
    def __init__(self, lsblk=None):
        self.log = []
        self.files = {"/etc/fstab": "UUID=1111 / btrfs defaults 0 0\n"}
        self.lsblk = lsblk if lsblk is not None else LSBLK

    def run(self, cmd, args):
        self.log.append([cmd, *args])
        if cmd == "lsblk":
            return json.dumps(self.lsblk)
        if cmd == "wipefs":
            return json.dumps({"signatures": []})
        if cmd == "blkid":
            return "33333333-3333-3333-3333-333333333333\n"
        if cmd == "zpool":
            raise Exception("zpool: not found")
        if cmd == "btrfs":
            if args[:2] == ["filesystem", "df"]:
                return "Data, RAID1: total=100, used=10\n"
            if args[:2] == ["device", "stats"]:
                return "[/dev/sda].write_io_errs  0\n[/dev/sdb].write_io_errs  0\n"
            if args[:2] == ["scrub", "status"]:
                return "Status: never\nError summary: no errors found\n"
            return ""
        return ""


def zfs_member_lsblk():
    tree = copy.deepcopy(LSBLK)
    sdb = next(d for d in tree["blockdevices"] if d["path"] == "/dev/sdb")
    sdb["children"] = [{
        "name": "sdb1",
        "path": "/dev/sdb1",
        "type": "part",
        "fstype": "zfs_member",
        "label": "tank",
        "uuid": "111",
        "mountpoints": [None],
    }]
    return tree


def run_with_zpool_list(fake, text):
    def run(cmd, args):
        if cmd == "zpool" and list(args)[:4] == ["list", "-H", "-o", "name"]:
            fake.log.append([cmd, *list(args)])
            return text
        if cmd == "zpool" and list(args)[:1] == ["get"] and "guid" in list(args):
            fake.log.append([cmd, *list(args)])
            return "111\n" if str(text).strip() else ""
        return fake.run(cmd, args)

    return run


class Helper(unittest.TestCase):
    def setUp(self):
        from helper import handle
        self.handle = handle
        self.fake = Fake()
        self.kw = dict(run=self.fake.run, user={"name": "chris", "uid": 1000, "home": "/home/chris"}, files=self.fake.files)

    def test_ping(self):
        self.assertEqual(self.handle("ping", [], **self.kw), "ok")

    def test_refuse_system_and_junk(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("format", ["/dev/nvme0n1", "blank"], **self.kw)
        with self.assertRaisesRegex(Exception, "Not a drive"):
            self.handle("format", ["../../etc/passwd", "blank"], **self.kw)
        with self.assertRaisesRegex(Exception, "blank, ext4 or exfat"):
            self.handle("format", ["/dev/sdc", "ntfs"], **self.kw)
        self.assertFalse(any(x[0] == "wipefs" for x in self.fake.log))

    def test_format_refuses_disks_in_use_by_encryption_lvm_or_raid(self):
        from helper import HelperError
        busy = copy.deepcopy(LSBLK)
        busy["blockdevices"].append({"name": "sdf", "path": "/dev/sdf", "type": "disk", "size": 4000000000000, "children": [
            {"name": "sdf1", "path": "/dev/sdf1", "type": "part", "fstype": "crypto_LUKS", "mountpoints": [None], "children": [
                {"name": "luks-x", "path": "/dev/mapper/luks-x", "type": "crypt", "fstype": "ext4", "mountpoints": [None]}]}]})
        busy["blockdevices"].append({"name": "sdg", "path": "/dev/sdg", "type": "disk", "size": 4000000000000, "fstype": "linux_raid_member", "children": [
            {"name": "md0", "path": "/dev/md0", "type": "raid1", "mountpoints": [None]}]})
        fake = Fake(busy)
        kw = dict(self.kw, run=fake.run, files=fake.files)
        for dev in ("/dev/sdf", "/dev/sdg"):
            with self.assertRaisesRegex(HelperError, "encryption, LVM or RAID"):
                self.handle("format", [dev, "blank"], **kw)
        self.assertFalse(any(c[0] == "wipefs" and "-a" in c for c in fake.log))

    def test_format_blank_then_ext4(self):
        self.assertEqual(self.handle("format", ["/dev/sdc", "blank"], **self.kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdc"], self.fake.log)
        self.fake.log.clear()
        self.handle("format", ["/dev/sdc", "ext4"], **self.kw)
        self.assertTrue(any(x[0] == "mkfs.ext4" for x in self.fake.log))

    def test_disks_roles_and_skips_loop(self):
        out = json.loads(self.handle("disks", [], **self.kw))
        names = [d["name"] for d in out]
        self.assertNotIn("loop0", names)
        by = {d["name"]: d for d in out}
        self.assertEqual(by["nvme0n1"]["role"], "system")
        self.assertTrue(by["nvme0n1"]["mounted"])
        self.assertIn("/", by["nvme0n1"]["mounts"])
        self.assertEqual(by["sdc"]["role"], "data")
        self.assertFalse(by["sdc"]["mounted"])
        self.assertEqual(by["sdc"]["path"], "/dev/sdc")
        self.assertTrue(by["sdc"]["id"])
        self.assertEqual(by["sdc"]["model"], "WDC")
        self.assertEqual(by["sdc"]["kind"], "hdd")
        self.assertIn("mounted", by["sdc"])
        self.assertIn("health", by["sdc"])

    def test_pool_create_blank_only_writes_fstab(self):
        with self.assertRaisesRegex(Exception, "Pool names"):
            self.handle("pool-create", ["Bad Name", "single", "/dev/sda"], **self.kw)
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("pool-create", ["tank", "single", "/dev/nvme0n1"], **self.kw)
        with self.assertRaisesRegex(Exception, "isn’t blank"):
            self.handle("pool-create", ["tank", "single", "/dev/sdc"], **self.kw)
        self.assertFalse(any(x[0] == "mkfs.btrfs" for x in self.fake.log))
        out = json.loads(self.handle("pool-create", ["tank", "raid1", "/dev/sda", "/dev/sdb"], **self.kw))
        self.assertEqual(out["mountpoint"], "/home/chris/Pools/tank")
        self.assertTrue(any(x[0] == "mkfs.btrfs" and "raid1" in x and "/dev/sda" in x for x in self.fake.log))
        self.assertIn("# omarchy-connector pool tank", self.fake.files["/etc/fstab"])
        self.assertIn("/home/chris/Pools/tank", self.fake.files["/etc/fstab"])
        self.assertTrue(any(x[0] == "mount" and "/home/chris/Pools/tank" in x for x in self.fake.log))

    def test_sleep_hdd_writes_udev_and_refuses_system(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("sleep", ["/dev/nvme0n1", "20"], **self.kw)
        with self.assertRaisesRegex(Exception, "Only spinning"):
            self.handle("sleep", ["/dev/sdd", "20"], **self.kw)
        with self.assertRaisesRegex(Exception, "0, 10, 20"):
            self.handle("sleep", ["/dev/sda", "15"], **self.kw)
        self.assertEqual(self.handle("sleep", ["/dev/sda", "20"], **self.kw), "ok")
        self.assertIn(["hdparm", "-S", "240", "/dev/sda"], self.fake.log)
        udev = self.fake.files["/etc/udev/rules.d/69-omarchy-connector-sleep.rules"]
        self.assertIn('ENV{ID_SERIAL_SHORT}=="WD-A"', udev)
        self.assertIn("hdparm -S 240", udev)
        disks = json.loads(self.handle("disks", [], **self.kw))
        by = {d["name"]: d for d in disks}
        self.assertEqual(by["sda"]["sleepMinutes"], 20)

    def test_zfs_available_is_no_when_zpool_missing(self):
        self.assertEqual(self.handle("zfs-available", [], **self.kw), "no")

    def test_pools_and_importable_match_host_shape(self):
        self.handle("pool-create", ["tank", "raid1", "/dev/sda", "/dev/sdb"], **self.kw)
        pools = json.loads(self.handle("pools", [], **self.kw))
        self.assertEqual(len(pools), 1)
        p = pools[0]
        self.assertEqual(p["kind"], "btrfs")
        self.assertEqual(p["name"], "tank")
        self.assertEqual(p["uuid"], "33333333-3333-3333-3333-333333333333")
        self.assertEqual(p["mountpoint"], "/home/chris/Pools/tank")
        self.assertEqual(p["folder"], "/Home/Pools/tank")
        found = json.loads(self.handle("importable", [], **self.kw))
        self.assertTrue(any(i["kind"] == "btrfs" and i["uuid"] == "44444444-4444-4444-4444-444444444444" for i in found))

    def test_mount_refuses_system_pool_blank_mounted_and_junk(self):
        with self.assertRaisesRegex(Exception, "holds the system"):
            self.handle("mount", ["/dev/nvme0n1"], **self.kw)
        self.fake.files["/etc/fstab"] = "UUID=44444444-4444-4444-4444-444444444444 /home/chris/Pools/old btrfs d 0 0 # omarchy-connector pool old\n"
        with self.assertRaisesRegex(Exception, "is in a pool"):
            self.handle("mount", ["/dev/sde"], **self.kw)
        with self.assertRaisesRegex(Exception, "Nothing to mount"):
            self.handle("mount", ["/dev/sdb"], **self.kw)
        with self.assertRaisesRegex(Exception, "Not a drive"):
            self.handle("mount", ["/etc/passwd"], **self.kw)
        mounted = copy.deepcopy(LSBLK)
        mounted["blockdevices"][3]["children"][0]["mountpoints"] = ["/run/media/chris/WINDOWS"]
        fake = Fake(mounted)
        kw = dict(run=fake.run, user=self.kw["user"], files=fake.files)
        with self.assertRaisesRegex(Exception, "already mounted"):
            self.handle("mount", ["/dev/sdc"], **kw)
        self.assertFalse(any(x[0] == "mount" for x in fake.log))

    def test_mount_ntfs_and_btrfs_at_run_media(self):
        self.assertEqual(self.handle("mount", ["/dev/sdc"], **self.kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev,uid=1000,gid=1000", "/dev/sdc1", "/run/media/chris/sdc1"], self.fake.log)
        self.fake.log.clear()
        self.assertEqual(self.handle("mount", ["/dev/sde"], **self.kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev", "/dev/sde1", "/run/media/chris/old"], self.fake.log)

    def test_mount_fat_chown_after_mount_is_skipped(self):
        mounted = set()
        chowns = []

        def run(cmd, args):
            if cmd == "mount":
                mounted.add(args[-1])
            return self.fake.run(cmd, args)

        def chown(path, uid, gid):
            if path in mounted:
                raise OSError(1, "Operation not permitted")
            chowns.append((path, uid, gid))

        kw = dict(self.kw, run=run, chown=chown)
        self.assertEqual(self.handle("mount", ["/dev/sdc"], **kw), "ok")
        self.assertIn(("/run/media/chris/sdc1", 1000, 1000), chowns)
        self.assertIn(("/run/media/chris", 1000, 1000), chowns)


    def test_mount_skips_luks_and_swap(self):
        lsblk = copy.deepcopy(LSBLK)
        lsblk["blockdevices"].append({
            "name": "sdf", "path": "/dev/sdf", "type": "disk", "size": 1000000000, "children": [
                {"name": "sdf1", "path": "/dev/sdf1", "type": "part", "fstype": "crypto_LUKS", "mountpoints": [None]},
                {"name": "sdf2", "path": "/dev/sdf2", "type": "part", "fstype": "swap", "mountpoints": [None]},
                {"name": "sdf3", "path": "/dev/sdf3", "type": "part", "fstype": "LVM2_member", "mountpoints": [None]},
            ]
        })
        fake = Fake(lsblk)
        kw = dict(run=fake.run, user=self.kw["user"], files=fake.files)
        with self.assertRaisesRegex(Exception, "Nothing to mount"):
            self.handle("mount", ["/dev/sdf"], **kw)
        self.assertFalse(any(x[0] == "mount" for x in fake.log))

    def test_mount_sanitizes_label(self):
        lsblk = copy.deepcopy(LSBLK)
        lsblk["blockdevices"].append({
            "name": "sdg", "path": "/dev/sdg", "type": "disk", "size": 1000000000, "fstype": "ext4",
            "uuid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "label": "My Disk / 2", "mountpoints": [None], "children": [],
        })
        fake = Fake(lsblk)
        kw = dict(run=fake.run, user=self.kw["user"], files=fake.files)
        self.assertEqual(self.handle("mount", ["/dev/sdg"], **kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev", "/dev/sdg", "/run/media/chris/My_Disk_2"], fake.log)

    def test_names_and_ids_with_a_trailing_newline_are_refused(self):
        # "$" matches just before a final newline, which would put a second fstab or udev line in.
        with self.assertRaisesRegex(Exception, "Pool names"):
            self.handle("pool-create", ["tank\n", "single", "/dev/sda"], **self.kw)
        self.assertEqual(self.fake.files["/etc/fstab"], "UUID=1111 / btrfs defaults 0 0\n")
        with self.assertRaisesRegex(Exception, "Pool names"):
            self.handle("pool-import", ["old\n", "44444444-4444-4444-4444-444444444444"], **self.kw)
        with self.assertRaisesRegex(Exception, "Choose a filesystem"):
            self.handle("pool-import", ["old", "44444444-4444-4444-4444-444444444444\n"], **self.kw)
        with self.assertRaisesRegex(Exception, "Not a drive"):
            self.handle("smart", ["/dev/sda\n"], **self.kw)
        lsblk = copy.deepcopy(LSBLK)
        next(d for d in lsblk["blockdevices"] if d["path"] == "/dev/sda")["serial"] = "WD-A\n"
        fake = Fake(lsblk)
        kw = dict(run=fake.run, user=self.kw["user"], files=fake.files)
        with self.assertRaisesRegex(Exception, "serial number"):
            self.handle("sleep", ["/dev/sda", "10"], **kw)
        self.assertFalse(any(x[0] == "hdparm" for x in fake.log))

    def test_pool_add_forget_and_scrub(self):
        self.handle("pool-create", ["tank", "single", "/dev/sda"], **self.kw)
        self.assertEqual(self.handle("pool-add", ["tank", "/dev/sdb"], **self.kw), "ok")
        self.assertTrue(any(x[:3] == ["btrfs", "device", "add"] and "/dev/sdb" in x for x in self.fake.log))
        self.assertEqual(self.handle("pool-scrub", ["tank"], **self.kw), "ok")
        self.assertTrue(any(x[:3] == ["btrfs", "scrub", "start"] for x in self.fake.log))
        self.assertEqual(self.handle("pool-forget", ["tank"], **self.kw), "ok")
        self.assertNotIn("# omarchy-connector pool tank", self.fake.files["/etc/fstab"])

    def test_format_and_umount_refuse_imported_zfs_pool(self):
        fake = Fake(zfs_member_lsblk())
        kw = dict(run=run_with_zpool_list(fake, "tank\n"), user=self.kw["user"], files=fake.files)
        with self.assertRaisesRegex(Exception, r"/dev/sdb is in a pool"):
            self.handle("format", ["/dev/sdb", "blank"], **kw)
        with self.assertRaisesRegex(Exception, r"/dev/sdb is in a pool"):
            self.handle("umount", ["/dev/sdb"], **kw)
        self.assertFalse(any(c[0] == "wipefs" and "-a" in c for c in fake.log))

    def test_format_allows_zfs_member_when_pool_not_imported(self):
        tree = zfs_member_lsblk()
        missing = Fake(tree)
        kw = dict(run=missing.run, user=self.kw["user"], files=missing.files)
        self.assertEqual(self.handle("format", ["/dev/sdb", "blank"], **kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdb"], missing.log)
        empty = Fake(tree)
        kw = dict(run=run_with_zpool_list(empty, ""), user=self.kw["user"], files=empty.files)
        self.assertEqual(self.handle("format", ["/dev/sdb", "blank"], **kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdb"], empty.log)

    def test_mmcblk_whole_disks_allowed_and_boot_rpmb_hidden(self):
        from helper import HelperError
        lsblk = {
            "blockdevices": [
                {
                    "name": "mmcblk0", "path": "/dev/mmcblk0", "type": "disk", "size": 62534975488, "rota": False, "tran": "mmc", "serial": "SD1",
                    "children": [{"name": "mmcblk0p1", "path": "/dev/mmcblk0p1", "type": "part", "fstype": "exfat", "label": "SDCARD", "mountpoints": [None]}],
                },
                {"name": "mmcblk0boot0", "path": "/dev/mmcblk0boot0", "type": "disk", "size": 4194304, "rota": False, "mountpoints": [None]},
                {"name": "mmcblk0boot1", "path": "/dev/mmcblk0boot1", "type": "disk", "size": 4194304, "rota": False, "mountpoints": [None]},
                {"name": "mmcblk0rpmb", "path": "/dev/mmcblk0rpmb", "type": "disk", "size": 4194304, "rota": False, "mountpoints": [None]},
            ]
        }
        mounted = [False]
        log = []

        def run(cmd, args):
            log.append([cmd, *args])
            if cmd == "lsblk":
                data = copy.deepcopy(lsblk)
                if mounted[0]:
                    data["blockdevices"][0]["children"][0]["mountpoints"] = ["/run/media/chris/SDCARD"]
                return json.dumps(data)
            if cmd == "wipefs":
                return json.dumps({"signatures": []})
            if cmd == "zpool":
                raise HelperError("zpool: not found")
            if cmd == "smartctl":
                return json.dumps({"smart_status": {"passed": True}})
            return ""

        kw = dict(run=run, user=self.kw["user"], files={})
        disks = json.loads(self.handle("disks", [], **kw))
        self.assertEqual([(d["name"], d["role"]) for d in disks], [("mmcblk0", "data")])
        for bad in ("/dev/mmcblk0p1", "/dev/mmcblk0boot0", "/dev/mmcblk0rpmb"):
            with self.assertRaisesRegex(HelperError, "Not a drive"):
                self.handle("mount", [bad], **kw)
            with self.assertRaisesRegex(HelperError, "Not a drive"):
                self.handle("format", [bad, "blank"], **kw)
        self.assertEqual(self.handle("mount", ["/dev/mmcblk0"], **kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev,uid=1000,gid=1000", "/dev/mmcblk0p1", "/run/media/chris/SDCARD"], log)
        mounted[0] = True
        self.assertEqual(self.handle("umount", ["/dev/mmcblk0"], **kw), "ok")
        self.assertIn(["umount", "/run/media/chris/SDCARD"], log)
        mounted[0] = False
        self.assertEqual(self.handle("format", ["/dev/mmcblk0", "blank"], **kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/mmcblk0"], log)

    def test_failed_pool_mount_rolls_back_fstab_and_forget_handles_unmounted(self):
        from helper import HelperError
        fail_mount = [True]

        def run(cmd, args):
            if cmd == "mount" and fail_mount[0]:
                raise HelperError("mount: wrong fs type, bad option, bad superblock")
            if cmd == "umount":
                raise HelperError("umount: /home/chris/Pools/old: not mounted.")
            return self.fake.run(cmd, args)

        kw = dict(self.kw, run=run)
        with self.assertRaisesRegex(HelperError, "wrong fs type"):
            self.handle("pool-import", ["old", "44444444-4444-4444-4444-444444444444"], **kw)
        self.assertEqual(self.fake.files["/etc/fstab"], "UUID=1111 / btrfs defaults 0 0\n")

        fail_mount[0] = False
        self.assertEqual(self.handle("pool-import", ["old", "44444444-4444-4444-4444-444444444444"], **kw), "ok")
        self.assertIn("# omarchy-connector pool old", self.fake.files["/etc/fstab"])
        self.assertEqual(self.handle("pool-forget", ["old"], **kw), "ok")
        self.assertNotIn("# omarchy-connector pool old", self.fake.files["/etc/fstab"])

        fail_mount[0] = True
        with self.assertRaisesRegex(HelperError, "wrong fs type"):
            self.handle("pool-create", ["tank", "single", "/dev/sda"], **kw)
        self.assertEqual(self.fake.files["/etc/fstab"], "UUID=1111 / btrfs defaults 0 0\n")

    def test_zfs_export_keeps_bind_mount_and_fstab_when_export_fails(self):
        from helper import HelperError
        fstab_before = "UUID=1 / ext4 defaults 0 0\n/tank /home/chris/Pools/tank none bind,nosuid,nodev,nofail,x-systemd.requires=zfs-mount.service 0 0 # omarchy-connector zfs tank\n"
        files = {"/etc/fstab": fstab_before}
        log = []
        mode = ["busy-export"]

        def run(cmd, args):
            log.append([cmd, *args])
            if cmd == "zpool" and args[:1] == ["list"]:
                return "tank\n"
            if cmd == "umount" and mode[0] == "busy-umount":
                raise HelperError("umount: /home/chris/Pools/tank: target is busy.")
            if cmd == "umount" and mode[0] == "not-mounted":
                raise HelperError("umount: /home/chris/Pools/tank: not mounted.")
            if cmd == "zpool" and args[:1] == ["export"] and mode[0] == "busy-export":
                raise HelperError("zpool: pool is busy")
            return ""

        kw = dict(run=run, user=self.kw["user"], files=files)
        with self.assertRaisesRegex(HelperError, "in use"):
            self.handle("zfs-export", ["tank"], **kw)
        self.assertEqual(files["/etc/fstab"], fstab_before)
        self.assertFalse(any(c[0] == "umount" for c in log))
        self.assertFalse(any(c[0] == "mount" for c in log))
        self.assertIn(["zpool", "export", "tank"], log)

        log.clear()
        mode[0] = "busy-umount"
        with self.assertRaisesRegex(HelperError, "in use"):
            self.handle("zfs-export", ["tank"], **kw)
        self.assertEqual(files["/etc/fstab"], fstab_before)
        export_idx = log.index(["zpool", "export", "tank"])
        umount_idx = next(i for i, c in enumerate(log) if c[0] == "umount" and c[-1] == "/home/chris/Pools/tank")
        self.assertLess(export_idx, umount_idx)

        for success_mode in ("ok", "not-mounted"):
            files["/etc/fstab"] = fstab_before
            log.clear()
            mode[0] = success_mode
            self.assertEqual(self.handle("zfs-export", ["tank"], **kw), "ok")
            self.assertEqual(files["/etc/fstab"], "UUID=1 / ext4 defaults 0 0\n")
            export_idx = log.index(["zpool", "export", "tank"])
            umount_idx = next(i for i, c in enumerate(log) if c[0] == "umount")
            self.assertLess(export_idx, umount_idx)
            self.assertIn(["systemctl", "daemon-reload"], log)

    def test_zfs_long_pool_names_work_across_import_scrub_and_export(self):
        from helper import HelperError
        imported = set()
        files = {"/etc/fstab": ""}

        def run(cmd, args):
            if cmd == "zpool" and args[:1] == ["list"]:
                return "\n".join(sorted(imported)) + ("\n" if imported else "")
            if cmd == "zfs" and args[:1] == ["list"]:
                return "%s\t/pools/%s\ton\n" % (args[-1], args[-1])
            return ""

        kw = dict(run=run, user=self.kw["user"], files=files)
        for name in ("backup-archive-2019-photos-and-videos", "a" * 64):
            imported.clear()
            self.assertEqual(self.handle("zfs-import", [name], **kw), "ok")
            imported.add(name)
            self.assertEqual(self.handle("zfs-scrub", [name], **kw), "ok")
            self.assertEqual(self.handle("zfs-export", [name], **kw), "ok")
        too_long = "a" * 65
        imported.add(too_long)
        for verb in ("zfs-import", "zfs-scrub", "zfs-export"):
            with self.assertRaisesRegex(HelperError, "Bad pool name"):
                self.handle(verb, [too_long], **kw)

    def test_zfs_import_uses_rbind_and_export_uses_recursive_umount(self):
        imported = set()
        files = {"/etc/fstab": ""}
        log = []

        def run(cmd, args):
            log.append([cmd, *args])
            if cmd == "zpool" and args[:1] == ["list"]:
                return "\n".join(sorted(imported)) + ("\n" if imported else "")
            if cmd == "zfs" and args[:1] == ["list"]:
                return "tank\t/tank\ton\ntank/media\t/tank/media\ton\n"
            return ""

        kw = dict(run=run, user=self.kw["user"], files=files)
        self.assertEqual(self.handle("zfs-import", ["tank"], **kw), "ok")
        self.assertRegex(files["/etc/fstab"], r"^/tank /home/chris/Pools/tank none rbind,nosuid,nodev,nofail,x-systemd\.requires=zfs-mount\.service 0 0 # omarchy-connector zfs tank\n$")
        self.assertIn(["mount", "/home/chris/Pools/tank"], log)

        imported.add("tank")
        log.clear()
        self.assertEqual(self.handle("zfs-export", ["tank"], **kw), "ok")
        self.assertIn(["umount", "-R", "/home/chris/Pools/tank"], log)

    def test_smart_uses_standby_flag_and_disks_caches_and_preserves_reading(self):
        lsblk = {
            "blockdevices": [
                {"name": "sda", "path": "/dev/sda", "type": "disk", "size": 4000000000000, "rota": True, "serial": "WD-A", "children": []},
                {"name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 4000000000000, "rota": True, "serial": "WD-B", "children": []},
            ]
        }
        clock = [1000000.0]
        sda_standby = [False]
        smart_log = []
        standby_json = json.dumps({"smartctl": {"exit_status": 2, "messages": [{"string": "Device is in STANDBY mode, exit(2)"}]}})

        def run(cmd, args):
            if cmd == "lsblk":
                return json.dumps(lsblk)
            if cmd == "smartctl":
                smart_log.append([cmd, *args])
                if args[-1] == "/dev/sda" and not sda_standby[0]:
                    return json.dumps({"smart_status": {"passed": True}, "temperature": {"current": 34}, "power_on_time": {"hours": 9000}})
                return standby_json
            return ""

        files = {}
        kw = dict(run=run, user=self.kw["user"], files=files, now=lambda: clock[0])

        res = json.loads(self.handle("smart", ["/dev/sda"], **kw))
        self.assertTrue(res["smart_status"]["passed"])
        self.assertEqual(smart_log[-1], ["smartctl", "-n", "standby", "-j", "-a", "/dev/sda"])
        smart_log.clear()

        disks = {d["name"]: d for d in json.loads(self.handle("disks", [], **kw))}
        self.assertEqual(disks["sda"]["health"]["temperature"], 34)
        self.assertIsNone(disks["sdb"]["health"])
        self.assertEqual(len(smart_log), 2)
        self.assertTrue(all(c[:3] == ["smartctl", "-n", "standby"] for c in smart_log))

        # Polling 30s later uses cached health and does not invoke smartctl.
        clock[0] += 30
        smart_log.clear()
        disks = {d["name"]: d for d in json.loads(self.handle("disks", [], **kw))}
        self.assertEqual(disks["sda"]["health"]["temperature"], 34)
        self.assertEqual(smart_log, [])

        # After cache expires and sda enters standby, last known reading is kept.
        clock[0] += 660
        sda_standby[0] = True
        disks = {d["name"]: d for d in json.loads(self.handle("disks", [], **kw))}
        self.assertEqual(disks["sda"]["health"]["temperature"], 34)
        self.assertTrue(disks["sda"]["health"]["passed"])
        self.assertIsNone(disks["sdb"]["health"])
        self.assertEqual(len(smart_log), 2)

        # Next 30s poll uses refreshed standby timestamp.
        clock[0] += 30
        smart_log.clear()
        self.handle("disks", [], **kw)
        self.assertEqual(smart_log, [])

    def test_disks_marks_zfs_drive_as_pool_only_when_imported(self):
        from helper import HelperError
        lsblk = {
            "blockdevices": [
                {
                    "name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 4000787030016, "rota": True, "tran": "sata",
                    "model": "WDC WD40EFRX", "serial": "WD-1", "mountpoints": [None],
                    "children": [{"name": "sdb1", "path": "/dev/sdb1", "type": "part", "size": 4000777252864, "fstype": "zfs_member", "label": "tank", "uuid": "123456", "mountpoints": [None]}],
                }
            ]
        }
        zpool_out = [None]

        def run(cmd, args):
            if cmd == "lsblk":
                return json.dumps(lsblk)
            if cmd == "zpool" and args[:1] == ["list"]:
                if zpool_out[0] is None:
                    raise HelperError("no zpool")
                return zpool_out[0]
            if cmd == "zpool" and args[:1] == ["get"]:
                return "123456\n" if zpool_out[0] and "tank" in zpool_out[0] else ""
            return ""

        kw = dict(run=run, user=self.kw["user"], files={})
        for not_imported in (None, ""):
            zpool_out[0] = not_imported
            d = json.loads(self.handle("disks", [], **kw))[0]
            self.assertEqual(d["role"], "data")
            self.assertIsNone(d["pool"])
            self.assertEqual(d["zfs"], {"pool": "tank"})

        zpool_out[0] = "tank\n"
        d = json.loads(self.handle("disks", [], **kw))[0]
        self.assertEqual(d["role"], "pool")
        self.assertEqual(d["pool"], "tank")
        self.assertIsNone(d["zfs"])

    def test_zfs_status_ignores_logs_cache_spares_special_and_dedup(self):
        status_with_aux = """  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 00:10:00 with 0 errors on Sun Nov  1 00:24:02 2026
config:

\tNAME                                          STATE     READ WRITE CKSUM
\ttank                                          ONLINE       0     0     0
\t  raidz1-0                                    ONLINE       0     0     0
\t    /dev/disk/by-id/ata-A-part1               ONLINE       0     0     0
\t    /dev/disk/by-id/ata-B-part1               ONLINE       0     0     0
\t    /dev/disk/by-id/ata-C-part1               ONLINE       0     0     0
\tlogs
\t  mirror-1                                    ONLINE       0     0     0
\t    /dev/disk/by-id/nvme-L1-part1             ONLINE       0     0     0
\t    /dev/disk/by-id/nvme-L2-part1             ONLINE       0     0     0
\tspecial
\t  mirror-2                                    ONLINE       0     0     0
\t    /dev/disk/by-id/nvme-S1-part1             ONLINE       0     0     0
\t    /dev/disk/by-id/nvme-S2-part1             ONLINE       0     0     0
\tdedup
\t  mirror-3                                    ONLINE       0     0     0
\t    /dev/disk/by-id/nvme-D1-part1             ONLINE       0     0     0
\t    /dev/disk/by-id/nvme-D2-part1             ONLINE       0     0     0
\tcache
\t  /dev/disk/by-id/nvme-C1-part1               ONLINE       0     0     0
\tspares
\t  /dev/disk/by-id/ata-SPARE-part1             AVAIL

errors: No known data errors
"""
        mixed_data = """  pool: mix
 state: ONLINE
config:

\tNAME                                STATE     READ WRITE CKSUM
\tmix                                 ONLINE       0     0     0
\t  raidz1-0                          ONLINE       0     0     0
\t    /dev/disk/by-id/ata-1           ONLINE       0     0     0
\t    /dev/disk/by-id/ata-2           ONLINE       0     0     0
\t    /dev/disk/by-id/ata-3           ONLINE       0     0     0
\t  mirror-1                          ONLINE       0     0     0
\t    /dev/disk/by-id/ata-4           ONLINE       0     0     0
\t    /dev/disk/by-id/ata-5           ONLINE       0     0     0

errors: No known data errors
"""

        def run(cmd, args):
            if cmd == "zpool" and args[:1] == ["list"]:
                return "tank\t8000\t1000\t7000\tONLINE\nmix\t9000\t1000\t8000\tONLINE\n"
            if cmd == "zpool" and args[:1] == ["status"]:
                return mixed_data if args[-1] == "mix" else status_with_aux
            if cmd == "zfs":
                return "/tank\n"
            return ""

        pools = {p["name"]: p for p in json.loads(self.handle("zfs-pools", [], run=run, user=self.kw["user"], files={}))}
        self.assertEqual(pools["tank"]["layout"], "raidz1")
        self.assertEqual(
            [d["path"] for d in pools["tank"]["devices"]],
            ["/dev/disk/by-id/ata-A-part1", "/dev/disk/by-id/ata-B-part1", "/dev/disk/by-id/ata-C-part1"],
        )
        self.assertEqual(pools["mix"]["layout"], "mirror+raidz1")
        self.assertEqual(len(pools["mix"]["devices"]), 5)

    def test_zfs_pools_report_usable_dataset_space(self):
        def run(cmd, args):
            if cmd == "lsblk":
                return json.dumps({"blockdevices": []})
            if cmd == "zpool":
                if args[:1] == ["version"]:
                    return "zfs-2.2.0\n"
                if args[:1] == ["list"]:
                    return "tank\t12000000000000\t4000000000000\t8000000000000\tONLINE\nfallback\t6000\t1000\t5000\tONLINE\n"
                return ""
            if cmd == "zfs":
                if args[:1] == ["get"]:
                    return "/home/chris/Pools/%s\n" % args[-1]
                if args[:1] == ["list"] and args[-1] == "tank":
                    return "2500000000000\t5500000000000\n"
                if args[:1] == ["list"] and args[-1] == "fallback":
                    return "-\t-\n"
            return ""

        kw = dict(run=run, user=self.kw["user"], files={})
        zpools = {p["name"]: p for p in json.loads(self.handle("zfs-pools", [], **kw))}
        self.assertEqual(zpools["tank"]["used"], 2500000000000)
        self.assertEqual(zpools["tank"]["free"], 5500000000000)
        self.assertEqual(zpools["tank"]["size"], 8000000000000)
        self.assertEqual(zpools["fallback"]["used"], 1000)
        self.assertEqual(zpools["fallback"]["free"], 5000)
        self.assertEqual(zpools["fallback"]["size"], 6000)

        pools = {p["name"]: p for p in json.loads(self.handle("pools", [], **kw))}
        self.assertEqual(pools["tank"]["size"], 8000000000000)
        self.assertEqual(pools["tank"]["free"], 5500000000000)

    def test_system_mounts_include_subpaths_opt_srv_nix_and_owner_home(self):
        from helper import HelperError
        sys_paths = ["/var/lib/docker", "/var/log", "/usr/local", "/opt", "/srv", "/nix", "/home/chris"]
        data_paths = ["/run/media/chris/stick", "/varnish", "/home/chris/extra"]
        all_paths = sys_paths + data_paths
        devs = [
            {
                "name": "sd%s" % chr(97 + i), "path": "/dev/sd%s" % chr(97 + i), "type": "disk", "size": 1000000000000, "rota": True,
                "children": [{"name": "sd%s1" % chr(97 + i), "path": "/dev/sd%s1" % chr(97 + i), "type": "part", "fstype": "ext4", "mountpoints": [mp]}],
            }
            for i, mp in enumerate(all_paths)
        ]

        def run(cmd, args):
            if cmd == "lsblk":
                return json.dumps({"blockdevices": devs})
            return ""

        kw = dict(run=run, user=self.kw["user"], files={})
        by_mount = {d["mounts"][0]: d["role"] for d in json.loads(self.handle("disks", [], **kw))}
        for mp in sys_paths:
            self.assertEqual(by_mount[mp], "system", mp)
        for mp in data_paths:
            self.assertEqual(by_mount[mp], "data", mp)

        for i in (0, 3, 4, 5, 6):
            dev = devs[i]["path"]
            for verb, extra in (("umount", []), ("format", ["blank"]), ("sleep", ["20"])):
                with self.assertRaisesRegex(HelperError, "holds the system"):
                    self.handle(verb, [dev, *extra], **kw)
            with self.assertRaisesRegex(HelperError, "holds the system"):
                self.handle("pool-create", ["tank", "single", dev], **kw)

        for i in range(len(sys_paths), len(all_paths)):
            dev = devs[i]["path"]
            with self.assertRaisesRegex(HelperError, "is in use"):
                self.handle("format", [dev, "blank"], **kw)



    def test_format_checks_mkfs_before_wipefs(self):
        import helper as h
        from helper import HelperError

        orig = h.shutil.which
        seen = []

        def which(cmd, path=None):
            seen.append((cmd, path))
            if cmd in ("mkfs.exfat", "mkfs.ext4"):
                return None
            return orig(cmd, path=path)

        h.shutil.which = which
        try:
            for kind, prog, pattern in (
                ("exfat", "mkfs.exfat", r"exFAT tools aren't installed on this computer \(exfatprogs\)"),
                ("ext4", "mkfs.ext4", r"mkfs\.ext4 isn't installed on this computer"),
            ):
                fake = Fake()

                def run(cmd, args, prog=prog, fake=fake):
                    if cmd == prog:
                        raise FileNotFoundError(prog)
                    return fake.run(cmd, args)

                kw = dict(run=run, user=self.kw["user"], files=fake.files)
                with self.assertRaisesRegex(HelperError, pattern):
                    self.handle("format", ["/dev/sdb", kind], **kw)
                with self.assertRaisesRegex(HelperError, prog.replace(".", r"\.")):
                    self.handle("format", ["/dev/sdb", kind], **kw)
                self.assertFalse(any(c[0] == "wipefs" and "-a" in c for c in fake.log))
                self.assertTrue(any(c == prog and p and "/usr/bin" in p for c, p in seen))
        finally:
            h.shutil.which = orig

    def test_mount_second_drive_with_same_label_gets_a_free_name(self):
        lsblk = {
            "blockdevices": [
                {"name": "sda", "path": "/dev/sda", "type": "disk", "size": 1000, "children": [
                    {"name": "sda1", "path": "/dev/sda1", "type": "part", "fstype": "vfat", "label": "USB", "mountpoints": ["/run/media/me/USB"]}
                ]},
                {"name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 1000, "children": [
                    {"name": "sdb1", "path": "/dev/sdb1", "type": "part", "fstype": "vfat", "label": "USB", "mountpoints": [None]}
                ]},
            ]
        }
        fake = Fake(lsblk)
        user = {"name": "me", "uid": 1000, "gid": 1000, "home": "/home/me"}
        kw = dict(run=fake.run, user=user, files=fake.files)
        self.assertEqual(self.handle("mount", ["/dev/sdb"], **kw), "ok")
        self.assertIn(["mount", "-o", "nosuid,nodev,uid=1000,gid=1000", "/dev/sdb1", "/run/media/me/USB-2"], fake.log)
        self.assertFalse(any(c[0] == "mount" and c[-1] == "/run/media/me/USB" for c in fake.log))

    def test_umount_deepest_mountpoint_first(self):
        from helper import HelperError

        lsblk = {
            "blockdevices": [
                {"name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 1000, "children": [
                    {"name": "sdb1", "path": "/dev/sdb1", "type": "part", "fstype": "btrfs", "mountpoints": ["/media/me/data", "/media/me/data/photos"]}
                ]}
            ]
        }
        mounted = {"/media/me/data", "/media/me/data/photos"}
        log = []

        def run(cmd, args):
            log.append([cmd, *args])
            if cmd == "lsblk":
                return json.dumps(lsblk)
            if cmd == "zpool":
                raise HelperError("zpool: not found")
            if cmd == "umount":
                target = args[-1]
                if any(m != target and m.startswith(target + "/") for m in mounted):
                    raise HelperError("umount: %s: target is busy." % target)
                mounted.discard(target)
                return ""
            return ""

        kw = dict(run=run, user={"name": "me", "uid": 1000, "gid": 1000, "home": "/home/me"}, files={})
        self.assertEqual(self.handle("umount", ["/dev/sdb"], **kw), "ok")
        self.assertEqual([c[-1] for c in log if c[0] == "umount"], ["/media/me/data/photos", "/media/me/data"])

    def test_zfs_status_counts_unit_suffixes(self):
        status = """  pool: p
 state: ONLINE
  scan: scrub repaired 1.50M in 01:00:00 with 3 errors on Sun Nov  8 00:24:04 2026
config:

	NAME        STATE     READ WRITE CKSUM
	p           ONLINE       0     0 1.50M
	  /dev/sda  ONLINE      12K    0 1.50M

errors: 3 data errors, use '-v' for a list
"""

        def run(cmd, args):
            if cmd == "zpool" and args[:1] == ["list"]:
                return "p\t1000\t100\t900\tONLINE\n"
            if cmd == "zpool" and args[:1] == ["status"]:
                return status
            if cmd == "zfs":
                return "/home/chris/Pools/p\n"
            return ""

        pools = json.loads(self.handle("zfs-pools", [], run=run, user=self.kw["user"], files={}))
        self.assertEqual(pools[0]["devices"][0]["path"], "/dev/sda")
        self.assertEqual(pools[0]["devices"][0]["errors"], 12000 + 1500000)

    def test_sleep_rewrites_old_hdparm_paths(self):
        from helper import UDEV_SLEEP, hdparm_path

        old = "\n".join([
            "# Drive sleep, set by Omarchy Server",
            'ACTION=="add", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ENV{ID_SERIAL_SHORT}=="WD-A", RUN+="/usr/bin/hdparm -S 241 /dev/%k"',
            'ACTION=="add", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", ENV{ID_SERIAL_SHORT}=="WD-B", RUN+="/usr/sbin/hdparm -S 240 /dev/%k"',
            "",
        ])
        files = {"/etc/fstab": "UUID=1111 / btrfs defaults 0 0\n", UDEV_SLEEP: old}
        fake = Fake()
        kw = dict(run=fake.run, user=self.kw["user"], files=files)
        self.assertEqual(self.handle("sleep", ["/dev/sdb", "20"], **kw), "ok")
        text = files[UDEV_SLEEP]
        resolved = hdparm_path()
        self.assertIn(resolved, text)
        # /sbin/hdparm is text inside /usr/sbin/hdparm, and on Arch /usr/sbin and /usr/bin
        # are the same directory, so the resolved path can be any one of these.
        rest = text.replace(resolved, "RESOLVED")
        for stale in ("/usr/bin/hdparm", "/usr/sbin/hdparm", "/sbin/hdparm"):
            self.assertNotIn(stale, rest)
        self.assertIn('ENV{ID_SERIAL_SHORT}=="WD-A"', text)
        self.assertIn('ENV{ID_SERIAL_SHORT}=="WD-B"', text)

    def test_zfs_pools_unavailable_pool_has_null_sizes(self):
        def run(cmd, args):
            if cmd == "zpool" and args[:1] == ["version"]:
                return "zfs-2.2.2\n"
            if cmd == "zpool" and args[:1] == ["list"]:
                return "tank\t4000787030016\t1000000\t3999787030016\tONLINE\nusbpool\t-\t-\t-\tUNAVAIL\n"
            if cmd == "zpool" and args[:1] == ["status"]:
                return "  pool: x\n state: ONLINE\nconfig:\n\n\tNAME STATE READ WRITE CKSUM\n\tx ONLINE 0 0 0\n\nerrors: No known data errors\n"
            if cmd == "zfs" and args[:1] == ["list"]:
                if args[-1] == "usbpool":
                    return "-\t-\n"
                return "100\t200\n"
            if cmd == "zfs":
                return "/tank\n"
            return ""

        pools = {p["name"]: p for p in json.loads(self.handle("zfs-pools", [], run=run, user=self.kw["user"], files={}))}
        self.assertEqual(pools["tank"]["health"], "ONLINE")
        self.assertEqual(pools["tank"]["size"], 300)
        self.assertIsNone(pools["usbpool"]["size"])
        self.assertIsNone(pools["usbpool"]["used"])
        self.assertIsNone(pools["usbpool"]["free"])
        self.assertEqual(pools["usbpool"]["health"], "UNAVAIL")

    def test_smartctl_timeout_is_short_and_a_stuck_drive_stays_unknown(self):
        import subprocess

        import helper

        seen = []

        def fake_run(argv, **kw):
            seen.append((argv[0], kw.get("timeout")))

            class R:
                returncode = 0
                stdout = "{}"
                stderr = ""

            return R()

        orig = helper.subprocess.run
        helper.subprocess.run = fake_run
        try:
            helper.default_run("smartctl", ["-n", "standby", "-j", "-a", "/dev/sda"])
            helper.default_run("lsblk", ["-J"])
        finally:
            helper.subprocess.run = orig
        self.assertEqual(seen[0][0], "smartctl")
        self.assertGreaterEqual(seen[0][1], 10)
        self.assertLessEqual(seen[0][1], 20)
        self.assertEqual(seen[1], ("lsblk", 600))

        lsblk = {"blockdevices": [
            {"name": "sda", "path": "/dev/sda", "type": "disk", "size": 1000, "rota": True, "serial": "A", "children": []},
            {"name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 1000, "rota": True, "serial": "B", "children": []},
        ]}

        def run(cmd, args):
            if cmd == "lsblk":
                return json.dumps(lsblk)
            if cmd == "zpool":
                raise Exception("no zpool")
            if cmd == "smartctl" and args[-1] == "/dev/sda":
                raise subprocess.TimeoutExpired(cmd, 15)
            if cmd == "smartctl":
                return json.dumps({"smart_status": {"passed": True}, "temperature": {"current": 30}})
            return ""

        disks = {d["name"]: d for d in json.loads(self.handle("disks", [], run=run, user=self.kw["user"], files={}))}
        self.assertIsNone(disks["sda"]["health"])
        self.assertEqual(disks["sdb"]["health"]["temperature"], 30)

    def test_format_allows_foreign_zfs_member_with_the_same_pool_name(self):
        from helper import HelperError

        real = "1111111111111111111"
        foreign = "2222222222222222222"
        lsblk = {"blockdevices": [
            {"name": "sda", "path": "/dev/sda", "type": "disk", "size": 1000, "children": [
                {"name": "sda1", "path": "/dev/sda1", "type": "part", "fstype": "zfs_member", "label": "tank", "uuid": real, "mountpoints": [None]}
            ]},
            {"name": "sdb", "path": "/dev/sdb", "type": "disk", "size": 1000, "children": [
                {"name": "sdb1", "path": "/dev/sdb1", "type": "part", "fstype": "zfs_member", "label": "tank", "uuid": foreign, "mountpoints": [None]}
            ]},
        ]}
        log = []

        def run(cmd, args):
            log.append([cmd, *args])
            if cmd == "lsblk":
                return json.dumps(lsblk)
            if cmd == "zpool" and args[:1] == ["list"]:
                return "tank\n"
            if cmd == "zpool" and args[:1] == ["get"]:
                return real + "\n"
            if cmd == "wipefs":
                return json.dumps({"signatures": []})
            return ""

        kw = dict(run=run, user=self.kw["user"], files={})
        with self.assertRaisesRegex(HelperError, r"/dev/sda is in a pool"):
            self.handle("format", ["/dev/sda", "blank"], **kw)
        self.assertFalse(any(c[0] == "wipefs" and "-a" in c and c[-1] == "/dev/sda" for c in log))
        log.clear()
        self.assertEqual(self.handle("format", ["/dev/sdb", "blank"], **kw), "ok")
        self.assertIn(["wipefs", "-a", "/dev/sdb"], log)


class OldLsblk(unittest.TestCase):
    # #118: util-linux before 2.37 has no MOUNTPOINTS column.
    def test_falls_back_to_mountpoint(self):
        from helper import HelperError, handle

        old = copy.deepcopy(LSBLK)
        for d in old["blockdevices"]:
            for c in d.get("children") or []:
                mp = c.pop("mountpoints", None)
                c["mountpoint"] = (mp or [None])[0]
        fake = Fake(old)

        def run(cmd, args):
            if cmd == "lsblk" and any("MOUNTPOINTS" in a for a in args):
                fake.log.append([cmd, *args])
                raise HelperError("lsblk: unknown column: MOUNTPOINTS")
            return fake.run(cmd, args)

        with self.assertRaisesRegex(Exception, "holds the system"):
            handle("format", ["/dev/nvme0n1", "blank"], run=run, user={"name": "chris", "uid": 1000, "home": "/home/chris"}, files=fake.files)
        self.assertTrue(any("MOUNTPOINT," in " ".join(x) or x[-1].endswith("MOUNTPOINT,RM,HOTPLUG") for x in fake.log))


class HelperFailures(unittest.TestCase):
    def test_missing_command_and_timeout_name_the_tool(self):
        import subprocess

        import helper
        from helper import HelperError, default_run

        with self.assertRaises(HelperError) as missing:
            default_run("mkfs.exfat-is-not-installed", ["/dev/null"])
        self.assertEqual(str(missing.exception), "mkfs.exfat-is-not-installed is not installed")

        real_run = subprocess.run

        def short(argv, **kw):
            kw["timeout"] = 0.05
            return real_run(argv, **kw)

        helper.subprocess.run = short
        try:
            with self.assertRaises(HelperError) as late:
                default_run("sleep", ["5"])
        finally:
            helper.subprocess.run = real_run
        self.assertEqual(str(late.exception), "sleep took too long")

    def test_pool_forget_and_zfs_export_keep_fstab_newline(self):
        import helper
        from helper import HelperError, handle

        fstab = "UUID=aaaa / ext4 defaults 0 1\nUUID=bbbb-0000-0000-0000-000000000000 /home/u/Pools/data btrfs defaults 0 0 # omarchy-connector pool data\n"
        files = {"/etc/fstab": fstab}
        user = {"name": "u", "uid": 1000, "gid": 1000, "home": "/home/u"}

        def run(cmd, args):
            if cmd == "umount":
                raise HelperError("umount: not mounted")
            return ""

        self.assertEqual(handle("pool-forget", ["data"], run=run, user=user, realpath=lambda p: p, files=files), "ok")
        self.assertEqual(files["/etc/fstab"], "UUID=aaaa / ext4 defaults 0 1\n")

        files["/etc/fstab"] = "UUID=aaaa / ext4 defaults 0 1\n/tank /home/u/Pools/tank none bind 0 0 # omarchy-connector zfs tank\n"

        def zrun(cmd, args):
            if cmd == "zpool" and args[:1] == ["list"]:
                return "tank\n"
            if cmd == "umount":
                raise HelperError("umount: not mounted")
            return ""

        self.assertEqual(handle("zfs-export", ["tank"], run=zrun, user=user, files=files), "ok")
        self.assertEqual(files["/etc/fstab"], "UUID=aaaa / ext4 defaults 0 1\n")

        files["/etc/fstab"] = "UUID=bbbb-0000-0000-0000-000000000000 /home/u/Pools/data btrfs defaults 0 0 # omarchy-connector pool data\n"
        self.assertEqual(handle("pool-forget", ["data"], run=run, user=user, files=files), "ok")
        self.assertEqual(files["/etc/fstab"], "")


class Hdparm(unittest.TestCase):
    # #119: udev needs the real path.
    def test_path_exists_or_sbin(self):
        from helper import hdparm_path

        p = hdparm_path()
        self.assertTrue(p.startswith("/"))
        self.assertTrue(os.path.exists(p) or p == "/usr/sbin/hdparm")


if __name__ == "__main__":
    unittest.main()
