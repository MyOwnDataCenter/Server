// Pure state transitions for Hyprland stream codec confirmation and live-reconfig rollback.

export function parseActualCodec(encoderStr) {
	const s = String(encoderStr || 'h264').toLowerCase()
	if (s.startsWith('hevc444')) return 'hevc444'
	if (s.startsWith('hevc10')) return 'hevc10'
	if (s.startsWith('hevc')) return 'hevc'
	return 'h264'
}

export function isStreamCodec(v) {
	return v === 'h264' || v === 'hevc' || v === 'hevc10' || v === 'hevc444'
}

export function createStreamControlState({tier, chroma444Pref, effective444, codec}) {
	return {
		handshakeTier: tier,
		handshakeEffective444: Boolean(effective444),
		appliedTier: tier,
		applied444Pref: Boolean(chroma444Pref),
		appliedCodec: codec,
	}
}

export function shouldReplayHandshakeReconfig(state, {tier, chroma444Pref, supportsHevc444}) {
	const latestEffective444 = Boolean(supportsHevc444 && chroma444Pref)
	return tier !== state.handshakeTier || latestEffective444 !== state.handshakeEffective444
}

export function applyMetaToStreamControl(state, encoderStr) {
	const actualCodec = parseActualCodec(encoderStr)
	return {
		state: {
			...state,
			appliedCodec: actualCodec,
		},
		actualCodec,
	}
}

export function applyReconfigAppliedToStreamControl(state, {codec, tier, chroma444Pref}) {
	const nextCodec = isStreamCodec(codec) ? codec : state.appliedCodec
	return {
		state: {
			...state,
			appliedTier: tier,
			applied444Pref: Boolean(chroma444Pref),
			appliedCodec: nextCodec,
		},
		confirmedCodec: isStreamCodec(codec) ? codec : null,
	}
}

export function applyReconfigUnsupportedToStreamControl(state) {
	return {
		tier: state.appliedTier,
		chroma444Pref: state.applied444Pref,
		codec: state.appliedCodec,
	}
}

export function applyMetaToProfiledStreamState(appliedCfg, encoderStr) {
	const actualCodec = parseActualCodec(encoderStr)
	return {
		appliedCfg: {
			...appliedCfg,
			codec: actualCodec,
		},
		actualCodec,
	}
}

export function applyReconfigAppliedToProfiledStreamState(
	appliedCfg,
	{msgCodec, msgBitrate, msgQuality, activeCodec, tierOverride, chromaOverride, codecFallback},
) {
	const appliedCodec = isStreamCodec(msgCodec) ? msgCodec : activeCodec
	return {
		appliedCfg: {
			codec: appliedCodec,
			bitrate: Number(msgBitrate) || appliedCfg.bitrate,
			quality: Number.isFinite(Number(msgQuality)) ? Number(msgQuality) : appliedCfg.quality,
			tierOverride,
			chromaOverride,
			codecFallback,
		},
		appliedCodec,
	}
}

export function applyReconfigUnsupportedToProfiledStreamState(appliedCfg) {
	return {
		tierOverride: appliedCfg.tierOverride,
		chromaOverride: appliedCfg.chromaOverride,
		codecFallback: appliedCfg.codecFallback,
		codec: appliedCfg.codec,
	}
}

export function createRttStats() {
	return {rttMs: null, jitterMs: 0, samples: 0}
}

export function updateRttStats(prev, sampleMs) {
	if (typeof sampleMs !== 'number' || !Number.isFinite(sampleMs) || sampleMs < 0 || sampleMs >= 10000) {
		return prev
	}
	if (prev.rttMs === null) {
		return {rttMs: sampleMs, jitterMs: 0, samples: 1}
	}
	const diff = Math.abs(sampleMs - prev.rttMs)
	return {
		rttMs: prev.rttMs * 0.65 + sampleMs * 0.35,
		jitterMs: prev.jitterMs * 0.75 + diff * 0.25,
		samples: prev.samples + 1,
	}
}

// Compute WebAudio jitter cushion that preserves tight LAN latency while expanding smoothly on WAN/relayed links.
export function computeAudioJitterBudget({rttMs, jitterMs = 0, mode = 'opus'}) {
	const isPcm = mode === 'pcm'
	const baseTarget = isPcm ? 0.035 : 0.025
	const minLeadSec = isPcm ? 0.005 : 0.004
	const baseMax = isPcm ? 0.16 : 0.14
	const maxTarget = isPcm ? 0.14 : 0.12
	const effRtt = typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0 ? rttMs : 0
	const effJitter = typeof jitterMs === 'number' && Number.isFinite(jitterMs) && jitterMs > 0 ? jitterMs : 0
	if (effRtt <= 12 && effJitter <= 3) {
		return {targetSec: baseTarget, minLeadSec, maxLeadSec: baseMax}
	}
	const adaptiveSec = (effRtt * 0.65 + effJitter * 2.5 + (isPcm ? 20 : 12)) / 1000
	const targetSec = Math.max(baseTarget, Math.min(maxTarget, adaptiveSec))
	const maxLeadSec = Math.max(baseMax, targetSec + 0.12)
	return {targetSec, minLeadSec, maxLeadSec}
}

// Scale WebCodecs decode-queue drop tolerance with WAN RTT/jitter so TCP burst drains do not trigger false IDR freezes.
export function computeVideoDropPolicy({rttMs, jitterMs = 0}) {
	const effRtt = typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs > 0 ? rttMs : 0
	const effJitter = typeof jitterMs === 'number' && Number.isFinite(jitterMs) && jitterMs > 0 ? jitterMs : 0
	if (effRtt <= 15 && effJitter <= 5) {
		return {queueThreshold: 4, sustainMs: 80, hardCap: 12}
	}
	const sustainMs = Math.max(80, Math.min(200, Math.round(80 + Math.max(0, effRtt - 15) * 1.4 + effJitter * 3)))
	const hardCap = effRtt > 35 || effJitter > 10 ? 16 : 14
	return {queueThreshold: 4, sustainMs, hardCap}
}

export function classifyNetworkQuality({rttMs, jitterMs = 0}) {
	if (typeof rttMs !== 'number' || !Number.isFinite(rttMs)) return 'unknown'
	const effJitter = typeof jitterMs === 'number' && Number.isFinite(jitterMs) && jitterMs > 0 ? jitterMs : 0
	if (rttMs > 35 || effJitter > 10) return 'high-jitter'
	if (rttMs > 15 || effJitter > 4) return 'wan'
	return 'lan'
}
