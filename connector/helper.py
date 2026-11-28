#!/usr/bin/env python3
"""Root helper for the Omarchy Server connector's Storage ability.

Installed at /usr/local/libexec/omarchy-connector/helper.py. A sudoers rule lets the person who
installed the connector run it (and nothing else) without a password. Every argument is treated as
hostile. Verbs:

  ping           is the helper installed and allowed?
  smart DEV      drive health (smartctl JSON)
  umount DEV     unmount every mountpoint on a non-system, non-pool whole disk
  mount DEV      mount each filesystem on a non-system, non-pool extra disk at /run/media/$USER
  format DEV FS  wipe a non-system, non-pool, unmounted whole disk (FS is blank, ext4 or exfat)
  sleep DEV MIN  spin-down time for a hard drive (0 = never)
  pool-*         Btrfs pools at ~/Pools/NAME (create, add, import, forget, scrub, status)
  zfs-available  is ZFS installed?
"""
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import time

DEV = re.compile(r"^/dev/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme\d{1,2}n\d{1,2}|mmcblk\d{1,2}|hd[a-z])\Z")
BY_ID = re.compile(r"^/dev/disk/by-id/[A-Za-z0-9._:+-]+\Z")
NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}\Z")
ZFS_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}\Z")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
SYSTEM_MOUNTS = frozenset(["/", "/home", "[SWAP]"])
SYSTEM_MOUNT_PREFIXES = ("/boot", "/efi", "/var", "/usr", "/opt", "/srv", "/nix")
SKIP_FS = frozenset(["crypto_LUKS", "swap", "LVM2_member", "linux_raid_member", "zfs_member"])
FAT_FS = frozenset(["vfat", "exfat", "ntfs", "msdos", "fuseblk"])


def clean_mount(m):
    if isinstance(m, str) and len(m) > 1:
        return m.rstrip("/") or "/"
    return m


def is_system_mount(m, home=None):
    p = clean_mount(m)
    if not p:
        return False
    if p in SYSTEM_MOUNTS:
        return True
    owner_home = clean_mount(home)
    if owner_home and p == owner_home:
        return True
    return any(p == pre or p.startswith(pre + "/") for pre in SYSTEM_MOUNT_PREFIXES)


def safe_mount_name(s):
    n = re.sub(r"[^A-Za-z0-9._-]+", "_", str(s or "")).strip("._-")
    if not n or n in (".", ".."):
        return ""
    return n[:64]


PROTECTED = ["/", "/boot", "/efi", "/etc", "/usr", "/var", "/home", "/root", "/opt", "/srv", "/bin", "/sbin", "/lib", "/lib64", "/dev", "/proc", "/sys", "/run", "/tmp"]
FSTAB_MARK = "# omarchy-connector pool"
ZFS_MARK = "# omarchy-connector zfs"
POOL_OPTIONS = "defaults,noatime,nosuid,nodev,compress=zstd:3,nofail,x-systemd.device-timeout=10s"
UDEV_SLEEP = "/etc/udev/rules.d/69-omarchy-connector-sleep.rules"
SMART_CACHE = "/run/omarchy-connector/smart-cache.json"
SMART_CACHE_TTL = 600
SLEEP_MINUTES = {0: 0, 10: 120, 20: 240, 30: 241, 60: 242, 120: 244, 240: 248}
HELPER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"
# zpool status prints large counters as 12K or 1.50M. The suffix is a power of 1000.
_ZFS_MULT = {"": 1, "K": 10**3, "M": 10**6, "G": 10**9, "T": 10**12, "P": 10**15}


def zfs_counter(raw):
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([KMGTP])?", raw or "", re.I)
    if not m:
        return 0
    unit = (m.group(2) or "").upper()
    return int(round(float(m.group(1)) * _ZFS_MULT[unit]))


def count_or_none(value):
    return int(value) if isinstance(value, str) and value.isdigit() else None


class HelperError(Exception):
    pass


def hdparm_path():
    # udev runs RUN+= with a fixed path: Debian and Ubuntu install hdparm in /usr/sbin, Arch in /usr/bin.
    for p in ("/usr/sbin/hdparm", "/usr/bin/hdparm", "/sbin/hdparm"):
        if os.path.exists(p):
            return os.path.realpath(p)
    return shutil.which("hdparm", path=HELPER_PATH) or "/usr/sbin/hdparm"


def fail(message):
    raise HelperError(message)


def default_run(cmd, args):
    env = dict(os.environ)
    env["PATH"] = HELPER_PATH
    env["LC_ALL"] = "C"
    # A drive that never answers smartctl must not hold the disk list for the full command limit.
    timeout = 15 if cmd == "smartctl" else 600
    try:
        r = subprocess.run([cmd, *args], capture_output=True, text=True, timeout=timeout, env=env)
    except FileNotFoundError:
        raise HelperError("%s is not installed" % cmd)
    except subprocess.TimeoutExpired:
        raise HelperError("%s took too long" % cmd)
    if r.returncode and not (cmd == "smartctl" and r.stdout):
        msg = (r.stderr or r.stdout or ("%s failed" % cmd)).strip().split("\n")[-1][:300]
        raise HelperError("%s: %s" % (cmd, msg) if msg else "%s failed" % cmd)
    return r.stdout


def parse_smart(j):
    if not isinstance(j, dict):
        return False, None
    power_mode = str(j.get("power_mode") or "")
    messages = (j.get("smartctl") or {}).get("messages") or []
    standby = bool(re.match(r"^(standby|sleep)$", power_mode, re.I)) or any(
        re.search(r"\b(standby|sleep)\b", str((m or {}).get("string") or ""), re.I) for m in messages
    )
    attrs = {a.get("id"): (a.get("raw") or {}).get("value") for a in ((j.get("ata_smart_attributes") or {}).get("table") or [])}
    nvme_log = j.get("nvme_smart_health_information_log")
    has_data = any(
        x is not None for x in (j.get("smart_status"), j.get("temperature"), j.get("power_on_time"), nvme_log)
    ) or bool(attrs)
    if (standby and not has_data) or (not has_data and (j.get("smartctl") or {}).get("exit_status") == 2):
        return True, None
    if not has_data:
        return False, None
    nvme = nvme_log or {}
    return False, {
        "passed": (j.get("smart_status") or {}).get("passed"),
        "temperature": (j.get("temperature") or {}).get("current") if j.get("temperature") else nvme.get("temperature"),
        "powerOnHours": (j.get("power_on_time") or {}).get("hours") if j.get("power_on_time") else nvme.get("power_on_hours"),
        "lifetimeUsed": nvme.get("percentage_used"),
        "reallocated": attrs.get(5),
        "pending": attrs.get(197),
    }


def handle(verb, args, run=None, user=None, realpath=None, fstab_text=None, files=None, chown=None, now=None):
    run = run or default_run
    realpath = realpath or os.path.realpath
    now = now or time.time
    if not user or not user.get("name") or not isinstance(user.get("uid"), int) or user.get("uid") == 0 or not str(user.get("home") or "").startswith("/"):
        fail("Run this through sudo as the person who installed the connector")
    if not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", user["name"]):
        fail("Run this through sudo as the person who installed the connector")
    uid = user["uid"]
    gid = user.get("gid", uid)
    pools_dir = os.path.join(user["home"], "Pools")

    def mount_of(name):
        return os.path.join(pools_dir, name)

    def read_text(path):
        if files is not None:
            if path not in files:
                raise OSError("ENOENT")
            return files[path]
        if fstab_text is not None and path == "/etc/fstab":
            return str(fstab_text)
        with open(path, encoding="utf-8") as f:
            return f.read()

    def write_text(path, text):
        if files is not None:
            files[path] = text
            return
        tmp = path + ".omarchy-connector.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)

    def block_devices():
        cols = "NAME,PATH,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,LABEL,UUID,%s,RM,HOTPLUG"
        try:
            j = json.loads(run("lsblk", ["-J", "-b", "-o", cols % "MOUNTPOINTS"]))
        except HelperError as e:
            # util-linux before 2.37 (Ubuntu 20.04, Debian 11, EL8) has only MOUNTPOINT.
            if "MOUNTPOINTS" not in str(e):
                raise
            j = json.loads(run("lsblk", ["-J", "-b", "-o", cols % "MOUNTPOINT"]))

            def plural(d):
                if "mountpoints" not in d:
                    d["mountpoints"] = [d.get("mountpoint")] if d.get("mountpoint") else []
                for c in d.get("children") or []:
                    plural(c)

            for d in j.get("blockdevices") or []:
                plural(d)
        return j.get("blockdevices") or []

    def flat(d):
        out = [d]
        for c in d.get("children") or []:
            out.extend(flat(c))
        return out

    def mounts(d):
        return [m for x in flat(d) for m in (x.get("mountpoints") or []) if m]

    def disk(path):
        if not DEV.match(path or ""):
            fail("Not a drive: %s" % path)
        for d in block_devices():
            if d.get("path") == path and d.get("type") == "disk":
                return d
        fail("No drive at %s" % path)

    def resolve_disk(path):
        p = "" if path is None else str(path)
        if BY_ID.match(p) and not re.search(r"-part\d+$", p):
            try:
                p = realpath(p)
            except OSError:
                fail("No drive at %s" % path)
        return disk(p)

    def fstab():
        try:
            return read_text("/etc/fstab").splitlines()
        except OSError:
            return []

    def mkdir_p(path):
        if files is not None:
            return
        os.makedirs(path, exist_ok=True)

    def chown_path(path):
        if chown is not None:
            chown(path, uid, gid)
            return
        if files is not None:
            return
        os.chown(path, uid, gid)

    def blank_disk(path):
        d = disk(path)
        if any(is_system_mount(m, user["home"]) for m in mounts(d)):
            fail("%s holds the system" % path)
        if mounts(d):
            fail("%s is in use" % path)
        if (d.get("children") or []) or d.get("fstype"):
            fail("%s isn’t blank. Format this drive first (choose blank)." % path)
        try:
            sig = (run("wipefs", ["--no-act", "--json", path]) or "").strip()
        except Exception:
            sig = ""
        if sig and (json.loads(sig).get("signatures") or []):
            fail("%s isn’t blank. Format this drive first (choose blank)." % path)
        return d

    def add_fstab(name, uuid):
        lines = [l for l in fstab() if not l.endswith("%s %s" % (FSTAB_MARK, name))]
        while lines and lines[-1] == "":
            lines.pop()
        lines.append("UUID=%s %s btrfs %s 0 0 %s %s" % (uuid, mount_of(name), POOL_OPTIONS, FSTAB_MARK, name))
        lines.append("")
        write_text("/etc/fstab", "\n".join(lines))

    def pool_mount(name):
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -")
        if not any(l.endswith("%s %s" % (FSTAB_MARK, name)) for l in fstab()):
            fail("No pool called %s" % name)
        return mount_of(name)

    def mount_pool(name, uuid):
        mkdir_p(mount_of(name))
        mkdir_p(pools_dir)
        chown_path(pools_dir)
        add_fstab(name, uuid)
        try:
            try:
                run("systemctl", ["daemon-reload"])
            except Exception:
                pass
            run("mount", [mount_of(name)])
        except Exception:
            try:
                kept = [l for l in fstab() if not l.endswith("%s %s" % (FSTAB_MARK, name))]
                write_text("/etc/fstab", ("\n".join(kept) + "\n") if kept else "")
            except Exception:
                pass
            try:
                run("systemctl", ["daemon-reload"])
            except Exception:
                pass
            raise
        chown_path(mount_of(name))

    def pool_member(d):
        if any("/Pools/" in m for m in mounts(d)):
            return True
        uuids = {x.get("uuid") for x in flat(d) if x.get("uuid")}
        if any(FSTAB_MARK in l and any(u in l for u in uuids) for l in fstab()):
            return True
        guids, names_without_guid = zfs_pool_ids()
        return any(
            x.get("fstype") == "zfs_member" and ((x.get("uuid") or "") in guids or (x.get("label") or "") in names_without_guid)
            for x in flat(d)
        )

    def fstab_pools():
        out = []
        for l in fstab():
            if FSTAB_MARK not in l:
                continue
            uuid_m = re.match(r"^UUID=(\S+)", l.strip())
            parts = l.split()
            name = l[l.index(FSTAB_MARK) + len(FSTAB_MARK) :].strip()
            if uuid_m and len(parts) >= 2 and NAME.match(name):
                out.append({"uuid": uuid_m.group(1), "mountpoint": parts[1], "name": name})
        return out

    def sleep_map():
        rev = {v: k for k, v in SLEEP_MINUTES.items()}
        out = {}
        try:
            text = read_text(UDEV_SLEEP)
        except OSError:
            return out
        for line in text.splitlines():
            sm = re.search(r'ENV\{ID_SERIAL_SHORT\}=="([^"]+)"', line)
            hm = re.search(r"hdparm -S (\d+)", line)
            if sm and hm:
                minutes = rev.get(int(hm.group(1)))
                if minutes is not None:
                    out[sm.group(1)] = minutes
        return out

    def pool_status_data(name):
        mnt = pool_mount(name)
        df = run("btrfs", ["filesystem", "df", "-b", mnt])
        pm = re.search(r"^Data,\s*(\w+)", df, re.M)
        profile = pm.group(1).lower() if pm else "unknown"
        stats = run("btrfs", ["device", "stats", mnt])
        devices = {}
        for m in re.finditer(r"^\[(/dev/[^\]]+)\]\.(\w+)\s+(\d+)", stats, re.M):
            devices.setdefault(m.group(1), {})[m.group(2)] = int(m.group(3))
        try:
            scrub = run("btrfs", ["scrub", "status", mnt])
        except Exception:
            scrub = ""
        sm = re.search(r"Status:\s*(\w+)", scrub)
        if sm:
            scrub_state = sm.group(1)
        elif "no stats available" in scrub:
            scrub_state = "never"
        else:
            scrub_state = "unknown"
        em = re.search(r"Error summary:\s*(.*)", scrub)
        scrub_errors = em.group(1).strip() if em else ""
        if scrub_errors == "no errors found":
            scrub_errors = ""
        started_m = re.search(r"Scrub started:\s*(.*)", scrub)
        started = started_m.group(1).strip() if started_m else None
        return {"profile": profile, "devices": devices, "scrub": {"state": scrub_state, "errors": scrub_errors, "started": started}}

    def zfs_available():
        try:
            run("zpool", ["version"])
            return True
        except Exception:
            return False

    def zfs_pool_names():
        try:
            return [l.strip() for l in run("zpool", ["list", "-H", "-o", "name"]).split("\n") if l.strip()]
        except Exception:
            return []

    # Imported pools are identified by GUID. Two pools can share a name; lsblk stores the GUID as the
    # zfs_member UUID, and `zpool get guid` is the imported pool's GUID.
    def zfs_pool_ids():
        found = {}
        # A named pool whose guid could not be read still matches disks by name, so a failed
        # `zpool get` does not make that pool's disks look free to format.
        names_without_guid = set()
        for name in zfs_pool_names():
            try:
                guid = run("zpool", ["get", "-H", "-o", "value", "guid", name]).strip()
            except Exception:
                names_without_guid.add(name)
                continue
            if guid and guid != "-":
                found[guid] = name
            else:
                names_without_guid.add(name)
        return found, names_without_guid

    def by_id(dev):
        directory = "/dev/disk/by-id"
        try:
            names = os.listdir(directory)
            target = realpath(dev)
        except OSError:
            return dev
        matches = []
        for n in names:
            if re.search(r"-part\d+$", n):
                continue
            try:
                if realpath(os.path.join(directory, n)) == target:
                    matches.append(n)
            except OSError:
                continue
        best = next((n for n in matches if re.match(r"^(nvme|ata|scsi|usb)-", n)), None)
        if not best:
            best = next((n for n in matches if not n.startswith("wwn-")), None)
        if not best and matches:
            best = matches[0]
        return os.path.join(directory, best) if best else dev

    def parse_status(text):
        state_m = re.search(r"^\s*state:\s*(\S+)", text, re.M)
        scan_m = re.search(r"^\s*scan:\s*(.+(?:\n\t.+)*)", text, re.M)
        errors_m = re.search(r"^errors:\s*(.+)$", text, re.M)
        cfg = ""
        parts = re.split(r"^\s*config:\s*$", text, flags=re.M)
        if len(parts) > 1:
            cfg = re.split(r"^errors:", parts[1], flags=re.M)[0]
        layout = set()
        devices = []
        section = "data"
        for line in cfg.split("\n"):
            sec = re.match(r"^\s+(logs|cache|spares|special|dedup)\s*\Z", line)
            if sec:
                section = sec.group(1)
                continue
            if section != "data":
                continue
            m = re.match(r"^\s+(\S+)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED)\s+(\d+\S*)\s+(\d+\S*)\s+(\d+\S*)", line)
            if not m:
                continue
            if re.match(r"^(mirror|raidz[123]?|draid)", m.group(1)):
                layout.add(re.sub(r"-\d+$", "", m.group(1)))
            elif m.group(1).startswith("/"):
                devices.append({
                    "path": m.group(1),
                    "state": m.group(2),
                    "errors": sum(zfs_counter(x) for x in (m.group(3), m.group(4), m.group(5))),
                })
        return {
            "state": state_m.group(1) if state_m else "UNKNOWN",
            "scan": re.sub(r"\s+", " ", scan_m.group(1)).strip() if scan_m else "",
            "errors": errors_m.group(1).strip() if errors_m else "",
            "layout": "+".join(sorted(layout)) if layout else "stripe",
            "devices": devices,
        }

    def zfs_pool_mount(name):
        if not ZFS_NAME.match(name or ""):
            fail("Bad pool name")
        if name not in zfs_pool_names():
            fail("No ZFS pool called %s" % name)
        return name

    def ensure_zfs_services():
        for unit in ("zfs-import-cache.service", "zfs-mount.service", "zfs-import.target", "zfs.target"):
            try:
                run("systemctl", ["enable", unit])
            except Exception:
                pass

    def zfs_pools_data():
        out = []
        tab = fstab()
        try:
            listing = run("zpool", ["list", "-H", "-p", "-o", "name,size,alloc,free,health"])
        except Exception:
            listing = ""
        for line in listing.split("\n"):
            parts = line.split("\t")
            if len(parts) < 5 or not parts[0]:
                continue
            name, size, alloc, free, health = parts[:5]
            try:
                st = parse_status(run("zpool", ["status", "-P", name]))
            except Exception:
                st = parse_status("")
            try:
                mountpoint = run("zfs", ["get", "-H", "-o", "value", "mountpoint", name]).strip()
            except Exception:
                mountpoint = ""
            try:
                space_lines = run("zfs", ["list", "-H", "-p", "-o", "used,avail", name]).strip().splitlines()
                sp = space_lines[0].split("\t") if space_lines else []
            except Exception:
                sp = []
            if len(sp) >= 2 and sp[0].isdigit() and sp[1].isdigit():
                used_bytes = int(sp[0])
                free_bytes = int(sp[1])
                size_bytes = used_bytes + free_bytes
            else:
                size_bytes = count_or_none(size)
                used_bytes = count_or_none(alloc)
                free_bytes = count_or_none(free)
            bind = next((l for l in tab if l.endswith("%s %s" % (ZFS_MARK, name))), None)
            if bind:
                folder = bind.split()[1]
            elif mountpoint.startswith(pools_dir + "/"):
                folder = mountpoint
            else:
                folder = None
            out.append({"name": name, "size": size_bytes, "used": used_bytes, "free": free_bytes, "health": health, "mountpoint": mountpoint, "folder": folder, **st})
        return out

    def zfs_importable_data():
        try:
            text = run("zpool", ["import"])
        except Exception as e:
            if re.search(r"no pools available", str(e), re.I):
                text = ""
            else:
                raise
        pools = []
        for block in re.split(r"^\s*pool:\s*", text, flags=re.M)[1:]:
            name = block.split("\n")[0].strip()
            id_m = re.search(r"^\s*id:\s*(\d+)", block, re.M)
            state_m = re.search(r"^\s*state:\s*(\S+)", block, re.M)
            status_m = re.search(r"^\s*status:\s*(.+(?:\n\s{2,}.+)*)", block, re.M)
            pools.append({
                "name": name,
                "id": id_m.group(1) if id_m else None,
                "state": state_m.group(1) if state_m else "UNKNOWN",
                "otherSystem": bool(re.search(r"another system|was last accessed by|-f flag", block, re.I)),
                "note": re.sub(r"\s+", " ", status_m.group(1)).strip() if status_m else "",
            })
        return pools

    if verb == "ping":
        return "ok"
    if verb == "smart":
        d = resolve_disk(args[0] if args else "")
        return run("smartctl", ["-n", "standby", "-j", "-a", d["path"]])
    if verb == "umount":
        d = resolve_disk(args[0] if args else "")
        if any(is_system_mount(m, user["home"]) for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        if pool_member(d):
            fail("%s is in a pool" % d["path"])
        # A mount inside another mount on this drive is busy until the child is gone.
        for m in sorted(mounts(d), key=len, reverse=True):
            run("umount", [m])
        return "ok"
    if verb == "mount":
        d = resolve_disk(args[0] if args else "")
        if any(is_system_mount(m, user["home"]) for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        if pool_member(d):
            fail("%s is in a pool" % d["path"])
        if mounts(d):
            fail("%s is already mounted" % d["path"])
        nodes = [x for x in flat(d) if x is not d] if d.get("children") else [d]
        targets = [x for x in nodes if x.get("fstype") and x["fstype"] not in SKIP_FS]
        if not targets:
            fail("Nothing to mount")
        # Names already mounted under /run/media/$USER, so a second stick with the same label
        # is placed beside the first instead of on top of it.
        media = "/run/media/%s" % user["name"]
        prefix = media + "/"
        used = set()
        for dev in block_devices():
            for m in mounts(dev):
                if not m.startswith(prefix):
                    continue
                name = m[len(prefix):].split("/")[0]
                if name:
                    used.add(name)
        for t in targets:
            name = safe_mount_name(t.get("label")) or safe_mount_name(t.get("uuid")) or safe_mount_name(t.get("name")) or "disk"
            base = name
            n = 2
            while name in used:
                name = "%s-%s" % (base, n)
                n += 1
            used.add(name)
            parent = os.path.join("/run/media", user["name"])
            dest = os.path.join(parent, name)
            mkdir_p(dest)
            try:
                chown_path(parent)
            except OSError:
                pass
            chown_path(dest)
            flags = ["nosuid", "nodev"]
            if t.get("fstype") in FAT_FS:
                flags.extend(["uid=%s" % uid, "gid=%s" % gid])
            run("mount", ["-o", ",".join(flags), t["path"], dest])
            if t.get("fstype") not in FAT_FS:
                chown_path(dest)
        return "ok"
    if verb == "format":
        fs_kind = args[1] if len(args) > 1 else ""
        if fs_kind not in ("blank", "ext4", "exfat"):
            fail("Choose blank, ext4 or exfat")
        d = resolve_disk(args[0] if args else "")
        if any(is_system_mount(m, user["home"]) for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        if pool_member(d):
            fail("%s is in a pool" % d["path"])
        if mounts(d):
            fail("%s is in use. Unmount it first." % d["path"])
        # Unlocked encryption, LVM or a running RAID array on it (lsblk shows them as its children),
        # even with nothing mounted: those are in use.
        if any(x is not d and x.get("type") != "part" for x in flat(d)):
            fail("%s is in use by encryption, LVM or RAID. Stop that first." % d["path"])
        if fs_kind in ("ext4", "exfat"):
            prog = "mkfs.ext4" if fs_kind == "ext4" else "mkfs.exfat"
            if not shutil.which(prog, path=HELPER_PATH):
                if fs_kind == "exfat":
                    fail("exFAT tools aren't installed on this computer (exfatprogs): mkfs.exfat")
                fail("mkfs.ext4 isn't installed on this computer")
        run("wipefs", ["-a", d["path"]])
        if fs_kind == "ext4":
            run("mkfs.ext4", ["-F", d["path"]])
        if fs_kind == "exfat":
            run("mkfs.exfat", [d["path"]])
        return "ok"
    if verb == "disks":
        skip = re.compile(r"^(zram|loop|sr|ram)|^mmcblk\d+boot|rpmb$")

        def disk_id(path):
            try:
                names = os.listdir("/dev/disk/by-id")
            except OSError:
                return path
            for name in names:
                if re.search(r"-part\d+$", name):
                    continue
                full = "/dev/disk/by-id/" + name
                try:
                    if realpath(full) == path:
                        return full
                except OSError:
                    continue
            return path

        use_cache = files is not None or fstab_text is None
        smart_cache = {}
        if use_cache:
            try:
                loaded = json.loads(read_text(SMART_CACHE))
                if isinstance(loaded, dict):
                    smart_cache = loaded
            except (OSError, ValueError, TypeError):
                pass
        ts = now()
        cache_dirty = False

        def health(path, serial):
            nonlocal cache_dirty
            cache_key = "%s|%s" % (path, serial or "")
            hit = smart_cache.get(cache_key)
            if isinstance(hit, dict) and isinstance(hit.get("at"), (int, float)) and ts - hit["at"] < SMART_CACHE_TTL:
                return hit.get("value")
            prev = hit.get("value") if isinstance(hit, dict) else None
            val = None
            try:
                standby, parsed = parse_smart(json.loads(run("smartctl", ["-n", "standby", "-j", "-a", path])))
                val = prev if standby else parsed
            except Exception as e:
                if re.search(r"\b(standby|sleep)\b", str(e), re.I) and prev is not None:
                    val = prev
            smart_cache[cache_key] = {"at": ts, "value": val}
            cache_dirty = True
            return val

        def pool_name(d):
            for m in mounts(d):
                if "/Pools/" in m:
                    return m.rsplit("/Pools/", 1)[-1].split("/")[0] or None
            uuids = {x.get("uuid") for x in flat(d) if x.get("uuid")}
            for l in fstab():
                if FSTAB_MARK in l and any(u in l for u in uuids):
                    return (l[l.index(FSTAB_MARK) + len(FSTAB_MARK) :].strip() or None)
            zmember = next((x for x in flat(d) if x.get("fstype") == "zfs_member"), None)
            if zmember and (zmember.get("uuid") or "") in zfs_guids:
                return zfs_guids[zmember["uuid"]]
            if zmember and (zmember.get("label") or "") in names_without_guid:
                return zmember.get("label")
            return None

        zfs_guids, names_without_guid = zfs_pool_ids()
        sleeps = sleep_map()
        out = []
        for d in block_devices():
            name = d.get("name") or ""
            if d.get("type") != "disk" or skip.search(name) or not int(d.get("size") or 0):
                continue
            allp = flat(d)
            mnt = [m for x in allp for m in (x.get("mountpoints") or []) if m]
            btrfs = next((x for x in allp if x.get("fstype") == "btrfs"), None)
            zmember = next((x for x in allp if x.get("fstype") == "zfs_member"), None)
            pool = pool_name(d)
            system = any(is_system_mount(m, user["home"]) for m in mnt)
            blank = not d.get("fstype") and not (d.get("children") or []) and not mnt
            nvme = d.get("tran") == "nvme" or name.startswith("nvme")
            rota = d.get("rota") in (True, 1, "1")
            role = "system" if system else "pool" if pool else "blank" if blank else "data"
            path = d.get("path")
            out.append({
                "path": path,
                "id": disk_id(path),
                "name": name,
                "model": (d.get("model") or "").strip() or None,
                "serial": d.get("serial"),
                "size": int(d.get("size") or 0),
                "kind": "nvme" if nvme else "hdd" if rota else "ssd",
                "transport": d.get("tran"),
                "removable": d.get("rm") in (True, 1, "1") or d.get("hotplug") in (True, 1, "1"),
                "role": role,
                "pool": pool if role == "pool" else None,
                "mounted": len(mnt) > 0,
                "mounts": mnt,
                "btrfs": {"uuid": btrfs.get("uuid"), "label": btrfs.get("label"), "mounted": any(btrfs.get("mountpoints") or [])} if btrfs and role != "pool" else None,
                "zfs": {"pool": zmember.get("label")} if zmember and role != "pool" else None,
                "sleepMinutes": sleeps.get(d.get("serial")) if d.get("serial") else None,
                "health": health(path, d.get("serial")),
            })
        if cache_dirty and use_cache:
            smart_cache = {
                k: v for k, v in smart_cache.items()
                if isinstance(v, dict) and isinstance(v.get("at"), (int, float)) and ts - v["at"] < 3600
            }
            try:
                if files is None:
                    os.makedirs(os.path.dirname(SMART_CACHE), mode=0o700, exist_ok=True)
                write_text(SMART_CACHE, json.dumps(smart_cache))
            except OSError:
                pass
        return json.dumps(out)
    if verb == "pool-create":
        name = args[0] if args else ""
        profile = args[1] if len(args) > 1 else ""
        devs = list(args[2:])
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -, starting with a letter")
        if profile not in ("single", "raid1", "raid10"):
            fail("Choose single, raid1 or raid10")
        if not devs or len(devs) > 16 or len(set(devs)) != len(devs):
            fail("Choose the drives for the pool")
        if profile == "raid1" and len(devs) < 2:
            fail("Mirroring needs at least 2 drives")
        if profile == "raid10" and len(devs) < 4:
            fail("RAID 10 needs at least 4 drives")
        if any(l.endswith("%s %s" % (FSTAB_MARK, name)) for l in fstab()):
            fail("There’s already a pool called %s" % name)
        for d in devs:
            blank_disk(d)
        meta = "dup" if len(devs) == 1 else ("raid10" if profile == "raid10" else "raid1")
        run("mkfs.btrfs", ["-L", "omarchy-%s" % name, "-d", profile, "-m", meta, *devs])
        try:
            run("udevadm", ["settle"])
        except Exception:
            pass
        uuid = (run("blkid", ["-s", "UUID", "-o", "value", devs[0]]) or "").strip()
        if not UUID.match(uuid):
            fail("The new pool has no UUID")
        mount_pool(name, uuid)
        return json.dumps({"name": name, "uuid": uuid, "mountpoint": mount_of(name)})
    if verb == "pool-add":
        name = args[0] if args else ""
        dev = args[1] if len(args) > 1 else ""
        mnt = pool_mount(name)
        blank_disk(dev)
        run("btrfs", ["device", "add", dev, mnt])
        run("btrfs", ["balance", "start", "--bg", "--full-balance", mnt])
        return "ok"
    if verb == "pool-import":
        name = args[0] if args else ""
        uuid = args[1] if len(args) > 1 else ""
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -, starting with a letter")
        if not UUID.match(uuid or ""):
            fail("Choose a filesystem to import")
        fs0 = [x for d in block_devices() for x in flat(d) if x.get("uuid") == uuid]
        if not fs0 or any(x.get("fstype") != "btrfs" for x in fs0):
            fail("Only Btrfs filesystems can be imported")
        if any(any(m for m in (x.get("mountpoints") or []) if m) for x in fs0):
            fail("That filesystem is already mounted")
        if any(l.endswith("%s %s" % (FSTAB_MARK, name)) or ("UUID=%s " % uuid) in l for l in fstab()):
            fail("That pool or filesystem is already set up")
        mount_pool(name, uuid)
        return "ok"
    if verb == "pool-forget":
        name = args[0] if args else ""
        mnt = pool_mount(name)
        try:
            run("umount", [mnt])
        except Exception as e:
            if "not mounted" not in str(e):
                fail("%s is in use. Stop apps and shares using it, then try again." % name)
        kept = [l for l in fstab() if not l.endswith("%s %s" % (FSTAB_MARK, name))]
        # fstab() uses splitlines(), which drops the final newline. Put it back.
        write_text("/etc/fstab", ("\n".join(kept) + "\n") if kept else "")
        try:
            run("systemctl", ["daemon-reload"])
        except Exception:
            pass
        return "ok"
    if verb == "pool-scrub":
        run("btrfs", ["scrub", "start", pool_mount(args[0] if args else "")])
        return "ok"
    if verb == "pool-status":
        return json.dumps(pool_status_data(args[0] if args else ""))
    if verb == "sleep":
        d = disk(args[0] if args else "")
        if any(is_system_mount(m, user["home"]) for m in mounts(d)):
            fail("%s holds the system" % d["path"])
        try:
            m = int(args[1]) if len(args) > 1 else -1
        except (TypeError, ValueError):
            m = -1
        if m not in SLEEP_MINUTES:
            fail("Choose 0, 10, 20, 30, 60, 120 or 240 minutes")
        if d.get("rota") not in (True, 1, "1"):
            fail("Only spinning hard drives sleep")
        serial = d.get("serial") or ""
        if not re.match(r"^[\w.-]{1,64}\Z", serial):
            fail("This drive doesn’t report a serial number, so its setting can’t be kept")
        run("hdparm", ["-S", str(SLEEP_MINUTES[m]), d["path"]])
        try:
            text = read_text(UDEV_SLEEP)
        except OSError:
            text = ""
        needle = 'ENV{ID_SERIAL_SHORT}=="%s"' % serial
        lines = [l for l in text.split("\n") if l and not l.startswith("#") and needle not in l]
        # Rules written before hdparm_path() still name /usr/bin/hdparm. Repair every line we keep.
        hd = hdparm_path()
        lines = [re.sub(r'RUN\+="\S*hdparm ', lambda _match: 'RUN+="%s ' % hd, l) for l in lines]
        if m:
            lines.append('ACTION=="add", SUBSYSTEM=="block", ENV{DEVTYPE}=="disk", %s, RUN+="%s -S %s /dev/%%k"' % (needle, hdparm_path(), SLEEP_MINUTES[m]))
        write_text(UDEV_SLEEP, "# Drive sleep, set by Omarchy Server\n%s\n" % "\n".join(lines) if lines else "")
        return "ok"
    if verb == "zfs-available":
        return "yes" if zfs_available() else "no"
    if verb == "zfs-pools":
        return json.dumps(zfs_pools_data())
    if verb == "zfs-importable":
        return json.dumps(zfs_importable_data())
    if verb == "zfs-create":
        name = args[0] if args else ""
        layout = args[1] if len(args) > 1 else ""
        devs = list(args[2:])
        if not NAME.match(name or ""):
            fail("Pool names use a-z, 0-9 and -, starting with a letter")
        min_n = {"stripe": 1, "mirror": 2, "raidz1": 3, "raidz2": 4}.get(layout)
        if not min_n:
            fail("Choose combined, mirror, raidz1 or raidz2")
        if not devs or len(devs) > 24 or len(set(devs)) != len(devs):
            fail("Choose the drives for the pool")
        if len(devs) < min_n:
            fail("That layout needs at least %s drives" % min_n)
        if name in zfs_pool_names():
            fail("There’s already a ZFS pool called %s" % name)
        if any(l.endswith("%s %s" % (FSTAB_MARK, name)) or l.endswith("%s %s" % (ZFS_MARK, name)) for l in fstab()):
            fail("There’s already a pool called %s" % name)
        for d in devs:
            blank_disk(d)
        ids = [by_id(d) for d in devs]
        mkdir_p(pools_dir)
        chown_path(pools_dir)
        vdev = ids if layout == "stripe" else [layout, *ids]
        run("zpool", ["create", "-o", "ashift=12", "-O", "compression=lz4", "-O", "atime=off", "-O", "xattr=sa", "-O", "acltype=posixacl", "-O", "setuid=off", "-O", "devices=off", "-O", "mountpoint=%s" % mount_of(name), name, *vdev])
        run("zpool", ["set", "cachefile=/etc/zfs/zpool.cache", name])
        ensure_zfs_services()
        chown_path(mount_of(name))
        return json.dumps({"name": name, "mountpoint": mount_of(name)})
    if verb == "zfs-import":
        name = args[0] if args else ""
        force = args[1] if len(args) > 1 else None
        if not ZFS_NAME.match(name or ""):
            fail("Bad pool name")
        if force not in (None, "force"):
            fail("Bad option")
        if name in zfs_pool_names():
            fail("%s is already imported" % name)
        run("zpool", ["import", "-N", *(["-f"] if force else []), name])
        try:
            listing = run("zfs", ["list", "-H", "-o", "name,mountpoint,canmount", "-r", name])
        except Exception:
            listing = ""
        datasets = [l.split("\t") for l in listing.split("\n") if l]
        bad = None
        for row in datasets:
            if len(row) < 3:
                continue
            n, mp, can = row[0], row[1], row[2]
            if can != "off" and mp.startswith("/") and any(mp == p or (p != "/" and mp.startswith(p + "/") and not mp.startswith(pools_dir + "/")) for p in PROTECTED):
                bad = (n, mp)
                break
        if bad:
            try:
                run("zpool", ["export", name])
            except Exception:
                pass
            fail("%s would be mounted at %s, a system folder, so the pool wasn’t imported. Change its mountpoint on the system it came from, or import it by hand." % bad)
        run("zfs", ["set", "setuid=off", name])
        run("zfs", ["set", "devices=off", name])
        run("zfs", ["mount", "-a"])
        run("zpool", ["set", "cachefile=/etc/zfs/zpool.cache", name])
        ensure_zfs_services()
        top = next((row[1] for row in datasets if row and row[0] == name), None)
        pretty = re.sub(r"^[^a-z]+", "p", re.sub(r"[^a-z0-9-]", "-", name.lower()))
        if top and top.startswith("/") and top != mount_of(pretty):
            mkdir_p(mount_of(pretty))
            chown_path(pools_dir)
            lines = [l for l in fstab() if not l.endswith("%s %s" % (ZFS_MARK, name))]
            while lines and lines[-1] == "":
                lines.pop()
            lines.append("%s %s none rbind,nosuid,nodev,nofail,x-systemd.requires=zfs-mount.service 0 0 %s %s" % (top, mount_of(pretty), ZFS_MARK, name))
            lines.append("")
            write_text("/etc/fstab", "\n".join(lines))
            try:
                run("systemctl", ["daemon-reload"])
            except Exception:
                pass
            run("mount", [mount_of(pretty)])
        return "ok"
    if verb == "zfs-scrub":
        run("zpool", ["scrub", zfs_pool_mount(args[0] if args else "")])
        return "ok"
    if verb == "zfs-export":
        name = args[0] if args else ""
        zfs_pool_mount(name)
        bind = next((l for l in fstab() if l.endswith("%s %s" % (ZFS_MARK, name))), None)
        bind_parts = bind.split() if bind else []
        bind_target = bind_parts[1] if len(bind_parts) >= 2 else None
        # Export first: a busy pool fails here and the bind mount and fstab line stay.
        try:
            run("zpool", ["export", name])
        except Exception:
            fail("%s is in use. Stop apps and shares using it, then try again." % name)
        if bind_target:
            try:
                run("umount", ["-R", bind_target])
            except Exception as e:
                if "not mounted" not in str(e).lower():
                    fail("%s is in use. Stop apps and shares using it, then try again." % name)
        if bind:
            kept = [l for l in fstab() if l != bind]
            write_text("/etc/fstab", ("\n".join(kept) + "\n") if kept else "")
            try:
                run("systemctl", ["daemon-reload"])
            except Exception:
                pass
        return "ok"
    if verb == "pools":
        devs = [d for d in block_devices() if d.get("type") == "disk"]
        btrfs_out = []
        for p in fstab_pools():
            members = [d.get("path") for d in devs if any(x.get("uuid") == p["uuid"] for x in flat(d))]
            mounted = any(p["mountpoint"] in (x.get("mountpoints") or []) for d in devs for x in flat(d))
            size = free = None
            if mounted and files is None:
                try:
                    s = os.statvfs(p["mountpoint"])
                    size = s.f_blocks * s.f_frsize
                    free = s.f_bavail * s.f_frsize
                except OSError:
                    pass
            detail = None
            if mounted:
                try:
                    detail = pool_status_data(p["name"])
                except Exception:
                    detail = None
            errors = 0
            if detail:
                errors = sum(sum(v.values()) for v in (detail.get("devices") or {}).values())
            btrfs_out.append({
                "kind": "btrfs",
                "name": p["name"],
                "uuid": p["uuid"],
                "mountpoint": p["mountpoint"],
                "folder": "/Home/Pools/%s" % p["name"],
                "mounted": mounted,
                "devices": members,
                "size": size,
                "free": free,
                "profile": (detail or {}).get("profile"),
                "errors": errors,
                "scrub": (detail or {}).get("scrub"),
            })
        zfs_out = []
        if zfs_available():
            def virtual_of(real):
                home = user["home"]
                if real and real.startswith(home + "/"):
                    return "/Home" + real[len(home):]
                return None
            for z in zfs_pools_data():
                scan = z.get("scan") or ""
                z_errors = sum(d.get("errors") or 0 for d in (z.get("devices") or []))
                if z.get("errors") and z.get("errors") != "No known data errors":
                    z_errors += 1
                if re.search(r"in progress", scan):
                    scrub_state = "running"
                elif scan:
                    scrub_state = "finished"
                else:
                    scrub_state = "never"
                if re.search(r" 0B repaired.* 0 errors| with 0 errors", scan) or not scan:
                    scrub_errors = ""
                elif re.search(r"errors", scan):
                    scrub_errors = scan
                else:
                    scrub_errors = ""
                zfs_out.append({
                    "kind": "zfs",
                    "name": z["name"],
                    "uuid": "zfs:%s" % z["name"],
                    "mountpoint": z.get("mountpoint"),
                    "folder": virtual_of(z.get("folder")),
                    "mounted": True,
                    "devices": [d["path"] for d in (z.get("devices") or [])],
                    "size": z.get("size"),
                    "free": z.get("free"),
                    "profile": z.get("layout"),
                    "health": z.get("health"),
                    "errors": z_errors,
                    "scrub": {"state": scrub_state, "errors": scrub_errors, "started": None, "summary": scan},
                })
        return json.dumps(btrfs_out + zfs_out)
    if verb == "importable":
        known = {p["uuid"] for p in fstab_pools()}
        by_uuid = {}
        for d in block_devices():
            for x in flat(d):
                if x.get("fstype") == "btrfs" and x.get("uuid") and x["uuid"] not in known and not any(m for m in (x.get("mountpoints") or []) if m):
                    e = by_uuid.get(x["uuid"]) or {"uuid": x["uuid"], "label": x.get("label"), "devices": []}
                    e["devices"].append(x.get("path"))
                    by_uuid[x["uuid"]] = e
        out = [{"kind": "btrfs", **b} for b in by_uuid.values()]
        if zfs_available():
            for z in zfs_importable_data():
                out.append({"kind": "zfs", "uuid": "zfs:%s" % z["name"], "label": z["name"], "devices": [], "state": z.get("state"), "otherSystem": z.get("otherSystem"), "note": z.get("note")})
        return json.dumps(out)
    fail("Unknown action: %s" % verb)


def main():
    verb = sys.argv[1] if len(sys.argv) > 1 else ""
    args = sys.argv[2:]
    try:
        if os.geteuid() != 0:
            fail("Run this through sudo as the person who installed the connector")
        name = os.environ.get("SUDO_USER") or ""
        try:
            uid = int(os.environ.get("SUDO_UID") or "0")
        except ValueError:
            uid = 0
        if not name or not uid:
            fail("Run this through sudo as the person who installed the connector")
        try:
            pw = pwd.getpwnam(name)
        except KeyError:
            fail("Unknown user")
        if pw.pw_uid != uid:
            fail("Unknown user")
        sys.stdout.write("%s\n" % handle(verb, args, user={"name": name, "uid": uid, "gid": pw.pw_gid, "home": pw.pw_dir}))
    except HelperError as e:
        sys.stderr.write("%s\n" % e)
        sys.exit(2)
    except Exception:
        sys.stderr.write("The helper failed\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
