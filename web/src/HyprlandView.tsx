// Direct Hyprland GPU WebCodecs renderer (H.264/HEVC/HEVC-4:4:4 Annex-B over WebSocket -> hardware VideoDecoder -> WebGL2 Catmull-Rom + CAS Canvas).
// Renders either the full Hyprland desktop monitor OR an individual native Hyprland Linux window.
import {useEffect, useMemo, useRef, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {mutate, query} from './api'
import {
	applyMetaToProfiledStreamState,
	applyReconfigAppliedToProfiledStreamState,
	applyReconfigUnsupportedToProfiledStreamState,
	classifyNetworkQuality,
	computeAudioJitterBudget,
	computeVideoDropPolicy,
	createRttStats,
	updateRttStats,
} from './hyprlandStreamState.mjs'
import {bindConsoleWheel} from './consoleHelpers'
import {Icon} from './icons'
import {getRailDeviceId, StreamProfilerSheet, type StreamCodec, type StreamProfile, type StreamProfilesResponse} from './screens/StreamProfiler'

export type HyprlandWindow = {
	address: string
	title: string
	class: string
	workspace: number
	at: [number, number]
	size: [number, number]
	floating: boolean
	fullscreen: boolean
	pid: number
}

export type HyprlandApp = {
	id: string
	name: string
	comment: string
	categories: string[]
	terminal: boolean
	wmClass: string
	hasIcon: boolean
}

export type HyprlandStatus = {
	available: boolean
	wayland: string | null
	vaapi: boolean
	nativeEngine?: boolean
	railReady?: boolean
	sessionLocked?: boolean
	encoder: string | null
	monitors: {id: number; name: string; width: number; height: number; refreshRate: number; activeWorkspace: number; dpmsStatus?: boolean}[]
	activeStreams: number
}

export function supportsWebCodecs(): boolean {
	return typeof window !== 'undefined' && typeof (window as unknown as {VideoDecoder?: unknown}).VideoDecoder === 'function' && typeof (window as unknown as {EncodedVideoChunk?: unknown}).EncodedVideoChunk === 'function'
}

// Browser KeyboardEvent.code -> Linux evdev keycodes (matching US_XKB_KEYMAP in hypr-rail-capture.c / hypr-stream.py)
const EVDEV_CODE: Record<string, number> = {
	Escape: 1,
	Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
	Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
	KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
	BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
	KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
	Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
	KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
	Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, AltLeft: 56, Space: 57, CapsLock: 58,
	F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
	ControlRight: 97, AltRight: 100,
	Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
	MetaLeft: 125, MetaRight: 126, OSLeft: 125, OSRight: 126,
}

function modsMask(e: KeyboardEvent | React.KeyboardEvent): number {
	return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 4 : 0) | (e.altKey ? 8 : 0) | (e.metaKey ? 64 : 0)
}

function mouseButtonEvdev(button: number): number {
	if (button === 2) return 273 // BTN_RIGHT
	if (button === 1) return 274 // BTN_MIDDLE
	return 272 // BTN_LEFT
}

const ALLOWED_CURSORS = new Set([
	'default',
	'pointer',
	'text',
	'grab',
	'grabbing',
	'ew-resize',
	'ns-resize',
	'nwse-resize',
	'nesw-resize',
	'col-resize',
	'row-resize',
	'crosshair',
	'not-allowed',
	'wait',
	'move',
	'zoom-in',
	'zoom-out',
])

// Compute the displayed video rectangle inside a CSS box (accounting for letterbox bars in full-screen fit mode).
export function computeDisplayedVideoRect(
	box: {left: number; top: number; width: number; height: number},
	codedW: number,
	codedH: number,
	contain: boolean,
): {left: number; top: number; width: number; height: number} {
	if (!contain || codedW <= 0 || codedH <= 0 || box.width <= 0 || box.height <= 0) return box
	const scale = Math.min(box.width / codedW, box.height / codedH)
	const width = codedW * scale
	const height = codedH * scale
	return {
		left: box.left + (box.width - width) / 2,
		top: box.top + (box.height - height) / 2,
		width,
		height,
	}
}

// Parse SPS NAL (type 7) from Annex-B bytes to derive exact avc1.PPCCLL codec string for WebCodecs.
function parseAvcCodecFromAnnexB(data: Uint8Array): string {
	for (let i = 0; i < data.length - 7; i++) {
		let start = -1
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) start = i + 3
		else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) start = i + 4
		if (start !== -1 && (data[start] & 0x1f) === 7 && start + 3 < data.length) {
			const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase()
			return `avc1.${hex(data[start + 1])}${hex(data[start + 2])}${hex(data[start + 3])}`
		}
	}
	return 'avc1.42E028'
}

// Parse HEVC SPS NAL (type 33) from Annex-B bytes to derive exact RFC 6381 hev1.<profile>.<compat>.<tier><level>.<constraints> string
// so 4:4:4 RExt (hev1.4.10.L153.BE.8), Main 10, and Main configure WebCodecs accurately at any resolution/level.
export function parseHevcCodecFromAnnexB(data: Uint8Array, fallback: string): string {
	for (let i = 0; i < data.length - 4; i++) {
		let start = -1
		if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) start = i + 3
		else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) start = i + 4
		if (start === -1 || start + 2 >= data.length) continue
		const nalType = (data[start] >> 1) & 0x3f
		if (nalType !== 33) continue
		// Bound RBSP extraction strictly to this NAL unit (stop at the next Annex-B start code).
		let nalEnd = data.length
		for (let j = start + 2; j < data.length - 2; j++) {
			if (data[j] === 0 && data[j + 1] === 0 && (data[j + 2] === 1 || (j + 3 < data.length && data[j + 2] === 0 && data[j + 3] === 1))) {
				nalEnd = j
				break
			}
		}
		// Extract first 14 RBSP bytes after 2-byte NAL header, stripping emulation prevention (0x00 0x00 0x03).
		const rbsp: number[] = []
		for (let p = start + 2; p < nalEnd && rbsp.length < 14; p++) {
			if (p >= start + 4 && data[p] === 3 && data[p - 1] === 0 && data[p - 2] === 0) continue
			rbsp.push(data[p])
		}
		if (rbsp.length < 13) return fallback
		const ptl0 = rbsp[1]
		const profileSpace = (ptl0 >> 6) & 3
		const tierFlag = (ptl0 >> 5) & 1
		const profileIdc = ptl0 & 0x1f
		const compat = (((rbsp[2] << 24) | (rbsp[3] << 16) | (rbsp[4] << 8) | rbsp[5]) >>> 0)
		let compatRev = 0
		for (let b = 0; b < 32; b++) {
			if ((compat >>> b) & 1) compatRev = (compatRev | (1 << (31 - b))) >>> 0
		}
		const levelIdc = rbsp[12]
		const constraints = rbsp.slice(6, 12)
		let lastNz = constraints.length - 1
		while (lastNz > 0 && constraints[lastNz] === 0) lastNz--
		const cStr = constraints
			.slice(0, lastNz + 1)
			.map((v) => v.toString(16).toUpperCase())
			.join('.')
		const spacePrefix = profileSpace === 1 ? 'A' : profileSpace === 2 ? 'B' : profileSpace === 3 ? 'C' : ''
		return `hev1.${spacePrefix}${profileIdc}.${compatRev.toString(16).toUpperCase()}.${tierFlag ? 'H' : 'L'}${levelIdc}.${cStr}`
	}
	return fallback
}

// Zero-copy WebGL2 VideoFrame texture blitter with adaptive 5-tap Catmull-Rom bicubic scaling (when scaled) +
// single-pass AMD FidelityFX CAS 5-tap sharpening and 1:1 physical pixel HiDPI sizing (applied inside draw() so idle screens never flash black).
type FrameDrawResult = 'ok' | 'need-2d' | 'fail'
type DrawOpts = {backingW: number; backingH: number; contain: boolean; sharpness: number}
type FrameBlitter = {draw: (frame: VideoFrame, opts: DrawOpts) => FrameDrawResult; destroy: () => void}

const CAS_BICUBIC_FRAG_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uTexSize;
uniform float uSharpness;
uniform float uBicubic;
in vec2 vUv;
out vec4 outColor;

vec3 sampleCatmullRom5(vec2 uv) {
	vec2 pos = uv * uTexSize;
	vec2 center = floor(pos - 0.5) + 0.5;
	vec2 f = pos - center;
	vec2 f2 = f * f;
	vec2 f3 = f2 * f;
	vec2 w0 = f2 - 0.5 * (f3 + f);
	vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
	vec2 w3 = 0.5 * (f3 - f2);
	vec2 w2 = 1.0 - w0 - w1 - w3;
	vec2 w12 = w1 + w2;
	vec2 tc0 = (center - 1.0) * uTexel;
	vec2 tc12 = (center + w2 / max(w12, vec2(1e-5))) * uTexel;
	vec2 tc3 = (center + 2.0) * uTexel;
	vec3 result = vec3(0.0);
	float wt = 0.0;
	float a = w12.x * w0.y;
	result += texture(uTex, vec2(tc12.x, tc0.y)).rgb * a; wt += a;
	float b = w0.x * w12.y;
	result += texture(uTex, vec2(tc0.x, tc12.y)).rgb * b; wt += b;
	float c = w12.x * w12.y;
	result += texture(uTex, vec2(tc12.x, tc12.y)).rgb * c; wt += c;
	float d = w3.x * w12.y;
	result += texture(uTex, vec2(tc3.x, tc12.y)).rgb * d; wt += d;
	float e = w12.x * w3.y;
	result += texture(uTex, vec2(tc12.x, tc3.y)).rgb * e; wt += e;
	return clamp(result / max(wt, 1e-5), 0.0, 1.0);
}

void main() {
	vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
	vec3 e = uBicubic > 0.5 ? sampleCatmullRom5(uv) : texture(uTex, uv).rgb;
	if (uSharpness <= 0.001) {
		outColor = vec4(e, 1.0);
		return;
	}
	vec3 b = texture(uTex, uv + vec2(0.0, -uTexel.y)).rgb;
	vec3 d = texture(uTex, uv + vec2(-uTexel.x, 0.0)).rgb;
	vec3 f = texture(uTex, uv + vec2(uTexel.x, 0.0)).rgb;
	vec3 h = texture(uTex, uv + vec2(0.0, uTexel.y)).rgb;
	vec3 mn = min(min(min(d, e), min(f, b)), h);
	vec3 mx = max(max(max(d, e), max(f, b)), h);
	vec3 rcpM = 1.0 / max(mx, vec3(1e-5));
	vec3 amp = clamp(min(mn, 1.0 - mx) * rcpM, 0.0, 1.0);
	amp = sqrt(amp);
	float peak = -1.0 / mix(8.0, 5.0, clamp(uSharpness, 0.0, 1.0));
	vec3 w = amp * peak;
	vec3 rcpW = 1.0 / (1.0 + 4.0 * w);
	vec3 sharpened = clamp(((b + d + f + h) * w + e) * rcpW, 0.0, 1.0);
	outColor = vec4(sharpened, 1.0);
}`

function createFrameBlitter(canvas: HTMLCanvasElement, force2d = false): FrameBlitter {
	// Standard compositor-synced WebGL2 with preserveDrawingBuffer:true so variable-rate frames (0 FPS idle <-> 60 FPS motion)
	// can NEVER expose an uncleared or stale Metal IOSurface swapchain drawable on macOS.
	let gl = force2d
		? null
		: canvas.getContext('webgl2', {alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance'})
	let prog: WebGLProgram | null = null
	let tex: WebGLTexture | null = null
	let vao: WebGLVertexArrayObject | null = null
	let uTexelLoc: WebGLUniformLocation | null = null
	let uTexSizeLoc: WebGLUniformLocation | null = null
	let uSharpLoc: WebGLUniformLocation | null = null
	let uBicubicLoc: WebGLUniformLocation | null = null
	let texW = 0
	let texH = 0
	let maxTex = 4096
	let lastVpKey = ''
	let glFailed = false
	if (gl) {
		try {
			if ('drawingBufferColorSpace' in gl) {
				;(gl as WebGL2RenderingContext & {drawingBufferColorSpace?: string}).drawingBufferColorSpace = 'srgb'
			}
			const lim = gl.getParameter(gl.MAX_TEXTURE_SIZE)
			if (typeof lim === 'number' && lim >= 2048) maxTex = Math.min(8192, lim)
		} catch {}
		const vs = gl.createShader(gl.VERTEX_SHADER)
		const fs = gl.createShader(gl.FRAGMENT_SHADER)
		if (vs && fs) {
			gl.shaderSource(vs, `#version 300 es\nconst vec2 p[4]=vec2[4](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(1,1));\nout vec2 vUv;\nvoid main(){vUv=p[gl_VertexID]*0.5+0.5;gl_Position=vec4(p[gl_VertexID],0,1);}`)
			gl.compileShader(vs)
			gl.shaderSource(fs, CAS_BICUBIC_FRAG_SHADER)
			gl.compileShader(fs)
			prog = gl.createProgram()
			if (prog) {
				gl.attachShader(prog, vs)
				gl.attachShader(prog, fs)
				gl.linkProgram(prog)
			}
			gl.deleteShader(vs)
			gl.deleteShader(fs)
			if (prog && gl.getProgramParameter(prog, gl.LINK_STATUS)) {
				vao = gl.createVertexArray()
				uTexelLoc = gl.getUniformLocation(prog, 'uTexel')
				uTexSizeLoc = gl.getUniformLocation(prog, 'uTexSize')
				uSharpLoc = gl.getUniformLocation(prog, 'uSharpness')
				uBicubicLoc = gl.getUniformLocation(prog, 'uBicubic')
				if (vao) {
					gl.bindVertexArray(vao)
					gl.useProgram(prog)
					gl.clearColor(0, 0, 0, 1)
				} else {
					glFailed = true
				}
			} else {
				if (prog) gl.deleteProgram(prog)
				prog = null
				glFailed = true
			}
		} else {
			if (vs) gl.deleteShader(vs)
			if (fs) gl.deleteShader(fs)
			glFailed = true
		}
		if (glFailed) {
			gl = null
		}
	}
	// A canvas that already bound WebGL2 cannot switch to 2D in-place (HTML spec returns null); signal caller to remount a fresh 2D canvas.
	let ctx2d: CanvasRenderingContext2D | null = force2d || (!gl && !glFailed) ? canvas.getContext('2d', {alpha: false}) : null
	return {
		draw(frame: VideoFrame, opts: DrawOpts): FrameDrawResult {
			const w = frame.displayWidth || frame.codedWidth
			const h = frame.displayHeight || frame.codedHeight
			if (!w || !h) return 'fail'
			if (glFailed) return 'need-2d'
			if (gl && prog) {
				if (gl.isContextLost()) {
					gl = null
					prog = null
					tex = null
					vao = null
					glFailed = true
					return 'need-2d'
				}
				const ctx = gl
				try {
					// 1:1 physical pixel backing store when ResizeObserver reported device pixels, else video resolution.
					const targetW = Math.max(2, Math.min(maxTex, opts.backingW > 0 ? opts.backingW : w))
					const targetH = Math.max(2, Math.min(maxTex, opts.backingH > 0 ? opts.backingH : h))
					let resized = false
					if (canvas.width !== targetW || canvas.height !== targetH) {
						canvas.width = targetW
						canvas.height = targetH
						resized = true
					}
					// Immutable texStorage2D allocated once per video resolution; hot path uses texSubImage2D.
					if (!tex || texW !== w || texH !== h) {
						if (tex) ctx.deleteTexture(tex)
						tex = ctx.createTexture()
						if (!tex) {
							glFailed = true
							return 'need-2d'
						}
						ctx.bindTexture(ctx.TEXTURE_2D, tex)
						ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE)
						ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE)
						ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR)
						ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR)
						ctx.texStorage2D(ctx.TEXTURE_2D, 1, ctx.RGBA8, w, h)
						texW = w
						texH = h
						if (uTexelLoc) ctx.uniform2f(uTexelLoc, 1 / w, 1 / h)
						if (uTexSizeLoc) ctx.uniform2f(uTexSizeLoc, w, h)
					}
					let vx = 0
					let vy = 0
					let vw = targetW
					let vh = targetH
					if (opts.contain) {
						const scale = Math.min(targetW / w, targetH / h)
						vw = Math.max(1, Math.round(w * scale))
						vh = Math.max(1, Math.round(h * scale))
						vx = Math.floor((targetW - vw) / 2)
						vy = Math.floor((targetH - vh) / 2)
					}
					const vpKey = `${vx},${vy},${vw},${vh},${targetW},${targetH}`
					if (resized || vpKey !== lastVpKey) {
						lastVpKey = vpKey
						if (vx > 0 || vy > 0 || vw !== targetW || vh !== targetH) {
							ctx.viewport(0, 0, targetW, targetH)
							ctx.clear(ctx.COLOR_BUFFER_BIT)
						}
						ctx.viewport(vx, vy, vw, vh)
					}
					if (uSharpLoc) ctx.uniform1f(uSharpLoc, opts.sharpness)
					if (uBicubicLoc) ctx.uniform1f(uBicubicLoc, Math.abs(vw - w) > 1 || Math.abs(vh - h) > 1 ? 1 : 0)
					ctx.texSubImage2D(ctx.TEXTURE_2D, 0, 0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, frame)
					ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4)
					if (ctx.isContextLost()) {
						gl = null
						prog = null
						tex = null
						vao = null
						glFailed = true
						return 'need-2d'
					}
					return 'ok'
				} catch {
					try {
						if (tex) ctx.deleteTexture(tex)
						if (vao) ctx.deleteVertexArray(vao)
						if (prog) ctx.deleteProgram(prog)
					} catch {}
					gl = null
					prog = null
					tex = null
					vao = null
					glFailed = true
					return 'need-2d'
				}
			}
			if (!ctx2d) ctx2d = canvas.getContext('2d', {alpha: false})
			if (!ctx2d) return 'fail'
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w
				canvas.height = h
			}
			ctx2d.drawImage(frame, 0, 0, canvas.width, canvas.height)
			return 'ok'
		},
		destroy() {
			if (gl) {
				try {
					if (tex) gl.deleteTexture(tex)
					if (vao) gl.deleteVertexArray(vao)
					if (prog) gl.deleteProgram(prog)
				} catch {}
			}
		},
	}
}

const CODEC_PREF_KEY = 'omarchy-server:hypr-codec:v2'
const QUALITY_TIER_KEY = 'omarchy-server:hypr-quality-tier:v1'
const CHROMA_444_KEY = 'omarchy-server:hypr-chroma-444:v1'
const SHARPNESS_KEY = 'omarchy-server:hypr-sharpness:v1'

export type StreamQualityTier = 'balanced' | 'high' | 'ultra'
export type SharpnessPreset = 'off' | 'crisp' | 'max'

const QUALITY_TIERS: Record<StreamQualityTier, {label: string; bitrate: number; quality: number}> = {
	balanced: {label: 'Balanced (20 Mbps)', bitrate: 20000, quality: 20},
	high: {label: 'High (45 Mbps)', bitrate: 45000, quality: 16},
	ultra: {label: 'Ultra LAN (100 Mbps)', bitrate: 100000, quality: 12},
}

const SHARPNESS_PRESETS: Record<SharpnessPreset, {label: string; value: number; next: SharpnessPreset}> = {
	crisp: {label: 'Sharp: Crisp', value: 0.35, next: 'max'},
	max: {label: 'Sharp: Max', value: 0.72, next: 'off'},
	off: {label: 'Sharp: Off', value: 0, next: 'crisp'},
}

function readQualityTierOverride(): StreamQualityTier | null {
	try {
		const v = localStorage.getItem(QUALITY_TIER_KEY)
		if (v === 'balanced' || v === 'high' || v === 'ultra') return v
	} catch {}
	return null
}

function readChroma444Override(): boolean | null {
	try {
		const v = localStorage.getItem(CHROMA_444_KEY)
		if (v === '1') return true
		if (v === '0') return false
	} catch {}
	return null
}

export function resolveEffectiveStreamConfig({
	profile,
	caps,
	tierOverride,
	chromaOverride,
	codecFallback,
	defaultBitrate,
	defaultFps,
}: {
	profile: StreamProfile | null
	caps: {baseCodec: StreamCodec; supports444: boolean; supportsOpus: boolean}
	tierOverride: StreamQualityTier | null
	chromaOverride: boolean | null
	codecFallback: StreamCodec | null
	defaultBitrate: number
	defaultFps: number
}): {codec: StreamCodec; bitrate: number; quality: number; fps: number; compression: number; chroma444: boolean; selectorValue: 'profile' | StreamQualityTier} {
	const effectiveTier = tierOverride ?? (profile ? null : 'balanced')
	const tier = effectiveTier ? QUALITY_TIERS[effectiveTier] : null
	const effectiveBitrate = tier ? tier.bitrate : profile?.bitrate || QUALITY_TIERS.balanced.bitrate || defaultBitrate
	const effectiveQuality = tier ? tier.quality : profile?.quality || QUALITY_TIERS.balanced.quality || 0
	const effectiveFps = profile?.fps || defaultFps
	const effectiveCompression = profile?.compression || 0
	const non444Base: StreamCodec = profile && profile.codec !== 'hevc444' ? profile.codec : caps.baseCodec
	const want444 = codecFallback ? false : chromaOverride !== null ? chromaOverride : profile?.codec === 'hevc444'
	const effective444 = want444 && caps.supports444
	const effectiveCodec: StreamCodec = codecFallback ?? (effective444 ? 'hevc444' : non444Base)
	return {
		codec: effectiveCodec,
		bitrate: effectiveBitrate,
		quality: effectiveQuality,
		fps: effectiveFps,
		compression: effectiveCompression,
		chroma444: effectiveCodec === 'hevc444',
		selectorValue: tierOverride ?? (profile ? 'profile' : 'balanced'),
	}
}

function readSharpnessPreset(fallback: number): SharpnessPreset {
	try {
		const v = localStorage.getItem(SHARPNESS_KEY)
		if (v === 'off' || v === 'crisp' || v === 'max') return v
	} catch {}
	if (fallback <= 0.01) return 'off'
	if (fallback >= 0.55) return 'max'
	return 'crisp'
}

type WebAudioDataLike = {
	numberOfFrames: number
	numberOfChannels: number
	sampleRate: number
	format?: string
	copyTo: (dest: Float32Array, opts: {planeIndex: number; format?: string}) => void
	close: () => void
}
type WebAudioDecoderLike = {
	state: string
	configure: (cfg: {codec: string; sampleRate: number; numberOfChannels: number}) => void
	decode: (chunk: unknown) => void
	close: () => void
}
type WebAudioDecoderCtor = {
	new (init: {output: (data: WebAudioDataLike) => void; error: (err: DOMException) => void}): WebAudioDecoderLike
	isConfigSupported?: (cfg: {codec: string; sampleRate: number; numberOfChannels: number}) => Promise<{supported?: boolean}>
}

async function probeCapabilities(): Promise<{baseCodec: StreamCodec; supports444: boolean; supportsOpus: boolean}> {
	let baseCodec: StreamCodec = 'h264'
	let cachedBase: StreamCodec | null = null
	try {
		const cached = sessionStorage.getItem(CODEC_PREF_KEY)
		if (cached === 'hevc10' || cached === 'hevc' || cached === 'h264') cachedBase = cached
	} catch {}

	if (cachedBase) {
		baseCodec = cachedBase
	} else if (typeof VideoDecoder?.isConfigSupported === 'function') {
		for (const [id, codec] of [
			['hevc', 'hev1.1.6.L153.B0'],
			['hevc10', 'hev1.2.4.L153.B0'],
		] as const) {
			try {
				const res = await VideoDecoder.isConfigSupported({
					codec,
					codedWidth: 1920,
					codedHeight: 1080,
					hardwareAcceleration: 'prefer-hardware',
					optimizeForLatency: true,
				})
				if (res?.supported) {
					baseCodec = id
					break
				}
			} catch {}
		}
	}

	let supports444 = false
	if (typeof VideoDecoder?.isConfigSupported === 'function') {
		try {
			const r444 = await VideoDecoder.isConfigSupported({
				codec: 'hev1.4.10.L153.BE.8',
				codedWidth: 1920,
				codedHeight: 1080,
				hardwareAcceleration: 'prefer-hardware',
				optimizeForLatency: true,
			})
			supports444 = !!r444?.supported
		} catch {}
	}

	let supportsOpus = false
	try {
		const win = window as unknown as {AudioDecoder?: WebAudioDecoderCtor; EncodedAudioChunk?: unknown}
		if (typeof win.AudioDecoder?.isConfigSupported === 'function' && typeof win.EncodedAudioChunk === 'function') {
			const ro = await win.AudioDecoder.isConfigSupported({codec: 'opus', sampleRate: 48000, numberOfChannels: 2})
			supportsOpus = !!ro?.supported
		}
	} catch {}

	return {baseCodec, supports444, supportsOpus}
}

function nextFallbackCodec(cur: StreamCodec): 'hevc' | 'h264' | null {
	if (cur === 'hevc444' || cur === 'hevc10') return 'hevc'
	if (cur === 'hevc') return 'h264'
	return null
}

export function HyprlandView({
	mode = 'output',
	address = '',
	output = '',
	fps = 60,
	bitrate = 20000,
	sharpness = 0.35,
	chrome = 'full',
	muted: controlledMuted,
	onToggleMute,
	windows = [],
	onSelectTarget,
	onResize,
	onFallbackVnc,
	onClose,
	title,
}: {
	mode?: 'output' | 'window'
	address?: string
	output?: string
	fps?: number
	bitrate?: number
	sharpness?: number
	chrome?: 'full' | 'rail'
	muted?: boolean
	onToggleMute?: () => void
	windows?: HyprlandWindow[]
	onSelectTarget?: (next: {mode: 'output' | 'window'; address: string; title: string}) => void
	onResize?: (width: number, height: number) => void
	onFallbackVnc?: () => void
	onClose?: () => void
	title?: string
}) {
	const [localMuted, setLocalMuted] = useState(false)
	const muted = controlledMuted ?? localMuted
	const toggleMute = onToggleMute ?? (() => setLocalMuted((m) => !m))
	const mutedRef = useRef(muted)
	mutedRef.current = muted
	const [sharpnessPreset, setSharpnessPresetState] = useState<SharpnessPreset>(() => readSharpnessPreset(sharpness))
	const sharpnessRef = useRef(SHARPNESS_PRESETS[sharpnessPreset].value)
	sharpnessRef.current = chrome === 'full' ? SHARPNESS_PRESETS[sharpnessPreset].value : sharpness
	const containRef = useRef(chrome === 'full')
	containRef.current = chrome === 'full'

	const audioCtxRef = useRef<AudioContext | null>(null)
	const audioGainRef = useRef<GainNode | null>(null)
	const nextAudioTimeRef = useRef(0)
	const rttStatsRef = useRef<{rttMs: number | null; jitterMs: number; samples: number}>(createRttStats())
	const audioResyncsRef = useRef(0)
	const hostRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const fpsSpanRef = useRef<HTMLSpanElement>(null)
	const statsOverlayRef = useRef<HTMLDivElement>(null)
	const [canvasMode, setCanvasMode] = useState<'webgl2' | '2d'>('webgl2')
	const canvasModeRef = useRef<'webgl2' | '2d'>('webgl2')
	canvasModeRef.current = canvasMode

	const codedSizeRef = useRef<{w: number; h: number}>({w: 0, h: 0})
	const targetBackingRef = useRef<{w: number; h: number}>({w: 0, h: 0})
	const canvasRectRef = useRef<{left: number; top: number; width: number; height: number} | null>(null)

	// Reusable pre-allocated binary input buffers (zero GC allocation per mouse move / click / scroll / keypress)
	const moveBufRef = useRef<Uint8Array>(new Uint8Array(5))
	const btnBufRef = useRef<Uint8Array>(new Uint8Array(7))
	const scrollBufRef = useRef<Uint8Array>(new Uint8Array(9))
	const scrollViewRef = useRef<DataView>(new DataView(scrollBufRef.current.buffer))
	const keyBufRef = useRef<Uint8Array>(new Uint8Array(4))

	const lastPtrSendRef = useRef(0)
	const lastSentXYRef = useRef<{ux: number; uy: number}>({ux: -1, uy: -1})
	const pendingPtrRef = useRef<{ux: number; uy: number} | null>(null)
	const ptrTimerRef = useRef<number | null>(null)
	const wsRef = useRef<WebSocket | null>(null)
	const deviceId = useMemo(() => getRailDeviceId(), [])
	const [caps, setCaps] = useState<{baseCodec: StreamCodec; supports444: boolean; supportsOpus: boolean} | null>(null)
	const [codecFallback, setCodecFallback] = useState<StreamCodec | null>(null)
	const codecFallbackRef = useRef<StreamCodec | null>(codecFallback)
	codecFallbackRef.current = codecFallback
	const [reconnectNonce, setReconnectNonce] = useState(0)
	const [tierOverride, setTierOverrideState] = useState<StreamQualityTier | null>(readQualityTierOverride)
	const [chromaOverride, setChromaOverrideState] = useState<boolean | null>(readChroma444Override)
	const [confirmedCodec, setConfirmedCodec] = useState<StreamCodec | null>(null)
	const [showStats, setShowStats] = useState(false)
	const [showProfiler, setShowProfiler] = useState(false)
	const showStatsRef = useRef(false)
	showStatsRef.current = showStats
	const tierOverrideRef = useRef<StreamQualityTier | null>(tierOverride)
	tierOverrideRef.current = tierOverride
	const chromaOverrideRef = useRef<boolean | null>(chromaOverride)
	chromaOverrideRef.current = chromaOverride
	const activeCodecRef = useRef<StreamCodec>('h264')
	const [attempt, setAttempt] = useState(0)

	const sendLiveReconfig = (nextTier: StreamQualityTier | null, nextChroma: boolean | null, nextFallback: StreamCodec | null = codecFallbackRef.current) => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN || !caps) return
		const cfg = resolveEffectiveStreamConfig({
			profile: activeProfileRef.current,
			caps,
			tierOverride: nextTier,
			chromaOverride: nextChroma,
			codecFallback: nextFallback,
			defaultBitrate: bitrate,
			defaultFps: fps,
		})
		activeCodecRef.current = cfg.codec
		ws.send(
			JSON.stringify({
				type: 'reconfig',
				bitrate: cfg.bitrate,
				quality: cfg.quality,
				codec: cfg.codec,
			}),
		)
	}

	const setQualityChoice = (choice: 'profile' | StreamQualityTier) => {
		const nextTier: StreamQualityTier | null = choice === 'profile' ? null : choice
		setTierOverrideState(nextTier)
		tierOverrideRef.current = nextTier
		try {
			if (nextTier === null) localStorage.removeItem(QUALITY_TIER_KEY)
			else localStorage.setItem(QUALITY_TIER_KEY, nextTier)
		} catch {}
		sendLiveReconfig(nextTier, chromaOverrideRef.current)
	}

	const toggleChroma444 = () => {
		if (!caps) return
		const cur = resolveEffectiveStreamConfig({
			profile: activeProfileRef.current,
			caps,
			tierOverride: tierOverrideRef.current,
			chromaOverride: chromaOverrideRef.current,
			codecFallback: codecFallbackRef.current,
			defaultBitrate: bitrate,
			defaultFps: fps,
		})
		const curDisplay = confirmedCodec !== null ? confirmedCodec === 'hevc444' : cur.chroma444
		const next = !curDisplay
		setChromaOverrideState(next)
		chromaOverrideRef.current = next
		setConfirmedCodec(null)
		try {
			localStorage.setItem(CHROMA_444_KEY, next ? '1' : '0')
		} catch {}
		// Commit cleared fallback to both state and ref when retrying 4:4:4 so controls and future tier changes stay consistent.
		const nextFallback = next ? null : codecFallbackRef.current
		if (next && codecFallbackRef.current !== null) {
			codecFallbackRef.current = null
			setCodecFallback(null)
		}
		sendLiveReconfig(tierOverrideRef.current, next, nextFallback)
	}

	const cycleSharpness = () => {
		const next = SHARPNESS_PRESETS[sharpnessPreset].next
		setSharpnessPresetState(next)
		sharpnessRef.current = SHARPNESS_PRESETS[next].value
		try {
			localStorage.setItem(SHARPNESS_KEY, next)
		} catch {}
		// Request one immediate frame refresh so static screens show the updated sharpness uniform immediately.
		const ws = wsRef.current
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({type: 'keyframe'}))
		}
	}

	const profilesQ = useQuery({
		queryKey: ['hyprland.profiles'],
		queryFn: () => query<StreamProfilesResponse>('hyprland.profiles'),
		staleTime: 10_000,
		retry: false,
	})

	useEffect(() => {
		let cancelled = false
		probeCapabilities()
			.then((c) => {
				if (!cancelled) setCaps(c)
			})
			.catch(() => {
				if (!cancelled) setCaps({baseCodec: 'h264', supports444: false, supportsOpus: false})
			})
		return () => {
			cancelled = true
		}
	}, [])

	const activeProfile = useMemo(() => {
		const store = profilesQ.data
		const activeId = store?.activeByDevice?.[deviceId] ?? store?.defaultProfileId ?? null
		return activeId ? store?.profiles?.find((p) => p.id === activeId) ?? null : null
	}, [profilesQ.data, deviceId])

	const activeProfileKey = activeProfile
		? `${activeProfile.id}:${activeProfile.codec}:${activeProfile.fps}:${activeProfile.bitrate}:${activeProfile.quality}:${activeProfile.compression}`
		: ''

	useEffect(() => {
		codecFallbackRef.current = null
		setCodecFallback(null)
	}, [activeProfileKey, attempt])

	useEffect(() => {
		const onActivated = () => {
			tierOverrideRef.current = null
			chromaOverrideRef.current = null
			codecFallbackRef.current = null
			setTierOverrideState(null)
			setChromaOverrideState(null)
			setCodecFallback(null)
			try {
				localStorage.removeItem(QUALITY_TIER_KEY)
				localStorage.removeItem(CHROMA_444_KEY)
			} catch {}
		}
		window.addEventListener('omarchy:stream-profile-activated', onActivated)
		return () => window.removeEventListener('omarchy:stream-profile-activated', onActivated)
	}, [])

	const profilesReady = !profilesQ.isPending || !!profilesQ.data
	const activeProfileRef = useRef(activeProfile)
	activeProfileRef.current = activeProfile
	const resolvedConfig = caps
		? resolveEffectiveStreamConfig({
				profile: activeProfile,
				caps,
				tierOverride,
				chromaOverride,
				codecFallback,
				defaultBitrate: bitrate,
				defaultFps: fps,
			})
		: null
	const refreshCanvasRect = () => {
		const el = canvasRef.current
		if (!el) return null
		const r = el.getBoundingClientRect()
		if (r.width > 0 && r.height > 0) {
			const cw = codedSizeRef.current.w || el.width
			const ch = codedSizeRef.current.h || el.height
			canvasRectRef.current = computeDisplayedVideoRect(
				{left: r.left, top: r.top, width: r.width, height: r.height},
				cw,
				ch,
				containRef.current,
			)
		}
		return canvasRectRef.current
	}

	useEffect(() => {
		const onWinChange = () => {
			canvasRectRef.current = null
		}
		window.addEventListener('resize', onWinChange, {passive: true})
		window.addEventListener('scroll', onWinChange, {passive: true, capture: true})
		const vv = window.visualViewport
		vv?.addEventListener('resize', onWinChange)
		vv?.addEventListener('scroll', onWinChange)
		let ro: ResizeObserver | null = null
		const canvasEl = canvasRef.current
		if (typeof ResizeObserver !== 'undefined' && canvasEl) {
			ro = new ResizeObserver((entries) => {
				canvasRectRef.current = null
				const entry = entries[0]
				if (!entry) return
				const dpcb = (entry as ResizeObserverEntry & {devicePixelContentBoxSize?: ReadonlyArray<{inlineSize: number; blockSize: number}>}).devicePixelContentBoxSize?.[0]
				if (dpcb && dpcb.inlineSize > 0 && dpcb.blockSize > 0) {
					targetBackingRef.current = {w: Math.round(dpcb.inlineSize), h: Math.round(dpcb.blockSize)}
				} else if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
					const dpr = Math.min(4, Math.max(1, window.devicePixelRatio || 1))
					targetBackingRef.current = {
						w: Math.round(entry.contentRect.width * dpr),
						h: Math.round(entry.contentRect.height * dpr),
					}
				}
			})
			try {
				ro.observe(canvasEl, {box: 'device-pixel-content-box' as ResizeObserverBoxOptions})
			} catch {
				ro.observe(canvasEl)
			}
		}
		// Handle idle WebGL context loss immediately even when the desktop is static and draw() is not running.
		const onWebglContextLost = (e: Event) => {
			e.preventDefault()
			if (canvasModeRef.current !== '2d') setCanvasMode('2d')
		}
		if (canvasEl && canvasMode === 'webgl2') {
			canvasEl.addEventListener('webglcontextlost', onWebglContextLost)
		}
		// Invalidate cached rect on position-only desktop window moves/drags (style transform/left/top mutations).
		let mo: MutationObserver | null = null
		const winEl = hostRef.current?.closest('.win')
		if (typeof MutationObserver !== 'undefined' && winEl) {
			mo = new MutationObserver(onWinChange)
			mo.observe(winEl, {attributes: true, attributeFilter: ['style', 'class']})
		}
		return () => {
			window.removeEventListener('resize', onWinChange)
			window.removeEventListener('scroll', onWinChange, true)
			vv?.removeEventListener('resize', onWinChange)
			vv?.removeEventListener('scroll', onWinChange)
			if (canvasEl) canvasEl.removeEventListener('webglcontextlost', onWebglContextLost)
			ro?.disconnect()
			mo?.disconnect()
			if (ptrTimerRef.current) {
				window.clearTimeout(ptrTimerRef.current)
				ptrTimerRef.current = null
			}
		}
	}, [canvasMode])

	const ensureAudioCtx = () => {
		if (mutedRef.current) return null
		let ac = audioCtxRef.current
		if (!ac || ac.state === 'closed') {
			const Ctor = window.AudioContext || (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext
			if (!Ctor) return null
			ac = new Ctor({sampleRate: 48000, latencyHint: 'interactive'})
			const gain = ac.createGain()
			gain.gain.value = mutedRef.current ? 0 : 1
			gain.connect(ac.destination)
			audioCtxRef.current = ac
			audioGainRef.current = gain
			nextAudioTimeRef.current = 0
		}
		if (audioGainRef.current) audioGainRef.current.gain.value = mutedRef.current ? 0 : 1
		if (ac.state === 'suspended') {
			ac.resume().catch(() => {})
		}
		return ac
	}

	const playPcmFrame = (pcmBytes: Uint8Array) => {
		if (mutedRef.current || pcmBytes.byteLength < 4) return
		const ac = audioCtxRef.current
		const gain = audioGainRef.current
		if (!ac || !gain || ac.state !== 'running') return
		const samples = Math.floor(pcmBytes.byteLength / 4)
		if (samples <= 0) return
		const ab = ac.createBuffer(2, samples, 48000)
		const ch0 = ab.getChannelData(0)
		const ch1 = ab.getChannelData(1)
		const dv = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, samples * 4)
		for (let i = 0; i < samples; i++) {
			ch0[i] = dv.getInt16(i * 4, true) / 32768
			ch1[i] = dv.getInt16(i * 4 + 2, true) / 32768
		}
		const src = ac.createBufferSource()
		src.buffer = ab
		src.connect(gain)
		const now = ac.currentTime
		// Adaptive jitter cushion: 35 ms on LAN, expanding smoothly on WAN/relayed links to prevent audio skips
		const {targetSec, minLeadSec, maxLeadSec} = computeAudioJitterBudget({...rttStatsRef.current, mode: 'pcm'})
		if (nextAudioTimeRef.current < now + minLeadSec || nextAudioTimeRef.current > now + maxLeadSec) {
			// Count only genuine recent underruns, not normal resumes after >200 ms silence gating
			if (nextAudioTimeRef.current > now - 0.2 && nextAudioTimeRef.current < now + minLeadSec) audioResyncsRef.current++
			nextAudioTimeRef.current = now + targetSec
		}
		src.start(nextAudioTimeRef.current)
		nextAudioTimeRef.current += ab.duration
	}

	// Push live mute/unmute to backend without reconnecting video stream; zero gain immediately so queued audio stops on handoff
	useEffect(() => {
		if (audioGainRef.current) audioGainRef.current.gain.value = muted ? 0 : 1
		const ws = wsRef.current
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({type: 'audio', enabled: !muted}))
		}
		if (muted) {
			nextAudioTimeRef.current = 0
		} else {
			ensureAudioCtx()
		}
	}, [muted])

	// When WebGL2 loses context and falls back to a fresh 2D canvas, request one immediate keyframe so the replacement canvas paints right away
	useEffect(() => {
		if (canvasMode === '2d' && wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({type: 'keyframe'}))
		}
	}, [canvasMode])

	useEffect(() => {
		return () => {
			try {
				audioCtxRef.current?.close()
			} catch {}
			audioCtxRef.current = null
			audioGainRef.current = null
		}
	}, [])

	const heldKeys = useRef<Set<number>>(new Set())
	const heldButtons = useRef<Set<number>>(new Set())
	const lastKeyframeReq = useRef(0)
	const onResizeRef = useRef(onResize)
	onResizeRef.current = onResize
	const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
	const statusRef = useRef<'connecting' | 'live' | 'error'>('connecting')
	const setStatusTracked = (next: 'connecting' | 'live' | 'error') => {
		if (statusRef.current === next) return
		statusRef.current = next
		setStatus(next)
	}
	const [error, setError] = useState<string | null>(null)
	const [sessionLocked, setSessionLocked] = useState(false)
	const [showingLockScreen, setShowingLockScreen] = useState(false)
	const [meta, setMeta] = useState<{width: number; height: number; fps: number; encoder: string} | null>(null)

	// When the desktop unlocks, clear lock-screen view and focus the window immediately.
	useEffect(() => {
		if (!sessionLocked) {
			if (showingLockScreen) setShowingLockScreen(false)
			if (mode === 'window' && address) {
				mutate('hyprland.dispatch', {action: 'focus', address}).catch(() => {})
			}
			hostRef.current?.focus({preventScroll: true})
		}
	}, [sessionLocked, showingLockScreen, mode, address])

	const effectiveMode = showingLockScreen ? 'output' : mode
	const effectiveAddress = showingLockScreen ? '' : address
	const effectiveOutput = showingLockScreen ? 'RAIL-1' : output

	// In window mode, notify Hyprland whenever this browser container is resized or tiled.
	useEffect(() => {
		if (!onResizeRef.current || !hostRef.current || typeof ResizeObserver === 'undefined') return
		let timer: number | undefined
		let lastW = 0
		let lastH = 0
		const ro = new ResizeObserver((entries) => {
			const cr = entries[0]?.contentRect
			if (!cr) return
			const w = Math.round(cr.width)
			const h = Math.round(cr.height)
			if (w < 120 || h < 100 || (Math.abs(w - lastW) < 4 && Math.abs(h - lastH) < 4)) return
			window.clearTimeout(timer)
			timer = window.setTimeout(() => {
				lastW = w
				lastH = h
				onResizeRef.current?.(w, h)
			}, 150)
		})
		ro.observe(hostRef.current)
		return () => {
			window.clearTimeout(timer)
			ro.disconnect()
		}
	}, [address])

	useEffect(() => {
		if (!supportsWebCodecs()) {
			setStatusTracked('error')
			setError('This browser does not support WebCodecs hardware video decoding.')
			return
		}
		if (!caps || !profilesReady) return
		const prof = activeProfileRef.current
		const initCfg = resolveEffectiveStreamConfig({
			profile: prof,
			caps,
			tierOverride: tierOverrideRef.current,
			chromaOverride: chromaOverrideRef.current,
			codecFallback: codecFallbackRef.current,
			defaultBitrate: bitrate,
			defaultFps: fps,
		})
		const initCodec: StreamCodec = initCfg.codec
		activeCodecRef.current = initCodec
		const activeFps = initCfg.fps
		const activeBitrate = initCfg.bitrate
		const activeQuality = initCfg.quality
		const activeCompression = initCfg.compression
		let disposed = false
		let decoder: VideoDecoder | null = null
		let audioDecoder: WebAudioDecoderLike | null = null
		let opusTs = 0
		let opusErrorCount = 0
		let opusBroken = false
		let audioModeLabel = caps.supportsOpus ? 'Opus 10ms' : 'PCM 20ms'
		let blitter: FrameBlitter | null = null
		let blitterCanvas: HTMLCanvasElement | null = null
		let configured = false
		let needKey = true
		let gotFirstFrame = false
		let gotFrameForConfig = false
		let codecWatchdog = 0
		let keyframeRetryTimer = 0
		let framesInWindow = 0
		let lastFps = 0
		let lastFpsAt = performance.now()
		let pendingFrame: VideoFrame | null = null
		let microtaskScheduled = false
		let queueHighSince = 0
		const decodeStartMap = new Map<number, number>()
		let lastDecMs = 0
		rttStatsRef.current = createRttStats()
		audioResyncsRef.current = 0
		let lastServerStats: {encMs: number; encP95Ms: number; mbps: number; polish: number; roi: number; slices: number} | null = null
		let metaEncName = ''
		let metaDim = ''
		const pingBuf = new Uint8Array(9)
		const pingView = new DataView(pingBuf.buffer)

		const renderStatsOverlay = () => {
			if (!showStatsRef.current || !statsOverlayRef.current) return
			const parts: string[] = []
			if (metaEncName) parts.push(metaEncName)
			if (metaDim) parts.push(metaDim)
			parts.push(`${lastFps} fps`)
			if (lastServerStats) {
				parts.push(`${lastServerStats.mbps.toFixed(1)} Mbps`)
				parts.push(`Enc ${lastServerStats.encMs.toFixed(1)}ms (p95 ${lastServerStats.encP95Ms.toFixed(1)}ms)`)
				if (lastServerStats.slices > 1) parts.push(`${lastServerStats.slices} slices`)
				if (lastServerStats.polish > 0) parts.push(`Polish ${lastServerStats.polish}`)
				if (lastServerStats.roi > 0) parts.push(`ROI ${lastServerStats.roi}`)
			}
			if (lastDecMs > 0) parts.push(`Dec ${lastDecMs.toFixed(1)}ms`)
			const rttState = rttStatsRef.current
			if (rttState.rttMs !== null) {
				const q = classifyNetworkQuality(rttState)
				const jitterPart = rttState.samples >= 2 ? ` ±${rttState.jitterMs.toFixed(1)}ms` : ''
				const netTag = q === 'high-jitter' ? ' · High RTT/jitter' : ''
				parts.push(`RTT ${rttState.rttMs.toFixed(1)}ms${jitterPart}${netTag}`)
			}
			const audioBudget = computeAudioJitterBudget({...rttState, mode: audioModeLabel.startsWith('Opus') ? 'opus' : 'pcm'})
			const resyncPart = audioResyncsRef.current > 0 ? `, ${audioResyncsRef.current} resync` : ''
			parts.push(`${audioModeLabel} (${Math.round(audioBudget.targetSec * 1000)}ms buf${resyncPart})`)
			statsOverlayRef.current.textContent = parts.join(' · ')
		}

		// Schedule decoded WebCodecs AudioData (10 ms Opus) onto WebAudio with RTT-adaptive jitter cushion via per-view GainNode.
		const scheduleAudioData = (ad: WebAudioDataLike) => {
			try {
				if (mutedRef.current) return
				const ac = audioCtxRef.current
				const gain = audioGainRef.current
				if (!ac || !gain || ac.state !== 'running') return
				const frames = ad.numberOfFrames
				const chCount = Math.min(2, ad.numberOfChannels || 2)
				if (frames <= 0) return
				const ab = ac.createBuffer(chCount, frames, ad.sampleRate || 48000)
				const fmt = ad.format || ''
				if (fmt.endsWith('-planar')) {
					for (let c = 0; c < chCount; c++) {
						ad.copyTo(ab.getChannelData(c), {planeIndex: c, format: 'f32-planar'})
					}
				} else {
					const interleaved = new Float32Array(frames * chCount)
					ad.copyTo(interleaved, {planeIndex: 0, format: 'f32'})
					const ch0 = ab.getChannelData(0)
					const ch1 = chCount > 1 ? ab.getChannelData(1) : null
					for (let i = 0; i < frames; i++) {
						ch0[i] = interleaved[i * chCount]
						if (ch1) ch1[i] = interleaved[i * chCount + 1]
					}
				}
				const src = ac.createBufferSource()
				src.buffer = ab
				src.connect(gain)
				const now = ac.currentTime
				const {targetSec, minLeadSec, maxLeadSec} = computeAudioJitterBudget({...rttStatsRef.current, mode: 'opus'})
				if (nextAudioTimeRef.current < now + minLeadSec || nextAudioTimeRef.current > now + maxLeadSec) {
					// Count only genuine recent underruns, not normal resumes after >200 ms silence gating
					if (nextAudioTimeRef.current > now - 0.2 && nextAudioTimeRef.current < now + minLeadSec) audioResyncsRef.current++
					nextAudioTimeRef.current = now + targetSec
				}
				src.start(nextAudioTimeRef.current)
				nextAudioTimeRef.current += ab.duration
			} catch {} finally {
				ad.close()
			}
		}

		const failOverOpusToPcm = () => {
			if (opusBroken) return
			opusBroken = true
			audioModeLabel = 'PCM 20ms'
			try {
				audioDecoder?.close()
			} catch {}
			audioDecoder = null
			if (wsRef.current?.readyState === WebSocket.OPEN) {
				wsRef.current.send(JSON.stringify({type: 'audio', enabled: !mutedRef.current, codec: 'pcm'}))
			}
		}

		const playOpusFrame = (opusBytes: Uint8Array) => {
			if (mutedRef.current || opusBroken || opusBytes.byteLength === 0) return
			audioModeLabel = 'Opus 10ms'
			const ac = audioCtxRef.current
			if (!ac || ac.state !== 'running') return
			const win = window as unknown as {
				AudioDecoder?: WebAudioDecoderCtor
				EncodedAudioChunk?: new (init: {type: 'key'; timestamp: number; data: Uint8Array}) => unknown
			}
			if (!win.AudioDecoder || !win.EncodedAudioChunk) {
				failOverOpusToPcm()
				return
			}
			if (!audioDecoder || audioDecoder.state === 'closed') {
				try {
					audioDecoder = new win.AudioDecoder({
						output(ad) {
							opusErrorCount = 0
							scheduleAudioData(ad)
						},
						error() {
							opusErrorCount++
							try {
								audioDecoder?.close()
							} catch {}
							audioDecoder = null
							if (opusErrorCount >= 2) failOverOpusToPcm()
						},
					})
					audioDecoder.configure({codec: 'opus', sampleRate: 48000, numberOfChannels: 2})
				} catch {
					audioDecoder = null
					failOverOpusToPcm()
					return
				}
			}
			if (audioDecoder.state !== 'configured') return
			try {
				audioDecoder.decode(new win.EncodedAudioChunk({type: 'key', timestamp: opusTs, data: opusBytes}))
				opusTs += 10000
			} catch {
				opusErrorCount++
				if (opusErrorCount >= 2) failOverOpusToPcm()
			}
		}

		// Update FPS readout & telemetry overlay directly on DOM nodes (zero 1 Hz React re-renders).
		const fpsTimer = window.setInterval(() => {
			const now = performance.now()
			const dt = (now - lastFpsAt) / 1000
			if (dt > 0) {
				lastFps = Math.round(framesInWindow / dt)
				if (fpsSpanRef.current) {
					fpsSpanRef.current.textContent = chrome === 'full' ? `${lastFps} fps` : lastFps > 0 ? `${lastFps} fps` : 'idle'
				}
				renderStatsOverlay()
			}
			framesInWindow = 0
			lastFpsAt = now
		}, 1000)

		// Sub-millisecond binary RTT ping (0x14 -> 0x04 pong) every 2s for live telemetry.
		const pingTimer = window.setInterval(() => {
			const curWs = wsRef.current
			if (curWs && curWs.readyState === WebSocket.OPEN) {
				pingBuf[0] = 0x14
				pingView.setFloat64(1, performance.now(), false)
				curWs.send(pingBuf)
			}
		}, 2000)

		const triggerCodecFallback = () => {
			const cur = activeCodecRef.current
			if (disposed || cur === 'h264') return false
			const next = nextFallbackCodec(cur)
			if (!next) return false
			if (cur === 'hevc444') {
				setChromaOverrideState(false)
				chromaOverrideRef.current = false
				try {
					localStorage.setItem(CHROMA_444_KEY, '0')
				} catch {}
				// If live stream already opened, downgrade 4:4:4 -> 4:2:0 in-place with zero reconnect while preserving active bitrate & QP!
				if (gotFirstFrame && wsRef.current?.readyState === WebSocket.OPEN) {
					codecFallbackRef.current = next
					setCodecFallback(next)
					const fallbackCfg = resolveEffectiveStreamConfig({
						profile: activeProfileRef.current,
						caps,
						tierOverride: tierOverrideRef.current,
						chromaOverride: false,
						codecFallback: next,
						defaultBitrate: bitrate,
						defaultFps: fps,
					})
					activeCodecRef.current = fallbackCfg.codec
					wsRef.current.send(
						JSON.stringify({
							type: 'reconfig',
							bitrate: fallbackCfg.bitrate,
							quality: fallbackCfg.quality,
							codec: fallbackCfg.codec,
						}),
					)
					return true
				}
			}
			if (gotFirstFrame) return false
			try {
				sessionStorage.setItem(CODEC_PREF_KEY, next)
			} catch {}
			codecFallbackRef.current = next
			setCodecFallback(next)
			setReconnectNonce((n) => n + 1)
			return true
		}

		const scheduleKeyframeReq = () => {
			if (disposed || !needKey) return
			const curWs = wsRef.current
			if (!curWs || curWs.readyState !== WebSocket.OPEN) return
			const nowMs = performance.now()
			const waitMs = Math.max(0, 1500 - (nowMs - lastKeyframeReq.current))
			if (waitMs === 0) {
				lastKeyframeReq.current = nowMs
				curWs.send(JSON.stringify({type: 'keyframe'}))
				if (keyframeRetryTimer) {
					window.clearTimeout(keyframeRetryTimer)
					keyframeRetryTimer = 0
				}
				keyframeRetryTimer = window.setTimeout(() => {
					keyframeRetryTimer = 0
					if (needKey) scheduleKeyframeReq()
				}, 1500)
				return
			}
			if (!keyframeRetryTimer) {
				keyframeRetryTimer = window.setTimeout(() => {
					keyframeRetryTimer = 0
					if (needKey) scheduleKeyframeReq()
				}, waitMs)
			}
		}

		// Start a per-configuration decode deadline on each decodable IDR keyframe (catches both cold connect and silent live 4:4:4 switch hangs).
		const armDecodeWatchdog = () => {
			if (codecWatchdog || gotFrameForConfig) return
			codecWatchdog = window.setTimeout(() => {
				codecWatchdog = 0
				if (disposed || gotFrameForConfig) return
				if (!triggerCodecFallback()) {
					setStatusTracked('error')
					setError('Hardware video decoder timed out before rendering a frame.')
				}
			}, 3500)
		}

		const presentFrame = (frame: VideoFrame) => {
			try {
				const canvas = canvasRef.current
				if (!canvas) return
				if (!blitter || blitterCanvas !== canvas) {
					blitter?.destroy()
					blitter = createFrameBlitter(canvas, canvasModeRef.current === '2d')
					blitterCanvas = canvas
				}
				const fw = frame.displayWidth || frame.codedWidth
				const fh = frame.displayHeight || frame.codedHeight
				if (fw > 0 && fh > 0 && (codedSizeRef.current.w !== fw || codedSizeRef.current.h !== fh)) {
					codedSizeRef.current = {w: fw, h: fh}
					canvasRectRef.current = null
				}
				const res = blitter.draw(frame, {
					backingW: targetBackingRef.current.w,
					backingH: targetBackingRef.current.h,
					contain: containRef.current,
					sharpness: sharpnessRef.current,
				})
				if (res === 'need-2d') {
					blitter.destroy()
					blitter = null
					blitterCanvas = null
					if (canvasModeRef.current !== '2d') setCanvasMode('2d')
					return
				}
				if (res !== 'ok') return
				const t0 = decodeStartMap.get(frame.timestamp)
				if (t0 !== undefined) {
					decodeStartMap.delete(frame.timestamp)
					const dt = performance.now() - t0
					lastDecMs = lastDecMs > 0 ? lastDecMs * 0.75 + dt * 0.25 : dt
				}
				framesInWindow++
				gotFrameForConfig = true
				if (codecWatchdog) {
					window.clearTimeout(codecWatchdog)
					codecWatchdog = 0
				}
				if (!gotFirstFrame) {
					gotFirstFrame = true
					const c = activeCodecRef.current
					if (c !== 'hevc444') {
						try {
							sessionStorage.setItem(CODEC_PREF_KEY, c)
						} catch {}
					}
				}
				setStatusTracked('live')
			} catch {
				/* ignore transient draw errors */
			} finally {
				frame.close()
			}
		}

		const flushPendingFrame = () => {
			microtaskScheduled = false
			const f = pendingFrame
			pendingFrame = null
			if (!f) return
			if (disposed) {
				f.close()
				return
			}
			presentFrame(f)
		}

		const ensureDecoder = (codec: string, width: number, height: number) => {
			if (decoder && decoder.state === 'configured' && configured) return
			try {
				decoder?.close()
			} catch {}
			decoder = new VideoDecoder({
				output(frame: VideoFrame) {
					if (disposed) {
						frame.close()
						return
					}
					// Zero-delay synchronous present in steady state (decodeQueueSize === 0);
					// coalesce rapid WAN TCP burst drains via latest-frame mailbox so only the newest frame uploads to GPU.
					if (decoder && decoder.decodeQueueSize > 0) {
						if (pendingFrame) pendingFrame.close()
						pendingFrame = frame
						if (!microtaskScheduled) {
							microtaskScheduled = true
							queueMicrotask(flushPendingFrame)
						}
						return
					}
					if (pendingFrame) {
						pendingFrame.close()
						pendingFrame = null
					}
					presentFrame(frame)
				},
				error(err: DOMException) {
					if (disposed) return
					if (triggerCodecFallback()) return
					needKey = true
					configured = false
					if (!gotFirstFrame) {
						setStatusTracked('error')
						setError(`Video decoder failed: ${err.message}`)
						return
					}
					setError(`Decoder reset: ${err.message}`)
					scheduleKeyframeReq()
				},
			})
			try {
				decoder.configure({
					codec,
					codedWidth: width || undefined,
					codedHeight: height || undefined,
					optimizeForLatency: true,
					hardwareAcceleration: 'prefer-hardware',
				})
				configured = true
			} catch (err) {
				if (!triggerCodecFallback()) {
					setStatusTracked('error')
					setError(`Hardware video decoder could not initialize (${err instanceof Error ? err.message : codec}).`)
				}
			}
		}

		const qs = new URLSearchParams({
			mode: effectiveMode,
			...(effectiveMode === 'window' && effectiveAddress ? {address: effectiveAddress} : {}),
			...(effectiveMode === 'output' && effectiveOutput ? {output: effectiveOutput} : {}),
			fps: String(activeFps),
			bitrate: String(activeBitrate),
			...(activeQuality >= 10 && activeQuality <= 34 ? {quality: String(activeQuality)} : {}),
			...(activeCompression >= 1 && activeCompression <= 7 ? {compression: String(activeCompression)} : {}),
			audio: mutedRef.current ? '0' : '1',
			audioCodec: caps.supportsOpus ? 'opus' : 'pcm',
			codec: initCodec,
		})
		const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
		const handshakeCfg = {
			codec: initCfg.codec,
			bitrate: initCfg.bitrate,
			quality: initCfg.quality,
			tierOverride: tierOverrideRef.current,
			chromaOverride: chromaOverrideRef.current,
			codecFallback: codecFallbackRef.current,
		}
		let appliedCfg = {...handshakeCfg}
		const ws = new WebSocket(`${scheme}//${location.host}/api/hyprland/stream?${qs.toString()}`)
		ws.binaryType = 'arraybuffer'
		wsRef.current = ws
		ws.onopen = () => {
			if (!disposed && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({type: 'audio', enabled: !mutedRef.current}))
				const latestCfg = resolveEffectiveStreamConfig({
					profile: activeProfileRef.current,
					caps,
					tierOverride: tierOverrideRef.current,
					chromaOverride: chromaOverrideRef.current,
					codecFallback: codecFallbackRef.current,
					defaultBitrate: bitrate,
					defaultFps: fps,
				})
				if (latestCfg.codec !== handshakeCfg.codec || latestCfg.bitrate !== handshakeCfg.bitrate || latestCfg.quality !== handshakeCfg.quality) {
					sendLiveReconfig(tierOverrideRef.current, chromaOverrideRef.current, codecFallbackRef.current)
				}
				pingBuf[0] = 0x14
				pingView.setFloat64(1, performance.now(), false)
				ws.send(pingBuf)
			}
		}
		setStatusTracked('connecting')
		setError(null)

		let currentW = 0
		let currentH = 0
		let currentCodec = 'avc1.640033'

		ws.onmessage = (ev) => {
			if (disposed) return
			if (typeof ev.data === 'string') {
				try {
					const msg = JSON.parse(ev.data)
					if (msg.type === 'meta') {
						currentW = Number(msg.width) || 0
						currentH = Number(msg.height) || 0
						codedSizeRef.current = {w: currentW, h: currentH}
						canvasRectRef.current = null
						if (typeof msg.codec === 'string' && msg.codec) currentCodec = msg.codec
						const encStr = String(msg.encoder || 'h264')
						const metaUpdate = applyMetaToProfiledStreamState(appliedCfg, encStr)
						appliedCfg = metaUpdate.appliedCfg
						activeCodecRef.current = metaUpdate.actualCodec
						setConfirmedCodec(metaUpdate.actualCodec)
						metaEncName = encStr === 'hevc444_vaapi_dmabuf' ? 'HEVC 4:4:4' : encStr === 'hevc10_vaapi_dmabuf' ? 'HEVC 10-bit' : encStr === 'hevc_vaapi_dmabuf' ? 'HEVC' : 'H.264'
						metaDim = `${currentW}x${currentH}`
						setMeta({width: currentW, height: currentH, fps: Number(msg.fps) || activeFps, encoder: encStr})
						try {
							decoder?.close()
						} catch {}
						decoder = null
						configured = false
						needKey = true
						gotFrameForConfig = false
						if (codecWatchdog) {
							window.clearTimeout(codecWatchdog)
							codecWatchdog = 0
						}
						renderStatsOverlay()
					} else if (msg.type === 'stats') {
						lastServerStats = {
							encMs: Number(msg.encMs) || 0,
							encP95Ms: Number(msg.encP95Ms) || 0,
							mbps: Number(msg.mbps) || 0,
							polish: Number(msg.polish) || 0,
							roi: Number(msg.roi) || 0,
							slices: Number(msg.slices) || 1,
						}
						renderStatsOverlay()
					} else if (msg.type === 'lock') {
						setSessionLocked(!!msg.locked)
					} else if (msg.type === 'cursor') {
						const c = typeof msg.cursor === 'string' && ALLOWED_CURSORS.has(msg.cursor) ? msg.cursor : 'default'
						if (canvasRef.current && canvasRef.current.style.cursor !== c) {
							canvasRef.current.style.cursor = c
						}
					} else if (msg.type === 'reconfig_applied') {
						const appliedUpdate = applyReconfigAppliedToProfiledStreamState(appliedCfg, {
							msgCodec: msg.codec,
							msgBitrate: msg.bitrate,
							msgQuality: msg.quality,
							activeCodec: activeCodecRef.current,
							tierOverride: tierOverrideRef.current,
							chromaOverride: chromaOverrideRef.current,
							codecFallback: codecFallbackRef.current,
						})
						appliedCfg = appliedUpdate.appliedCfg
						activeCodecRef.current = appliedUpdate.appliedCodec
						setConfirmedCodec(appliedUpdate.appliedCodec)
					} else if (msg.type === 'reconfig_unsupported') {
						const rolledBack = applyReconfigUnsupportedToProfiledStreamState(appliedCfg)
						tierOverrideRef.current = rolledBack.tierOverride
						chromaOverrideRef.current = rolledBack.chromaOverride
						codecFallbackRef.current = rolledBack.codecFallback
						activeCodecRef.current = rolledBack.codec
						setTierOverrideState(rolledBack.tierOverride)
						setChromaOverrideState(rolledBack.chromaOverride)
						setCodecFallback(rolledBack.codecFallback)
						setConfirmedCodec(rolledBack.codec)
						try {
							if (rolledBack.tierOverride === null) localStorage.removeItem(QUALITY_TIER_KEY)
							else localStorage.setItem(QUALITY_TIER_KEY, rolledBack.tierOverride)
							if (rolledBack.chromaOverride === null) localStorage.removeItem(CHROMA_444_KEY)
							else localStorage.setItem(CHROMA_444_KEY, rolledBack.chromaOverride ? '1' : '0')
						} catch {}
					} else if (msg.type === 'error') {
						setStatusTracked('error')
						setError(String(msg.error || 'Hyprland stream error'))
					}
				} catch {}
				return
			}
			const buf = new Uint8Array(ev.data as ArrayBuffer)
			if (buf.byteLength === 9 && buf[0] === 0x04) {
				const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
				const rtt = performance.now() - dv.getFloat64(1, false)
				const nextRtt = updateRttStats(rttStatsRef.current, rtt)
				if (nextRtt !== rttStatsRef.current) {
					rttStatsRef.current = nextRtt
					renderStatsOverlay()
				}
				return
			}
			if (buf.byteLength > 1 && buf[0] === 3) {
				playOpusFrame(buf.subarray(1))
				return
			}
			if (buf.byteLength > 4 && buf[0] === 2) {
				audioModeLabel = 'PCM 20ms'
				playPcmFrame(buf.subarray(1))
				return
			}
			if (buf.byteLength <= 9) return
			const isKey = buf[0] === 1
			const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
			const tsHi = view.getUint32(1, false)
			const tsLo = view.getUint32(5, false)
			const timestamp = tsHi * 4294967296 + tsLo
			const annexb = buf.subarray(9)

			if (isKey) {
				const codec =
					currentCodec.startsWith('hev') || currentCodec.startsWith('hvc')
						? parseHevcCodecFromAnnexB(annexb, currentCodec)
						: parseAvcCodecFromAnnexB(annexb)
				if (!configured) ensureDecoder(codec, currentW, currentH)
				needKey = false
				queueHighSince = 0
				if (keyframeRetryTimer) {
					window.clearTimeout(keyframeRetryTimer)
					keyframeRetryTimer = 0
				}
			} else if (needKey || !configured) {
				return
			}
			if (decoder && decoder.state === 'configured') {
				const q = decoder.decodeQueueSize
				const nowMs = performance.now()
				const dropPolicy = computeVideoDropPolicy(rttStatsRef.current)
				if (q >= dropPolicy.queueThreshold) {
					if (queueHighSince === 0) queueHighSince = nowMs
				} else {
					queueHighSince = 0
				}
				// Drop to next keyframe only on sustained decode backlog or hard cap, scaling tolerance with WAN RTT/jitter to absorb TCP burst drains
				if (!isKey && (q > dropPolicy.hardCap || (queueHighSince > 0 && nowMs - queueHighSince > dropPolicy.sustainMs))) {
					needKey = true
					queueHighSince = 0
					scheduleKeyframeReq()
					return
				}
				try {
					if (isKey) armDecodeWatchdog()
					if (decodeStartMap.size > 32) decodeStartMap.clear()
					decodeStartMap.set(timestamp, nowMs)
					decoder.decode(
						new EncodedVideoChunk({
							type: isKey ? 'key' : 'delta',
							timestamp,
							data: annexb,
						}),
					)
				} catch {
					if (triggerCodecFallback()) return
					needKey = true
					if (!gotFirstFrame) {
						setStatusTracked('error')
						setError('Hardware video decoder rejected the incoming video stream.')
						return
					}
					scheduleKeyframeReq()
				}
			}
		}

		ws.onerror = () => {
			if (!disposed) {
				setStatusTracked('error')
				setError('Lost connection to the Hyprland GPU stream.')
			}
		}
		ws.onclose = (e) => {
			if (!disposed && statusRef.current !== 'error') {
				setStatusTracked('error')
				setError(e.reason || 'Hyprland stream ended.')
			}
		}

		return () => {
			disposed = true
			if (pendingFrame) {
				pendingFrame.close()
				pendingFrame = null
			}
			if (codecWatchdog) window.clearTimeout(codecWatchdog)
			if (keyframeRetryTimer) window.clearTimeout(keyframeRetryTimer)
			window.clearInterval(fpsTimer)
			window.clearInterval(pingTimer)
			try {
				ws.close()
			} catch {}
			wsRef.current = null
			try {
				decoder?.close()
			} catch {}
			try {
				audioDecoder?.close()
			} catch {}
			try {
				blitter?.destroy()
			} catch {}
		}
	}, [effectiveMode, effectiveAddress, effectiveOutput, caps, profilesReady, activeProfileKey, reconnectNonce, fps, bitrate, attempt, chrome])

	const sendBinaryMove = (ux: number, uy: number) => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		const buf = moveBufRef.current
		buf[0] = 0x10
		buf[1] = (ux >> 8) & 0xff
		buf[2] = ux & 0xff
		buf[3] = (uy >> 8) & 0xff
		buf[4] = uy & 0xff
		ws.send(buf)
		lastPtrSendRef.current = performance.now()
		lastSentXYRef.current.ux = ux
		lastSentXYRef.current.uy = uy
	}

	const sendBinaryButton = (button: number, down: boolean, ux: number, uy: number) => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		const buf = btnBufRef.current
		buf[0] = 0x11
		buf[1] = Math.max(0, Math.min(7, button - 272))
		buf[2] = down ? 1 : 0
		buf[3] = (ux >> 8) & 0xff
		buf[4] = ux & 0xff
		buf[5] = (uy >> 8) & 0xff
		buf[6] = uy & 0xff
		ws.send(buf)
		lastSentXYRef.current.ux = ux
		lastSentXYRef.current.uy = uy
	}

	const sendBinaryScroll = (dx: number, dy: number) => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		const buf = scrollBufRef.current
		const dv = scrollViewRef.current
		buf[0] = 0x12
		dv.setInt32(1, Math.max(-2560000, Math.min(2560000, Math.round(dx * 256))), false)
		dv.setInt32(5, Math.max(-2560000, Math.min(2560000, Math.round(dy * 256))), false)
		ws.send(buf)
	}

	const sendBinaryKey = (code: number, down: boolean, mods: number) => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		const buf = keyBufRef.current
		buf[0] = 0x13
		buf[1] = Math.max(1, Math.min(247, code))
		buf[2] = down ? 1 : 0
		buf[3] = mods & 0xff
		ws.send(buf)
	}

	const flushPendingMove = () => {
		if (ptrTimerRef.current) {
			window.clearTimeout(ptrTimerRef.current)
			ptrTimerRef.current = null
		}
		const pending = pendingPtrRef.current
		if (!pending) return
		pendingPtrRef.current = null
		if (pending.ux !== lastSentXYRef.current.ux || pending.uy !== lastSentXYRef.current.uy) {
			sendBinaryMove(pending.ux, pending.uy)
		}
	}

	const releaseHeldInputs = () => {
		if (ptrTimerRef.current) {
			window.clearTimeout(ptrTimerRef.current)
			ptrTimerRef.current = null
		}
		pendingPtrRef.current = null
		for (const code of heldKeys.current) sendBinaryKey(code, false, 0)
		heldKeys.current.clear()
		const ux = lastSentXYRef.current.ux >= 0 ? lastSentXYRef.current.ux : 32768
		const uy = lastSentXYRef.current.uy >= 0 ? lastSentXYRef.current.uy : 32768
		for (const button of heldButtons.current) sendBinaryButton(button, false, ux, uy)
		heldButtons.current.clear()
	}

	const normXYFromClient = (clientX: number, clientY: number) => {
		const r = canvasRectRef.current ?? refreshCanvasRect()
		if (!r) return {ux: 32768, uy: 32768}
		const x = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)))
		const y = Math.max(0, Math.min(1, (clientY - r.top) / Math.max(1, r.height)))
		return {
			ux: Math.max(0, Math.min(65535, Math.round(x * 65535))),
			uy: Math.max(0, Math.min(65535, Math.round(y * 65535))),
		}
	}

	const handlePointerMotion = (clientX: number, clientY: number) => {
		const {ux, uy} = normXYFromClient(clientX, clientY)
		if (ux === lastSentXYRef.current.ux && uy === lastSentXYRef.current.uy && !pendingPtrRef.current) return
		const now = performance.now()
		const elapsed = now - lastPtrSendRef.current
		// Leading-edge immediate send + 4ms (250 Hz) coalescing with trailing flush
		if (elapsed >= 4) {
			if (ptrTimerRef.current) {
				window.clearTimeout(ptrTimerRef.current)
				ptrTimerRef.current = null
			}
			pendingPtrRef.current = null
			sendBinaryMove(ux, uy)
		} else {
			pendingPtrRef.current = {ux, uy}
			if (!ptrTimerRef.current) {
				ptrTimerRef.current = window.setTimeout(() => {
					ptrTimerRef.current = null
					flushPendingMove()
				}, Math.max(1, Math.ceil(4 - elapsed)))
			}
		}
	}

	// Prefer native pointerrawupdate (bypasses 60 Hz browser compositor vsync alignment, cutting 4-16 ms input lag) when supported.
	const hasPointerRawRef = useRef(typeof window !== 'undefined' && 'onpointerrawupdate' in window)
	const handleMotionRef = useRef(handlePointerMotion)
	handleMotionRef.current = handlePointerMotion
	useEffect(() => {
		const el = canvasRef.current
		if (!el || !hasPointerRawRef.current) return
		const onRaw = (e: Event) => {
			const pe = e as PointerEvent
			handleMotionRef.current(pe.clientX, pe.clientY)
		}
		el.addEventListener('pointerrawupdate', onRaw, {passive: true})
		return () => el.removeEventListener('pointerrawupdate', onRaw)
	}, [canvasMode])

	// A native, non-passive listener: React's onWheel is passive, so its preventDefault is ignored and a
	// pinch or Ctrl+scroll would also zoom the browser page.
	const sendScrollRef = useRef(sendBinaryScroll)
	sendScrollRef.current = sendBinaryScroll
	useEffect(() => {
		const el = canvasRef.current
		if (!el) return
		return bindConsoleWheel(el, (e) => {
			e.preventDefault()
			sendScrollRef.current(e.deltaX * 0.15, e.deltaY * 0.15)
		})
	}, [canvasMode])

	const encoderLabel =
		meta?.encoder === 'hevc444_vaapi_dmabuf'
			? 'HEVC 4:4:4 DMA-BUF'
			: meta?.encoder === 'hevc10_vaapi_dmabuf'
				? 'HEVC 10-bit DMA-BUF'
				: meta?.encoder === 'hevc_vaapi_dmabuf'
					? 'HEVC DMA-BUF'
					: meta?.encoder === 'h264_vaapi_dmabuf'
						? 'H.264 High DMA-BUF'
						: meta?.encoder?.includes('vaapi')
							? 'VA-API GPU'
							: 'H.264'

	return (
		<div
			ref={hostRef}
			className={`hypr-view${chrome === 'rail' ? ' rail' : ''}`}
			tabIndex={0}
			onFocus={() => {
				if (effectiveMode === 'window' && effectiveAddress) {
					mutate('hyprland.dispatch', {action: 'focus', address: effectiveAddress}).catch(() => {})
				}
			}}
			onBlur={releaseHeldInputs}
			onKeyDown={(e) => {
				if (showProfiler) return
				ensureAudioCtx()
				const tag = (e.target as HTMLElement | null)?.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
				const code = EVDEV_CODE[e.code]
				if (!code) return
				e.preventDefault()
				e.stopPropagation()
				heldKeys.current.add(code)
				sendBinaryKey(code, true, modsMask(e))
			}}
			onKeyUp={(e) => {
				if (showProfiler) return
				const tag = (e.target as HTMLElement | null)?.tagName
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
				const code = EVDEV_CODE[e.code]
				if (!code) return
				e.preventDefault()
				e.stopPropagation()
				heldKeys.current.delete(code)
				sendBinaryKey(code, false, modsMask(e))
			}}
		>
			{chrome === 'full' ? (
				<div className="hypr-hud">
					<span className="hypr-pill">
						<Icon name="gpu" size={14} />
						{title ? `${title} · ` : ''}
						{meta ? (
							<>
								{`${encoderLabel} · ${meta.width}×${meta.height} · `}
								<span ref={fpsSpanRef}>0 fps</span>
							</>
						) : (
							'Direct GPU WebCodecs'
						)}
					</span>
					<div className="hypr-hud-actions">
						{onSelectTarget && windows.length > 0 && (
							<select
								className="hypr-select"
								aria-label="Render target"
								value={mode === 'window' ? address : '__output__'}
								onChange={(e) => {
									const v = e.target.value
									if (v === '__output__') {
										onSelectTarget({mode: 'output', address: '', title: 'Full Desktop'})
									} else {
										const w = windows.find((x) => x.address === v)
										if (w) onSelectTarget({mode: 'window', address: w.address, title: w.title})
									}
								}}
							>
								<option value="__output__">Full Hyprland Desktop</option>
								{windows.map((w) => (
									<option key={w.address} value={w.address}>
										Window: {w.title} (WS {w.workspace})
									</option>
								))}
							</select>
						)}
						<select
							className="hypr-select"
							aria-label="Stream bitrate quality"
							value={resolvedConfig?.selectorValue ?? (tierOverride ?? (activeProfile ? 'profile' : 'balanced'))}
							onChange={(e) => setQualityChoice(e.target.value as 'profile' | StreamQualityTier)}
							title="Live stream bitrate & quality preset (instant, zero reconnect)"
						>
							{activeProfile && <option value="profile">{`Profile (${Math.round(activeProfile.bitrate / 1000)} Mbps)`}</option>}
							<option value="balanced">{QUALITY_TIERS.balanced.label}</option>
							<option value="high">{QUALITY_TIERS.high.label}</option>
							<option value="ultra">{QUALITY_TIERS.ultra.label}</option>
						</select>
						{caps?.supports444 && (
							<button
								type="button"
								className={`btn small${(confirmedCodec !== null ? confirmedCodec === 'hevc444' : !!resolvedConfig?.chroma444) ? ' primary' : ''}`}
								onClick={toggleChroma444}
								title="Toggle hardware HEVC 4:4:4 full chroma for razor-sharp colored text (instant, zero reconnect)"
							>
								4:4:4
							</button>
						)}
						<button
							type="button"
							className={`btn small${showProfiler ? ' primary' : ''}`}
							onClick={() => {
								releaseHeldInputs()
								setShowProfiler(true)
							}}
							title="Benchmark GPU and manage per-device stream profiles"
						>
							Profiles
						</button>
						<button type="button" className="btn small" onClick={cycleSharpness} title="Cycle WebGL2 AMD FidelityFX CAS sharpening">
							{SHARPNESS_PRESETS[sharpnessPreset].label}
						</button>
						<button type="button" className={`btn small${showStats ? ' primary' : ''}`} onClick={() => setShowStats((s) => !s)} title="Toggle live GPU engine telemetry overlay">
							Stats
						</button>
						<button type="button" className="btn small" onClick={toggleMute} title={muted ? 'Unmute desktop audio' : 'Mute desktop audio'}>
							{muted ? 'Audio off' : 'Audio on'}
						</button>
						{onFallbackVnc && (
							<button type="button" className="btn small" onClick={onFallbackVnc}>
								Switch to VNC
							</button>
						)}
						{onClose && (
							<button type="button" className="btn small" aria-label="Close" onClick={onClose}>
								<Icon name="close" size={14} />
							</button>
						)}
					</div>
				</div>
			) : (
				meta && (
					<span className="hypr-rail-badge" aria-hidden="true">
						<Icon name="gpu" size={12} />
						{`${encoderLabel} · `}
						<span ref={fpsSpanRef}>idle</span>
					</span>
				)
			)}

			<canvas
				key={canvasMode}
				ref={canvasRef}
				className="hypr-canvas"
				onContextMenu={(e) => e.preventDefault()}
				onPointerEnter={() => {
					refreshCanvasRect()
				}}
				onPointerMove={(e) => {
					if (hasPointerRawRef.current) return
					handlePointerMotion(e.clientX, e.clientY)
				}}
				onPointerDown={(e) => {
					e.preventDefault()
					ensureAudioCtx()
					hostRef.current?.focus({preventScroll: true})
					flushPendingMove()
					const {ux, uy} = normXYFromClient(e.clientX, e.clientY)
					const button = mouseButtonEvdev(e.button)
					heldButtons.current.add(button)
					sendBinaryButton(button, true, ux, uy)
				}}
				onPointerUp={(e) => {
					flushPendingMove()
					const {ux, uy} = normXYFromClient(e.clientX, e.clientY)
					const button = mouseButtonEvdev(e.button)
					heldButtons.current.delete(button)
					sendBinaryButton(button, false, ux, uy)
				}}
				onPointerLeave={() => {
					if (canvasRef.current) canvasRef.current.style.cursor = 'default'
					releaseHeldInputs()
				}}
			/>

			{showStats && (
				<div
					ref={statsOverlayRef}
					aria-live="off"
					style={{
						position: 'absolute',
						left: 12,
						bottom: 12,
						zIndex: 7,
						pointerEvents: 'none',
						background: 'rgba(10, 12, 18, 0.82)',
						color: '#e2e8f0',
						border: '1px solid rgba(255, 255, 255, 0.14)',
						borderRadius: 8,
						padding: '5px 10px',
						fontSize: 11,
						fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
						backdropFilter: 'blur(8px)',
						maxWidth: 'calc(100% - 24px)',
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					Collecting engine telemetry…
				</div>
			)}

			{sessionLocked && status !== 'error' &&
				(showingLockScreen || mode === 'output' ? (
					<div
						role="status"
						onPointerDown={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
						onKeyUp={(e) => e.stopPropagation()}
						style={{
							position: 'absolute',
							top: 10,
							left: '50%',
							transform: 'translateX(-50%)',
							zIndex: 8,
							background: 'rgba(18, 20, 26, 0.94)',
							color: '#f8fafc',
							border: '1px solid rgba(251, 191, 36, 0.5)',
							borderRadius: 999,
							padding: '6px 12px',
							fontSize: 12,
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							backdropFilter: 'blur(10px)',
							maxWidth: 'calc(100% - 24px)',
							boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
						}}
					>
						<Icon name="key" size={14} />
						<span>Click the lock screen and type your Linux password. Your app returns automatically</span>
						{mode === 'window' && (
							<button
								type="button"
								className="btn small"
								style={{padding: '3px 10px', fontSize: 12}}
								onClick={() => setShowingLockScreen(false)}
							>
								Hide lock screen
							</button>
						)}
					</div>
				) : (
					<div
						role="dialog"
						aria-label="Desktop locked"
						onPointerDown={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
						onKeyUp={(e) => e.stopPropagation()}
						style={{
							position: 'absolute',
							inset: 0,
							zIndex: 8,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							background: 'rgba(10, 12, 18, 0.58)',
							backdropFilter: 'blur(12px)',
							padding: 16,
						}}
					>
						<div
							style={{
								width: '100%',
								maxWidth: 340,
								background: 'rgba(20, 22, 30, 0.94)',
								color: '#f8fafc',
								border: '1px solid rgba(255, 255, 255, 0.14)',
								borderRadius: 14,
								padding: '20px 20px 18px',
								display: 'flex',
								flexDirection: 'column',
								gap: 12,
								boxShadow: '0 20px 50px rgba(0, 0, 0, 0.55)',
							}}
						>
							<div style={{display: 'flex', alignItems: 'center', gap: 10}}>
								<Icon name="key" size={18} />
								<div>
									<div style={{fontWeight: 600, fontSize: 14}}>Omarchy desktop is locked</div>
									<div style={{fontSize: 12, opacity: 0.72}}>Unlock directly on the desktop lock screen; your app returns automatically.</div>
								</div>
							</div>
							<div style={{display: 'flex', justifyContent: 'flex-end'}}>
								<button
									type="button"
									className="btn primary small"
									onClick={() => {
										setShowingLockScreen(true)
										hostRef.current?.focus({preventScroll: true})
									}}
								>
									Show lock screen
								</button>
							</div>
						</div>
					</div>
				))}

			{status !== 'live' && (
				<div className="console-overlay">
					{status === 'connecting' ? (
						<>
							<span className="spinner" style={{width: 28, height: 28}} />
							<span className="muted">Starting direct Hyprland GPU stream…</span>
						</>
					) : (
						<>
							<Icon name="alert" size={32} />
							<b>Direct GPU render unavailable</b>
							<span>{error}</span>
							<div style={{display: 'flex', gap: 8}}>
								<button
									type="button"
									className="btn primary small"
									onClick={() => {
										profilesQ.refetch().catch(() => {})
										setAttempt((a) => a + 1)
									}}
								>
									Try again
								</button>
								{onFallbackVnc && (
									<button type="button" className="btn small" onClick={onFallbackVnc}>
										Use VNC instead
									</button>
								)}
							</div>
						</>
					)}
				</div>
			)}
			<div onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
				<StreamProfilerSheet
					open={showProfiler}
					onClose={() => setShowProfiler(false)}
					onProfileActivated={() => {
						tierOverrideRef.current = null
						chromaOverrideRef.current = null
						codecFallbackRef.current = null
						setTierOverrideState(null)
						setChromaOverrideState(null)
						setCodecFallback(null)
						try {
							localStorage.removeItem(QUALITY_TIER_KEY)
							localStorage.removeItem(CHROMA_444_KEY)
						} catch {}
					}}
				/>
			</div>
		</div>
	)
}
