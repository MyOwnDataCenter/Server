/*
 * hypr-rail-capture.c - Zero-copy 60 FPS GPU Wayland -> VA-API H.264/HEVC streamer for Omarchy Server RAIL.
 *
 * Pipeline:
 *   Hyprland (zwlr_screencopy_manager_v1 / hyprland_toplevel_export_manager_v1)
 *     -> GPU DMA-BUF (gbm_bo + zwp_linux_dmabuf_v1)  [automatic SHM mmap fallback]
 *     -> VA-API GPU surface (AV_PIX_FMT_DRM_PRIME -> AV_PIX_FMT_VAAPI -> scale_vaapi nv12)
 *     -> Hardware H.264 (h264_vaapi constrained_baseline, zero B-frames, on-demand IDR)
 *     -> Big-endian framed stdout ([u8 type][u32be len][payload]) for omarchyd WebSocket -> WebCodecs
 *
 * Build:
 *   gcc -O2 -Wall -Wextra -pthread hypr-rail-capture.c -o hypr-rail-capture \
 *       $(pkg-config --cflags --libs gbm libva libva-drm libavcodec libavfilter libavutil libdrm) -ldl
 */

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <gbm.h>
#include <inttypes.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <drm_fourcc.h>
#include <va/va.h>
#include <va/va_drmcommon.h>
#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_drm.h>
#include <libavutil/hwcontext_vaapi.h>
#include <libavutil/opt.h>
#include <libavutil/pixfmt.h>

#define WL_SHM_FORMAT_ARGB8888 0U
#define WL_SHM_FORMAT_XRGB8888 1U
#define WL_SHM_FORMAT_ABGR8888 0x34324241U
#define WL_SHM_FORMAT_XBGR8888 0x34324258U
#define CAP_SLOTS 3
#define MAX_DAMAGE_RECTS 8
#ifndef AV_PROFILE_HEVC_REXT
#define AV_PROFILE_HEVC_REXT 4
#endif

typedef struct {
	int32_t x, y, w, h;
} DamageRect;

static _Atomic int g_running = 1;
static _Atomic int g_force_keyframe = 0;
static _Atomic uint32_t g_reconfig_gen = 0;
static pthread_mutex_t g_reconfig_mu = PTHREAD_MUTEX_INITIALIZER;
static int g_reconfig_bitrate = 20000;
static int g_reconfig_quality = 0;
static char g_reconfig_codec[16] = "h264";
static int g_wake_fd = -1;

static void wake_wl(void) {
	int fd = g_wake_fd;
	if (fd >= 0) {
		uint64_t one = 1;
		ssize_t r = write(fd, &one, sizeof(one));
		(void)r;
	}
}

static void on_signal(int sig) {
	(void)sig;
	atomic_store_explicit(&g_running, 0, memory_order_relaxed);
	wake_wl();
}

static uint64_t monotonic_us(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)(ts.tv_nsec / 1000ULL);
}

/* ---- Big-endian stdout framing ([u8 type][u32be len][payload]) ---- */
static pthread_mutex_t g_out_lock = PTHREAD_MUTEX_INITIALIZER;

static bool write_all(int fd, const void *buf, size_t len) {
	const uint8_t *p = (const uint8_t *)buf;
	while (len > 0) {
		ssize_t n = write(fd, p, len);
		if (n < 0) {
			if (errno == EINTR) continue;
			return false;
		}
		p += (size_t)n;
		len -= (size_t)n;
	}
	return true;
}

static bool writev_all(int fd, struct iovec *iov, int iovcnt) {
	while (iovcnt > 0) {
		ssize_t n = writev(fd, iov, iovcnt);
		if (n < 0) {
			if (errno == EINTR) continue;
			return false;
		}
		size_t rem = (size_t)n;
		while (iovcnt > 0 && rem >= iov[0].iov_len) {
			rem -= iov[0].iov_len;
			iov++;
			iovcnt--;
		}
		if (iovcnt > 0 && rem > 0) {
			iov[0].iov_base = (uint8_t *)iov[0].iov_base + rem;
			iov[0].iov_len -= rem;
		}
	}
	return true;
}

static void send_json_msg(uint8_t type, const char *json) {
	size_t n = strlen(json);
	uint8_t hdr[5];
	hdr[0] = type;
	uint32_t be_len = htonl((uint32_t)n);
	memcpy(hdr + 1, &be_len, 4);
	struct iovec iov[2] = {
		{.iov_base = hdr, .iov_len = 5},
		{.iov_base = (void *)json, .iov_len = n},
	};
	pthread_mutex_lock(&g_out_lock);
	writev_all(STDOUT_FILENO, iov, 2);
	pthread_mutex_unlock(&g_out_lock);
}

static void send_video_msg_parts(bool is_key, uint64_t ts_us, const uint8_t *extra, size_t extra_len, const uint8_t *data, size_t len) {
	uint8_t hdr[14];
	hdr[0] = 2;
	uint32_t be_len = htonl((uint32_t)(9 + extra_len + len));
	memcpy(hdr + 1, &be_len, 4);
	hdr[5] = is_key ? 1 : 0;
	uint32_t ts_hi = htonl((uint32_t)(ts_us >> 32));
	uint32_t ts_lo = htonl((uint32_t)(ts_us & 0xFFFFFFFFU));
	memcpy(hdr + 6, &ts_hi, 4);
	memcpy(hdr + 10, &ts_lo, 4);
	struct iovec iov[3];
	int niov = 0;
	iov[niov++] = (struct iovec){.iov_base = hdr, .iov_len = 14};
	if (extra && extra_len > 0) iov[niov++] = (struct iovec){.iov_base = (void *)extra, .iov_len = extra_len};
	if (data && len > 0) iov[niov++] = (struct iovec){.iov_base = (void *)data, .iov_len = len};
	pthread_mutex_lock(&g_out_lock);
	writev_all(STDOUT_FILENO, iov, niov);
	pthread_mutex_unlock(&g_out_lock);
}

static void send_video_msg(bool is_key, uint64_t ts_us, const uint8_t *data, size_t len) {
	send_video_msg_parts(is_key, ts_us, NULL, 0, data, len);
}

/* ---- Optional 10 ms low-latency Opus stdin encoder (zero compile-time dep via dlopen libopus.so.0) ---- */
typedef struct OpusEncoder OpusEncoder;
typedef OpusEncoder *(*opus_encoder_create_fn)(int32_t Fs, int channels, int application, int *error);
typedef void (*opus_encoder_destroy_fn)(OpusEncoder *st);
typedef int32_t (*opus_encode_fn)(OpusEncoder *st, const int16_t *pcm, int frame_size, unsigned char *data, int32_t max_data_bytes);
typedef int (*opus_encoder_ctl_fn)(OpusEncoder *st, int request, ...);

static int run_opus_stdin(void) {
	signal(SIGPIPE, SIG_IGN);
	void *lib = dlopen("libopus.so.0", RTLD_LAZY);
	if (!lib) return 2;
	opus_encoder_create_fn p_create = (opus_encoder_create_fn)dlsym(lib, "opus_encoder_create");
	opus_encoder_destroy_fn p_destroy = (opus_encoder_destroy_fn)dlsym(lib, "opus_encoder_destroy");
	opus_encode_fn p_encode = (opus_encode_fn)dlsym(lib, "opus_encode");
	opus_encoder_ctl_fn p_ctl = (opus_encoder_ctl_fn)dlsym(lib, "opus_encoder_ctl");
	if (!p_create || !p_destroy || !p_encode || !p_ctl) {
		dlclose(lib);
		return 2;
	}
	int err = 0;
	/* 48 kHz stereo, OPUS_APPLICATION_RESTRICTED_LOWDELAY (2051) for ~12.5 ms algorithmic delay */
	OpusEncoder *enc = p_create(48000, 2, 2051, &err);
	if (!enc || err != 0) {
		if (enc) p_destroy(enc);
		dlclose(lib);
		return 2;
	}
	p_ctl(enc, 4002 /* OPUS_SET_BITRATE */, (int32_t)128000);
	p_ctl(enc, 4010 /* OPUS_SET_COMPLEXITY */, (int32_t)5);

	/* 10 ms @ 48 kHz stereo s16le = 480 frames * 4 bytes = 1920 bytes */
	uint8_t pcm_raw[1920];
	uint8_t out[2 + 1276];
	int hang_frames = 0;
	for (;;) {
		size_t got = 0;
		while (got < sizeof(pcm_raw)) {
			ssize_t n = read(STDIN_FILENO, pcm_raw + got, sizeof(pcm_raw) - got);
			if (n < 0) {
				if (errno == EINTR) continue;
				got = 0;
				break;
			}
			if (n == 0) {
				got = 0;
				break;
			}
			got += (size_t)n;
		}
		if (got < sizeof(pcm_raw)) break;

		bool silent = true;
		const int16_t *samples = (const int16_t *)pcm_raw;
		for (int i = 0; i < 960; i++) {
			int16_t s = samples[i];
			if (s > 16 || s < -16) {
				silent = false;
				break;
			}
		}
		if (!silent) {
			hang_frames = 24; /* 240 ms tail before gating to 0 kbps */
		} else if (hang_frames > 0) {
			hang_frames--;
		} else {
			continue;
		}

		int32_t encoded = p_encode(enc, samples, 480, out + 2, 1276);
		if (encoded > 0 && encoded <= 1276) {
			out[0] = (uint8_t)((encoded >> 8) & 0xFF);
			out[1] = (uint8_t)(encoded & 0xFF);
			if (!write_all(STDOUT_FILENO, out, (size_t)(2 + encoded))) break;
		}
	}
	p_destroy(enc);
	dlclose(lib);
	return 0;
}

/* ---- Minimal Wayland binary wire client (zero generated headers needed) ---- */
typedef struct {
	char iface[96];
	uint32_t name;
	uint32_t version;
} WlGlobal;

typedef void (*WlHandler)(void *ctx, uint32_t obj_id, uint16_t op, const uint8_t *payload, size_t len);

typedef struct {
	uint32_t obj_id;
	WlHandler fn;
	void *ctx;
} WlSlot;

typedef struct {
	int fd;
	pthread_mutex_t tx_lock;
	uint32_t next_id;
	uint32_t free_ids[256];
	int n_free_ids;
	uint32_t registry_id;
	WlGlobal globals[128];
	int num_globals;
	WlSlot slots[64];
	int num_slots;
	uint8_t rx[65536];
	size_t rx_len;
	char last_error[256];
} WlClient;

static uint32_t wl_alloc_id(WlClient *wl) {
	if (wl->n_free_ids > 0) {
		return wl->free_ids[--wl->n_free_ids];
	}
	return wl->next_id++;
}

static void wl_set_handler(WlClient *wl, uint32_t obj_id, WlHandler fn, void *ctx) {
	for (int i = 0; i < wl->num_slots; i++) {
		if (wl->slots[i].obj_id == obj_id) {
			wl->slots[i].fn = fn;
			wl->slots[i].ctx = ctx;
			return;
		}
	}
	if (wl->num_slots < 64) {
		wl->slots[wl->num_slots++] = (WlSlot){obj_id, fn, ctx};
	}
}

static void wl_clear_handler(WlClient *wl, uint32_t obj_id) {
	for (int i = 0; i < wl->num_slots; i++) {
		if (wl->slots[i].obj_id == obj_id) {
			wl->slots[i] = wl->slots[--wl->num_slots];
			return;
		}
	}
}

static bool wl_send(WlClient *wl, uint32_t obj_id, uint16_t op, const void *payload, size_t len, int send_fd) {
	uint8_t buf[512];
	if (8 + len > sizeof(buf)) return false;
	uint32_t hdr[2];
	hdr[0] = obj_id;
	hdr[1] = ((uint32_t)(8 + len) << 16) | op;
	memcpy(buf, hdr, 8);
	if (len > 0) memcpy(buf + 8, payload, len);

	pthread_mutex_lock(&wl->tx_lock);
	bool ok = true;
	if (send_fd >= 0) {
		struct iovec iov = {.iov_base = buf, .iov_len = 8 + len};
		union {
			char buf[CMSG_SPACE(sizeof(int))];
			struct cmsghdr align;
		} cmsg_u;
		memset(&cmsg_u, 0, sizeof(cmsg_u));
		struct msghdr msg = {0};
		msg.msg_iov = &iov;
		msg.msg_iovlen = 1;
		msg.msg_control = cmsg_u.buf;
		msg.msg_controllen = sizeof(cmsg_u.buf);
		struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
		cmsg->cmsg_level = SOL_SOCKET;
		cmsg->cmsg_type = SCM_RIGHTS;
		cmsg->cmsg_len = CMSG_LEN(sizeof(int));
		memcpy(CMSG_DATA(cmsg), &send_fd, sizeof(int));
		ssize_t n;
		do {
			n = sendmsg(wl->fd, &msg, MSG_NOSIGNAL);
		} while (n < 0 && errno == EINTR);
		if (n <= 0) {
			ok = false;
			atomic_store(&g_running, 0);
		} else {
			/* FD was transferred with the first n bytes; finish any remaining bytes without re-attaching SCM_RIGHTS. */
			size_t off = (size_t)n;
			while (off < 8 + len) {
				ssize_t m = send(wl->fd, buf + off, 8 + len - off, MSG_NOSIGNAL);
				if (m < 0) {
					if (errno == EINTR) continue;
					ok = false;
					atomic_store(&g_running, 0);
					break;
				}
				if (m == 0) {
					ok = false;
					atomic_store(&g_running, 0);
					break;
				}
				off += (size_t)m;
			}
		}
	} else {
		size_t off = 0;
		while (off < 8 + len) {
			ssize_t n = send(wl->fd, buf + off, 8 + len - off, MSG_NOSIGNAL);
			if (n < 0) {
				if (errno == EINTR) continue;
				ok = false;
				if (off > 0) atomic_store(&g_running, 0);
				break;
			}
			if (n == 0) {
				ok = false;
				atomic_store(&g_running, 0);
				break;
			}
			off += (size_t)n;
		}
	}
	pthread_mutex_unlock(&wl->tx_lock);
	return ok;
}

/* Batch two small Wayland messages (e.g. pointer motion + frame) into a single send() under one lock for minimal latency */
static bool wl_send_pair(WlClient *wl, uint32_t obj1, uint16_t op1, const void *pl1, size_t len1,
	uint32_t obj2, uint16_t op2, const void *pl2, size_t len2) {
	uint8_t buf[512];
	size_t tot = 8 + len1 + 8 + len2;
	if (tot > sizeof(buf)) return false;
	uint32_t h1[2] = {obj1, ((uint32_t)(8 + len1) << 16) | op1};
	uint32_t h2[2] = {obj2, ((uint32_t)(8 + len2) << 16) | op2};
	memcpy(buf, h1, 8);
	if (len1 > 0) memcpy(buf + 8, pl1, len1);
	memcpy(buf + 8 + len1, h2, 8);
	if (len2 > 0) memcpy(buf + 16 + len1, pl2, len2);

	pthread_mutex_lock(&wl->tx_lock);
	bool ok = true;
	size_t off = 0;
	while (off < tot) {
		ssize_t n = send(wl->fd, buf + off, tot - off, MSG_NOSIGNAL);
		if (n < 0) {
			if (errno == EINTR) continue;
			ok = false;
			if (off > 0) atomic_store(&g_running, 0);
			break;
		}
		if (n == 0) {
			ok = false;
			atomic_store(&g_running, 0);
			break;
		}
		off += (size_t)n;
	}
	pthread_mutex_unlock(&wl->tx_lock);
	return ok;
}

static size_t wl_pack_str(uint8_t *dst, const char *s) {
	uint32_t slen = (uint32_t)strlen(s) + 1;
	memcpy(dst, &slen, 4);
	memcpy(dst + 4, s, slen);
	size_t pad = (4 - (slen % 4)) % 4;
	if (pad) memset(dst + 4 + slen, 0, pad);
	return 4 + slen + pad;
}

static bool wl_pump(WlClient *wl, int timeout_ms) {
	struct pollfd pfds[2] = {
		{.fd = wl->fd, .events = POLLIN},
		{.fd = g_wake_fd, .events = POLLIN},
	};
	int nfds = (g_wake_fd >= 0) ? 2 : 1;
	int rc = poll(pfds, (nfds_t)nfds, timeout_ms);
	if (rc <= 0) return false;
	if (nfds == 2 && (pfds[1].revents & POLLIN)) {
		uint64_t dummy = 0;
		ssize_t dr = read(g_wake_fd, &dummy, sizeof(dummy));
		(void)dr;
	}
	if (!(pfds[0].revents & (POLLIN | POLLERR | POLLHUP))) return false;
	if (pfds[0].revents & (POLLERR | POLLHUP)) {
		atomic_store(&g_running, 0);
		return false;
	}
	if (wl->rx_len >= sizeof(wl->rx)) {
		atomic_store(&g_running, 0);
		return false;
	}
	ssize_t n = recv(wl->fd, wl->rx + wl->rx_len, sizeof(wl->rx) - wl->rx_len, 0);
	if (n <= 0) {
		atomic_store(&g_running, 0);
		return false;
	}
	wl->rx_len += (size_t)n;

	while (wl->rx_len >= 8) {
		uint32_t obj_id, size_op;
		memcpy(&obj_id, wl->rx, 4);
		memcpy(&size_op, wl->rx + 4, 4);
		uint16_t size = (uint16_t)(size_op >> 16);
		uint16_t op = (uint16_t)(size_op & 0xFFFF);
		if (size < 8 || (size & 3U) != 0) {
			atomic_store(&g_running, 0);
			return false;
		}
		if (wl->rx_len < size) break;

		uint8_t pl_stack[512];
		size_t plen = size - 8;
		uint8_t *pl = pl_stack;
		if (plen > sizeof(pl_stack)) {
			pl = malloc(plen);
			if (!pl) {
				memmove(wl->rx, wl->rx + size, wl->rx_len - size);
				wl->rx_len -= size;
				continue;
			}
		}
		if (plen > 0) memcpy(pl, wl->rx + 8, plen);
		memmove(wl->rx, wl->rx + size, wl->rx_len - size);
		wl->rx_len -= size;

		if (obj_id == 1) {
			if (op == 0 && plen >= 12) {
				uint32_t eo, ec, sl;
				memcpy(&eo, pl, 4);
				memcpy(&ec, pl + 4, 4);
				memcpy(&sl, pl + 8, 4);
				if (sl > 0 && sl <= plen - 12) {
					snprintf(wl->last_error, sizeof(wl->last_error), "wl_display error obj=%u code=%u: %.*s", eo, ec, (int)(sl - 1), (const char *)(pl + 12));
				}
			} else if (op == 1 && plen >= 4) {
				/* wl_display::delete_id - recycle acknowledged object IDs so long-lived 60 FPS streams never grow libwayland's ID map */
				uint32_t del_id = 0;
				memcpy(&del_id, pl, 4);
				if (del_id >= 2 && wl->n_free_ids < (int)(sizeof(wl->free_ids) / sizeof(wl->free_ids[0]))) {
					wl->free_ids[wl->n_free_ids++] = del_id;
				}
			}
			if (pl != pl_stack) free(pl);
			continue;
		}
		for (int i = 0; i < wl->num_slots; i++) {
			if (wl->slots[i].obj_id == obj_id) {
				wl->slots[i].fn(wl->slots[i].ctx, obj_id, op, pl, plen);
				break;
			}
		}
		if (pl != pl_stack) free(pl);
	}
	return true;
}

static void on_sync_cb(void *ctx, uint32_t obj_id, uint16_t op, const uint8_t *pl, size_t len) {
	(void)obj_id; (void)op; (void)pl; (void)len;
	*(bool *)ctx = true;
}

static bool wl_roundtrip(WlClient *wl) {
	uint32_t cb = wl_alloc_id(wl);
	bool done = false;
	wl_set_handler(wl, cb, on_sync_cb, &done);
	wl_send(wl, 1, 0, &cb, 4, -1);
	uint64_t deadline = monotonic_us() + 3000000ULL;
	while (!done && atomic_load(&g_running) && monotonic_us() < deadline) {
		wl_pump(wl, 50);
	}
	wl_clear_handler(wl, cb);
	return done;
}

static void on_registry(void *ctx, uint32_t obj_id, uint16_t op, const uint8_t *pl, size_t len) {
	(void)obj_id;
	WlClient *wl = (WlClient *)ctx;
	if (op != 0 || len < 12 || wl->num_globals >= 128) return;
	uint32_t name, slen;
	memcpy(&name, pl, 4);
	memcpy(&slen, pl + 4, 4);
	if (slen > len - 8) return;
	size_t pad = (4 - (slen & 3U)) & 3U;
	if (pad + 4 > len - 8 - slen) return;
	uint32_t ver;
	memcpy(&ver, pl + 8 + slen + pad, 4);
	WlGlobal *g = &wl->globals[wl->num_globals++];
	g->name = name;
	g->version = ver;
	snprintf(g->iface, sizeof(g->iface), "%.*s", (int)(slen > 0 ? slen - 1 : 0), (const char *)(pl + 8));
}

static uint32_t wl_bind_nth(WlClient *wl, const char *iface, uint32_t max_ver, int nth, uint32_t *out_ver) {
	int seen = 0;
	for (int i = 0; i < wl->num_globals; i++) {
		if (strcmp(wl->globals[i].iface, iface) == 0) {
			if (seen++ == nth) {
				uint32_t uv = wl->globals[i].version < max_ver ? wl->globals[i].version : max_ver;
				uint32_t oid = wl_alloc_id(wl);
				uint8_t pl[160];
				size_t off = 0;
				memcpy(pl + off, &wl->globals[i].name, 4); off += 4;
				off += wl_pack_str(pl + off, iface);
				memcpy(pl + off, &uv, 4); off += 4;
				memcpy(pl + off, &oid, 4); off += 4;
				wl_send(wl, wl->registry_id, 0, pl, off, -1);
				if (out_ver) *out_ver = uv;
				return oid;
			}
		}
	}
	return 0;
}

/* ---- Output name discovery (wl_output::name event op=4 in v4) ---- */
typedef struct {
	uint32_t oid;
	char name[64];
} OutProbe;

static void on_output_evt(void *ctx, uint32_t obj_id, uint16_t op, const uint8_t *pl, size_t len) {
	(void)obj_id;
	OutProbe *p = (OutProbe *)ctx;
	if (op == 4 && len >= 4) {
		uint32_t sl;
		memcpy(&sl, pl, 4);
		if (sl > 0 && sl <= len - 4) {
			snprintf(p->name, sizeof(p->name), "%.*s", (int)(sl - 1), (const char *)(pl + 4));
		}
	}
}

/* ---- GPU DMA-BUF + SHM capture buffers ---- */
typedef struct {
	bool is_dmabuf;
	int width, height;
	uint32_t fmt;
	uint32_t stride;
	uint32_t offset;
	uint64_t modifier;
	uint32_t buf_id;
	/* DMA-BUF fields */
	struct gbm_bo *bo;
	int dmabuf_fd;
	/* SHM fields */
	uint32_t pool_id;
	int shm_fd;
	uint8_t *shm_map;
	size_t shm_size;
} CapBuf;

static void capbuf_destroy(WlClient *wl, CapBuf *b) {
	if (b->buf_id) {
		wl_send(wl, b->buf_id, 0, NULL, 0, -1); /* wl_buffer::destroy */
		b->buf_id = 0;
	}
	if (b->is_dmabuf) {
		if (b->dmabuf_fd >= 0) close(b->dmabuf_fd);
		if (b->bo) gbm_bo_destroy(b->bo);
		b->dmabuf_fd = -1;
		b->bo = NULL;
	} else {
		if (b->pool_id) {
			wl_send(wl, b->pool_id, 1, NULL, 0, -1); /* wl_shm_pool::destroy */
			b->pool_id = 0;
		}
		if (b->shm_map && b->shm_map != MAP_FAILED) munmap(b->shm_map, b->shm_size);
		if (b->shm_fd >= 0) close(b->shm_fd);
		b->shm_map = NULL;
		b->shm_fd = -1;
	}
}

static bool capbuf_create_dmabuf(WlClient *wl, struct gbm_device *gbm, uint32_t dmabuf_id, int w, int h, uint32_t fourcc, CapBuf *b) {
	memset(b, 0, sizeof(*b));
	b->dmabuf_fd = -1;
	b->shm_fd = -1;
	uint64_t mod_linear = DRM_FORMAT_MOD_LINEAR;
	struct gbm_bo *bo = gbm_bo_create_with_modifiers(gbm, (uint32_t)w, (uint32_t)h, fourcc, &mod_linear, 1);
	if (!bo) bo = gbm_bo_create(gbm, (uint32_t)w, (uint32_t)h, fourcc, GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
	if (!bo) return false;

	int fd = gbm_bo_get_fd(bo);
	if (fd < 0) {
		gbm_bo_destroy(bo);
		return false;
	}
	uint32_t stride = gbm_bo_get_stride(bo);
	uint32_t offset = gbm_bo_get_offset(bo, 0);
	uint64_t mod = gbm_bo_get_modifier(bo);

	/* zwp_linux_dmabuf_v1::create_params (op 1) */
	uint32_t params_id = wl_alloc_id(wl);
	wl_send(wl, dmabuf_id, 1, &params_id, 4, -1);

	/* zwp_linux_buffer_params_v1::add (op 1): fd, plane_idx, offset, stride, mod_hi, mod_lo */
	uint32_t add_pl[5] = {0, offset, stride, (uint32_t)(mod >> 32), (uint32_t)(mod & 0xFFFFFFFFU)};
	wl_send(wl, params_id, 1, add_pl, sizeof(add_pl), fd);

	/* zwp_linux_buffer_params_v1::create_immed (op 3): buffer_id, width, height, format, flags */
	uint32_t buf_id = wl_alloc_id(wl);
	uint32_t ci_pl[5] = {buf_id, (uint32_t)w, (uint32_t)h, fourcc, 0};
	wl_send(wl, params_id, 3, ci_pl, sizeof(ci_pl), -1);

	/* zwp_linux_buffer_params_v1::destroy (op 0) */
	wl_send(wl, params_id, 0, NULL, 0, -1);

	b->is_dmabuf = true;
	b->width = w;
	b->height = h;
	b->fmt = fourcc;
	b->stride = stride;
	b->offset = offset;
	b->modifier = mod;
	b->buf_id = buf_id;
	b->bo = bo;
	b->dmabuf_fd = fd;
	return true;
}

static bool is_supported_shm_fmt(uint32_t fmt) {
	return fmt == WL_SHM_FORMAT_ARGB8888 || fmt == WL_SHM_FORMAT_XRGB8888 || fmt == WL_SHM_FORMAT_ABGR8888 || fmt == WL_SHM_FORMAT_XBGR8888;
}

static bool is_supported_drm_fmt(uint32_t fmt) {
	return fmt == DRM_FORMAT_XRGB8888 || fmt == DRM_FORMAT_ARGB8888 || fmt == DRM_FORMAT_XBGR8888 || fmt == DRM_FORMAT_ABGR8888;
}

static bool capbuf_create_shm(WlClient *wl, uint32_t shm_id, int w, int h, uint32_t stride, uint32_t fmt, CapBuf *b) {
	memset(b, 0, sizeof(*b));
	b->dmabuf_fd = -1;
	b->shm_fd = -1;
	if (!is_supported_shm_fmt(fmt) || w < 2 || h < 2 || w > 16384 || h > 16384) return false;
	if ((uint64_t)stride < (uint64_t)w * 4ULL) return false;
	uint64_t sz64 = (uint64_t)stride * (uint64_t)h;
	/* wl_shm::create_pool takes a signed 32-bit size field; refuse sizes that overflow int32 */
	if (sz64 == 0 || sz64 > 0x7FFFFFFFULL) return false;
	size_t sz = (size_t)sz64;
	int fd = memfd_create("hypr-rail-shm", MFD_CLOEXEC);
	if (fd < 0) return false;
	if (ftruncate(fd, (off_t)sz) < 0) {
		close(fd);
		return false;
	}
	uint8_t *mm = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (mm == MAP_FAILED) {
		close(fd);
		return false;
	}
	uint32_t pool_id = wl_alloc_id(wl);
	uint32_t pool_pl[2] = {pool_id, (uint32_t)sz};
	wl_send(wl, shm_id, 0, pool_pl, sizeof(pool_pl), fd);

	uint32_t buf_id = wl_alloc_id(wl);
	int32_t buf_pl[6] = {(int32_t)buf_id, 0, w, h, (int32_t)stride, (int32_t)fmt};
	wl_send(wl, pool_id, 0, buf_pl, sizeof(buf_pl), -1);

	b->is_dmabuf = false;
	b->width = w;
	b->height = h;
	b->fmt = fmt;
	b->stride = stride;
	b->buf_id = buf_id;
	b->pool_id = pool_id;
	b->shm_fd = fd;
	b->shm_map = mm;
	b->shm_size = sz;
	return true;
}

/* ---- Zero-copy VA-API H.264/HEVC/AV1 encoder (libavfilter scale_vaapi + libavcodec *_vaapi) ---- */
typedef struct {
	int width, height, even_w, even_h, fps;
	bool dmabuf_mode;
	bool y_invert;
	uint32_t drm_fourcc;
	AVBufferRef *vaapi_dev;
	AVBufferRef *va_frames_ctx;
	VASurfaceID imported_sid[CAP_SLOTS];
	struct gbm_bo *imported_bo[CAP_SLOTS];
	AVFilterGraph *graph;
	AVFilterContext *src_ctx;
	AVFilterContext *sink_ctx;
	AVCodecContext *codec;
	AVFrame *va_in;
	AVFrame *nv12;
	AVFrame *sw;
	AVPacket *pkt;
	int64_t pts;
	uint64_t start_us;
	bool is_hevc;
	int slices;
	char encoder_name[32];
	char codec_str[32];
	/* Lightweight live telemetry (msgType 5 every ~500ms while active) */
	uint64_t stat_window_us;
	uint64_t stat_bytes;
	uint64_t stat_enc_us[64];
	int stat_enc_n;
	uint32_t stat_polish_count;
	uint32_t stat_roi_count;
	/* Optional --bench-stats latency telemetry */
	bool bench_stats;
	uint64_t enc_samples[512];
	uint64_t pts_ready[1024];
	int enc_n;
	int enc_submitted;
	int enc_emitted;
} VaapiEncoder;

static void enc_destroy(VaapiEncoder *e) {
	if (e->pkt) av_packet_free(&e->pkt);
	if (e->sw) av_frame_free(&e->sw);
	if (e->nv12) av_frame_free(&e->nv12);
	if (e->va_in) av_frame_free(&e->va_in);
	if (e->codec) avcodec_free_context(&e->codec);
	if (e->graph) avfilter_graph_free(&e->graph);
	if (e->vaapi_dev) {
		AVVAAPIDeviceContext *vactx = ((AVHWDeviceContext *)e->vaapi_dev->data)->hwctx;
		for (int i = 0; i < CAP_SLOTS; i++) {
			if (e->imported_sid[i] != VA_INVALID_SURFACE) {
				vaDestroySurfaces(vactx->display, &e->imported_sid[i], 1);
			}
		}
	}
	if (e->va_frames_ctx) av_buffer_unref(&e->va_frames_ctx);
	if (e->vaapi_dev) av_buffer_unref(&e->vaapi_dev);
	memset(e, 0, sizeof(*e));
	for (int i = 0; i < CAP_SLOTS; i++) {
		e->imported_sid[i] = VA_INVALID_SURFACE;
		e->imported_bo[i] = NULL;
	}
}

static enum AVPixelFormat drm_to_av_sw_fmt(uint32_t fourcc, bool is_dmabuf) {
	if (is_dmabuf) {
		if (fourcc == DRM_FORMAT_ARGB8888) return AV_PIX_FMT_BGRA;
		if (fourcc == DRM_FORMAT_ABGR8888) return AV_PIX_FMT_RGBA;
		if (fourcc == DRM_FORMAT_XBGR8888) return AV_PIX_FMT_RGB0;
		return AV_PIX_FMT_BGR0;
	}
	if (fourcc == WL_SHM_FORMAT_ABGR8888 || fourcc == WL_SHM_FORMAT_XBGR8888) return AV_PIX_FMT_RGBA;
	return AV_PIX_FMT_BGRA;
}

static bool enc_init_one(VaapiEncoder *e, const char *vaapi_device, int w, int h, uint32_t fmt, bool dmabuf_mode, bool y_invert, int fps, int bitrate_kbps, const char *req_codec, int req_quality, int req_comp) {
	memset(e, 0, sizeof(*e));
	for (int i = 0; i < CAP_SLOTS; i++) {
		e->imported_sid[i] = VA_INVALID_SURFACE;
		e->imported_bo[i] = NULL;
	}
	e->width = w;
	e->height = h;
	e->even_w = (w & ~1) < 2 ? 2 : (w & ~1);
	e->even_h = (h & ~1) < 2 ? 2 : (h & ~1);
	e->fps = fps;
	e->dmabuf_mode = dmabuf_mode;
	e->y_invert = y_invert;
	e->drm_fourcc = fmt;
	e->start_us = monotonic_us();
	e->stat_window_us = e->start_us;

	bool want_hevc444 = (strcmp(req_codec, "hevc444") == 0);
	bool want_hevc10 = (strcmp(req_codec, "hevc10") == 0);
	bool want_hevc = want_hevc444 || want_hevc10 || (strcmp(req_codec, "hevc") == 0);
	e->is_hevc = want_hevc;
	const char *va_pix = want_hevc444 ? "vuyx" : want_hevc10 ? "p010" : "nv12";
	enum AVPixelFormat sw_fmt = drm_to_av_sw_fmt(fmt, dmabuf_mode);

	if (av_hwdevice_ctx_create(&e->vaapi_dev, AV_HWDEVICE_TYPE_VAAPI, vaapi_device, NULL, 0) < 0) {
		fprintf(stderr, "enc_init: vaapi_dev failed\n");
		return false;
	}
	e->va_frames_ctx = av_hwframe_ctx_alloc(e->vaapi_dev);
	if (!e->va_frames_ctx) { enc_destroy(e); return false; }
	AVHWFramesContext *fc = (AVHWFramesContext *)e->va_frames_ctx->data;
	fc->format = AV_PIX_FMT_VAAPI;
	fc->sw_format = sw_fmt;
	fc->width = w;
	fc->height = h;
	fc->initial_pool_size = dmabuf_mode ? 1 : 4;
	if (av_hwframe_ctx_init(e->va_frames_ctx) < 0) {
		fprintf(stderr, "enc_init: hwframe_ctx_init failed\n");
		enc_destroy(e); return false;
	}

	/* Build in-GPU VA-API filter graph: Full-Range BT.709 color conversion (zero BT.601 color shift / crushed blacks!) */
	e->graph = avfilter_graph_alloc();
	if (!e->graph) { enc_destroy(e); return false; }

	e->src_ctx = avfilter_graph_alloc_filter(e->graph, avfilter_get_by_name("buffer"), "in");
	if (!e->src_ctx) { enc_destroy(e); return false; }
	AVBufferSrcParameters *par = av_buffersrc_parameters_alloc();
	if (!par) { enc_destroy(e); return false; }
	par->format = AV_PIX_FMT_VAAPI;
	par->width = w;
	par->height = h;
	par->time_base = (AVRational){1, fps};
	par->sample_aspect_ratio = (AVRational){1, 1};
	par->hw_frames_ctx = av_buffer_ref(e->va_frames_ctx);
	if (!par->hw_frames_ctx || av_buffersrc_parameters_set(e->src_ctx, par) < 0 || avfilter_init_str(e->src_ctx, NULL) < 0) {
		fprintf(stderr, "enc_init: buffersrc init failed\n");
		av_buffer_unref(&par->hw_frames_ctx);
		av_free(par);
		enc_destroy(e); return false;
	}
	av_buffer_unref(&par->hw_frames_ctx);
	av_free(par);

	if (avfilter_graph_create_filter(&e->sink_ctx, avfilter_get_by_name("buffersink"), "out", NULL, NULL, e->graph) < 0) {
		fprintf(stderr, "enc_init: buffersink failed\n");
		enc_destroy(e); return false;
	}

	AVFilterInOut *outputs = avfilter_inout_alloc();
	AVFilterInOut *inputs = avfilter_inout_alloc();
	if (!outputs || !inputs) {
		avfilter_inout_free(&inputs);
		avfilter_inout_free(&outputs);
		enc_destroy(e);
		return false;
	}
	outputs->name = av_strdup("in");
	outputs->filter_ctx = e->src_ctx;
	outputs->pad_idx = 0;
	outputs->next = NULL;
	inputs->name = av_strdup("out");
	inputs->filter_ctx = e->sink_ctx;
	inputs->pad_idx = 0;
	inputs->next = NULL;

	char fdesc[360];
	if (y_invert) {
		snprintf(fdesc, sizeof(fdesc), "transpose_vaapi=dir=vflip,scale_vaapi=w=%d:h=%d:format=%s:out_color_matrix=bt709:out_range=pc:mode=hq", e->even_w, e->even_h, va_pix);
	} else {
		snprintf(fdesc, sizeof(fdesc), "scale_vaapi=w=%d:h=%d:format=%s:out_color_matrix=bt709:out_range=pc:mode=hq", e->even_w, e->even_h, va_pix);
	}
	int rc = avfilter_graph_parse_ptr(e->graph, fdesc, &inputs, &outputs, NULL);
	avfilter_inout_free(&inputs);
	avfilter_inout_free(&outputs);
	if (rc < 0) { fprintf(stderr, "enc_init: parse_ptr failed rc=%d (%s)\n", rc, fdesc); enc_destroy(e); return false; }

	for (unsigned i = 0; i < e->graph->nb_filters; i++) {
		e->graph->filters[i]->hw_device_ctx = av_buffer_ref(e->vaapi_dev);
	}
	if ((rc = avfilter_graph_config(e->graph, NULL)) < 0) { fprintf(stderr, "enc_init: graph_config failed rc=%d\n", rc); enc_destroy(e); return false; }

	const char *ff_codec_name = want_hevc ? "hevc_vaapi" : "h264_vaapi";
	const AVCodec *codec = avcodec_find_encoder_by_name(ff_codec_name);
	if (!codec) { enc_destroy(e); return false; }
	AVBufferRef *sink_hw = av_buffersink_get_hw_frames_ctx(e->sink_ctx);

	typedef struct { int profile; const char *low_power; const char *rc_mode; int global_q; const char *comp; const char *codec_id; } EncTry;
	/* Empirically hillclimbed defaults: QVBR (QP 20-21) + TU7 + async_depth=1 + infinite GOP + refs=1 halves 4K encode latency (~10.4ms p50, ~11.6ms p95, 0 stalled frames) */
	const EncTry h264_tries[] = {
		{AV_PROFILE_H264_HIGH,                 NULL, "QVBR", 21, "7", "avc1.640033"},
		{AV_PROFILE_H264_HIGH,                 "1",  "QVBR", 21, "7", "avc1.640033"},
		{AV_PROFILE_H264_HIGH,                 NULL, "VBR",   0, "7", "avc1.640033"},
		{AV_PROFILE_H264_HIGH,                 "1",  "VBR",   0, "7", "avc1.640033"},
		{AV_PROFILE_H264_MAIN,                 NULL, "VBR",   0, "7", "avc1.4D4033"},
		{AV_PROFILE_H264_CONSTRAINED_BASELINE, "1",  "VBR",   0, "7", "avc1.42E033"},
		{AV_PROFILE_H264_HIGH,                 NULL, "CBR",   0, "7", "avc1.640033"},
		{AV_PROFILE_H264_CONSTRAINED_BASELINE, NULL, "CBR",   0, "7", "avc1.42E033"},
		{AV_PROFILE_H264_MAIN,                 NULL, NULL,    0, "7", "avc1.4D4033"},
		{AV_PROFILE_UNKNOWN,                   NULL, NULL,    0, NULL,"avc1.42E033"},
	};
	const EncTry hevc444_tries[] = {
		{AV_PROFILE_HEVC_REXT, NULL, "QVBR", 20, "7", "hev1.4.10.L153.BE.8"},
		{AV_PROFILE_HEVC_REXT, "1",  "QVBR", 20, "7", "hev1.4.10.L153.BE.8"},
		{AV_PROFILE_HEVC_REXT, NULL, "VBR",   0, "7", "hev1.4.10.L153.BE.8"},
		{AV_PROFILE_HEVC_REXT, NULL, NULL,    0, "7", "hev1.4.10.L153.BE.8"},
	};
	const EncTry hevc10_tries[] = {
		{AV_PROFILE_HEVC_MAIN_10, NULL, "QVBR", 21, "7", "hev1.2.4.L153.B0"},
		{AV_PROFILE_HEVC_MAIN_10, "1",  "QVBR", 21, "7", "hev1.2.4.L153.B0"},
		{AV_PROFILE_HEVC_MAIN_10, NULL, "VBR",   0, "7", "hev1.2.4.L153.B0"},
		{AV_PROFILE_HEVC_MAIN_10, NULL, NULL,    0, "7", "hev1.2.4.L153.B0"},
	};
	const EncTry hevc8_tries[] = {
		{AV_PROFILE_HEVC_MAIN, NULL, "QVBR", 20, "7", "hev1.1.6.L153.B0"},
		{AV_PROFILE_HEVC_MAIN, "1",  "QVBR", 20, "7", "hev1.1.6.L153.B0"},
		{AV_PROFILE_HEVC_MAIN, NULL, "VBR",   0, "7", "hev1.1.6.L153.B0"},
		{AV_PROFILE_HEVC_MAIN, "1",  "VBR",   0, "7", "hev1.1.6.L153.B0"},
		{AV_PROFILE_HEVC_MAIN, NULL, NULL,    0, "7", "hev1.1.6.L153.B0"},
	};
	const EncTry *tries = want_hevc444 ? hevc444_tries : want_hevc10 ? hevc10_tries : want_hevc ? hevc8_tries : h264_tries;
	size_t n_tries = want_hevc444 ? (sizeof(hevc444_tries) / sizeof(hevc444_tries[0]))
		: want_hevc10 ? (sizeof(hevc10_tries) / sizeof(hevc10_tries[0]))
		: want_hevc ? (sizeof(hevc8_tries) / sizeof(hevc8_tries[0]))
		: (sizeof(h264_tries) / sizeof(h264_tries[0]));

	rc = -1;
	const char *chosen_id = want_hevc444 ? "hev1.4.10.L153.BE.8" : want_hevc10 ? "hev1.2.4.L153.B0" : want_hevc ? "hev1.1.6.L153.B0" : "avc1.640033";
	int target_slices = ((int64_t)e->even_w * (int64_t)e->even_h >= 2000000LL) ? 4 : 1;
	for (size_t ti = 0; ti < n_tries; ti++) {
		int slice_cands[2] = {target_slices, 1};
		int n_slice_cands = (target_slices > 1) ? 2 : 1;
		for (int sc = 0; sc < n_slice_cands; sc++) {
			int try_slices = slice_cands[sc];
			if (e->codec) avcodec_free_context(&e->codec);
			e->codec = avcodec_alloc_context3(codec);
			if (!e->codec) { enc_destroy(e); return false; }
			e->codec->width = e->even_w;
			e->codec->height = e->even_h;
			e->codec->time_base = (AVRational){1, fps};
			e->codec->framerate = (AVRational){fps, 1};
			e->codec->pix_fmt = AV_PIX_FMT_VAAPI;
			e->codec->color_primaries = AVCOL_PRI_BT709;
			e->codec->color_trc = AVCOL_TRC_IEC61966_2_1;
			e->codec->colorspace = AVCOL_SPC_BT709;
			e->codec->color_range = AVCOL_RANGE_JPEG;
			e->codec->bit_rate = (int64_t)bitrate_kbps * 1000LL;
			/* Tight WAN-friendly VBV (0.25s buffer, 1.25x peak) prevents 600KB keyframe / scene-cut TCP bufferbloat */
			e->codec->rc_max_rate = (int64_t)bitrate_kbps * 1250LL;
			e->codec->rc_buffer_size = (int64_t)bitrate_kbps * 250LL;
			int eff_q = (req_quality >= 10 && req_quality <= 34) ? req_quality : tries[ti].global_q;
			if (tries[ti].rc_mode && strcmp(tries[ti].rc_mode, "QVBR") == 0 && eff_q > 0) {
				e->codec->global_quality = eff_q;
			}
			/* Infinite GOP over reliable TCP WebSocket eliminates periodic 320 KB IDR spikes; on-demand IDR fires on connect/resize/recovery */
			e->codec->gop_size = 1000000;
			e->codec->max_b_frames = 0;
			e->codec->refs = 1;
			if (try_slices > 1) e->codec->slices = try_slices;
			e->codec->profile = tries[ti].profile;
			if (sink_hw) e->codec->hw_frames_ctx = av_buffer_ref(sink_hw);
			else e->codec->hw_device_ctx = av_buffer_ref(e->vaapi_dev);

			AVDictionary *opts = NULL;
			if (tries[ti].low_power) av_dict_set(&opts, "low_power", tries[ti].low_power, 0);
			if (tries[ti].rc_mode) av_dict_set(&opts, "rc_mode", tries[ti].rc_mode, 0);
			char comp_buf[8];
			if (req_comp >= 1 && req_comp <= 7 && tries[ti].comp) {
				snprintf(comp_buf, sizeof(comp_buf), "%d", req_comp);
				av_dict_set(&opts, "compression_level", comp_buf, 0);
			} else if (tries[ti].comp) {
				av_dict_set(&opts, "compression_level", tries[ti].comp, 0);
			}
			/* async_depth=1 flushes every frame immediately with 0 queued frames (eliminates +16.7ms latency and last-frame damage stalls) */
			av_dict_set(&opts, "async_depth", "1", 0);
			av_dict_set(&opts, "aud", "0", 0);
			av_dict_set(&opts, "sei", "0", 0);
			rc = avcodec_open2(e->codec, codec, &opts);
			av_dict_free(&opts);
			if (rc == 0) {
				chosen_id = tries[ti].codec_id;
				e->slices = try_slices;
				break;
			}
		}
		if (rc == 0) break;
	}
	if (rc < 0) { enc_destroy(e); return false; }
	e->va_in = av_frame_alloc();
	e->nv12 = av_frame_alloc();
	e->sw = av_frame_alloc();
	e->pkt = av_packet_alloc();
	if (!e->va_in || !e->nv12 || !e->sw || !e->pkt) { enc_destroy(e); return false; }
	const char *prefix = want_hevc444 ? "hevc444_vaapi" : want_hevc10 ? "hevc10_vaapi" : want_hevc ? "hevc_vaapi" : "h264_vaapi";
	snprintf(e->encoder_name, sizeof(e->encoder_name), "%s%s", prefix, dmabuf_mode ? "_dmabuf" : "");
	snprintf(e->codec_str, sizeof(e->codec_str), "%s", chosen_id);
	return true;
}

static bool enc_init(VaapiEncoder *e, const char *vaapi_device, int w, int h, uint32_t fmt, bool dmabuf_mode, bool y_invert, int fps, int bitrate_kbps, const char *req_codec, int req_quality, int req_comp) {
	if (enc_init_one(e, vaapi_device, w, h, fmt, dmabuf_mode, y_invert, fps, bitrate_kbps, req_codec, req_quality, req_comp)) return true;
	if (strcmp(req_codec, "hevc444") == 0 || strcmp(req_codec, "hevc10") == 0) {
		if (enc_init_one(e, vaapi_device, w, h, fmt, dmabuf_mode, y_invert, fps, bitrate_kbps, "hevc", req_quality, req_comp)) return true;
	}
	if (strcmp(req_codec, "h264") != 0) {
		if (enc_init_one(e, vaapi_device, w, h, fmt, dmabuf_mode, y_invert, fps, bitrate_kbps, "h264", req_quality, req_comp)) return true;
	}
	fprintf(stderr, "enc_init: all VA-API encoders failed for %dx%d\n", w, h);
	return false;
}

static int cmp_u64(const void *a, const void *b) {
	uint64_t va = *(const uint64_t *)a;
	uint64_t vb = *(const uint64_t *)b;
	return (va > vb) - (va < vb);
}

static void noop_buf_free(void *opaque, uint8_t *data) {
	(void)opaque; (void)data;
}

static void attach_roi_side_data(VaapiEncoder *e, AVFrame *frame, bool is_polish, const DamageRect *dmg, int n_dmg) {
	if (is_polish) {
		AVFrameSideData *sd = av_frame_new_side_data(frame, AV_FRAME_DATA_REGIONS_OF_INTEREST, sizeof(AVRegionOfInterest));
		if (sd) {
			AVRegionOfInterest *roi = (AVRegionOfInterest *)sd->data;
			memset(roi, 0, sizeof(*roi));
			roi->self_size = sizeof(AVRegionOfInterest);
			roi->top = 0;
			roi->left = 0;
			roi->bottom = e->even_h;
			roi->right = e->even_w;
			roi->qoffset = (AVRational){-1, 4}; /* Build-to-Lossless delta QP (~ -12) for razor-sharp static text */
			e->stat_polish_count++;
		}
		return;
	}
	if (!dmg || n_dmg <= 0) return;
	AVRegionOfInterest rects[MAX_DAMAGE_RECTS];
	int n_valid = 0;
	uint64_t total_area = 0;
	for (int i = 0; i < n_dmg && n_valid < MAX_DAMAGE_RECTS; i++) {
		int64_t x1_64 = dmg[i].x < 0 ? 0 : (int64_t)dmg[i].x;
		int64_t y1_64 = dmg[i].y < 0 ? 0 : (int64_t)dmg[i].y;
		int64_t x2_64 = (int64_t)dmg[i].x + (int64_t)dmg[i].w;
		int64_t y2_64 = (int64_t)dmg[i].y + (int64_t)dmg[i].h;
		if (x2_64 > (int64_t)e->even_w) x2_64 = (int64_t)e->even_w;
		if (y2_64 > (int64_t)e->even_h) y2_64 = (int64_t)e->even_h;
		if (x2_64 <= x1_64 || y2_64 <= y1_64) continue;
		int32_t x1 = (int32_t)x1_64;
		int32_t y1 = (int32_t)y1_64;
		int32_t x2 = (int32_t)x2_64;
		int32_t y2 = (int32_t)y2_64;
		if (e->y_invert) {
			int32_t fy1 = e->even_h - y2;
			int32_t fy2 = e->even_h - y1;
			y1 = fy1;
			y2 = fy2;
		}
		total_area += (uint64_t)(x2 - x1) * (uint64_t)(y2 - y1);
		memset(&rects[n_valid], 0, sizeof(AVRegionOfInterest));
		rects[n_valid].self_size = sizeof(AVRegionOfInterest);
		rects[n_valid].left = x1;
		rects[n_valid].top = y1;
		rects[n_valid].right = x2;
		rects[n_valid].bottom = y2;
		rects[n_valid].qoffset = (AVRational){-1, 6}; /* Prioritize dirty text/UI regions (~ -8 QP) */
		n_valid++;
	}
	uint64_t frame_area = (uint64_t)e->even_w * (uint64_t)e->even_h;
	if (n_valid > 0 && frame_area > 0 && total_area * 100ULL < frame_area * 45ULL) {
		AVFrameSideData *sd = av_frame_new_side_data(frame, AV_FRAME_DATA_REGIONS_OF_INTEREST, (size_t)n_valid * sizeof(AVRegionOfInterest));
		if (sd) {
			memcpy(sd->data, rects, (size_t)n_valid * sizeof(AVRegionOfInterest));
			e->stat_roi_count++;
		}
	}
}

static bool enc_submit_capbuf(VaapiEncoder *e, CapBuf *b, int slot, bool force_key, bool is_polish, const DamageRect *dmg, int n_dmg, uint64_t ready_us) {
	AVFrame *va_in = e->va_in;
	AVFrame *nv12 = e->nv12;
	AVPacket *pkt = e->pkt;
	if (!va_in || !nv12 || !pkt) return false;
	av_frame_unref(va_in);
	av_frame_unref(nv12);
	int si = (slot >= 0 && slot < CAP_SLOTS) ? slot : 0;

	bool ok = false;
	if (b->is_dmabuf && e->dmabuf_mode) {
		/* ZERO-COPY: Import each ping-pong GBM DMA-BUF once into a persistent VA-API GPU surface via DRM_PRIME_2! */
		if (e->imported_sid[si] == VA_INVALID_SURFACE || e->imported_bo[si] != b->bo) {
			AVVAAPIDeviceContext *vactx = ((AVHWDeviceContext *)e->vaapi_dev->data)->hwctx;
			if (e->imported_sid[si] != VA_INVALID_SURFACE) {
				vaDestroySurfaces(vactx->display, &e->imported_sid[si], 1);
				e->imported_sid[si] = VA_INVALID_SURFACE;
			}
			VADRMPRIMESurfaceDescriptor prime = {0};
			prime.fourcc = (b->fmt == DRM_FORMAT_ARGB8888) ? VA_FOURCC_BGRA
				: (b->fmt == DRM_FORMAT_ABGR8888) ? VA_FOURCC_RGBA
				: (b->fmt == DRM_FORMAT_XBGR8888) ? VA_FOURCC_RGBX
				: VA_FOURCC_BGRX;
			prime.width = (uint32_t)b->width;
			prime.height = (uint32_t)b->height;
			prime.num_objects = 1;
			prime.objects[0].fd = b->dmabuf_fd;
			prime.objects[0].size = (uint32_t)((size_t)b->offset + (size_t)b->stride * (size_t)b->height);
			prime.objects[0].drm_format_modifier = b->modifier;
			prime.num_layers = 1;
			prime.layers[0].drm_format = b->fmt;
			prime.layers[0].num_planes = 1;
			prime.layers[0].object_index[0] = 0;
			prime.layers[0].offset[0] = b->offset;
			prime.layers[0].pitch[0] = b->stride;

			VASurfaceAttrib attribs[2];
			attribs[0].type = VASurfaceAttribMemoryType;
			attribs[0].flags = VA_SURFACE_ATTRIB_SETTABLE;
			attribs[0].value.type = VAGenericValueTypeInteger;
			attribs[0].value.value.i = VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2;
			attribs[1].type = VASurfaceAttribExternalBufferDescriptor;
			attribs[1].flags = VA_SURFACE_ATTRIB_SETTABLE;
			attribs[1].value.type = VAGenericValueTypePointer;
			attribs[1].value.value.p = &prime;

			VAStatus st = vaCreateSurfaces(vactx->display, VA_RT_FORMAT_RGB32, (unsigned)b->width, (unsigned)b->height, &e->imported_sid[si], 1, attribs, 2);
			if (st != VA_STATUS_SUCCESS) {
				fprintf(stderr, "vaCreateSurfaces(DRM_PRIME_2) failed: %s\n", vaErrorStr(st));
				return false;
			}
			e->imported_bo[si] = b->bo;
		}
		va_in->format = AV_PIX_FMT_VAAPI;
		va_in->width = b->width;
		va_in->height = b->height;
		va_in->hw_frames_ctx = av_buffer_ref(e->va_frames_ctx);
		va_in->data[3] = (uint8_t *)(uintptr_t)e->imported_sid[si];
		va_in->buf[0] = av_buffer_create((uint8_t *)(uintptr_t)e->imported_sid[si], 1, noop_buf_free, NULL, 0);
		ok = (va_in->buf[0] != NULL);
	} else if (!b->is_dmabuf && e->sw) {
		av_frame_unref(e->sw);
		e->sw->format = drm_to_av_sw_fmt(b->fmt, false);
		e->sw->width = b->width;
		e->sw->height = b->height;
		e->sw->data[0] = b->shm_map;
		e->sw->linesize[0] = (int)b->stride;
		if (av_hwframe_get_buffer(e->va_frames_ctx, va_in, 0) == 0 && av_hwframe_transfer_data(va_in, e->sw, 0) == 0) {
			ok = true;
		}
		av_frame_unref(e->sw);
	}

	if (!ok) {
		av_frame_unref(va_in);
		return false;
	}
	/* Explicit full-range sRGB input metadata so VPP RGB->NV12 BT.709 conversion never guesses limited range */
	va_in->color_range = AVCOL_RANGE_JPEG;
	va_in->colorspace = AVCOL_SPC_RGB;
	va_in->color_primaries = AVCOL_PRI_BT709;
	va_in->color_trc = AVCOL_TRC_IEC61966_2_1;
	int64_t cur_pts = e->pts++;
	va_in->pts = cur_pts;
	if (cur_pts >= 0 && cur_pts < 1024) e->pts_ready[cur_pts] = ready_us;

	int rc = av_buffersrc_add_frame_flags(e->src_ctx, va_in, AV_BUFFERSRC_FLAG_KEEP_REF);
	av_frame_unref(va_in);
	if (rc < 0) return false;

	if (av_buffersink_get_frame(e->sink_ctx, nv12) < 0) {
		av_frame_unref(nv12);
		return false;
	}
	if (force_key) {
		nv12->pict_type = AV_PICTURE_TYPE_I;
		nv12->flags |= AV_FRAME_FLAG_KEY;
	} else {
		attach_roi_side_data(e, nv12, is_polish, dmg, n_dmg);
	}
	rc = avcodec_send_frame(e->codec, nv12);
	av_frame_unref(nv12);
	if (b->is_dmabuf && e->dmabuf_mode && e->imported_sid[si] != VA_INVALID_SURFACE) {
		/* Sync input DMA-BUF AFTER submitting encode to VDENC so VPP and VDENC overlap on GPU while capture waits safely */
		AVVAAPIDeviceContext *vactx = ((AVHWDeviceContext *)e->vaapi_dev->data)->hwctx;
		vaSyncSurface(vactx->display, e->imported_sid[si]);
	}
	if (rc < 0) return false;
	e->enc_submitted++;

	while (avcodec_receive_packet(e->codec, pkt) == 0) {
		bool is_key = (pkt->flags & AV_PKT_FLAG_KEY) != 0;
		uint64_t now_us = monotonic_us();
		uint64_t ts_us = now_us - e->start_us;
		e->enc_emitted++;
		if (e->bench_stats && pkt->pts > 2 && pkt->pts < 1024 && e->pts_ready[pkt->pts] > 0 && now_us >= e->pts_ready[pkt->pts] && e->enc_n < 512) {
			e->enc_samples[e->enc_n++] = now_us - e->pts_ready[pkt->pts];
		}
		if (ready_us > 0 && now_us >= ready_us && e->stat_enc_n < 64) {
			e->stat_enc_us[e->stat_enc_n++] = now_us - ready_us;
		}
		e->stat_bytes += (uint64_t)pkt->size;
		bool has_param_set = false;
		if (pkt->size > 4) {
			if (e->is_hevc) {
				int nalu = (pkt->data[4] >> 1) & 0x3F;
				has_param_set = (nalu == 32 || nalu == 33 || nalu == 34);
			} else {
				has_param_set = ((pkt->data[4] & 0x1F) == 7);
			}
		}
		if (is_key && e->codec->extradata_size > 0 && !has_param_set) {
			/* Zero-malloc writev prepend of VPS/SPS/PPS extradata if codec didn't emit inline parameter sets */
			send_video_msg_parts(true, ts_us, e->codec->extradata, (size_t)e->codec->extradata_size, pkt->data, (size_t)pkt->size);
		} else {
			send_video_msg(is_key, ts_us, pkt->data, (size_t)pkt->size);
		}
		av_packet_unref(pkt);

		if ((is_polish || now_us >= e->stat_window_us + 500000ULL) && e->stat_enc_n > 0) {
			qsort(e->stat_enc_us, (size_t)e->stat_enc_n, sizeof(uint64_t), cmp_u64);
			double enc_p50 = (double)e->stat_enc_us[e->stat_enc_n / 2] / 1000.0;
			double enc_p95 = (double)e->stat_enc_us[(e->stat_enc_n * 95) / 100] / 1000.0;
			double dt_us = (double)(now_us - e->stat_window_us);
			double mbps = dt_us > 1000.0 ? ((double)e->stat_bytes * 8.0 / dt_us) : 0.0;
			char stat_json[256];
			snprintf(stat_json, sizeof(stat_json),
				"{\"encMs\":%.2f,\"encP95Ms\":%.2f,\"mbps\":%.2f,\"polish\":%u,\"roi\":%u,\"slices\":%d}",
				enc_p50, enc_p95, mbps, e->stat_polish_count, e->stat_roi_count, e->slices);
			send_json_msg(5, stat_json);
			e->stat_window_us = now_us;
			e->stat_bytes = 0;
			e->stat_enc_n = 0;
		}
	}
	return true;
}

/* ---- Input injection thread (virtual pointer + virtual keyboard + live win_rect) ---- */
static const char *US_XKB_KEYMAP =
	"xkb_keymap {\n"
	"xkb_keycodes \"evdev\" { minimum = 8; maximum = 255;\n"
	"<ESC>=9;<AE01>=10;<AE02>=11;<AE03>=12;<AE04>=13;<AE05>=14;<AE06>=15;<AE07>=16;<AE08>=17;<AE09>=18;<AE10>=19;<AE11>=20;<AE12>=21;<BKSP>=22;<TAB>=23;\n"
	"<AD01>=24;<AD02>=25;<AD03>=26;<AD04>=27;<AD05>=28;<AD06>=29;<AD07>=30;<AD08>=31;<AD09>=32;<AD10>=33;<AD11>=34;<AD12>=35;<RTRN>=36;<LCTL>=37;\n"
	"<AC01>=38;<AC02>=39;<AC03>=40;<AC04>=41;<AC05>=42;<AC06>=43;<AC07>=44;<AC08>=45;<AC09>=46;<AC10>=47;<AC11>=48;<TLDE>=49;<LFSH>=50;<BKSL>=51;\n"
	"<AB01>=52;<AB02>=53;<AB03>=54;<AB04>=55;<AB05>=56;<AB06>=57;<AB07>=58;<AB08>=59;<AB09>=60;<AB10>=61;<RTSH>=62;<LALT>=64;<SPCE>=65;<CAPS>=66;\n"
	"<FK01>=67;<FK02>=68;<FK03>=69;<FK04>=70;<FK05>=71;<FK06>=72;<FK07>=73;<FK08>=74;<FK09>=75;<FK10>=76;<FK11>=95;<FK12>=96;<RCTL>=105;<RALT>=108;\n"
	"<HOME>=110;<UP>=111;<PGUP>=112;<LEFT>=113;<RGHT>=114;<END>=115;<DOWN>=116;<PGDN>=117;<INS>=118;<DELE>=119;<LWIN>=133;<RWIN>=134;\n};\n"
	"xkb_types \"complete\" { virtual_modifiers NumLock,Alt,LevelThree,Super;\n"
	"type \"ONE_LEVEL\" { modifiers=none; level_name[Level1]=\"Any\"; };\n"
	"type \"TWO_LEVEL\" { modifiers=Shift; map[Shift]=Level2; level_name[Level1]=\"Base\"; level_name[Level2]=\"Shift\"; };\n"
	"type \"ALPHABETIC\" { modifiers=Shift+Lock; map[Shift]=Level2; map[Lock]=Level2; level_name[Level1]=\"Base\"; level_name[Level2]=\"Caps\"; };\n};\n"
	"xkb_compatibility \"complete\" { virtual_modifiers NumLock,Alt,LevelThree,Super;\n"
	"interpret Any+AnyOf(all) { action=SetMods(modifiers=modMapMods,clearLocks); };\n};\n"
	"xkb_symbols \"pc+us\" {\n"
	"key <ESC>{[Escape]};key <AE01>{[1,exclam]};key <AE02>{[2,at]};key <AE03>{[3,numbersign]};key <AE04>{[4,dollar]};key <AE05>{[5,percent]};\n"
	"key <AE06>{[6,asciicircum]};key <AE07>{[7,ampersand]};key <AE08>{[8,asterisk]};key <AE09>{[9,parenleft]};key <AE10>{[0,parenright]};\n"
	"key <AE11>{[minus,underscore]};key <AE12>{[equal,plus]};key <BKSP>{[BackSpace]};key <TAB>{[Tab,ISO_Left_Tab]};\n"
	"key <AD01>{[q,Q]};key <AD02>{[w,W]};key <AD03>{[e,E]};key <AD04>{[r,R]};key <AD05>{[t,T]};key <AD06>{[y,Y]};key <AD07>{[u,U]};key <AD08>{[i,I]};key <AD09>{[o,O]};key <AD10>{[p,P]};\n"
	"key <AD11>{[bracketleft,braceleft]};key <AD12>{[bracketright,braceright]};key <RTRN>{[Return]};key <LCTL>{[Control_L]};\n"
	"key <AC01>{[a,A]};key <AC02>{[s,S]};key <AC03>{[d,D]};key <AC04>{[f,F]};key <AC05>{[g,G]};key <AC06>{[h,H]};key <AC07>{[j,J]};key <AC08>{[k,K]};key <AC09>{[l,L]};\n"
	"key <AC10>{[semicolon,colon]};key <AC11>{[apostrophe,quotedbl]};key <TLDE>{[grave,asciitilde]};key <LFSH>{[Shift_L]};key <BKSL>{[backslash,bar]};\n"
	"key <AB01>{[z,Z]};key <AB02>{[x,X]};key <AB03>{[c,C]};key <AB04>{[v,V]};key <AB05>{[b,B]};key <AB06>{[n,N]};key <AB07>{[m,M]};\n"
	"key <AB08>{[comma,less]};key <AB09>{[period,greater]};key <AB10>{[slash,question]};key <RTSH>{[Shift_R]};key <LALT>{[Alt_L]};key <SPCE>{[space]};key <CAPS>{[Caps_Lock]};\n"
	"key <FK01>{[F1]};key <FK02>{[F2]};key <FK03>{[F3]};key <FK04>{[F4]};key <FK05>{[F5]};key <FK06>{[F6]};key <FK07>{[F7]};key <FK08>{[F8]};key <FK09>{[F9]};key <FK10>{[F10]};key <FK11>{[F11]};key <FK12>{[F12]};\n"
	"key <RCTL>{[Control_R]};key <RALT>{[Alt_R]};key <HOME>{[Home]};key <UP>{[Up]};key <PGUP>{[Prior]};key <LEFT>{[Left]};key <RGHT>{[Right]};key <END>{[End]};key <DOWN>{[Down]};key <PGDN>{[Next]};key <INS>{[Insert]};key <DELE>{[Delete]};key <LWIN>{[Super_L]};key <RWIN>{[Super_R]};\n"
	"modifier_map Shift{<LFSH>,<RTSH>};modifier_map Lock{<CAPS>};modifier_map Control{<LCTL>,<RCTL>};modifier_map Mod1{<LALT>,<RALT>};modifier_map Mod4{<LWIN>,<RWIN>};\n};\n"
	"xkb_geometry \"pc(pc104)\" {};\n};\n";

typedef struct {
	WlClient *wl;
	uint32_t ptr_id;
	uint32_t kbd_id;
	bool window_mode;
	int layout_x, layout_y, layout_w, layout_h;
	int win_x, win_y, win_w, win_h;
	double last_x, last_y;
} InputCtx;

static bool json_get_double(const char *s, const char *key, double *out) {
	char pat[64];
	snprintf(pat, sizeof(pat), "\"%s\":", key);
	const char *p = strstr(s, pat);
	if (!p) return false;
	p += strlen(pat);
	while (*p == ' ') p++;
	char *end = NULL;
	double v = strtod(p, &end);
	if (end == p) return false;
	*out = v;
	return true;
}

static bool json_get_bool(const char *s, const char *key, bool *out) {
	char pat[64];
	snprintf(pat, sizeof(pat), "\"%s\":", key);
	const char *p = strstr(s, pat);
	if (!p) return false;
	p += strlen(pat);
	while (*p == ' ') p++;
	if (strncmp(p, "true", 4) == 0) { *out = true; return true; }
	if (strncmp(p, "false", 5) == 0) { *out = false; return true; }
	return false;
}

static int clamp_int(double v, int lo, int hi) {
	if (!(v >= (double)lo && v <= (double)hi)) {
		if (v < (double)lo) return lo;
		if (v > (double)hi) return hi;
		return lo;
	}
	return (int)v;
}

static void map_pointer(InputCtx *ic, double nx, double ny, uint32_t *ox, uint32_t *oy, uint32_t *ex, uint32_t *ey) {
	if (!(nx >= 0.0 && nx <= 1.0)) nx = (nx > 1.0) ? 1.0 : 0.0;
	if (!(ny >= 0.0 && ny <= 1.0)) ny = (ny > 1.0) ? 1.0 : 0.0;
	if (ic->win_w > 0 && ic->win_h > 0 && ic->layout_w > 0 && ic->layout_h > 0) {
		double gx = (double)ic->win_x + nx * (double)ic->win_w - (double)ic->layout_x;
		double gy = (double)ic->win_y + ny * (double)ic->win_h - (double)ic->layout_y;
		if (gx < 0) gx = 0;
		if (gy < 0) gy = 0;
		if (gx >= ic->layout_w) gx = ic->layout_w - 1;
		if (gy >= ic->layout_h) gy = ic->layout_h - 1;
		*ox = (uint32_t)gx;
		*oy = (uint32_t)gy;
		*ex = (uint32_t)ic->layout_w;
		*ey = (uint32_t)ic->layout_h;
		return;
	}
	*ox = (uint32_t)(nx * 65535.0);
	*oy = (uint32_t)(ny * 65535.0);
	*ex = 65535U;
	*ey = 65535U;
}

static void handle_stdin_line(InputCtx *ic, const char *line) {
	uint32_t ts = (uint32_t)(monotonic_us() / 1000ULL);
	/* Ultra-low-latency fast paths for compact binary-forwarded input commands:
	 *   M <ux> <uy>                (pointer motion + frame)
	 *   B <btn> <down> [<ux> <uy>] (optional motion + button + frame)
	 *   S <dx256> <dy256>          (scroll axes + frame)
	 *   K <code> <down> <mods>     (modifiers + key)
	 *   F                          (force IDR keyframe + instant eventfd wakeup)
	 */
	if (line[0] == 'M' && line[1] == ' ' && ic->ptr_id) {
		char *ep1 = NULL, *ep2 = NULL;
		long ux = strtol(line + 2, &ep1, 10);
		long uy = (ep1 != line + 2 && *ep1 == ' ') ? strtol(ep1 + 1, &ep2, 10) : -1;
		bool valid_end = ep2 != NULL && ep2 != ep1 + 1 && (*ep2 == '\n' || *ep2 == '\r' || *ep2 == '\0');
		if (valid_end && ux >= 0 && ux <= 65535 && uy >= 0 && uy <= 65535) {
			double x = (double)ux / 65535.0;
			double y = (double)uy / 65535.0;
			ic->last_x = x; ic->last_y = y;
			uint32_t pl[5];
			pl[0] = ts;
			map_pointer(ic, x, y, &pl[1], &pl[2], &pl[3], &pl[4]);
			wl_send_pair(ic->wl, ic->ptr_id, 1, pl, sizeof(pl), ic->ptr_id, 4, NULL, 0);
		}
		return;
	}
	if (line[0] == 'B' && line[1] == ' ' && ic->ptr_id) {
		char *ep1 = NULL, *ep2 = NULL, *ep3 = NULL, *ep4 = NULL;
		long btn = strtol(line + 2, &ep1, 10);
		long down = (ep1 != line + 2 && *ep1 == ' ') ? strtol(ep1 + 1, &ep2, 10) : -1;
		if (ep2 != NULL && ep2 != ep1 + 1 && btn >= 272 && btn <= 279 && (down == 0 || down == 1)) {
			if (*ep2 == ' ') {
				long ux = strtol(ep2 + 1, &ep3, 10);
				long uy = (ep3 != ep2 + 1 && *ep3 == ' ') ? strtol(ep3 + 1, &ep4, 10) : -1;
				if (ep4 != NULL && ep4 != ep3 + 1 && ux >= 0 && ux <= 65535 && uy >= 0 && uy <= 65535) {
					double x = (double)ux / 65535.0;
					double y = (double)uy / 65535.0;
					ic->last_x = x; ic->last_y = y;
					uint32_t mpl[5];
					mpl[0] = ts;
					map_pointer(ic, x, y, &mpl[1], &mpl[2], &mpl[3], &mpl[4]);
					wl_send(ic->wl, ic->ptr_id, 1, mpl, sizeof(mpl), -1);
				}
			}
			uint32_t bpl[3] = {ts, (uint32_t)btn, (uint32_t)down};
			wl_send_pair(ic->wl, ic->ptr_id, 2, bpl, sizeof(bpl), ic->ptr_id, 4, NULL, 0);
		}
		return;
	}
	if (line[0] == 'S' && line[1] == ' ' && ic->ptr_id) {
		char *ep1 = NULL, *ep2 = NULL;
		long dx256 = strtol(line + 2, &ep1, 10);
		long dy256 = (ep1 != line + 2 && *ep1 == ' ') ? strtol(ep1 + 1, &ep2, 10) : 0;
		bool valid_end = ep2 != NULL && ep2 != ep1 + 1 && (*ep2 == '\n' || *ep2 == '\r' || *ep2 == '\0');
		if (valid_end) {
			if (dx256 < -2560000L) dx256 = -2560000L; else if (dx256 > 2560000L) dx256 = 2560000L;
			if (dy256 < -2560000L) dy256 = -2560000L; else if (dy256 > 2560000L) dy256 = 2560000L;
			if (dy256 != 0 && dx256 == 0) {
				int32_t apl[3] = {(int32_t)ts, 0, (int32_t)dy256};
				wl_send_pair(ic->wl, ic->ptr_id, 3, apl, sizeof(apl), ic->ptr_id, 4, NULL, 0);
			} else if (dx256 != 0 && dy256 == 0) {
				int32_t apl[3] = {(int32_t)ts, 1, (int32_t)dx256};
				wl_send_pair(ic->wl, ic->ptr_id, 3, apl, sizeof(apl), ic->ptr_id, 4, NULL, 0);
			} else {
				if (dy256 != 0) {
					int32_t apl[3] = {(int32_t)ts, 0, (int32_t)dy256};
					wl_send(ic->wl, ic->ptr_id, 3, apl, sizeof(apl), -1);
				}
				if (dx256 != 0) {
					int32_t apl[3] = {(int32_t)ts, 1, (int32_t)dx256};
					wl_send(ic->wl, ic->ptr_id, 3, apl, sizeof(apl), -1);
				}
				wl_send(ic->wl, ic->ptr_id, 4, NULL, 0, -1);
			}
		}
		return;
	}
	if (line[0] == 'K' && line[1] == ' ' && ic->kbd_id) {
		char *ep1 = NULL, *ep2 = NULL, *ep3 = NULL;
		long code = strtol(line + 2, &ep1, 10);
		long down = (ep1 != line + 2 && *ep1 == ' ') ? strtol(ep1 + 1, &ep2, 10) : -1;
		long mods = (ep2 != NULL && ep2 != ep1 + 1 && *ep2 == ' ') ? strtol(ep2 + 1, &ep3, 10) : -1;
		if (code >= 1 && code <= 247 && (down == 0 || down == 1)) {
			uint32_t kpl[3] = {ts, (uint32_t)code, (uint32_t)down};
			if (mods >= 0 && mods <= 255) {
				uint32_t mpl[4] = {(uint32_t)mods, 0, 0, 0};
				wl_send_pair(ic->wl, ic->kbd_id, 2, mpl, sizeof(mpl), ic->kbd_id, 1, kpl, sizeof(kpl));
			} else {
				wl_send(ic->wl, ic->kbd_id, 1, kpl, sizeof(kpl), -1);
			}
		}
		return;
	}
	if (line[0] == 'F' && (line[1] == '\n' || line[1] == '\r' || line[1] == '\0')) {
		atomic_store(&g_force_keyframe, 1);
		wake_wl();
		return;
	}
	if (line[0] == 'R' && line[1] == ' ') {
		char *ep1 = NULL, *ep2 = NULL;
		long br = strtol(line + 2, &ep1, 10);
		long q = (ep1 != line + 2 && *ep1 == ' ') ? strtol(ep1 + 1, &ep2, 10) : -1;
		if (ep2 != NULL && ep2 != ep1 + 1 && *ep2 == ' ') {
			const char *cstr = ep2 + 1;
			char codec_buf[16] = {0};
			size_t ci = 0;
			while (ci + 1 < sizeof(codec_buf) && cstr[ci] && cstr[ci] != '\n' && cstr[ci] != '\r' && cstr[ci] != ' ') {
				codec_buf[ci] = cstr[ci];
				ci++;
			}
			codec_buf[ci] = '\0';
			bool valid_codec = (strcmp(codec_buf, "h264") == 0 || strcmp(codec_buf, "hevc") == 0 ||
				strcmp(codec_buf, "hevc10") == 0 || strcmp(codec_buf, "hevc444") == 0);
			if (br >= 1000 && br <= 150000 && (q == 0 || (q >= 10 && q <= 34)) && valid_codec) {
				pthread_mutex_lock(&g_reconfig_mu);
				g_reconfig_bitrate = (int)br;
				g_reconfig_quality = (int)q;
				snprintf(g_reconfig_codec, sizeof(g_reconfig_codec), "%s", codec_buf);
				atomic_fetch_add(&g_reconfig_gen, 1);
				pthread_mutex_unlock(&g_reconfig_mu);
				wake_wl();
			}
		}
		return;
	}
	if (strstr(line, "\"type\":\"keyframe\"")) {
		atomic_store(&g_force_keyframe, 1);
		wake_wl();
	} else if (strstr(line, "\"type\":\"win_rect\"")) {
		double wx, wy, ww, wh, lx, ly, lw, lh;
		if (json_get_double(line, "x", &wx)) ic->win_x = clamp_int(wx, -65536, 65536);
		if (json_get_double(line, "y", &wy)) ic->win_y = clamp_int(wy, -65536, 65536);
		if (json_get_double(line, "w", &ww)) ic->win_w = clamp_int(ww, 0, 65536);
		if (json_get_double(line, "h", &wh)) ic->win_h = clamp_int(wh, 0, 65536);
		if (json_get_double(line, "lx", &lx)) ic->layout_x = clamp_int(lx, -65536, 65536);
		if (json_get_double(line, "ly", &ly)) ic->layout_y = clamp_int(ly, -65536, 65536);
		if (json_get_double(line, "lw", &lw)) ic->layout_w = clamp_int(lw, 1, 65536);
		if (json_get_double(line, "lh", &lh)) ic->layout_h = clamp_int(lh, 1, 65536);
	} else if (strstr(line, "\"type\":\"pointer_move\"") && ic->ptr_id) {
		double x = ic->last_x, y = ic->last_y;
		json_get_double(line, "x", &x);
		json_get_double(line, "y", &y);
		ic->last_x = x; ic->last_y = y;
		uint32_t pl[5];
		pl[0] = ts;
		map_pointer(ic, x, y, &pl[1], &pl[2], &pl[3], &pl[4]);
		wl_send_pair(ic->wl, ic->ptr_id, 1, pl, sizeof(pl), ic->ptr_id, 4, NULL, 0);
	} else if (strstr(line, "\"type\":\"pointer_button\"") && ic->ptr_id) {
		double x, y, btn = 272;
		bool down = false;
		if (json_get_double(line, "x", &x) && json_get_double(line, "y", &y)) {
			ic->last_x = x; ic->last_y = y;
			uint32_t mpl[5];
			mpl[0] = ts;
			map_pointer(ic, x, y, &mpl[1], &mpl[2], &mpl[3], &mpl[4]);
			wl_send(ic->wl, ic->ptr_id, 1, mpl, sizeof(mpl), -1);
		}
		json_get_double(line, "button", &btn);
		json_get_bool(line, "down", &down);
		uint32_t bpl[3] = {ts, (uint32_t)clamp_int(btn, 272, 279), down ? 1U : 0U};
		wl_send_pair(ic->wl, ic->ptr_id, 2, bpl, sizeof(bpl), ic->ptr_id, 4, NULL, 0);
	} else if (strstr(line, "\"type\":\"pointer_scroll\"") && ic->ptr_id) {
		double dx = 0, dy = 0;
		json_get_double(line, "dx", &dx);
		json_get_double(line, "dy", &dy);
		if (dx < -10000.0) dx = -10000.0; else if (dx > 10000.0) dx = 10000.0;
		if (dy < -10000.0) dy = -10000.0; else if (dy > 10000.0) dy = 10000.0;
		if (dy != 0.0 && dy == dy) {
			int32_t apl[3] = {(int32_t)ts, 0, (int32_t)(dy * 256.0)};
			wl_send(ic->wl, ic->ptr_id, 3, apl, sizeof(apl), -1);
		}
		if (dx != 0.0 && dx == dx) {
			int32_t apl[3] = {(int32_t)ts, 1, (int32_t)(dx * 256.0)};
			wl_send(ic->wl, ic->ptr_id, 3, apl, sizeof(apl), -1);
		}
		wl_send(ic->wl, ic->ptr_id, 4, NULL, 0, -1);
	} else if (strstr(line, "\"type\":\"key\"") && ic->kbd_id) {
		double code = 0, mods = -1;
		bool down = false;
		json_get_double(line, "code", &code);
		json_get_bool(line, "down", &down);
		int icd = clamp_int(code, 0, 247);
		if (json_get_double(line, "mods", &mods) && mods >= 0) {
			uint32_t mpl[4] = {(uint32_t)clamp_int(mods, 0, 255), 0, 0, 0};
			if (icd > 0) {
				uint32_t kpl[3] = {ts, (uint32_t)icd, down ? 1U : 0U};
				wl_send_pair(ic->wl, ic->kbd_id, 2, mpl, sizeof(mpl), ic->kbd_id, 1, kpl, sizeof(kpl));
			} else {
				wl_send(ic->wl, ic->kbd_id, 2, mpl, sizeof(mpl), -1);
			}
		} else if (icd > 0) {
			uint32_t kpl[3] = {ts, (uint32_t)icd, down ? 1U : 0U};
			wl_send(ic->wl, ic->kbd_id, 1, kpl, sizeof(kpl), -1);
		}
	}
}

static void *stdin_thread(void *arg) {
	InputCtx *ic = (InputCtx *)arg;
	char buf[4096];
	size_t used = 0;
	while (atomic_load(&g_running)) {
		ssize_t n = read(STDIN_FILENO, buf + used, sizeof(buf) - 1 - used);
		if (n < 0) {
			if (errno == EINTR) continue;
			break;
		}
		if (n == 0) break;
		used += (size_t)n;
		buf[used] = '\0';
		char *start = buf;
		char *nl;
		while ((nl = memchr(start, '\n', (size_t)(buf + used - start))) != NULL) {
			*nl = '\0';
			handle_stdin_line(ic, start);
			start = nl + 1;
		}
		size_t rem = (size_t)(buf + used - start);
		if (rem >= sizeof(buf) - 1) {
			/* Discard overly long line without blocking */
			used = 0;
		} else if (rem > 0) {
			if (start != buf) memmove(buf, start, rem);
			used = rem;
		} else {
			used = 0;
		}
	}
	atomic_store(&g_running, 0);
	wake_wl();
	return NULL;
}

/* ---- Native cursor shape tracker (ext_image_copy_capture_cursor_session_v1 hotspot -> CSS cursor) ---- */
typedef struct {
	int32_t hx, hy;
	const char *css;
} CursorHotspot;

typedef struct {
	CursorHotspot map[32];
	int n_map;
	uint32_t sess_ids[8];
	int n_sess;
	uint32_t active_sess;
	char last_css[24];
} CursorTracker;

static void cursor_map_add(CursorTracker *ct, int32_t hx, int32_t hy, const char *css) {
	if (ct->n_map >= 32) return;
	for (int i = 0; i < ct->n_map; i++) {
		if (ct->map[i].hx == hx && ct->map[i].hy == hy) return; /* earlier higher-priority shape wins */
	}
	ct->map[ct->n_map++] = (CursorHotspot){hx, hy, css};
}

static bool cursor_read_xcur_hot(const char *path, int32_t *out_hx, int32_t *out_hy) {
	FILE *f = fopen(path, "rb");
	if (!f) return false;
	uint8_t hdr[16];
	if (fread(hdr, 1, 16, f) != 16 || memcmp(hdr, "Xcur", 4) != 0) { fclose(f); return false; }
	uint32_t hlen = 0, ntoc = 0;
	memcpy(&hlen, hdr + 4, 4);
	memcpy(&ntoc, hdr + 12, 4);
	if (ntoc > 256 || fseek(f, (long)hlen, SEEK_SET) != 0) { fclose(f); return false; }
	bool found = false;
	int best_diff = 9999;
	for (uint32_t i = 0; i < ntoc; i++) {
		uint32_t toc[3];
		if (fread(toc, 4, 3, f) != 3) break;
		if (toc[0] != 0xfffd0002U) continue; /* XCURSOR_IMAGE_TYPE */
		long cur = ftell(f);
		if (fseek(f, (long)toc[2], SEEK_SET) == 0) {
			uint32_t ih[8];
			if (fread(ih, 4, 8, f) == 8) {
				int w = (int)ih[4];
				int diff = w > 24 ? (w - 24) : (24 - w);
				if (w >= 16 && w <= 64 && diff < best_diff) {
					best_diff = diff;
					*out_hx = (int32_t)ih[6];
					*out_hy = (int32_t)ih[7];
					found = true;
				}
			}
		}
		if (fseek(f, cur, SEEK_SET) != 0) break;
	}
	fclose(f);
	return found;
}

static void cursor_load_theme(CursorTracker *ct) {
	const char *env_theme = getenv("XCURSOR_THEME");
	const char *home = getenv("HOME");
	const char *themes[5] = {env_theme, "Adwaita", "breeze", "breeze-dark", "default"};
	static const struct { const char *file; const char *css; } shapes[] = {
		{"default",     "default"},
		{"left_ptr",    "default"},
		{"pointer",     "pointer"},
		{"hand2",       "pointer"},
		{"text",        "text"},
		{"xterm",       "text"},
		{"grab",        "grab"},
		{"grabbing",    "grabbing"},
		{"ew-resize",   "ew-resize"},
		{"col-resize",  "ew-resize"},
		{"ns-resize",   "ns-resize"},
		{"row-resize",  "ns-resize"},
		{"nwse-resize", "nwse-resize"},
		{"nesw-resize", "nesw-resize"},
		{"zoom-in",     "zoom-in"},
		{"crosshair",   "crosshair"},
		{"not-allowed", "not-allowed"},
		{"wait",        "wait"},
	};
	for (int t = 0; t < 5; t++) {
		if (!themes[t] || !themes[t][0]) continue;
		const char *bases[2] = {home, "/usr/share/icons"};
		for (int b = 0; b < 2; b++) {
			if (!bases[b] || !bases[b][0]) continue;
			char dir[320];
			if (b == 0) snprintf(dir, sizeof(dir), "%s/.local/share/icons/%s/cursors", bases[b], themes[t]);
			else snprintf(dir, sizeof(dir), "%s/%s/cursors", bases[b], themes[t]);
			char probe[384];
			snprintf(probe, sizeof(probe), "%s/default", dir);
			if (access(probe, R_OK) != 0) {
				snprintf(probe, sizeof(probe), "%s/left_ptr", dir);
				if (access(probe, R_OK) != 0) continue;
			}
			for (size_t s = 0; s < sizeof(shapes) / sizeof(shapes[0]); s++) {
				char path[384];
				snprintf(path, sizeof(path), "%s/%s", dir, shapes[s].file);
				int32_t hx = 0, hy = 0;
				if (cursor_read_xcur_hot(path, &hx, &hy)) {
					cursor_map_add(ct, hx, hy, shapes[s].css);
				}
			}
			if (ct->n_map >= 3) return;
		}
	}
	/* Fallback built-in Adwaita 24px hotspots */
	cursor_map_add(ct, 3, 1, "default");
	cursor_map_add(ct, 7, 5, "pointer");
	cursor_map_add(ct, 11, 12, "text");
	cursor_map_add(ct, 11, 2, "grab");
	cursor_map_add(ct, 9, 5, "grabbing");
	cursor_map_add(ct, 12, 12, "ew-resize");
	cursor_map_add(ct, 12, 13, "ns-resize");
	cursor_map_add(ct, 11, 10, "zoom-in");
	cursor_map_add(ct, 11, 11, "crosshair");
}

static const char *cursor_lookup(const CursorTracker *ct, int32_t hx, int32_t hy) {
	for (int i = 0; i < ct->n_map; i++) {
		if (ct->map[i].hx == hx && ct->map[i].hy == hy) return ct->map[i].css;
	}
	/* Also tolerate 2x HiDPI scaled cursor hotspots */
	if ((hx & 1) == 0 && (hy & 1) == 0) {
		int32_t h2x = hx / 2, h2y = hy / 2;
		for (int i = 0; i < ct->n_map; i++) {
			if (ct->map[i].hx == h2x && ct->map[i].hy == h2y) return ct->map[i].css;
		}
	}
	return "default";
}

static void on_cursor_evt(void *ctx, uint32_t obj_id, uint16_t op, const uint8_t *pl, size_t len) {
	CursorTracker *ct = (CursorTracker *)ctx;
	const char *css = NULL;
	if (op == 0) { /* enter */
		ct->active_sess = obj_id;
	} else if (op == 3 && len >= 8) { /* hotspot(x, y) */
		ct->active_sess = obj_id;
		int32_t hx = 0, hy = 0;
		memcpy(&hx, pl, 4);
		memcpy(&hy, pl + 4, 4);
		css = cursor_lookup(ct, hx, hy);
	} else if (op == 1) { /* leave */
		if (ct->active_sess == 0 || ct->active_sess == obj_id) {
			ct->active_sess = 0;
			css = "default";
		}
	}
	if (css && strcmp(css, ct->last_css) != 0) {
		snprintf(ct->last_css, sizeof(ct->last_css), "%s", css);
		char msg[64];
		snprintf(msg, sizeof(msg), "{\"cursor\":\"%s\"}", ct->last_css);
		send_json_msg(4, msg);
	}
}

static void cursor_tracker_init(CursorTracker *ct, WlClient *wl, uint32_t seat_id, const OutProbe *probes, int n_out) {
	uint32_t out_src_mgr = wl_bind_nth(wl, "ext_output_image_capture_source_manager_v1", 1, 0, NULL);
	uint32_t cap_mgr = wl_bind_nth(wl, "ext_image_copy_capture_manager_v1", 1, 0, NULL);
	if (!out_src_mgr || !cap_mgr || !seat_id || n_out <= 0) return;
	cursor_load_theme(ct);
	uint32_t ptr_id = wl_alloc_id(wl);
	wl_send(wl, seat_id, 0, &ptr_id, 4, -1); /* wl_seat::get_pointer */
	for (int i = 0; i < n_out && ct->n_sess < 8; i++) {
		uint32_t src_id = wl_alloc_id(wl);
		uint32_t spl[2] = {src_id, probes[i].oid};
		wl_send(wl, out_src_mgr, 0, spl, sizeof(spl), -1); /* create_source */
		uint32_t cs_id = wl_alloc_id(wl);
		uint32_t cpl[3] = {cs_id, src_id, ptr_id};
		wl_send(wl, cap_mgr, 1, cpl, sizeof(cpl), -1); /* create_pointer_cursor_session */
		wl_set_handler(wl, cs_id, on_cursor_evt, ct);
		ct->sess_ids[ct->n_sess++] = cs_id;
	}
}

/* ---- Pre-armed ping-pong frame capture slots (zero roundtrip between vblanks -> locked 60.0 FPS!) ---- */
typedef struct {
	uint32_t frame_id;
	bool window_mode;
	uint32_t mgr_ver;
	/* received metadata */
	bool has_shm;
	uint32_t shm_fmt, shm_w, shm_h, shm_stride;
	bool has_dmabuf;
	uint32_t dma_fmt, dma_w, dma_h;
	uint32_t flags;
	bool buf_done, copy_sent, copy_ign, is_polish, ready, failed;
	uint64_t armed_us, copy_sent_us;
	DamageRect damage[MAX_DAMAGE_RECTS];
	int n_damage;
	CapBuf *buf;
} FrameSlot;

static void on_frame_evt(void *ctx, uint32_t obj_id, uint16_t op, const uint8_t *pl, size_t len) {
	(void)obj_id;
	FrameSlot *fs = (FrameSlot *)ctx;
	if (op == 0 && len >= 16) {
		uint32_t fmt, w, h, stride;
		memcpy(&fmt, pl, 4); memcpy(&w, pl + 4, 4); memcpy(&h, pl + 8, 4); memcpy(&stride, pl + 12, 4);
		if (is_supported_shm_fmt(fmt) && w >= 2 && h >= 2 && w <= 16384 && h <= 16384 &&
			(uint64_t)stride >= (uint64_t)w * 4ULL && (uint64_t)stride * (uint64_t)h <= 0x7FFFFFFFULL) {
			fs->has_shm = true; fs->shm_fmt = fmt; fs->shm_w = w; fs->shm_h = h; fs->shm_stride = stride;
		}
		if (!fs->window_mode && fs->mgr_ver < 3) fs->buf_done = true;
	} else if (((fs->window_mode && op == 1) || (!fs->window_mode && op == 4)) && len >= 16) {
		if (fs->n_damage < MAX_DAMAGE_RECTS) {
			uint32_t dx, dy, dw, dh;
			memcpy(&dx, pl, 4); memcpy(&dy, pl + 4, 4); memcpy(&dw, pl + 8, 4); memcpy(&dh, pl + 12, 4);
			if (dw > 0 && dh > 0 && dx <= 0x7FFFFFFFU && dy <= 0x7FFFFFFFU && dw <= 0x7FFFFFFFU && dh <= 0x7FFFFFFFU) {
				fs->damage[fs->n_damage++] = (DamageRect){(int32_t)dx, (int32_t)dy, (int32_t)dw, (int32_t)dh};
			}
		}
	} else if (op == 5 && len >= 12) {
		uint32_t fmt, w, h;
		memcpy(&fmt, pl, 4); memcpy(&w, pl + 4, 4); memcpy(&h, pl + 8, 4);
		if (is_supported_drm_fmt(fmt) && w >= 2 && h >= 2 && w <= 16384 && h <= 16384) {
			fs->has_dmabuf = true; fs->dma_fmt = fmt; fs->dma_w = w; fs->dma_h = h;
		}
	} else if ((fs->window_mode && op == 2) || (!fs->window_mode && op == 1)) {
		if (len >= 4) memcpy(&fs->flags, pl, 4);
	} else if ((fs->window_mode && op == 3) || (!fs->window_mode && op == 2)) {
		fs->ready = true;
	} else if ((fs->window_mode && op == 4) || (!fs->window_mode && op == 3)) {
		fs->failed = true;
	} else if (op == 6) {
		fs->buf_done = true;
	}
}

static void slot_destroy(WlClient *wl, FrameSlot *fs) {
	if (fs->frame_id) {
		wl_clear_handler(wl, fs->frame_id);
		wl_send(wl, fs->frame_id, 1, NULL, 0, -1); /* destroy frame */
		fs->frame_id = 0;
	}
	fs->buf_done = false;
	fs->copy_sent = false;
	fs->copy_ign = false;
	fs->ready = false;
	fs->failed = false;
}

static void slot_arm(WlClient *wl, uint32_t mgr_id, bool window_mode, uint32_t mgr_ver, uint32_t handle_u32, uint32_t output_id, FrameSlot *fs, CapBuf *buf) {
	slot_destroy(wl, fs);
	memset(fs, 0, sizeof(*fs));
	fs->buf = buf;
	fs->window_mode = window_mode;
	fs->mgr_ver = mgr_ver;
	fs->frame_id = wl_alloc_id(wl);
	fs->armed_us = monotonic_us();
	wl_set_handler(wl, fs->frame_id, on_frame_evt, fs);
	/* overlay_cursor = 0U: never paint a duplicate software cursor over the browser's native cursor */
	uint32_t req_pl[3] = {fs->frame_id, 0U, window_mode ? handle_u32 : output_id};
	wl_send(wl, mgr_id, 0, req_pl, sizeof(req_pl), -1);
}

static bool slot_send_copy(WlClient *wl, struct gbm_device *gbm, uint32_t shm_id, uint32_t dmabuf_id, bool allow_dmabuf, FrameSlot *fs, bool ignore_damage) {
	if (!fs->frame_id || !fs->buf_done || fs->copy_sent) return false;
	bool want_dma = allow_dmabuf && gbm && dmabuf_id && fs->has_dmabuf && fs->dma_w > 0 && fs->dma_h > 0;
	if (want_dma) {
		if (!fs->buf->is_dmabuf || fs->buf->width != (int)fs->dma_w || fs->buf->height != (int)fs->dma_h || fs->buf->fmt != fs->dma_fmt) {
			capbuf_destroy(wl, fs->buf);
			if (!capbuf_create_dmabuf(wl, gbm, dmabuf_id, (int)fs->dma_w, (int)fs->dma_h, fs->dma_fmt, fs->buf)) {
				want_dma = false;
			}
		}
	}
	if (!want_dma) {
		if (!fs->has_shm || fs->shm_w == 0 || fs->shm_h == 0) {
			fs->failed = true;
			return false;
		}
		if (fs->buf->is_dmabuf || fs->buf->width != (int)fs->shm_w || fs->buf->height != (int)fs->shm_h || fs->buf->stride != fs->shm_stride || fs->buf->fmt != fs->shm_fmt) {
			capbuf_destroy(wl, fs->buf);
			if (!capbuf_create_shm(wl, shm_id, (int)fs->shm_w, (int)fs->shm_h, fs->shm_stride, fs->shm_fmt, fs->buf)) {
				fs->failed = true;
				return false;
			}
		}
	}
	if (fs->window_mode) {
		uint32_t pl[2] = {fs->buf->buf_id, ignore_damage ? 1U : 0U};
		wl_send(wl, fs->frame_id, 0, pl, sizeof(pl), -1);
	} else {
		uint16_t op = (!ignore_damage && fs->mgr_ver >= 2) ? 2 : 0; /* copy_with_damage vs copy */
		wl_send(wl, fs->frame_id, op, &fs->buf->buf_id, 4, -1);
	}
	fs->copy_sent = true;
	fs->copy_ign = ignore_damage;
	fs->copy_sent_us = monotonic_us();
	return true;
}

typedef struct {
	pthread_mutex_t mu;
	pthread_cond_t cv;
	CapBuf *caps;
	bool slot_busy[CAP_SLOTS];
	int queue[CAP_SLOTS];
	int q_head;
	int q_count;
	bool y_inv[CAP_SLOTS];
	bool want_key[CAP_SLOTS];
	bool is_polish[CAP_SLOTS];
	DamageRect damage[CAP_SLOTS][MAX_DAMAGE_RECTS];
	int n_damage[CAP_SLOTS];
	uint64_t ready_us[CAP_SLOTS];
	bool stop;
	bool fallback_shm;
	bool fatal;
	const char *vaapi_device;
	const char *address;
	const char *req_codec;
	bool window_mode;
	int fps;
	int bitrate;
	int quality;
	int compression;
	bool once;
	bool bench_stats;
} EncPipe;

static void *encode_thread(void *arg) {
	EncPipe *ep = (EncPipe *)arg;
	VaapiEncoder enc = {0};
	for (int i = 0; i < CAP_SLOTS; i++) enc.imported_sid[i] = VA_INVALID_SURFACE;
	bool enc_ready = false;
	int enc_fail_streak = 0;
	int cur_bitrate;
	int cur_quality;
	char cur_codec[16];
	/* Snapshot initial reconfig settings and generation together under g_reconfig_mu so early stdin R lines are never lost */
	pthread_mutex_lock(&g_reconfig_mu);
	cur_bitrate = g_reconfig_bitrate;
	cur_quality = g_reconfig_quality;
	snprintf(cur_codec, sizeof(cur_codec), "%s", g_reconfig_codec);
	uint32_t applied_reconfig_gen = atomic_load(&g_reconfig_gen);
	pthread_mutex_unlock(&g_reconfig_mu);

	for (;;) {
		pthread_mutex_lock(&ep->mu);
		while (ep->q_count == 0 && !ep->stop) {
			pthread_cond_wait(&ep->cv, &ep->mu);
		}
		if (ep->q_count == 0 && ep->stop) {
			pthread_mutex_unlock(&ep->mu);
			break;
		}
		int slot = ep->queue[ep->q_head];
		ep->q_head = (ep->q_head + 1) % CAP_SLOTS;
		ep->q_count--;
		bool y_inv = ep->y_inv[slot];
		bool want_key = ep->want_key[slot];
		bool is_polish = ep->is_polish[slot];
		int n_dmg = ep->n_damage[slot];
		DamageRect dmg[MAX_DAMAGE_RECTS];
		if (n_dmg > 0) memcpy(dmg, ep->damage[slot], (size_t)n_dmg * sizeof(DamageRect));
		uint64_t ready_us = ep->ready_us[slot];
		pthread_mutex_unlock(&ep->mu);

		CapBuf *b = &ep->caps[slot];
		bool dmabuf_fallback = false;
		bool fatal = false;
		bool reconfig_needed = false;
		if (atomic_load(&g_reconfig_gen) != applied_reconfig_gen) {
			pthread_mutex_lock(&g_reconfig_mu);
			uint32_t cur_gen = atomic_load(&g_reconfig_gen);
			if (cur_gen != applied_reconfig_gen) {
				cur_bitrate = g_reconfig_bitrate;
				cur_quality = g_reconfig_quality;
				snprintf(cur_codec, sizeof(cur_codec), "%s", g_reconfig_codec);
				applied_reconfig_gen = cur_gen;
				reconfig_needed = true;
			}
			pthread_mutex_unlock(&g_reconfig_mu);
		}

		if (!enc_ready || reconfig_needed || enc.width != b->width || enc.height != b->height || enc.dmabuf_mode != b->is_dmabuf || enc.drm_fourcc != b->fmt || enc.y_invert != y_inv) {
			if (enc_ready) enc_destroy(&enc);
			enc_ready = enc_init(&enc, ep->vaapi_device, b->width, b->height, b->fmt, b->is_dmabuf, y_inv, ep->fps, cur_bitrate, cur_codec, cur_quality, ep->compression);
			enc.bench_stats = ep->bench_stats;
			if (!enc_ready && b->is_dmabuf) {
				dmabuf_fallback = true;
			} else if (!enc_ready) {
				send_json_msg(3, "{\"error\":\"VA-API hardware encoder failed to initialize\"}");
				fatal = true;
			} else {
				char meta[480];
				snprintf(meta, sizeof(meta), "{\"mode\":\"%s\",\"address\":\"%s\",\"width\":%d,\"height\":%d,\"fps\":%d,\"bitrate\":%d,\"quality\":%d,\"reconfigGen\":%u,\"encoder\":\"%s\",\"codec\":\"%s\"}",
					ep->window_mode ? "window" : "output", ep->address, enc.even_w, enc.even_h, ep->fps, cur_bitrate, cur_quality, applied_reconfig_gen, enc.encoder_name, enc.codec_str);
				send_json_msg(1, meta);
				want_key = true;
			}
		}

		if (enc_ready && !dmabuf_fallback && !fatal) {
			if (!enc_submit_capbuf(&enc, b, slot, want_key, is_polish, dmg, n_dmg, ready_us)) {
				if (b->is_dmabuf) {
					enc_destroy(&enc);
					enc_ready = false;
					dmabuf_fallback = true;
				} else {
					enc_fail_streak++;
					if (enc_fail_streak >= 10) {
						send_json_msg(3, "{\"error\":\"VA-API encoder failed repeatedly\"}");
						fatal = true;
					}
				}
			} else {
				enc_fail_streak = 0;
				if (ep->once) {
					avcodec_send_frame(enc.codec, NULL);
					while (avcodec_receive_packet(enc.codec, enc.pkt) == 0) {
						bool is_key = (enc.pkt->flags & AV_PKT_FLAG_KEY) != 0;
						send_video_msg(is_key, monotonic_us() - enc.start_us, enc.pkt->data, (size_t)enc.pkt->size);
						av_packet_unref(enc.pkt);
					}
				}
			}
		}

		pthread_mutex_lock(&ep->mu);
		ep->slot_busy[slot] = false;
		if (dmabuf_fallback) ep->fallback_shm = true;
		if (fatal) {
			ep->fatal = true;
			atomic_store(&g_running, 0);
		}
		pthread_cond_broadcast(&ep->cv);
		pthread_mutex_unlock(&ep->mu);
	}

	if (ep->bench_stats && enc_ready && enc.enc_n > 0) {
		qsort(enc.enc_samples, (size_t)enc.enc_n, sizeof(uint64_t), cmp_u64);
		double p50 = (double)enc.enc_samples[enc.enc_n / 2] / 1000.0;
		double p95 = (double)enc.enc_samples[(enc.enc_n * 95) / 100] / 1000.0;
		double mx = (double)enc.enc_samples[enc.enc_n - 1] / 1000.0;
		fprintf(stderr, "STATS submitted=%d emitted=%d stalled=%d enc_p50_ms=%.2f enc_p95_ms=%.2f enc_max_ms=%.2f mod=0x%" PRIx64 "\n",
			enc.enc_submitted, enc.enc_emitted, enc.enc_submitted - enc.enc_emitted, p50, p95, mx, ep->caps[0].modifier);
	}
	if (enc_ready) enc_destroy(&enc);
	return NULL;
}

int main(int argc, char **argv) {
	if (argc >= 2 && strcmp(argv[1], "--opus-stdin") == 0) {
		return run_opus_stdin();
	}
	bool window_mode = false;
	const char *address = "";
	const char *output_name = "";
	const char *vaapi_device = "/dev/dri/renderD128";
	const char *req_codec = "h264";
	int fps = 60;
	int bitrate = 20000;
	int quality = 0;
	int compression = 0;
	bool once = false;
	bool allow_dmabuf = true;
	bool always_frame = false;
	bool bench_stats = false;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) window_mode = (strcmp(argv[++i], "window") == 0);
		else if (strcmp(argv[i], "--address") == 0 && i + 1 < argc) address = argv[++i];
		else if (strcmp(argv[i], "--output") == 0 && i + 1 < argc) output_name = argv[++i];
		else if (strcmp(argv[i], "--vaapi-device") == 0 && i + 1 < argc) vaapi_device = argv[++i];
		else if (strcmp(argv[i], "--codec") == 0 && i + 1 < argc) req_codec = argv[++i];
		else if (strcmp(argv[i], "--fps") == 0 && i + 1 < argc) fps = atoi(argv[++i]);
		else if (strcmp(argv[i], "--bitrate") == 0 && i + 1 < argc) bitrate = atoi(argv[++i]);
		else if (strcmp(argv[i], "--quality") == 0 && i + 1 < argc) quality = atoi(argv[++i]);
		else if (strcmp(argv[i], "--compression") == 0 && i + 1 < argc) compression = atoi(argv[++i]);
		else if (strcmp(argv[i], "--once") == 0) once = true;
		else if (strcmp(argv[i], "--no-dmabuf") == 0) allow_dmabuf = false;
		else if (strcmp(argv[i], "--continuous") == 0) always_frame = true;
		else if (strcmp(argv[i], "--bench-stats") == 0) bench_stats = true;
	}
	if (fps < 5) fps = 5;
	if (fps > 120) fps = 120;
	if (bitrate < 1000) bitrate = 1000;
	if (bitrate > 150000) bitrate = 150000;
	g_reconfig_bitrate = bitrate;
	g_reconfig_quality = quality;
	snprintf(g_reconfig_codec, sizeof(g_reconfig_codec), "%s", req_codec);

	/* Enlarge stdout pipe up to 2 MiB (fallback 1 MiB) so near-lossless 4K keyframes never stall the encoder thread */
#ifdef F_SETPIPE_SZ
	if (fcntl(STDOUT_FILENO, F_SETPIPE_SZ, 2097152) < 0) {
		(void)fcntl(STDOUT_FILENO, F_SETPIPE_SZ, 1048576);
	}
#endif
	g_wake_fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);

	signal(SIGTERM, on_signal);
	signal(SIGINT, on_signal);
	signal(SIGPIPE, SIG_IGN);
	av_log_set_level(AV_LOG_QUIET);

	const char *runtime = getenv("XDG_RUNTIME_DIR");
	const char *display = getenv("WAYLAND_DISPLAY");
	if (!runtime || !display) {
		send_json_msg(3, "{\"error\":\"Missing XDG_RUNTIME_DIR or WAYLAND_DISPLAY\"}");
		return 1;
	}

	char sock_path[256];
	snprintf(sock_path, sizeof(sock_path), "%s/%s", runtime, display);
	WlClient wl = {0};
	pthread_mutex_init(&wl.tx_lock, NULL);
	wl.next_id = 2;
	wl.fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	struct sockaddr_un addr = {0};
	addr.sun_family = AF_UNIX;
	snprintf(addr.sun_path, sizeof(addr.sun_path), "%.*s", (int)(sizeof(addr.sun_path) - 1), sock_path);
	if (connect(wl.fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		send_json_msg(3, "{\"error\":\"Failed to connect to Wayland compositor\"}");
		return 1;
	}

	wl.registry_id = wl_alloc_id(&wl);
	wl_set_handler(&wl, wl.registry_id, on_registry, &wl);
	wl_send(&wl, 1, 1, &wl.registry_id, 4, -1);
	wl_roundtrip(&wl);

	uint32_t shm_id = wl_bind_nth(&wl, "wl_shm", 2, 0, NULL);
	uint32_t seat_id = wl_bind_nth(&wl, "wl_seat", 7, 0, NULL);
	uint32_t dmabuf_id = wl_bind_nth(&wl, "zwp_linux_dmabuf_v1", 4, 0, NULL);

	/* Find target wl_output (matching --output name if given, else first output) */
	uint32_t output_id = 0;
	OutProbe probes[8];
	int n_out = 0;
	for (int i = 0; i < 8; i++) {
		uint32_t oid = wl_bind_nth(&wl, "wl_output", 4, i, NULL);
		if (!oid) break;
		probes[n_out].oid = oid;
		probes[n_out].name[0] = '\0';
		wl_set_handler(&wl, oid, on_output_evt, &probes[n_out]);
		n_out++;
	}
	if (n_out > 0) wl_roundtrip(&wl);
	for (int i = 0; i < n_out; i++) {
		wl_clear_handler(&wl, probes[i].oid);
		if (output_name[0] && strcmp(probes[i].name, output_name) == 0) output_id = probes[i].oid;
	}
	if (!window_mode && output_name[0] && !output_id) {
		send_json_msg(3, "{\"error\":\"Requested Wayland output is unavailable\"}");
		close(wl.fd);
		return 1;
	}
	if (!output_id && !output_name[0] && n_out > 0) output_id = probes[0].oid;

	/* Native cursor shape tracker via ext_image_copy_capture_cursor_session_v1 (zero CPU/GPU overhead, push-only on shape change) */
	CursorTracker ct = {0};
	if (!once && seat_id && n_out > 0) {
		cursor_tracker_init(&ct, &wl, seat_id, probes, n_out);
	}

	uint32_t mgr_ver = 0;
	uint32_t mgr_id = 0;
	uint32_t handle_u32 = 0;
	if (window_mode) {
		mgr_id = wl_bind_nth(&wl, "hyprland_toplevel_export_manager_v1", 2, 0, &mgr_ver);
		if (!mgr_id) {
			send_json_msg(3, "{\"error\":\"Hyprland toplevel export protocol not available\"}");
			return 1;
		}
		handle_u32 = (uint32_t)(strtoull(address, NULL, 16) & 0xFFFFFFFFULL);
	} else {
		mgr_id = wl_bind_nth(&wl, "zwlr_screencopy_manager_v1", 3, 0, &mgr_ver);
		if (!mgr_id || !output_id) {
			send_json_msg(3, "{\"error\":\"zwlr_screencopy_manager_v1 or wl_output unavailable\"}");
			return 1;
		}
	}

	/* Open DRM render node + GBM for zero-copy DMA-BUF */
	int drm_fd = open(vaapi_device, O_RDWR | O_CLOEXEC);
	struct gbm_device *gbm = (drm_fd >= 0) ? gbm_create_device(drm_fd) : NULL;

	/* Virtual pointer + virtual keyboard for ultra-low-latency input */
	InputCtx ic = {0};
	ic.wl = &wl;
	ic.window_mode = window_mode;
	ic.last_x = 0.5;
	ic.last_y = 0.5;
	uint32_t pm_id = wl_bind_nth(&wl, "zwlr_virtual_pointer_manager_v1", 2, 0, NULL);
	if (pm_id && seat_id) {
		ic.ptr_id = wl_alloc_id(&wl);
		uint32_t pl[2] = {seat_id, ic.ptr_id};
		wl_send(&wl, pm_id, 0, pl, sizeof(pl), -1);
	}
	uint32_t km_id = wl_bind_nth(&wl, "zwp_virtual_keyboard_manager_v1", 1, 0, NULL);
	if (km_id && seat_id) {
		ic.kbd_id = wl_alloc_id(&wl);
		uint32_t pl[2] = {seat_id, ic.kbd_id};
		wl_send(&wl, km_id, 0, pl, sizeof(pl), -1);
		size_t klen = strlen(US_XKB_KEYMAP) + 1;
		int kfd = memfd_create("hypr-rail-km", MFD_CLOEXEC);
		if (kfd >= 0) {
			if (write_all(kfd, US_XKB_KEYMAP, klen)) {
				lseek(kfd, 0, SEEK_SET);
				uint32_t kpl[2] = {1U, (uint32_t)klen};
				wl_send(&wl, ic.kbd_id, 0, kpl, sizeof(kpl), kfd);
			}
			close(kfd);
		}
	}

	pthread_t in_tid;
	if (!once) {
		if (pthread_create(&in_tid, NULL, stdin_thread, &ic) == 0) {
			pthread_detach(in_tid);
		}
	}

	CapBuf caps[CAP_SLOTS];
	for (int i = 0; i < CAP_SLOTS; i++) {
		memset(&caps[i], 0, sizeof(caps[i]));
		caps[i].dmabuf_fd = -1;
		caps[i].shm_fd = -1;
	}
	EncPipe ep = {
		.mu = PTHREAD_MUTEX_INITIALIZER,
		.cv = PTHREAD_COND_INITIALIZER,
		.caps = caps,
		.vaapi_device = vaapi_device,
		.address = address,
		.req_codec = req_codec,
		.window_mode = window_mode,
		.fps = fps,
		.bitrate = bitrate,
		.quality = quality,
		.compression = compression,
		.once = once,
		.bench_stats = bench_stats,
	};
	pthread_t enc_tid;
	bool has_enc_thread = (pthread_create(&enc_tid, NULL, encode_thread, &ep) == 0);
	if (!has_enc_thread) {
		send_json_msg(3, "{\"error\":\"Failed to start encoder thread\"}");
		return 2;
	}

	uint64_t interval_us = 1000000ULL / (uint64_t)fps;
	uint64_t last_fire_us = 0;
	uint64_t last_motion_us = 0;
	bool needs_polish = false;
	bool next_is_polish = false;
	uint32_t seen_reconfig_gen = atomic_load(&g_reconfig_gen);
	int fail_streak = 0;
	bool first_frame = true;
	int n_slots = once ? 1 : CAP_SLOTS;
	FrameSlot fslots[CAP_SLOTS] = {0};
	int active_slot = -1;
	int next_slot = 0;

	/* Pre-arm all triple-buffered Wayland frame slots so a free pre-armed slot is ALWAYS ready on every 16.6ms vblank! */
	for (int i = 0; i < n_slots; i++) {
		slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[i], &caps[i]);
	}

	while (atomic_load(&g_running)) {
		pthread_mutex_lock(&ep.mu);
		bool do_fallback = ep.fallback_shm;
		if (do_fallback) ep.fallback_shm = false;
		bool enc_fatal = ep.fatal;
		pthread_mutex_unlock(&ep.mu);
		if (!atomic_load(&g_running) || enc_fatal) break;

		if (do_fallback && allow_dmabuf) {
			/* Drain all slots before tearing down DMA-BUF buffers for SHM fallback */
			for (int i = 0; i < CAP_SLOTS; i++) slot_destroy(&wl, &fslots[i]);
			active_slot = -1;
			pthread_mutex_lock(&ep.mu);
			while ((ep.slot_busy[0] || ep.slot_busy[1] || ep.slot_busy[2]) && atomic_load(&g_running) && !ep.fatal) {
				pthread_cond_wait(&ep.cv, &ep.mu);
			}
			enc_fatal = ep.fatal;
			pthread_mutex_unlock(&ep.mu);
			/* On shutdown or fatal error, never destroy buffers before encode_thread is joined below */
			if (!atomic_load(&g_running) || enc_fatal) break;
			allow_dmabuf = false;
			for (int i = 0; i < CAP_SLOTS; i++) capbuf_destroy(&wl, &caps[i]);
			for (int i = 0; i < n_slots; i++) {
				slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[i], &caps[i]);
			}
			next_slot = 0;
			continue;
		}

		uint32_t cur_reconfig_gen = atomic_load(&g_reconfig_gen);
		bool reconfig_pending = (cur_reconfig_gen != seen_reconfig_gen);
		/* Build-to-Lossless ("Still-Frame Polish"): 130 ms after motion stops, fire ONE near-lossless ROI polish frame so static text snaps crystal clear! */
		bool polish_due = (!always_frame && !once && needs_polish && !first_frame && last_motion_us > 0 && (monotonic_us() - last_motion_us) >= 130000ULL);

		/* If idle in copy_with_damage and an on-demand keyframe, live reconfig, or polish frame is due, cancel idle wait & fire immediate copy! */
		if (active_slot >= 0 && !fslots[active_slot].copy_ign && (atomic_load(&g_force_keyframe) || reconfig_pending || polish_due)) {
			int s = active_slot;
			slot_destroy(&wl, &fslots[s]);
			active_slot = -1;
			if (polish_due && !reconfig_pending && !atomic_load(&g_force_keyframe)) {
				next_is_polish = true;
				needs_polish = false;
			}
			slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[s], &caps[s]);
			next_slot = (s + 1) % n_slots;
		}

		/* Fire next copy when no copy is currently in-flight */
		if (active_slot < 0) {
			int s = next_slot;
			/* Pick a ready, non-busy pre-armed slot if the preferred slot isn't ready yet */
			pthread_mutex_lock(&ep.mu);
			for (int off = 0; off < n_slots; off++) {
				int cand = (next_slot + off) % n_slots;
				if (!ep.slot_busy[cand] && fslots[cand].buf_done && !fslots[cand].copy_sent && !fslots[cand].failed) {
					s = cand;
					break;
				}
			}
			pthread_mutex_unlock(&ep.mu);
			if (!fslots[s].frame_id) {
				slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[s], &caps[s]);
			}
			if (fslots[s].buf_done && !fslots[s].copy_sent) {
				/* Pace only if we would exceed target fps (e.g. --fps 30 on 60 Hz or --fps 60 on 120 Hz) */
				uint64_t now_us = monotonic_us();
				if (last_fire_us > 0 && now_us < last_fire_us + (interval_us * 3ULL) / 4ULL) {
					uint64_t target_us = last_fire_us + interval_us;
					struct timespec ts = {
						.tv_sec = (time_t)(target_us / 1000000ULL),
						.tv_nsec = (long)((target_us % 1000000ULL) * 1000ULL),
					};
					clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL);
				}
				/* Wait only if this slot is still being encoded (0ms wait with triple-buffering!) */
				pthread_mutex_lock(&ep.mu);
				while (ep.slot_busy[s] && atomic_load(&g_running) && !ep.fatal) {
					pthread_cond_wait(&ep.cv, &ep.mu);
				}
				enc_fatal = ep.fatal;
				pthread_mutex_unlock(&ep.mu);
				if (!atomic_load(&g_running) || enc_fatal) break;

				bool ign = first_frame || (atomic_load(&g_force_keyframe) != 0) || reconfig_pending || next_is_polish || once || always_frame;
				fslots[s].is_polish = next_is_polish && !reconfig_pending && !first_frame;
				if (slot_send_copy(&wl, gbm, shm_id, dmabuf_id, allow_dmabuf, &fslots[s], ign)) {
					active_slot = s;
					last_fire_us = monotonic_us();
					next_is_polish = false;
					if (reconfig_pending) seen_reconfig_gen = cur_reconfig_gen;
					int nxt = (s + 1) % n_slots;
					if (!once && !fslots[nxt].frame_id) {
						slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[nxt], &caps[nxt]);
					}
				}
			}
		}

		wl_pump(&wl, 8);
		if (!atomic_load(&g_running)) break;

		/* Handle ready/failed on active copy: fire next free pre-armed slot IMMEDIATELY with 0.00ms roundtrip! */
		if (active_slot >= 0 && (fslots[active_slot].ready || fslots[active_slot].failed)) {
			int s = active_slot;
			bool ok = fslots[s].ready;
			uint32_t flags = fslots[s].flags;
			bool was_polish = fslots[s].is_polish;
			int n_dmg = fslots[s].n_damage;
			DamageRect dmg[MAX_DAMAGE_RECTS];
			if (n_dmg > 0) memcpy(dmg, fslots[s].damage, (size_t)n_dmg * sizeof(DamageRect));
			slot_destroy(&wl, &fslots[s]);
			active_slot = -1;

			if (ok) {
				fail_streak = 0;
				uint64_t ready_us = monotonic_us();
				bool y_inv = (flags & 1U) != 0;
				bool want_key = first_frame || (atomic_exchange(&g_force_keyframe, 0) != 0);
				first_frame = false;
				if (!always_frame && !once) {
					if (was_polish) {
						needs_polish = false;
					} else {
						last_motion_us = ready_us;
						needs_polish = true;
					}
				}

				int next_free = -1;
				pthread_mutex_lock(&ep.mu);
				ep.slot_busy[s] = true;
				ep.y_inv[s] = y_inv;
				ep.want_key[s] = want_key;
				ep.is_polish[s] = was_polish;
				ep.n_damage[s] = n_dmg;
				if (n_dmg > 0) memcpy(ep.damage[s], dmg, (size_t)n_dmg * sizeof(DamageRect));
				ep.ready_us[s] = ready_us;
				int tail = (ep.q_head + ep.q_count) % CAP_SLOTS;
				ep.queue[tail] = s;
				ep.q_count++;
				for (int off = 1; off < n_slots; off++) {
					int cand = (s + off) % n_slots;
					if (!ep.slot_busy[cand] && fslots[cand].frame_id && fslots[cand].buf_done && !fslots[cand].copy_sent && !fslots[cand].failed) {
						next_free = cand;
						break;
					}
				}
				pthread_cond_signal(&ep.cv);
				pthread_mutex_unlock(&ep.mu);

				if (once) break;

				bool pacing_ok = (last_fire_us == 0) || ((ready_us - last_fire_us) >= (interval_us * 3ULL) / 4ULL);
				if (next_free >= 0 && pacing_ok) {
					uint32_t ng = atomic_load(&g_reconfig_gen);
					bool n_reconfig = (ng != seen_reconfig_gen);
					bool next_ign = (atomic_load(&g_force_keyframe) != 0) || n_reconfig || always_frame;
					fslots[next_free].is_polish = false;
					if (slot_send_copy(&wl, gbm, shm_id, dmabuf_id, allow_dmabuf, &fslots[next_free], next_ign)) {
						active_slot = next_free;
						last_fire_us = ready_us;
						if (n_reconfig) seen_reconfig_gen = ng;
					}
				}
				slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[s], &caps[s]);
				next_slot = (s + 1) % n_slots;
			} else {
				fail_streak++;
				if (fail_streak >= 12) {
					send_json_msg(3, "{\"error\":\"Target window or monitor closed\"}");
					break;
				}
				usleep(80000);
				slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[s], &caps[s]);
				next_slot = (s + 1) % n_slots;
			}
			continue;
		}

		/* Check for failures or stalls on armed/waiting slots */
		uint64_t now_us = monotonic_us();
		for (int i = 0; i < n_slots; i++) {
			if (i == active_slot) continue;
			if (fslots[i].frame_id && (fslots[i].failed || (!fslots[i].buf_done && (now_us - fslots[i].armed_us) > 2500000ULL))) {
				slot_destroy(&wl, &fslots[i]);
				fail_streak++;
				if (fail_streak >= 12) {
					send_json_msg(3, "{\"error\":\"Target window or monitor closed\"}");
					atomic_store(&g_running, 0);
					break;
				}
				usleep(80000);
				slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[i], &caps[i]);
			}
		}
		if (active_slot >= 0) {
			FrameSlot *as = &fslots[active_slot];
			uint64_t waited = now_us - as->copy_sent_us;
			if (as->copy_ign && waited > 2500000ULL) {
				/* A full copy (keyframe, reconfig) that hasn't arrived means the screen hasn't been redrawn:
				 * Hyprland renders only when something changes, so on a still desktop or an idle window this
				 * is not a failure. Counting it as one ended the stream after 12 keyframe requests on a still
				 * screen ("Target window or monitor closed") and the viewer reconnected over and over. Only
				 * the compositor's own failed event counts; this copy is simply asked for again. */
				int s = active_slot;
				slot_destroy(&wl, as);
				active_slot = -1;
				usleep(80000);
				slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[s], &caps[s]);
				next_slot = (s + 1) % n_slots;
			} else if (!as->copy_ign && waited > 10000000ULL) {
				/* Idle window with no damage for 10s - recycle frame quietly without burning GPU */
				int s = active_slot;
				slot_destroy(&wl, as);
				active_slot = -1;
				slot_arm(&wl, mgr_id, window_mode, mgr_ver, handle_u32, output_id, &fslots[s], &caps[s]);
				next_slot = (s + 1) % n_slots;
			}
		}
	}

	for (int i = 0; i < CAP_SLOTS; i++) slot_destroy(&wl, &fslots[i]);

	/* Cleanly drain & join encoder thread before releasing GBM/Wayland buffers */
	pthread_mutex_lock(&ep.mu);
	ep.stop = true;
	pthread_cond_broadcast(&ep.cv);
	pthread_mutex_unlock(&ep.mu);
	pthread_join(enc_tid, NULL);

	if (wl.last_error[0]) {
		char err_json[320];
		char clean[240];
		size_t j = 0;
		for (size_t i = 0; wl.last_error[i] && j + 1 < sizeof(clean); i++) {
			char c = wl.last_error[i];
			clean[j++] = (c == '"' || c == '\\' || (unsigned char)c < 0x20) ? ' ' : c;
		}
		clean[j] = '\0';
		snprintf(err_json, sizeof(err_json), "{\"error\":\"%s\"}", clean);
		send_json_msg(3, err_json);
	}
	for (int i = 0; i < CAP_SLOTS; i++) capbuf_destroy(&wl, &caps[i]);
	if (gbm) gbm_device_destroy(gbm);
	if (drm_fd >= 0) close(drm_fd);
	if (g_wake_fd >= 0) {
		close(g_wake_fd);
		g_wake_fd = -1;
	}
	close(wl.fd);
	return 0;
}
