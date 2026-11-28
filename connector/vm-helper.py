#!/usr/bin/env python3
"""Session libvirt helper. Runs as the connector user: no sudo, no shell."""
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

VERBS = frozenset([
    "status", "fetch", "disk-create", "seed", "define", "start", "shutdown",
    "reboot", "destroy", "suspend", "resume", "undefine", "state", "vnc-path",
    "inspect", "stats", "ga-ping", "ga-exec", "ga-status",
])
ARITY = {
    "status": (0, 0),
    "fetch": (2, 2),
    "disk-create": (2, 3),
    "seed": (2, 2),
    "define": (1, 1),
    "start": (1, 1),
    "shutdown": (1, 1),
    "reboot": (1, 1),
    "destroy": (1, 1),
    "suspend": (1, 1),
    "resume": (1, 1),
    "undefine": (1, 1),
    "state": (0, 0),
    "vnc-path": (1, 1),
    "inspect": (1, 1),
    "stats": (0, 0),
    "ga-ping": (1, 1),
    "ga-exec": (1, 1),
    "ga-status": (2, 2),
}
IMAGE_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{1,63}$")
GUEST_ID = re.compile(r"^[a-f0-9]{8}$")
DOMAIN_NAME = re.compile(r"^omarchy-[0-9a-f]{8}$")
FILE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
SEED_NAME = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$")
DISK_ID = re.compile(r"^[a-z][a-z0-9]{0,15}$")
MAC = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")
GA_PATH = re.compile(r"^(?:/(?:[A-Za-z0-9._+-]+/)*[A-Za-z0-9._+-]+|[A-Za-z][A-Za-z0-9._+-]*)$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
LIBVIRT = "qemu:///session"
ROOT_MESSAGE = "Run this as the person who installed the connector, not root"
CHECKSUM_MESSAGE = "The image didn’t match its checksum"
ARCH_MESSAGE = "That operating system isn’t available on this computer"
IDE_MESSAGE = "IDE is only available on the i440fx (pc) machine type"
NOT_RUNNING = "isn’t running"
CACHES = ("default", "none", "writeback", "writethrough", "directsync", "unsafe")
CPU_TYPES = ("host", "host-model", "max", "qemu64")
NICS = ("virtio", "e1000e", "e1000", "rtl8139")
VIDEOS = ("vga", "virtio", "bochs", "qxl", "cirrus", "none")
BUSES = ("virtio", "sata", "scsi", "ide")
DEFINE_FIELDS = {
    "id", "name", "memoryMb", "sockets", "cores", "cpuType", "mac", "firmware",
    "arch", "machineType", "nic", "video", "kvm", "tablet", "acpi", "agent",
    "bootMenu", "notes", "linkDown", "boot", "disks", "portForwards",
}
DISK_FIELDS = {"id", "device", "bus", "format", "role", "cache", "discard", "file"}
FORWARD_FIELDS = {"protocol", "hostPort", "guestPort"}
GA_EXEC_FIELDS = {"path", "args", "input", "capture"}


class HelperError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def default_data_dir():
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "omarchy-connector")


def default_run(cmd, args, input=None):
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    timeout = 30
    if cmd == "qemu-img" and args and args[0] in ("convert", "create"):
        timeout = 30 * 60
    elif cmd == "xorriso":
        timeout = 120
    try:
        kw = {"capture_output": True, "text": True, "timeout": timeout, "env": env}
        # A child must not consume the helper's stdin.
        if input is None:
            kw["stdin"] = subprocess.DEVNULL
        else:
            kw["input"] = input
        r = subprocess.run([cmd, *args], **kw)
    except FileNotFoundError:
        raise HelperError("%s is not installed" % cmd)
    except subprocess.TimeoutExpired:
        raise HelperError("%s took too long" % cmd)
    if r.returncode:
        msg = (r.stderr or r.stdout or ("%s failed" % cmd)).strip().split("\n")[-1][:300]
        raise HelperError("%s: %s" % (cmd, msg) if msg else "%s failed" % cmd)
    return r.stdout


def probe(run, cmd, args):
    # A missing binary or a failing probe is a down status, not an error from handle.
    try:
        out = run(cmd, args)
    except Exception:
        return None
    return out if isinstance(out, str) else None


def version_of(text):
    if not text:
        return None
    found = re.search(r"(\d+\.\d+(?:\.\d+)*)", text)
    return found.group(1) if found else None


def memory_mb(text):
    for line in (text or "").splitlines():
        if not line.startswith("MemTotal:"):
            continue
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            return int(parts[1]) // 1024
    return 0


def free_gb(path):
    try:
        st = os.statvfs(path)
    except OSError:
        return 0
    return int(round((st.f_bavail * (st.f_frsize or st.f_bsize)) / 1024 ** 3))


def read_meminfo():
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def host_arch(uname):
    machine = uname if isinstance(uname, str) else os.uname().machine
    return "arm64" if machine in ("aarch64", "arm64") else "amd64"


def video_models(run, arch):
    # ARM has no PC display adapters.
    if arch == "arm64":
        return ["virtio", "none"]
    text = probe(run, "qemu-system-x86_64", ["-device", "help"]) or ""
    extra = []
    if '"bochs-display"' in text:
        extra.append("bochs")
    if '"qxl-vga"' in text:
        extra.append("qxl")
    if '"cirrus-vga"' in text:
        extra.append("cirrus")
    return ["vga", "virtio", *extra, "none"]


def status_report(run, data_dir, kvm_path, uname, meminfo):
    if data_dir is None:
        data_dir = default_data_dir()
    if kvm_path is None:
        kvm_path = "/dev/kvm"
    if meminfo is None:
        meminfo = read_meminfo()
    virsh_ver = probe(run, "virsh", ["--version"])
    qemu = probe(run, "qemu-img", ["--version"])
    arch = host_arch(uname)
    body = {
        "libvirt": virsh_ver is not None and qemu is not None,
        "kvm": os.access(kvm_path, os.R_OK | os.W_OK),
        "arch": arch,
        "threads": os.cpu_count() or 1,
        "memoryMb": memory_mb(meminfo),
        "freeGb": free_gb(data_dir),
        "passt": bool(shutil.which("passt")),
        "xorriso": bool(shutil.which("xorriso")),
        "videoModels": video_models(run, arch),
        "qemu": version_of(qemu),
        "libvirtVersion": version_of(virsh_ver),
    }
    return json.dumps(body)


def catalog_url_ok(url):
    if not isinstance(url, str) or len(url) < 8 or len(url) > 500:
        return False
    if not url.startswith("https://") or "@" in url:
        return False
    return not any(ch.isspace() for ch in url)


def find_checksum(text, file, algorithm):
    length = 128 if algorithm == "sha512" else 64
    for raw in text.split("\n"):
        line = raw.strip()
        m = re.match(r"^([0-9a-fA-F]+)\s+\*?(.+)$", line)
        if m and os.path.basename(m.group(2).strip()) == file and len(m.group(1)) == length:
            return m.group(1).lower()
        m = re.match(r"^SHA\d+\s*\((.+)\)\s*=\s*([0-9a-fA-F]+)$", line)
        if m and os.path.basename(m.group(1)) == file and len(m.group(2)) == length:
            return m.group(2).lower()
    return None


def xml_escape(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("'", "&apos;")
        .replace('"', "&quot;")
    )


def xml_chars(s):
    for ch in str(s):
        c = ord(ch)
        if c in (0x9, 0xA, 0xD):
            continue
        if 0x20 <= c <= 0xD7FF or 0xE000 <= c <= 0xFFFD or 0x10000 <= c <= 0x10FFFF:
            continue
        return False
    return True


def emit_progress(n):
    sys.stderr.write("PROGRESS %d\n" % n)
    sys.stderr.flush()


def ensure_dir(path, mode=0o700):
    os.makedirs(path, mode=mode, exist_ok=True)
    try:
        os.chmod(path, mode)
    except OSError:
        pass
    return os.path.realpath(path)


def inside(path, root):
    path = os.path.realpath(path)
    root = os.path.realpath(root)
    return path == root or path.startswith(root + os.sep)


def require_inside(path, root):
    real = os.path.realpath(path)
    if not inside(real, root):
        raise HelperError("That path isn’t allowed")
    return real


def images_root(data_dir):
    return os.path.join(os.path.realpath(data_dir), "vm-images")


def guest_root(data_dir, guest_id):
    return os.path.join(os.path.realpath(data_dir), "vms", guest_id)


def domain(guest_id):
    return "omarchy-%s" % guest_id


def virsh(run, *args):
    out = run("virsh", ["-c", LIBVIRT, *args])
    return out if isinstance(out, str) else ""


def parse_image_id(value):
    if not isinstance(value, str):
        raise HelperError("Unknown action")
    if IMAGE_ID.fullmatch(value) is None:
        raise HelperError("Not an image: %s" % value[:200])
    return value


def parse_guest_id(value):
    if not isinstance(value, str):
        raise HelperError("Unknown action")
    if GUEST_ID.fullmatch(value) is None:
        raise HelperError("Not a virtual machine: %s" % value[:200])
    return value


def parse_size_gb(value):
    if type(value) is int:
        n = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        n = int(value)
    else:
        raise HelperError("Disk size must be between 1 and 4096 GB")
    if n < 1 or n > 4096:
        raise HelperError("Disk size must be between 1 and 4096 GB")
    return n


def is_int(value):
    return type(value) is int


def read_object(stdin):
    if isinstance(stdin, bytes):
        stdin = stdin.decode("utf-8")
    if not isinstance(stdin, str) or not stdin.strip():
        raise HelperError("Expected a JSON object")
    try:
        data = json.loads(stdin)
    except json.JSONDecodeError:
        raise HelperError("Expected a JSON object")
    if not isinstance(data, dict):
        raise HelperError("Expected a JSON object")
    return data


def fetch_bytes(url, fetch):
    if fetch is not None:
        data = fetch(url)
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)):
            raise HelperError("Couldn’t download that file")
        return bytes(data)
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            return resp.read()
    except Exception:
        raise HelperError("Couldn’t download that file")


def write_image(url, part, algorithm, fetch):
    hasher = hashlib.new(algorithm)
    if fetch is not None:
        data = fetch_bytes(url, fetch)
        hasher.update(data)
        fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        emit_progress(100)
        return hasher.hexdigest()
    try:
        resp = urllib.request.urlopen(url, timeout=120)
    except Exception:
        raise HelperError("Couldn’t download that file")
    try:
        total = 0
        try:
            total = int(resp.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            total = 0
        got = 0
        last = -1
        fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                fh.write(chunk)
                hasher.update(chunk)
                got += len(chunk)
                if total:
                    pct = min(99, int(got * 100 / total))
                    if pct != last:
                        last = pct
                        emit_progress(pct)
        emit_progress(100)
        return hasher.hexdigest()
    except HelperError:
        raise
    except Exception:
        raise HelperError("Couldn’t download that file")
    finally:
        try:
            resp.close()
        except Exception:
            pass


def expected_checksum(img, fetch):
    sha = img.get("sha256")
    if isinstance(sha, str) and re.fullmatch(r"[0-9a-fA-F]{64}", sha):
        return "sha256", sha.lower()
    sums = img.get("checksums")
    if not isinstance(sums, dict):
        raise HelperError("That image has no checksum")
    algorithm = sums.get("algorithm")
    if algorithm not in ("sha256", "sha512"):
        raise HelperError("That image has no checksum")
    sum_url = sums.get("url")
    if not catalog_url_ok(sum_url):
        raise HelperError("The catalog address must be https")
    text = fetch_bytes(sum_url, fetch).decode("utf-8", "replace")
    name = os.path.basename(urllib.parse.urlparse(img.get("url") or "").path)
    found = find_checksum(text, name, algorithm)
    if not found:
        raise HelperError("That image’s checksum list doesn’t include this image")
    return algorithm, found


def do_fetch(args, fetch, data_dir, uname):
    image_id = parse_image_id(args[0])
    catalog_url = args[1]
    if not catalog_url_ok(catalog_url):
        raise HelperError("The catalog address must be https")
    raw = fetch_bytes(catalog_url, fetch)
    try:
        catalog = json.loads(raw)
    except json.JSONDecodeError:
        raise HelperError("The catalog isn’t valid")
    if not isinstance(catalog, dict) or catalog.get("version") != 1 or not isinstance(catalog.get("images"), list):
        raise HelperError("The catalog isn’t valid")
    img = None
    for item in catalog["images"]:
        if isinstance(item, dict) and item.get("id") == image_id:
            img = item
            break
    if img is None or img.get("arch") != host_arch(uname):
        raise HelperError(ARCH_MESSAGE)
    img_url = img.get("url")
    if not catalog_url_ok(img_url):
        raise HelperError("The catalog address must be https")
    algorithm, expected = expected_checksum(img, fetch)
    root = ensure_dir(images_root(data_dir))
    final = os.path.join(root, image_id)
    part = final + ".part"
    require_inside(final, root)
    require_inside(part, root)
    try:
        digest = write_image(img_url, part, algorithm, fetch)
        if digest != expected:
            raise HelperError(CHECKSUM_MESSAGE)
        os.replace(part, final)
        try:
            os.chmod(final, 0o600)
        except OSError:
            pass
    except Exception:
        try:
            os.remove(part)
        except OSError:
            pass
        raise
    return os.path.realpath(final)


def finish_part(part, final):
    # Convert/create write the part; a stubbed run may not. Never leave a partial as disk.qcow2.
    if not os.path.isfile(part):
        fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
    os.replace(part, final)


def do_disk_create(args, run, data_dir):
    guest_id = parse_guest_id(args[0])
    size = parse_size_gb(args[1])
    guest = ensure_dir(guest_root(data_dir, guest_id))
    final = os.path.join(guest, "disk.qcow2")
    part = final + ".part"
    require_inside(final, guest)
    require_inside(part, guest)
    try:
        if os.path.exists(part):
            os.remove(part)
        if len(args) == 3:
            image_id = parse_image_id(args[2])
            image = os.path.join(images_root(data_dir), image_id)
            image = require_inside(image, images_root(data_dir))
            if not os.path.isfile(image):
                raise HelperError("That image isn’t downloaded")
            run("qemu-img", ["convert", "-O", "qcow2", image, part])
            run("qemu-img", ["resize", part, "%dG" % size])
        else:
            run("qemu-img", ["create", "-f", "qcow2", part, "%dG" % size])
        finish_part(part, final)
    except Exception:
        try:
            os.remove(part)
        except OSError:
            pass
        raise
    return "ok"


def do_seed(args, stdin, run, data_dir):
    guest_id = parse_guest_id(args[0])
    name = args[1]
    if name not in ("seed", "answer"):
        raise HelperError("Unknown action")
    body = read_object(stdin)
    extra = set(body) - {"label", "files"}
    if extra:
        raise HelperError("Unexpected field")
    label = body.get("label")
    files = body.get("files")
    if label not in ("cidata", "OMARCHY_ANSWER") or not isinstance(files, dict):
        raise HelperError("Invalid seed")
    if name == "seed" and label != "cidata":
        raise HelperError("Invalid seed")
    if name == "answer" and label != "OMARCHY_ANSWER":
        raise HelperError("Invalid seed")
    if len(files) > 8:
        raise HelperError("Invalid seed")
    total = 0
    names = []
    for fname, text in files.items():
        if not isinstance(fname, str) or SEED_NAME.fullmatch(fname) is None or fname in (".", ".."):
            raise HelperError("Invalid seed")
        if not isinstance(text, str):
            raise HelperError("Invalid seed")
        size = len(text.encode("utf-8"))
        if size > 256 * 1024:
            raise HelperError("That seed is too large")
        total += size
        names.append(fname)
    if total > 1024 * 1024:
        raise HelperError("That seed is too large")
    guest = ensure_dir(guest_root(data_dir, guest_id))
    output = os.path.join(guest, "%s.iso" % name)
    require_inside(output, guest)
    work = tempfile.mkdtemp(prefix="%s." % name, dir=guest)
    require_inside(work, guest)
    here = os.getcwd()
    try:
        for fname, text in files.items():
            path = os.path.join(work, fname)
            require_inside(path, work)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
        os.chdir(work)
        run("xorriso", ["-as", "mkisofs", "-quiet", "-output", output, "-volid", label, "-joliet", "-rock", *names])
    finally:
        try:
            os.chdir(here)
        except OSError:
            pass
        shutil.rmtree(work, ignore_errors=True)
    return "ok"


def require_bool(spec, key):
    value = spec.get(key)
    if type(value) is not bool:
        raise HelperError("Invalid %s" % key)
    return value


def require_int(spec, key, lo, hi):
    value = spec.get(key)
    if not is_int(value) or value < lo or value > hi:
        raise HelperError("Invalid %s" % key)
    return value


def resolve_disk_file(data_dir, guest_id, disk):
    role = disk.get("role")
    guest = guest_root(data_dir, guest_id)
    if role == "seed":
        return require_inside(os.path.join(guest, "seed.iso"), guest)
    if role == "answer":
        return require_inside(os.path.join(guest, "answer.iso"), guest)
    name = disk.get("file")
    if isinstance(name, str) and name.startswith("image:"):
        image_id = parse_image_id(name[6:])
        root = images_root(data_dir)
        return require_inside(os.path.join(root, image_id), root)
    if not isinstance(name, str) or FILE_NAME.fullmatch(name) is None or name in (".", ".."):
        raise HelperError("Invalid disk file")
    if os.path.basename(name) != name:
        raise HelperError("Invalid disk file")
    return require_inside(os.path.join(guest, name), guest)


def validate_disk(disk):
    if not isinstance(disk, dict):
        raise HelperError("Invalid disk")
    if set(disk) - DISK_FIELDS:
        raise HelperError("Unexpected field")
    disk_id = disk.get("id")
    if not isinstance(disk_id, str) or DISK_ID.fullmatch(disk_id) is None:
        raise HelperError("Invalid disk")
    if disk.get("device") not in ("disk", "cdrom"):
        raise HelperError("Invalid disk")
    if disk.get("bus") not in BUSES:
        raise HelperError("Invalid disk")
    if disk.get("format") not in ("qcow2", "raw"):
        raise HelperError("Invalid disk")
    if "role" in disk and disk["role"] not in (None, "seed", "answer"):
        raise HelperError("Invalid disk")
    if "cache" in disk and disk["cache"] not in CACHES:
        raise HelperError("Invalid disk")
    if "discard" in disk and type(disk["discard"]) is not bool:
        raise HelperError("Invalid disk")
    if "file" in disk and not isinstance(disk.get("file"), str):
        raise HelperError("Invalid disk")
    return disk


def validate_forward(fwd):
    if not isinstance(fwd, dict):
        raise HelperError("Invalid port forward")
    if set(fwd) - FORWARD_FIELDS:
        raise HelperError("Unexpected field")
    if fwd.get("protocol") not in ("tcp", "udp"):
        raise HelperError("Invalid port forward")
    if not is_int(fwd.get("hostPort")) or not (40000 <= fwd["hostPort"] <= 49999):
        raise HelperError("Invalid port forward")
    if not is_int(fwd.get("guestPort")) or not (1 <= fwd["guestPort"] <= 65535):
        raise HelperError("Invalid port forward")
    return fwd


def validate_spec(spec, guest_id, arch):
    if set(spec) - DEFINE_FIELDS:
        raise HelperError("Unexpected field")
    if spec.get("id") != guest_id:
        raise HelperError("Invalid id")
    name = spec.get("name")
    if not isinstance(name, str) or not (1 <= len(name) <= 64) or not xml_chars(name):
        raise HelperError("Invalid name")
    require_int(spec, "memoryMb", 256, 1048576)
    require_int(spec, "sockets", 1, 16)
    require_int(spec, "cores", 1, 256)
    if spec.get("cpuType") not in CPU_TYPES:
        raise HelperError("Invalid cpuType")
    mac = spec.get("mac")
    if not isinstance(mac, str) or MAC.fullmatch(mac) is None or int(mac.split(":")[0], 16) & 1:
        raise HelperError("Invalid mac")
    if spec.get("firmware") not in ("bios", "efi"):
        raise HelperError("Invalid firmware")
    if spec.get("arch") not in ("amd64", "arm64") or spec["arch"] != arch:
        raise HelperError(ARCH_MESSAGE)
    if spec.get("machineType") not in ("q35", "pc"):
        raise HelperError("Invalid machineType")
    if spec.get("nic") not in NICS:
        raise HelperError("Invalid nic")
    if spec.get("video") not in VIDEOS:
        raise HelperError("Invalid video")
    for key in ("kvm", "tablet", "acpi", "agent", "bootMenu"):
        require_bool(spec, key)
    if "linkDown" in spec:
        require_bool(spec, "linkDown")
    notes = spec.get("notes", "")
    if not isinstance(notes, str) or len(notes) > 8000 or not xml_chars(notes):
        raise HelperError("Invalid notes")
    boot = spec.get("boot")
    if not isinstance(boot, list) or not boot or not all(isinstance(b, str) for b in boot) or len(boot) != len(set(boot)):
        raise HelperError("Invalid boot")
    disks = spec.get("disks")
    if not isinstance(disks, list) or not (1 <= len(disks) <= 8):
        raise HelperError("Invalid disks")
    seen = set()
    for disk in disks:
        validate_disk(disk)
        if disk["id"] in seen:
            raise HelperError("Invalid disks")
        seen.add(disk["id"])
    for item in boot:
        if not isinstance(item, str) or (item != "net" and item not in seen):
            raise HelperError("Invalid boot")
    forwards = spec.get("portForwards", [])
    if not isinstance(forwards, list) or len(forwards) > 32:
        raise HelperError("Invalid port forwards")
    for fwd in forwards:
        validate_forward(fwd)
    if spec.get("arch") != "arm64" and spec.get("machineType") == "q35":
        for disk in disks:
            if disk.get("bus") == "ide":
                raise HelperError(IDE_MESSAGE)
    return spec


def disk_targets(disks, bus_of):
    sd = vd = hd = 0
    out = {}
    for disk in disks:
        bus = bus_of(disk)
        if bus == "virtio":
            out[disk["id"]] = "vd" + chr(97 + vd)
            vd += 1
        elif bus == "ide":
            out[disk["id"]] = "hd" + chr(97 + hd)
            hd += 1
        else:
            out[disk["id"]] = "sd" + chr(97 + sd)
            sd += 1
    return out


def domain_xml(spec, guest_dir, kvm_usable, uuid, files):
    arm = spec["arch"] == "arm64"
    use_kvm = kvm_usable and spec["kvm"]
    boot = spec["boot"]

    def bus_of(disk):
        if arm and disk["bus"] in ("sata", "ide"):
            return "scsi"
        return disk["bus"]

    def order(disk_id):
        if disk_id in boot:
            return "<boot order='%d'/>" % (boot.index(disk_id) + 1)
        return ""

    names = disk_targets(spec["disks"], bus_of)
    forwards = "".join(
        "<portForward proto='%s'><range start='%d' to='%d'/></portForward>"
        % (fwd["protocol"], fwd["hostPort"], fwd["guestPort"])
        for fwd in spec.get("portForwards") or []
    )
    disk_xml = []
    for disk in spec["disks"]:
        cdrom = disk["device"] == "cdrom"
        cache = disk.get("cache")
        cache_attr = " cache='%s'" % cache if cache and cache != "default" else ""
        discard_attr = " discard='unmap'" if not cdrom and disk.get("discard") is not False else ""
        path = files.get(disk["id"])
        if path:
            optional = "startupPolicy='optional' " if cdrom else ""
            source = "<source %sfile='%s'/>" % (optional, xml_escape(path))
        else:
            source = ""
        disk_xml.append(
            "<disk type='file' device='%s'><driver name='qemu' type='%s'%s%s/>%s"
            "<target dev='%s' bus='%s'/>%s%s</disk>"
            % (
                disk["device"],
                disk["format"],
                cache_attr,
                discard_attr,
                source,
                names[disk["id"]],
                bus_of(disk),
                order(disk["id"]),
                "<readonly/>" if cdrom else "",
            )
        )
    disks = "\n    ".join(disk_xml)
    scsi = "\n    <controller type='scsi' model='virtio-scsi'/>" if any(bus_of(d) == "scsi" for d in spec["disks"]) else ""
    machine = "virt" if arm else ("pc" if spec["machineType"] == "pc" else "q35")
    cpu_arch = "aarch64" if arm else "x86_64"
    bootmenu = "<bootmenu enable='yes' timeout='3000'/>" if spec["bootMenu"] else ""
    if spec["firmware"] == "efi" or arm:
        os_el = (
            "<os firmware='efi'><type arch='%s' machine='%s'>hvm</type>"
            "<firmware><feature enabled='no' name='secure-boot'/></firmware>%s</os>"
            % (cpu_arch, machine, bootmenu)
        )
    else:
        os_el = "<os><type arch='%s' machine='%s'>hvm</type>%s</os>" % (cpu_arch, machine, bootmenu)
    sockets = spec["sockets"]
    topology = "<topology sockets='%d' dies='1' cores='%d' threads='1'/>" % (sockets, spec["cores"])
    cpu_type = spec["cpuType"]
    if use_kvm and cpu_type == "host":
        cpu = "<cpu mode='host-passthrough'>%s</cpu>" % topology
    elif use_kvm and cpu_type == "host-model":
        cpu = "<cpu mode='host-model'>%s</cpu>" % topology
    elif cpu_type == "max":
        cpu = "<cpu mode='maximum'>%s</cpu>" % topology
    elif cpu_type == "qemu64":
        cpu = "<cpu mode='custom' match='exact'><model fallback='allow'>qemu64</model>%s</cpu>" % topology
    else:
        cpu = "<cpu>%s</cpu>" % topology
    video = "virtio" if arm and spec["video"] != "none" else spec["video"]
    nic = (
        "<interface type='user'><backend type='passt'/><mac address='%s'/><model type='%s'/>%s%s%s</interface>"
        % (
            spec["mac"],
            spec["nic"],
            "<link state='down'/>" if spec.get("linkDown") else "",
            forwards,
            order("net"),
        )
    )
    notes = spec.get("notes") or ""
    description = "\n  <description>%s</description>" % xml_escape(notes) if notes else ""
    uuid_el = "\n  <uuid>%s</uuid>" % uuid if uuid else ""
    tablet = "" if spec["tablet"] is False else "\n    <input type='tablet' bus='usb'/>"
    agent = (
        "\n    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>"
        if spec["agent"]
        else ""
    )
    vnc = xml_escape(os.path.join(guest_dir, "vnc.sock"))
    features = "%s%s" % ("" if spec["acpi"] is False else "<acpi/>", "" if arm else "<apic/>")
    return (
        "<domain type='%s'>\n"
        "  <name>%s</name>%s\n"
        "  <title>%s</title>%s\n"
        "  <memory unit='MiB'>%d</memory>\n"
        "  <vcpu>%d</vcpu>\n"
        "  %s\n"
        "  <features>%s</features>\n"
        "  %s\n"
        "  <on_reboot>restart</on_reboot>\n"
        "  <devices>\n"
        "    %s%s\n"
        "    %s\n"
        "    <serial type='pty'/><console type='pty'/>\n"
        "    <graphics type='vnc' socket='%s'/>\n"
        "    <video><model type='%s'/></video>%s%s\n"
        "    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>\n"
        "  </devices>\n"
        "</domain>\n"
        % (
            "kvm" if use_kvm else "qemu",
            domain(spec["id"]),
            uuid_el,
            xml_escape(spec["name"]),
            description,
            spec["memoryMb"],
            sockets * spec["cores"],
            os_el,
            features,
            cpu,
            disks,
            scsi,
            nic,
            vnc,
            video,
            tablet,
            agent,
        )
    )


def defined_uuid(run, guest_id):
    try:
        text = virsh(run, "domuuid", domain(guest_id)).strip()
    except HelperError:
        return ""
    except Exception:
        return ""
    return text.lower() if UUID.fullmatch(text) else ""


def do_define(args, stdin, run, data_dir, kvm_path, uname):
    guest_id = parse_guest_id(args[0])
    spec = validate_spec(read_object(stdin), guest_id, host_arch(uname))
    guest = ensure_dir(guest_root(data_dir, guest_id))
    files = {}
    for disk in spec["disks"]:
        path = resolve_disk_file(data_dir, guest_id, disk)
        if disk["device"] == "disk" and not os.path.isfile(path):
            raise HelperError("That disk isn’t on this computer")
        files[disk["id"]] = path
    kvm_usable = os.access(kvm_path, os.R_OK | os.W_OK)
    uuid = defined_uuid(run, guest_id)
    xml = domain_xml(spec, guest, kvm_usable, uuid, files)
    xml_path = os.path.join(guest, "domain.xml")
    require_inside(xml_path, guest)
    fd = os.open(xml_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(xml)
    try:
        os.chmod(xml_path, 0o600)
    except OSError:
        pass
    virsh(run, "define", xml_path)
    return "ok"


def list_states(run):
    text = virsh(run, "list", "--all")
    out = {}
    for line in text.split("\n")[2:]:
        m = re.match(r"^\s*(\S+)\s+(\S+)\s+(.+?)\s*$", line)
        if m and DOMAIN_NAME.fullmatch(m.group(2)):
            out[m.group(2)] = m.group(3)
    return out


def do_state(run):
    return json.dumps(list_states(run))


def already_active(message):
    return re.search(r"already (?:running|active)", message or "", re.I) is not None


def missing_domain(message):
    return re.search(r"failed to get domain|domain not found|no domain with matching", message or "", re.I) is not None


def do_start(args, run):
    guest_id = parse_guest_id(args[0])
    try:
        virsh(run, "start", domain(guest_id))
    except HelperError as err:
        if not already_active(err.message):
            raise
    return "ok"


def do_power(verb, args, run):
    guest_id = parse_guest_id(args[0])
    if verb == "destroy":
        try:
            virsh(run, "destroy", domain(guest_id))
        except HelperError as err:
            if not missing_domain(err.message):
                raise
        return "ok"
    virsh(run, verb, domain(guest_id))
    return "ok"


def do_vnc_path(args, data_dir):
    guest_id = parse_guest_id(args[0])
    guest = guest_root(data_dir, guest_id)
    path = os.path.join(guest, "vnc.sock")
    try:
        st = os.stat(path)
    except OSError:
        raise HelperError(NOT_RUNNING)
    if not stat.S_ISSOCK(st.st_mode):
        raise HelperError(NOT_RUNNING)
    real = os.path.realpath(path)
    expected = os.path.join(os.path.realpath(guest), "vnc.sock")
    if real != expected:
        raise HelperError(NOT_RUNNING)
    return real


def qemu_img_info(run, path):
    try:
        out = run("qemu-img", ["info", "--output=json", "-U", path])
    except Exception:
        return {}
    try:
        info = json.loads(out or "")
        virtual = info.get("virtual-size")
        actual = info.get("actual-size") or 0
        body = {}
        if isinstance(virtual, (int, float)):
            body["virtualGb"] = round(virtual / 1024 ** 3 * 10) / 10
        if isinstance(actual, (int, float)):
            body["usedGb"] = round(actual / 1024 ** 3 * 10) / 10
        return body
    except (json.JSONDecodeError, TypeError, ValueError):
        return {}


def do_inspect(args, run, data_dir):
    guest_id = parse_guest_id(args[0])
    states = list_states(run)
    state = states.get(domain(guest_id))
    disks = []
    guest = guest_root(data_dir, guest_id)
    if os.path.isdir(guest):
        for name in sorted(os.listdir(guest)):
            path = os.path.join(guest, name)
            if not os.path.isfile(path):
                continue
            if not (name.endswith(".qcow2") or name == "disk.qcow2"):
                continue
            require_inside(path, guest)
            info = qemu_img_info(run, path)
            disks.append({"file": name, "virtualGb": info.get("virtualGb"), "usedGb": info.get("usedGb")})
    return json.dumps({"state": state, "disks": disks})


def do_stats(run):
    text = virsh(run, "domstats", "--list-running", "--cpu-total", "--balloon", "--interface", "--block")
    kept = []
    for block in re.split(r"\n(?=Domain: )", text or ""):
        m = re.search(r"Domain: '([^']+)'", block)
        if m and DOMAIN_NAME.fullmatch(m.group(1)):
            kept.append(block)
    return "\n".join(kept)


def do_undefine(args, run, data_dir):
    guest_id = parse_guest_id(args[0])
    name = domain(guest_id)
    live = None
    text = virsh(run, "list", "--all")
    for line in text.split("\n")[2:]:
        m = re.match(r"^\s*(\S+)\s+(\S+)\s+(.+?)\s*$", line)
        if m and m.group(2) == name:
            live = m.group(3)
            break
    if live and live != "shut off":
        virsh(run, "destroy", name)
    if live:
        last = None
        for extra in (["--nvram", "--managed-save"], ["--nvram"], []):
            try:
                virsh(run, "undefine", name, *extra)
                last = None
                break
            except HelperError as err:
                last = err
        if last is not None:
            raise last
    path = guest_root(data_dir, guest_id)
    if os.path.exists(path):
        real = os.path.realpath(path)
        root = os.path.realpath(os.path.join(os.path.realpath(data_dir), "vms"))
        if os.path.basename(real) != guest_id or not inside(real, root) or real == root:
            raise HelperError("That path isn’t allowed")
        shutil.rmtree(real)
    return "ok"


def ga_json(payload):
    return json.dumps(payload, separators=(",", ":"))


def do_ga_ping(args, run):
    guest_id = parse_guest_id(args[0])
    return virsh(run, "qemu-agent-command", domain(guest_id), ga_json({"execute": "guest-ping"}))


def do_ga_exec(args, stdin, run):
    guest_id = parse_guest_id(args[0])
    body = read_object(stdin)
    if set(body) - GA_EXEC_FIELDS:
        raise HelperError("Unexpected field")
    path = body.get("path")
    if not isinstance(path, str) or len(path) > 200 or GA_PATH.fullmatch(path) is None:
        raise HelperError("Invalid path")
    ga = {"path": path}
    if "args" in body:
        argv = body.get("args")
        if not isinstance(argv, list) or len(argv) > 32:
            raise HelperError("Invalid args")
        for item in argv:
            if not isinstance(item, str) or len(item) > 4096 or "\0" in item:
                raise HelperError("Invalid args")
        ga["arg"] = argv
    if body.get("capture", True) is not False:
        if "capture" in body and type(body["capture"]) is not bool:
            raise HelperError("Invalid capture")
        ga["capture-output"] = True
    elif type(body.get("capture")) is not bool:
        raise HelperError("Invalid capture")
    if "input" in body:
        secret = body.get("input")
        if not isinstance(secret, str) or len(secret) > 65536:
            raise HelperError("Invalid input")
        ga["input-data"] = base64.b64encode(secret.encode("utf-8")).decode("ascii")
    blob = ga_json({"execute": "guest-exec", "arguments": ga})
    out = virsh(run, "qemu-agent-command", domain(guest_id), blob)
    pid = 0
    try:
        reply = json.loads(out) if out else {}
        ret = reply.get("return") if isinstance(reply, dict) else None
        if isinstance(ret, dict) and is_int(ret.get("pid")):
            pid = ret["pid"]
    except json.JSONDecodeError:
        pass
    return json.dumps({"pid": pid})


def b64_text(value):
    if not value:
        return ""
    try:
        return base64.b64decode(value).decode("utf-8", "replace")
    except Exception:
        return ""


def do_ga_status(args, run):
    guest_id = parse_guest_id(args[0])
    raw_pid = args[1]
    if not isinstance(raw_pid, str) or not re.fullmatch(r"[0-9]+", raw_pid):
        raise HelperError("Unknown action")
    pid = int(raw_pid)
    if pid < 1 or pid > 2147483647:
        raise HelperError("Invalid pid")
    out = virsh(run, "qemu-agent-command", domain(guest_id), ga_json({"execute": "guest-exec-status", "arguments": {"pid": pid}}))
    exited = False
    exitcode = None
    stdout = ""
    stderr = ""
    try:
        reply = json.loads(out) if out else {}
        ret = reply.get("return") if isinstance(reply, dict) else None
        if isinstance(ret, dict):
            exited = bool(ret.get("exited"))
            code = ret.get("exitcode")
            exitcode = code if is_int(code) else None
            stdout = b64_text(ret.get("out-data"))
            stderr = b64_text(ret.get("err-data"))
    except json.JSONDecodeError:
        pass
    return json.dumps({"exited": exited, "exitcode": exitcode, "out": stdout, "err": stderr})


def handle(verb, args, stdin=None, run=None, fetch=None, data_dir=None, kvm_path=None, uid=None, uname=None, meminfo=None):
    if uid is None:
        uid = os.geteuid()
    if uid == 0:
        raise HelperError(ROOT_MESSAGE)
    if args is None:
        args = []
    if verb not in VERBS:
        raise HelperError("Unknown action")
    lo, hi = ARITY[verb]
    if len(args) < lo or len(args) > hi:
        raise HelperError("Unknown action")
    run = run or default_run
    if data_dir is None:
        data_dir = default_data_dir()
    if kvm_path is None:
        kvm_path = "/dev/kvm"
    if verb == "status":
        return status_report(run, data_dir, kvm_path, uname, meminfo)
    if verb == "fetch":
        return do_fetch(args, fetch, data_dir, uname)
    if verb == "disk-create":
        return do_disk_create(args, run, data_dir)
    if verb == "seed":
        return do_seed(args, stdin, run, data_dir)
    if verb == "define":
        return do_define(args, stdin, run, data_dir, kvm_path, uname)
    if verb == "start":
        return do_start(args, run)
    if verb in ("shutdown", "reboot", "destroy", "suspend", "resume"):
        return do_power(verb, args, run)
    if verb == "undefine":
        return do_undefine(args, run, data_dir)
    if verb == "state":
        return do_state(run)
    if verb == "vnc-path":
        return do_vnc_path(args, data_dir)
    if verb == "inspect":
        return do_inspect(args, run, data_dir)
    if verb == "stats":
        return do_stats(run)
    if verb == "ga-ping":
        return do_ga_ping(args, run)
    if verb == "ga-exec":
        return do_ga_exec(args, stdin, run)
    if verb == "ga-status":
        return do_ga_status(args, run)
    raise HelperError("Unknown action")


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)
    verb = argv[1] if len(argv) > 1 else ""
    args = argv[2:]
    stdin = None
    if not sys.stdin.isatty():
        stdin = sys.stdin.read()
    try:
        sys.stdout.write(handle(verb, args, stdin=stdin, uid=os.geteuid()))
        sys.stdout.write("\n")
    except HelperError as err:
        sys.stderr.write("%s\n" % err.message)
        sys.exit(1)


if __name__ == "__main__":
    main()
