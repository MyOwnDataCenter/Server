#!/usr/bin/env python3
"""Per-user Incus helper for swarm computers. Runs as the connector user: no sudo, no shell."""
import json
import os
import re
import shutil
import subprocess
import sys

VERBS = frozenset(("status", "list", "launch", "start", "stop", "restart", "delete"))
ARITY = {"status": (0, 0), "list": (0, 0), "launch": (0, 0), "start": (1, 1), "stop": (1, 1), "restart": (1, 1), "delete": (1, 1)}
NAME = re.compile(r"^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$")
SETUP = "machines-add-lxc"


class HelperError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


def default_run(cmd, args, input=None, timeout=120):
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    try:
        kw = {"capture_output": True, "text": True, "timeout": timeout, "env": env}
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
        err = (r.stderr or r.stdout or "%s failed" % cmd).strip().split("\n")[-1]
        raise HelperError(err[:300])
    return r.stdout or ""


def incus_path():
    return shutil.which("incus") or "incus"


def status_report(run=None):
    run = run or default_run
    incus = incus_path()
    try:
        out = run(incus, ["query", "/1.0"], timeout=10)
        info = json.loads(out) if out.strip() else {}
        env = info.get("environment") or {}
        return json.dumps(
            {
                "available": True,
                "version": env.get("server_version"),
                "project": env.get("project"),
            }
        )
    except HelperError as e:
        text = e.message or ""
        if "not installed" in text:
            reason = "Incus isn’t installed on this computer yet."
        elif re.search(r"permission denied", text, re.I):
            reason = "This account can’t reach Incus yet. Run the setup below again."
        elif re.search(r"no such file|connection refused|unix\.socket", text, re.I):
            reason = "Incus is installed but its per-user service isn’t running."
        else:
            reason = text or "Incus isn’t ready on this computer."
        return json.dumps({"available": False, "reason": reason, "setupCommand": SETUP})
    except (json.JSONDecodeError, TypeError, ValueError):
        return json.dumps({"available": True, "version": None, "project": None})


def list_containers(run=None):
    run = run or default_run
    incus = incus_path()
    out = run(incus, ["list", "--format", "json"], timeout=20)
    try:
        rows = json.loads(out)
    except (json.JSONDecodeError, TypeError):
        raise HelperError("Incus gave a list this helper couldn’t read")
    if not isinstance(rows, list):
        rows = []
    return json.dumps([c for c in rows if isinstance(c, dict) and c.get("type") == "container"])


def valid_name(name):
    if not isinstance(name, str) or not NAME.match(name):
        raise HelperError("That container name isn’t valid")


def launch_containers(run=None, body=None):
    run = run or default_run
    incus = incus_path()
    if not isinstance(body, dict):
        raise HelperError("Unknown action")
    name = body.get("name")
    source = body.get("source")
    configs = body.get("configs") or []
    disk = body.get("diskGiB", 8)
    valid_name(name)
    if not isinstance(source, str) or not source or len(source) > 200:
        raise HelperError("Pick a system from the library")
    if not isinstance(configs, list):
        raise HelperError("Unknown action")
    try:
        disk_gib = int(disk)
    except (TypeError, ValueError):
        raise HelperError("Use 1 to 4096 GB of disk")
    if disk_gib < 1 or disk_gib > 4096:
        raise HelperError("Use 1 to 4096 GB of disk")
    args = ["launch", source, name]
    for cfg in configs:
        if not isinstance(cfg, str) or not cfg or len(cfg) > 200:
            raise HelperError("Unknown action")
        args.extend(["--config", cfg])
    args.extend(["--device", "root,size=%dGiB" % disk_gib])
    run(incus, args, timeout=20 * 60)
    return json.dumps({"name": name})


def power_verb(run, verb, name):
    valid_name(name)
    incus = incus_path()
    timeout = 90 if verb == "restart" else 120
    extra = ["--timeout", "60"] if verb in ("stop", "restart") else []
    run(incus, [verb, name, *extra], timeout=timeout)
    return json.dumps({"ok": True})


def delete_container(run=None, name=None):
    run = run or default_run
    valid_name(name)
    run(incus_path(), ["delete", name, "--force"], timeout=120)
    return json.dumps({"ok": True})


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in VERBS:
        sys.stderr.write("Unknown action\n")
        return 2
    verb = sys.argv[1]
    lo, hi = ARITY[verb]
    pos = sys.argv[2 : 2 + hi]
    if len(pos) < lo:
        sys.stderr.write("Unknown action\n")
        return 2
    body = None
    if verb == "launch":
        raw = sys.stdin.read()
        try:
            body = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError:
            sys.stderr.write("Unknown action\n")
            return 2
    try:
        if verb == "status":
            sys.stdout.write(status_report())
        elif verb == "list":
            sys.stdout.write(list_containers())
        elif verb == "launch":
            sys.stdout.write(launch_containers(body=body))
        elif verb == "delete":
            sys.stdout.write(delete_container(name=pos[0]))
        else:
            sys.stdout.write(power_verb(default_run, verb, pos[0]))
    except HelperError as e:
        sys.stderr.write(e.message + "\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())