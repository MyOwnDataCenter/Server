#!/usr/bin/env python3
"""
Direct Wayland GPU-accelerated Hyprland streamer (zero external Python deps).

Speaks Wayland binary wire protocol directly over $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY:
  - Full monitor capture via zwlr_screencopy_manager_v1
  - Single native window capture via hyprland_toplevel_export_manager_v1
  - Hardware H.264 encoding via ffmpeg VA-API (/dev/dri/renderD128) with libx264 fallback
  - Direct pointer + keyboard injection via zwlr_virtual_pointer_manager_v1 and
    zwp_virtual_keyboard_manager_v1 (or hyprctl fallback for window-relative clicks)

Stdout binary protocol:
  [u8 msg_type][u32be payload_len][payload]
    type 1: UTF-8 JSON metadata {width, height, fps, encoder, codec, mode, address}
    type 2: [u8 is_keyframe][u64be timestamp_us][Annex-B H.264 access unit]
    type 3: UTF-8 JSON error/notice {error}

Stdin newline-delimited JSON commands:
  {"type":"pointer_move","x":0.5,"y":0.5}
  {"type":"pointer_button","button":272,"down":true}
  {"type":"pointer_scroll","dx":0,"dy":15}
  {"type":"key","code":30,"down":true,"mods":0}
  {"type":"keyframe"}
"""

import argparse
import array
import json
import mmap
import os
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

# Wayland SHM pixel formats
WL_SHM_FORMAT_ARGB8888 = 0
WL_SHM_FORMAT_XRGB8888 = 1
WL_SHM_FORMAT_ABGR8888 = 0x34324241
WL_SHM_FORMAT_XBGR8888 = 0x34324258

# Standard compact US XKB keymap (evdev keycodes 8..255) for zwp_virtual_keyboard_v1
US_XKB_KEYMAP = r"""xkb_keymap {
xkb_keycodes "evdev" {
	minimum = 8;
	maximum = 255;
	<ESC> = 9;
	<AE01> = 10; <AE02> = 11; <AE03> = 12; <AE04> = 13; <AE05> = 14;
	<AE06> = 15; <AE07> = 16; <AE08> = 17; <AE09> = 18; <AE10> = 19;
	<AE11> = 20; <AE12> = 21; <BKSP> = 22; <TAB> = 23;
	<AD01> = 24; <AD02> = 25; <AD03> = 26; <AD04> = 27; <AD05> = 28;
	<AD06> = 29; <AD07> = 30; <AD08> = 31; <AD09> = 32; <AD10> = 33;
	<AD11> = 34; <AD12> = 35; <RTRN> = 36; <LCTL> = 37;
	<AC01> = 38; <AC02> = 39; <AC03> = 40; <AC04> = 41; <AC05> = 42;
	<AC06> = 43; <AC07> = 44; <AC08> = 45; <AC09> = 46; <AC10> = 47;
	<AC11> = 48; <TLDE> = 49; <LFSH> = 50; <BKSL> = 51;
	<AB01> = 52; <AB02> = 53; <AB03> = 54; <AB04> = 55; <AB05> = 56;
	<AB06> = 57; <AB07> = 58; <AB08> = 59; <AB09> = 60; <AB10> = 61;
	<RTSH> = 62; <LALT> = 64; <SPCE> = 65; <CAPS> = 66;
	<FK01> = 67; <FK02> = 68; <FK03> = 69; <FK04> = 70; <FK05> = 71;
	<FK06> = 72; <FK07> = 73; <FK08> = 74; <FK09> = 75; <FK10> = 76;
	<FK11> = 95; <FK12> = 96; <RCTL> = 105; <RALT> = 108;
	<HOME> = 110; <UP> = 111; <PGUP> = 112; <LEFT> = 113; <RGHT> = 114;
	<END> = 115; <DOWN> = 116; <PGDN> = 117; <INS> = 118; <DELE> = 119;
	<LWIN> = 133; <RWIN> = 134;
};
xkb_types "complete" {
	virtual_modifiers NumLock,Alt,LevelThree,Super;
	type "ONE_LEVEL" { modifiers= none; level_name[Level1]= "Any"; };
	type "TWO_LEVEL" {
		modifiers= Shift;
		map[Shift]= Level2;
		level_name[Level1]= "Base";
		level_name[Level2]= "Shift";
	};
	type "ALPHABETIC" {
		modifiers= Shift+Lock;
		map[Shift]= Level2;
		map[Lock]= Level2;
		level_name[Level1]= "Base";
		level_name[Level2]= "Caps";
	};
};
xkb_compatibility "complete" {
	virtual_modifiers NumLock,Alt,LevelThree,Super;
	interpret Any+AnyOf(all) { action= SetMods(modifiers=modMapMods,clearLocks); };
};
xkb_symbols "pc+us" {
	key <ESC>  { [ Escape ] };
	key <AE01> { [ 1, exclam ] };
	key <AE02> { [ 2, at ] };
	key <AE03> { [ 3, numbersign ] };
	key <AE04> { [ 4, dollar ] };
	key <AE05> { [ 5, percent ] };
	key <AE06> { [ 6, asciicircum ] };
	key <AE07> { [ 7, ampersand ] };
	key <AE08> { [ 8, asterisk ] };
	key <AE09> { [ 9, parenleft ] };
	key <AE10> { [ 0, parenright ] };
	key <AE11> { [ minus, underscore ] };
	key <AE12> { [ equal, plus ] };
	key <BKSP> { [ BackSpace ] };
	key <TAB>  { [ Tab, ISO_Left_Tab ] };
	key <AD01> { [ q, Q ] }; key <AD02> { [ w, W ] }; key <AD03> { [ e, E ] };
	key <AD04> { [ r, R ] }; key <AD05> { [ t, T ] }; key <AD06> { [ y, Y ] };
	key <AD07> { [ u, U ] }; key <AD08> { [ i, I ] }; key <AD09> { [ o, O ] };
	key <AD10> { [ p, P ] };
	key <AD11> { [ bracketleft, braceleft ] };
	key <AD12> { [ bracketright, braceright ] };
	key <RTRN> { [ Return ] };
	key <LCTL> { [ Control_L ] };
	key <AC01> { [ a, A ] }; key <AC02> { [ s, S ] }; key <AC03> { [ d, D ] };
	key <AC04> { [ f, F ] }; key <AC05> { [ g, G ] }; key <AC06> { [ h, H ] };
	key <AC07> { [ j, J ] }; key <AC08> { [ k, K ] }; key <AC09> { [ l, L ] };
	key <AC10> { [ semicolon, colon ] };
	key <AC11> { [ apostrophe, quotedbl ] };
	key <TLDE> { [ grave, asciitilde ] };
	key <LFSH> { [ Shift_L ] };
	key <BKSL> { [ backslash, bar ] };
	key <AB01> { [ z, Z ] }; key <AB02> { [ x, X ] }; key <AB03> { [ c, C ] };
	key <AB04> { [ v, V ] }; key <AB05> { [ b, B ] }; key <AB06> { [ n, N ] };
	key <AB07> { [ m, M ] };
	key <AB08> { [ comma, less ] };
	key <AB09> { [ period, greater ] };
	key <AB10> { [ slash, question ] };
	key <RTSH> { [ Shift_R ] };
	key <LALT> { [ Alt_L ] };
	key <SPCE> { [ space ] };
	key <CAPS> { [ Caps_Lock ] };
	key <FK01> { [ F1 ] }; key <FK02> { [ F2 ] }; key <FK03> { [ F3 ] };
	key <FK04> { [ F4 ] }; key <FK05> { [ F5 ] }; key <FK06> { [ F6 ] };
	key <FK07> { [ F7 ] }; key <FK08> { [ F8 ] }; key <FK09> { [ F9 ] };
	key <FK10> { [ F10 ] }; key <FK11> { [ F11 ] }; key <FK12> { [ F12 ] };
	key <RCTL> { [ Control_R ] };
	key <RALT> { [ Alt_R ] };
	key <HOME> { [ Home ] }; key <UP> { [ Up ] }; key <PGUP> { [ Prior ] };
	key <LEFT> { [ Left ] }; key <RGHT> { [ Right ] }; key <END> { [ End ] };
	key <DOWN> { [ Down ] }; key <PGDN> { [ Next ] };
	key <INS>  { [ Insert ] }; key <DELE> { [ Delete ] };
	key <LWIN> { [ Super_L ] }; key <RWIN> { [ Super_R ] };
	modifier_map Shift { <LFSH>, <RTSH> };
	modifier_map Lock { <CAPS> };
	modifier_map Control { <LCTL>, <RCTL> };
	modifier_map Mod1 { <LALT>, <RALT> };
	modifier_map Mod4 { <LWIN>, <RWIN> };
};
xkb_geometry "pc(pc104)" {};
};
"""


def wl_pack_str(s: str) -> bytes:
    b = s.encode("utf-8") + b"\x00"
    pad = (4 - (len(b) % 4)) % 4
    return struct.pack("<I", len(b)) + b + (b"\x00" * pad)


def wl_unpack_str(buf: bytes, offset: int):
    (n,) = struct.unpack_from("<I", buf, offset)
    s = buf[offset + 4 : offset + 4 + max(0, n - 1)].decode("utf-8", errors="replace")
    pad = (4 - (n % 4)) % 4
    return s, offset + 4 + n + pad


class WaylandClient:
    def __init__(self, sock_path: str):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(sock_path)
        self.lock = threading.Lock()
        self.next_id = 2
        self.free_ids = []
        self.rx = bytearray()
        self.globals = {}  # interface -> list[(name, version)]
        self.callbacks = {}
        self.handlers = {}
        self.last_error = None

    def alloc_id(self) -> int:
        if self.free_ids:
            return self.free_ids.pop()
        oid = self.next_id
        self.next_id += 1
        return oid

    def send(self, obj_id: int, opcode: int, payload: bytes = b"", fds=None):
        size = 8 + len(payload)
        msg = struct.pack("<II", obj_id, (size << 16) | opcode) + payload
        with self.lock:
            try:
                if fds:
                    anc = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds).tobytes())]
                    sent = self.sock.sendmsg([msg], anc)
                    if sent <= 0:
                        raise OSError("Wayland sendmsg wrote 0 bytes")
                    if sent < len(msg):
                        self.sock.sendall(msg[sent:])
                else:
                    self.sock.sendall(msg)
            except Exception:
                self.close()
                raise

    def read_once(self, timeout=0.05) -> bool:
        r, _, _ = select.select([self.sock], [], [], timeout)
        if not r:
            return False
        chunk = self.sock.recv(65536)
        if not chunk:
            raise EOFError("Wayland compositor closed connection")
        self.rx.extend(chunk)
        self._dispatch()
        return True

    def _dispatch(self):
        while len(self.rx) >= 8:
            obj_id, size_op = struct.unpack_from("<II", self.rx, 0)
            size = size_op >> 16
            op = size_op & 0xFFFF
            if size < 8 or (size & 3) != 0:
                self.close()
                raise RuntimeError(f"Invalid Wayland frame size: {size}")
            if len(self.rx) < size:
                return
            payload = bytes(self.rx[8:size])
            del self.rx[:size]
            if obj_id == 1:
                if op == 0 and len(payload) >= 12:
                    err_obj, err_code = struct.unpack_from("<II", payload, 0)
                    err_msg, _ = wl_unpack_str(payload, 8)
                    self.last_error = f"wl_display error obj={err_obj} code={err_code}: {err_msg}"
                elif op == 1 and len(payload) >= 4:
                    (del_id,) = struct.unpack_from("<I", payload, 0)
                    if del_id >= 2 and len(self.free_ids) < 256:
                        self.free_ids.append(del_id)
                continue
            fn = self.handlers.get(obj_id)
            if fn:
                fn(op, payload)

    def roundtrip(self, timeout=3.0):
        cb = self.alloc_id()
        done = [False]
        self.handlers[cb] = lambda op, p: done.__setitem__(0, True)
        self.send(1, 0, struct.pack("<I", cb))
        deadline = time.monotonic() + timeout
        while not done[0]:
            if time.monotonic() > deadline:
                raise TimeoutError("Wayland roundtrip timeout")
            self.read_once(0.05)
        self.handlers.pop(cb, None)

    def discover_globals(self):
        reg = self.alloc_id()
        self.registry_id = reg

        def on_reg(op, payload):
            if op == 0:
                (name,) = struct.unpack_from("<I", payload, 0)
                iface, off = wl_unpack_str(payload, 4)
                (ver,) = struct.unpack_from("<I", payload, off)
                self.globals.setdefault(iface, []).append((name, ver))

        self.handlers[reg] = on_reg
        self.send(1, 1, struct.pack("<I", reg))
        self.roundtrip()
        return self.globals

    def bind(self, iface: str, max_ver: int, index: int = 0):
        entries = self.globals.get(iface)
        if not entries or index >= len(entries):
            return None, 0
        name, ver = entries[index]
        use_ver = min(ver, max_ver)
        oid = self.alloc_id()
        payload = struct.pack("<I", name) + wl_pack_str(iface) + struct.pack("<II", use_ver, oid)
        self.send(self.registry_id, 0, payload)
        return oid, use_ver

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


SUPPORTED_SHM_FORMATS = (
    WL_SHM_FORMAT_ARGB8888,
    WL_SHM_FORMAT_XRGB8888,
    WL_SHM_FORMAT_ABGR8888,
    WL_SHM_FORMAT_XBGR8888,
)
MAX_CAPTURE_DIM = 8192
MAX_SHM_POOL_BYTES = 0x7FFFFFFF


def is_valid_shm_layout(fmt: int, width: int, height: int, stride: int) -> bool:
    if fmt not in SUPPORTED_SHM_FORMATS:
        return False
    if width <= 0 or height <= 0 or width > MAX_CAPTURE_DIM or height > MAX_CAPTURE_DIM:
        return False
    if stride < width * 4 or stride > MAX_SHM_POOL_BYTES:
        return False
    size = stride * height
    if size <= 0 or size > MAX_SHM_POOL_BYTES:
        return False
    return True


class ShmBuffer:
    def __init__(self, wl: WaylandClient, shm_id: int, width: int, height: int, stride: int, fmt: int):
        if not is_valid_shm_layout(fmt, width, height, stride):
            raise ValueError(f"Unsupported or invalid SHM layout: fmt={fmt} {width}x{height} stride={stride}")
        self.wl = wl
        self.width = width
        self.height = height
        self.stride = stride
        self.fmt = fmt
        self.size = stride * height
        self.fd = os.memfd_create("hypr-frame", 0)
        self.mm = None
        self.pool_id = None
        self.buf_id = None
        try:
            os.ftruncate(self.fd, self.size)
            self.mm = mmap.mmap(self.fd, self.size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
            self.pool_id = wl.alloc_id()
            wl.send(shm_id, 0, struct.pack("<Ii", self.pool_id, self.size), fds=[self.fd])
            self.buf_id = wl.alloc_id()
            wl.send(
                self.pool_id,
                0,
                struct.pack("<IiiiiI", self.buf_id, 0, width, height, stride, fmt),
            )
        except Exception:
            if self.mm is not None:
                try:
                    self.mm.close()
                except Exception:
                    pass
                self.mm = None
            if self.fd is not None:
                try:
                    os.close(self.fd)
                except Exception:
                    pass
                self.fd = None
            raise

    def read_frame_bytes(self, y_invert: bool = False) -> bytes:
        row_bytes = self.width * 4
        if not y_invert and self.stride == row_bytes:
            return self.mm[:]
        out = bytearray(row_bytes * self.height)
        for y in range(self.height):
            src_y = (self.height - 1 - y) if y_invert else y
            src_off = src_y * self.stride
            dst_off = y * row_bytes
            out[dst_off : dst_off + row_bytes] = self.mm[src_off : src_off + row_bytes]
        return bytes(out)

    def destroy(self):
        try:
            self.wl.send(self.buf_id, 0)
            self.wl.send(self.pool_id, 1)
        except Exception:
            pass
        try:
            self.mm.close()
        except Exception:
            pass
        try:
            os.close(self.fd)
        except Exception:
            pass


class FrameWriter:
    def __init__(self):
        self.lock = threading.Lock()
        self.out = sys.stdout.buffer

    def send_json(self, msg_type: int, obj: dict):
        data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        with self.lock:
            self.out.write(struct.pack(">BI", msg_type, len(data)) + data)
            self.out.flush()

    def send_video(self, is_key: bool, ts_us: int, annexb: bytes):
        header = struct.pack(">BQ", 1 if is_key else 0, ts_us)
        with self.lock:
            self.out.write(struct.pack(">BI", 2, len(header) + len(annexb)) + header + annexb)
            self.out.flush()


def find_start_codes(buf: bytearray):
    """Return list of (pos, code_len) for Annex-B start codes in buf."""
    found = []
    i = 0
    n = len(buf)
    while i < n - 3:
        idx = buf.find(b"\x00\x00", i)
        if idx == -1 or idx >= n - 2:
            break
        if buf[idx + 2] == 1:
            found.append((idx, 3))
            i = idx + 3
        elif idx + 3 < n and buf[idx + 2] == 0 and buf[idx + 3] == 1:
            found.append((idx, 4))
            i = idx + 4
        else:
            i = idx + 1
    return found


class H264Encoder:
    def __init__(
        self,
        width: int,
        height: int,
        pix_fmt: str,
        fps: int,
        bitrate_kbps: int,
        writer: FrameWriter,
        meta_base: dict,
        prefer_vaapi: bool = True,
    ):
        self.width = width
        self.height = height
        self.pix_fmt = pix_fmt
        self.fps = fps
        self.writer = writer
        self.meta_base = meta_base
        self.stop_event = threading.Event()
        self.encoder_name = "libx264"
        self.proc = None
        self.reader_thread = None
        self.frame_index = 0
        self._start(bitrate_kbps, prefer_vaapi)

    def _build_cmd(self, use_vaapi: bool, bitrate_kbps: int):
        even_w = self.width - (self.width % 2)
        even_h = self.height - (self.height % 2)
        if even_w < 2:
            even_w = 2
        if even_h < 2:
            even_h = 2
        crop = f"crop={even_w}:{even_h}:0:0"
        base = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-f",
            "rawvideo",
            "-pix_fmt",
            self.pix_fmt,
            "-s:v",
            f"{self.width}x{self.height}",
            "-r",
            str(self.fps),
            "-i",
            "pipe:0",
        ]
        if use_vaapi:
            return base + [
                "-vaapi_device",
                "/dev/dri/renderD128",
                "-vf",
                f"{crop},format=nv12,hwupload",
                "-c:v",
                "h264_vaapi",
                "-profile:v",
                "constrained_baseline",
                "-bf",
                "0",
                "-aud",
                "1",
                "-g",
                str(max(15, self.fps * 2)),
                "-b:v",
                f"{bitrate_kbps}k",
                "-maxrate",
                f"{int(bitrate_kbps * 1.4)}k",
                "-bufsize",
                f"{bitrate_kbps}k",
                "-f",
                "h264",
                "pipe:1",
            ]
        return base + [
            "-vf",
            f"{crop},format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-x264-params",
            "slices=1:repeat-headers=1:aud=1",
            "-profile:v",
            "baseline",
            "-bf",
            "0",
            "-g",
            str(max(15, self.fps * 2)),
            "-b:v",
            f"{bitrate_kbps}k",
            "-maxrate",
            f"{int(bitrate_kbps * 1.4)}k",
            "-bufsize",
            f"{bitrate_kbps}k",
            "-f",
            "h264",
            "pipe:1",
        ]

    def _start(self, bitrate_kbps: int, prefer_vaapi: bool):
        has_vaapi = prefer_vaapi and os.path.exists("/dev/dri/renderD128")
        tried = [True, False] if has_vaapi else [False]
        last_err = ""
        for use_vaapi in tried:
            cmd = self._build_cmd(use_vaapi, bitrate_kbps)
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
            time.sleep(0.05)
            if proc.poll() is not None:
                last_err = (proc.stderr.read() or b"").decode("utf-8", errors="replace").strip()
                continue
            self.proc = proc
            self.encoder_name = "h264_vaapi" if use_vaapi else "libx264"
            break
        if not self.proc:
            raise RuntimeError(f"ffmpeg failed to start: {last_err}")

        even_w = max(2, self.width - (self.width % 2))
        even_h = max(2, self.height - (self.height % 2))
        self.writer.send_json(
            1,
            {
                **self.meta_base,
                "width": even_w,
                "height": even_h,
                "fps": self.fps,
                "encoder": self.encoder_name,
                "codec": "avc1.42E028",
            },
        )
        self.reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self.reader_thread.start()

    def _read_loop(self):
        buf = bytearray()
        sps = None
        pps = None
        start_t = time.monotonic()
        self.frames_emitted = 0
        stdout = self.proc.stdout
        au_parts = []
        au_has_vcl = False
        au_is_key = False

        def flush_au():
            nonlocal au_parts, au_has_vcl, au_is_key
            if not au_has_vcl or not au_parts:
                au_parts = []
                au_has_vcl = False
                au_is_key = False
                return
            payload = ((sps or b"") + (pps or b"") if au_is_key else b"") + b"".join(au_parts)
            ts_us = int((time.monotonic() - start_t) * 1_000_000)
            self.frames_emitted += 1
            self.writer.send_video(au_is_key, ts_us, payload)
            au_parts = []
            au_has_vcl = False
            au_is_key = False

        def handle_nal(nal: bytes, l0: int):
            nonlocal sps, pps, au_has_vcl, au_is_key
            if len(nal) <= l0:
                return
            nal_type = nal[l0] & 0x1F
            if nal_type == 9:
                # Access Unit Delimiter starts a new picture
                flush_au()
                return
            if nal_type == 7:
                if au_has_vcl:
                    flush_au()
                sps = nal
                return
            if nal_type == 8:
                if au_has_vcl:
                    flush_au()
                pps = nal
                return
            if nal_type in (1, 5):
                # first_mb_in_slice == 0 (exp-golomb leading bit 1 at MSB of first slice header byte) starts a new picture
                is_first_slice = len(nal) > l0 + 1 and (nal[l0 + 1] & 0x80) != 0
                if au_has_vcl and is_first_slice:
                    flush_au()
                au_parts.append(nal)
                au_has_vcl = True
                if nal_type == 5:
                    au_is_key = True

        while not self.stop_event.is_set():
            chunk = stdout.read(65536)
            if not chunk:
                break
            buf.extend(chunk)
            codes = find_start_codes(buf)
            if len(codes) < 2:
                continue
            # Process every complete NALU before the final start code
            last_pos = codes[-1][0]
            for i in range(len(codes) - 1):
                p0, l0 = codes[i]
                p1, _ = codes[i + 1]
                handle_nal(bytes(buf[p0:p1]), l0)
            del buf[:last_pos]

        # Drain remaining NALUs and flush the final access unit ONLY on clean EOF (never on cancellation, which could emit a truncated picture)
        if not self.stop_event.is_set():
            codes = find_start_codes(buf)
            for i in range(len(codes)):
                p0, l0 = codes[i]
                p1 = codes[i + 1][0] if i + 1 < len(codes) else len(buf)
                handle_nal(bytes(buf[p0:p1]), l0)
            flush_au()

    def write_frame(self, raw: bytes) -> bool:
        if not self.proc or self.proc.poll() is not None:
            return False
        try:
            self.proc.stdin.write(raw)
            self.proc.stdin.flush()
            self.frame_index += 1
            return True
        except BrokenPipeError:
            return False

    def close(self):
        self.stop_event.set()
        if self.proc:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.terminate()
                self.proc.wait(timeout=1.5)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            try:
                self.proc.stdout.close()
            except Exception:
                pass
            self.proc = None
        rt = getattr(self, "reader_thread", None)
        if rt is not None and rt.is_alive() and rt is not threading.current_thread():
            rt.join(timeout=2.0)


class InputInjector:
    def __init__(self, wl: WaylandClient, seat_id: int, mode: str, address: str):
        self.wl = wl
        self.mode = mode
        self.address = address
        self.ptr_id = None
        self.kbd_id = None
        self.last_x = 0.5
        self.last_y = 0.5
        self.extent_w = 1920
        self.extent_h = 1080
        self.win_rect = None  # (x, y, w, h) for window-mode pointer mapping
        self.win_rect_at = 0.0

        pm_id, _ = wl.bind("zwlr_virtual_pointer_manager_v1", 2)
        if pm_id and seat_id:
            self.ptr_id = wl.alloc_id()
            wl.send(pm_id, 0, struct.pack("<II", seat_id, self.ptr_id))

        km_id, _ = wl.bind("zwp_virtual_keyboard_manager_v1", 1)
        if km_id and seat_id:
            self.kbd_id = wl.alloc_id()
            wl.send(km_id, 0, struct.pack("<II", seat_id, self.kbd_id))
            km_bytes = US_XKB_KEYMAP.encode("utf-8") + b"\x00"
            fd = os.memfd_create("hypr-keymap", 0)
            os.write(fd, km_bytes)
            os.lseek(fd, 0, os.SEEK_SET)
            wl.send(self.kbd_id, 0, struct.pack("<II", 1, len(km_bytes)), fds=[fd])
            os.close(fd)

    def _refresh_window_rect(self):
        now = time.monotonic()
        if self.win_rect and now - self.win_rect_at < 0.75:
            return
        try:
            raw = subprocess.check_output(["hyprctl", "clients", "-j"], timeout=1.0)
            clients = json.loads(raw)
            target = self.address.lower()
            for c in clients:
                if str(c.get("address", "")).lower() == target:
                    at = c.get("at") or [0, 0]
                    sz = c.get("size") or [1, 1]
                    self.win_rect = (int(at[0]), int(at[1]), max(1, int(sz[0])), max(1, int(sz[1])))
                    self.win_rect_at = now
                    return
        except Exception:
            pass

    def _map_xy(self, nx: float, ny: float):
        nx = max(0.0, min(1.0, float(nx)))
        ny = max(0.0, min(1.0, float(ny)))
        if self.win_rect and self.extent_w > 0 and self.extent_h > 0:
            wx, wy, ww, wh = self.win_rect
            lx, ly = getattr(self, "layout_x", 0), getattr(self, "layout_y", 0)
            ax = int(max(0, min(self.extent_w - 1, (wx - lx) + nx * ww)))
            ay = int(max(0, min(self.extent_h - 1, (wy - ly) + ny * wh)))
            return ax, ay, self.extent_w, self.extent_h
        if self.mode == "window" and self.address:
            self._refresh_window_rect()
            if self.win_rect and self.extent_w > 0 and self.extent_h > 0:
                wx, wy, ww, wh = self.win_rect
                lx, ly = getattr(self, "layout_x", 0), getattr(self, "layout_y", 0)
                ax = int(max(0, min(self.extent_w - 1, (wx - lx) + nx * ww)))
                ay = int(max(0, min(self.extent_h - 1, (wy - ly) + ny * wh)))
                return ax, ay, self.extent_w, self.extent_h
        return int(nx * 65535), int(ny * 65535), 65535, 65535

    def handle(self, cmd: dict):
        t = cmd.get("type")
        ts = int(time.monotonic() * 1000) & 0xFFFFFFFF
        if t == "win_rect":
            try:
                self.win_rect = (int(cmd.get("x", 0)), int(cmd.get("y", 0)), max(1, int(cmd.get("w", 1))), max(1, int(cmd.get("h", 1))))
                self.win_rect_at = time.monotonic()
                self.layout_x = int(cmd.get("lx", 0))
                self.layout_y = int(cmd.get("ly", 0))
                self.extent_w = max(1, int(cmd.get("lw", self.extent_w)))
                self.extent_h = max(1, int(cmd.get("lh", self.extent_h)))
            except Exception:
                pass
            return
        if t == "pointer_move" and self.ptr_id:
            self.last_x = float(cmd.get("x", self.last_x))
            self.last_y = float(cmd.get("y", self.last_y))
            x, y, ex, ey = self._map_xy(self.last_x, self.last_y)
            self.wl.send(self.ptr_id, 1, struct.pack("<IIIII", ts, x, y, ex, ey))
            self.wl.send(self.ptr_id, 4)
        elif t == "pointer_button" and self.ptr_id:
            if "x" in cmd and "y" in cmd:
                self.last_x = float(cmd["x"])
                self.last_y = float(cmd["y"])
                x, y, ex, ey = self._map_xy(self.last_x, self.last_y)
                self.wl.send(self.ptr_id, 1, struct.pack("<IIIII", ts, x, y, ex, ey))
            btn = int(cmd.get("button", 272))
            state = 1 if cmd.get("down") else 0
            if self.mode == "window" and self.address and state == 1:
                try:
                    # Hyprland 0.57+ uses Lua hl.dsp, older Hyprland uses legacy dispatch
                    subprocess.Popen(
                        ["hyprctl", "dispatch", "focuswindow", f"address:{self.address}"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                except Exception:
                    pass
            self.wl.send(self.ptr_id, 2, struct.pack("<III", ts, btn, state))
            self.wl.send(self.ptr_id, 4)
        elif t == "pointer_scroll" and self.ptr_id:
            dy = float(cmd.get("dy", 0))
            dx = float(cmd.get("dx", 0))
            if dy:
                self.wl.send(self.ptr_id, 3, struct.pack("<IIi", ts, 0, int(dy * 256)))
            if dx:
                self.wl.send(self.ptr_id, 3, struct.pack("<IIi", ts, 1, int(dx * 256)))
            self.wl.send(self.ptr_id, 4)
        elif t == "key" and self.kbd_id:
            code = int(cmd.get("code", 0))
            state = 1 if cmd.get("down") else 0
            if 0 < code < 248:
                self.wl.send(self.kbd_id, 1, struct.pack("<III", ts, code, state))
            if "mods" in cmd:
                mods = int(cmd.get("mods", 0)) & 0xFF
                self.wl.send(self.kbd_id, 2, struct.pack("<IIII", mods, 0, 0, 0))


IDLE = "idle"


def capture_once(wl: WaylandClient, shm_id: int, mgr_id: int, mgr_ver: int, mode: str, output_id: int, handle_u32: int, cached_shm, timeout: float = 2.0):
    """Capture one frame via zwlr_screencopy_manager_v1 or hyprland_toplevel_export_manager_v1.

    Returns (frame, shm) on success, (None, shm) when the compositor says the capture failed (the
    window or monitor is gone), and (IDLE, shm) when nothing arrived in time. Hyprland renders only
    when something on screen changes, so a still desktop or an idle window simply has no new frame:
    that is not a failure, and must never end the stream."""
    frame_id = wl.alloc_id()
    state = {"fmt": None, "w": 0, "h": 0, "stride": 0, "flags": 0, "ready": False, "failed": False, "copied": False}
    shm_ref = [cached_shm]

    def do_copy():
        if state["copied"] or state["fmt"] is None or not is_valid_shm_layout(state["fmt"], state["w"], state["h"], state["stride"]):
            state["failed"] = True
            return
        state["copied"] = True
        cur = shm_ref[0]
        if (
            cur is None
            or cur.width != state["w"]
            or cur.height != state["h"]
            or cur.stride != state["stride"]
            or cur.fmt != state["fmt"]
        ):
            if cur is not None:
                cur.destroy()
            try:
                cur = ShmBuffer(wl, shm_id, state["w"], state["h"], state["stride"], state["fmt"])
            except Exception:
                shm_ref[0] = None
                state["failed"] = True
                return
            shm_ref[0] = cur
        if mode == "window":
            wl.send(frame_id, 0, struct.pack("<Ii", cur.buf_id, 1))
        else:
            wl.send(frame_id, 0, struct.pack("<I", cur.buf_id))

    def on_frame(op, payload):
        if op == 0 and len(payload) >= 16:
            fmt, w, h, stride = struct.unpack_from("<IIII", payload, 0)
            # Only accept validated 32-bit RGB/BGR SHM layouts within protocol size bounds
            if is_valid_shm_layout(fmt, w, h, stride):
                state["fmt"], state["w"], state["h"], state["stride"] = fmt, w, h, stride
            if mode == "output" and mgr_ver < 3:
                do_copy()
        elif (mode == "output" and op == 1) or (mode == "window" and op == 2):
            if len(payload) >= 4:
                (state["flags"],) = struct.unpack_from("<I", payload, 0)
        elif (mode == "output" and op == 2) or (mode == "window" and op == 3):
            state["ready"] = True
        elif (mode == "output" and op == 3) or (mode == "window" and op == 4):
            state["failed"] = True
        elif op == 6:
            do_copy()

    wl.handlers[frame_id] = on_frame
    if mode == "window":
        wl.send(mgr_id, 0, struct.pack("<IiI", frame_id, 1, handle_u32))
    else:
        wl.send(mgr_id, 0, struct.pack("<IiI", frame_id, 1, output_id))

    deadline = time.monotonic() + timeout
    timed_out = False
    while not state["ready"] and not state["failed"]:
        if time.monotonic() > deadline:
            timed_out = True
            break
        wl.read_once(min(0.02, timeout))

    wl.handlers.pop(frame_id, None)
    try:
        wl.send(frame_id, 1)  # destroy frame
    except Exception:
        pass

    if timed_out and not state["failed"]:
        return IDLE, shm_ref[0]
    if state["failed"] or not shm_ref[0]:
        return None, shm_ref[0]

    y_invert = bool(state["flags"] & 1)
    raw = shm_ref[0].read_frame_bytes(y_invert=y_invert)
    pix_fmt = "rgba" if state["fmt"] in (WL_SHM_FORMAT_ABGR8888, WL_SHM_FORMAT_XBGR8888) else "bgra"
    return (state["w"], state["h"], pix_fmt, raw), shm_ref[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["output", "window"], default="output")
    parser.add_argument("--address", default="")
    parser.add_argument("--output", default="")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--bitrate", type=int, default=6000)
    parser.add_argument("--no-vaapi", action="store_true")
    parser.add_argument("--once", action="store_true", help="Capture 1 frame, encode, print meta+frames, and exit")
    parser.add_argument("--steady", action="store_true", help="On a still screen, repeat the last frame at the full rate (benchmarks)")
    args = parser.parse_args()

    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    display = os.environ.get("WAYLAND_DISPLAY")
    if not display:
        for name in sorted(os.listdir(runtime)):
            if name.startswith("wayland-") and not name.endswith(".lock"):
                display = name
                break
    if not display:
        FrameWriter().send_json(3, {"error": "No Wayland display socket found"})
        sys.exit(1)

    sock_path = os.path.join(runtime, display)
    writer = FrameWriter()
    wl = WaylandClient(sock_path)
    wl.discover_globals()

    shm_id, _ = wl.bind("wl_shm", 2)
    seat_id, _ = wl.bind("wl_seat", 7)
    # Bind all outputs and match --output by wl_output::name (op=4) when explicitly requested.
    out_probes = []
    for idx in range(min(8, len(wl.globals.get("wl_output", [])))):
        oid, _ = wl.bind("wl_output", 4, idx)
        if not oid:
            break
        probe = {"oid": oid, "name": ""}
        def _mk_handler(p):
            def _h(op, payload):
                if op == 4 and len(payload) >= 4:
                    try:
                        p["name"], _ = wl_unpack_str(payload, 0)
                    except Exception:
                        pass
            return _h
        wl.handlers[oid] = _mk_handler(probe)
        out_probes.append(probe)
    if out_probes:
        wl.roundtrip()
    output_id = None
    for p in out_probes:
        wl.handlers.pop(p["oid"], None)
        if args.output and p["name"] == args.output:
            output_id = p["oid"]
    if args.mode == "output" and args.output and not output_id:
        writer.send_json(3, {"error": f"Requested Wayland output '{args.output}' is unavailable"})
        sys.exit(1)
    if not output_id and not args.output and out_probes:
        output_id = out_probes[0]["oid"]
    if not shm_id or (args.mode == "output" and not output_id):
        writer.send_json(3, {"error": "Wayland compositor missing wl_shm or wl_output"})
        sys.exit(1)

    handle_u32 = 0
    if args.mode == "window":
        mgr_id, mgr_ver = wl.bind("hyprland_toplevel_export_manager_v1", 2)
        if not mgr_id:
            writer.send_json(3, {"error": "Hyprland toplevel export protocol not available"})
            sys.exit(1)
        try:
            handle_u32 = int(args.address, 16) & 0xFFFFFFFF
        except ValueError:
            writer.send_json(3, {"error": f"Invalid window address: {args.address}"})
            sys.exit(1)
    else:
        mgr_id, mgr_ver = wl.bind("zwlr_screencopy_manager_v1", 3)
        if not mgr_id:
            writer.send_json(3, {"error": "zwlr_screencopy_manager_v1 not available"})
            sys.exit(1)

    injector = InputInjector(wl, seat_id, args.mode, args.address)
    # Grab full multi-monitor logical layout extent and matching target monitor rect, and wake DPMS if asleep.
    try:
        mons = json.loads(subprocess.check_output(["hyprctl", "monitors", "-j"], timeout=1.0))
        if mons:
            min_x = min(int(m.get("x", 0)) for m in mons)
            min_y = min(int(m.get("y", 0)) for m in mons)
            max_x = max(int(m.get("x", 0)) + max(1, int(round(float(m.get("width", 1920)) / (float(m.get("scale") or 1.0) or 1.0)))) for m in mons)
            max_y = max(int(m.get("y", 0)) + max(1, int(round(float(m.get("height", 1080)) / (float(m.get("scale") or 1.0) or 1.0)))) for m in mons)
            injector.layout_x = min_x
            injector.layout_y = min_y
            injector.extent_w = max(1, max_x - min_x)
            injector.extent_h = max(1, max_y - min_y)
            target_mon = next((m for m in mons if args.output and m.get("name") == args.output), mons[0])
            tscale = float(target_mon.get("scale") or 1.0) or 1.0
            if args.mode == "output":
                injector.win_rect = (
                    int(target_mon.get("x", 0)),
                    int(target_mon.get("y", 0)),
                    max(1, int(round(float(target_mon.get("width", 1920)) / tscale))),
                    max(1, int(round(float(target_mon.get("height", 1080)) / tscale))),
                )
            if target_mon.get("dpmsStatus") is False:
                r = subprocess.run(
                    ["hyprctl", "eval", 'hl.dispatch(hl.dsp.dpms("on"))'],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=1.5,
                )
                if r.returncode != 0:
                    subprocess.run(
                        ["hyprctl", "dispatch", "dpms", "on"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=1.5,
                    )
    except Exception:
        pass

    running = [True]
    force_restart_enc = [False]

    def on_sig(_sig, _frame):
        running[0] = False

    signal.signal(signal.SIGTERM, on_sig)
    signal.signal(signal.SIGINT, on_sig)

    def stdin_loop():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                if cmd.get("type") == "keyframe":
                    force_restart_enc[0] = True
                else:
                    injector.handle(cmd)
            except Exception:
                pass
        running[0] = False

    if not args.once:
        threading.Thread(target=stdin_loop, daemon=True).start()

    fps = max(5, min(60, args.fps))
    frame_interval = 1.0 / fps
    encoder = None
    shm_buf = None
    fail_streak = 0
    vaapi_failed = bool(args.no_vaapi)

    # Wait about three frames for a new one; after that the screen is simply still.
    capture_wait = max(0.05, min(0.25, frame_interval * 3))
    # On a still screen the last picture is sent again now and then, so the viewer keeps a live,
    # decodable stream (and a keyframe asked for arrives) without spending a full frame rate on it.
    idle_repeat = frame_interval if args.steady else 0.5
    last = None
    last_sent = 0.0

    try:
        while running[0]:
            t0 = time.monotonic()
            res, shm_buf = capture_once(wl, shm_id, mgr_id, mgr_ver, args.mode, output_id, handle_u32, shm_buf, timeout=2.0 if last is None and args.once else capture_wait)
            if res is IDLE:
                fail_streak = 0
                if last is None or not (force_restart_enc[0] or t0 - last_sent >= idle_repeat):
                    continue
                res = last
            elif res is None:
                fail_streak += 1
                if fail_streak >= 15:
                    writer.send_json(3, {"error": "Target window or monitor closed"})
                    break
                time.sleep(0.1)
                continue
            fail_streak = 0
            last = res
            last_sent = t0
            w, h, pix_fmt, raw = res

            if (
                encoder is None
                or force_restart_enc[0]
                or encoder.width != w
                or encoder.height != h
                or encoder.pix_fmt != pix_fmt
            ):
                force_restart_enc[0] = False
                if encoder is not None:
                    encoder.close()
                encoder = H264Encoder(
                    width=w,
                    height=h,
                    pix_fmt=pix_fmt,
                    fps=fps,
                    bitrate_kbps=args.bitrate,
                    writer=writer,
                    meta_base={"mode": args.mode, "address": args.address},
                    prefer_vaapi=not vaapi_failed,
                )

            if not encoder.write_frame(raw):
                if encoder.encoder_name == "h264_vaapi" and getattr(encoder, "frames_emitted", 0) == 0:
                    vaapi_failed = True
                encoder.close()
                encoder = None
                continue

            if args.once:
                # Feed a few duplicate frames so VA-API/libx264 flushes the initial IDR immediately
                for _ in range(4):
                    encoder.write_frame(raw)
                time.sleep(0.25)
                break

            elapsed = time.monotonic() - t0
            sleep_for = frame_interval - elapsed
            if sleep_for > 0.001:
                time.sleep(sleep_for)
    finally:
        if encoder is not None:
            encoder.close()
        if shm_buf is not None:
            shm_buf.destroy()
        wl.close()


if __name__ == "__main__":
    main()
