/**
 * Audio engine for the GSM Call Bridge renderer.
 *
 * Capture:  getUserMedia → ScriptProcessorNode → float32→int16 → 20ms frames
 * Playback: queue PCM16 frames → AudioBufferSourceNode jitter buffer
 */

const TARGET_SAMPLE_RATE = 16000; // PCM16 16 kHz mono
const FRAME_SAMPLES = TARGET_SAMPLE_RATE * 0.02; // 320 samples per 20 ms frame

export class AudioEngine {
	private captureCtx: AudioContext | null = null;
	private playbackCtx: AudioContext | null = null;
	private captureStream: MediaStream | null = null;
	private processor: ScriptProcessorNode | null = null;
	private inputGainNode: GainNode | null = null;
	private outputGainNode: GainNode | null = null;
	private jitterBuffer: Float32Array[] = [];
	private nextPlayTime = 0;
	private playbackSink = '';
	private monitorCtx: AudioContext | null = null;
	private monitorGain: GainNode | null = null;
	private monitorSource: MediaStreamAudioSourceNode | null = null;
	private monitorStream: MediaStream | null = null;
	private monitorEnabled = false;

	// ── Capture ─────────────────────────────────────────────────────────────

	async startCapture(deviceId: string, onFrame: (buf: ArrayBuffer) => void): Promise<void> {
		this.stopCapture();

		const constraints: MediaStreamConstraints = {
			audio: deviceId && deviceId !== 'default'
				? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
				: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
		};

		this.captureStream = await navigator.mediaDevices.getUserMedia(constraints);
		// Use device native rate; we will downsample to TARGET_SAMPLE_RATE in the processor
		this.captureCtx = new AudioContext();
		const sourceRate = this.captureCtx.sampleRate;

		const source = this.captureCtx.createMediaStreamSource(this.captureStream);
		this.inputGainNode = this.captureCtx.createGain();
		source.connect(this.inputGainNode);

		// ScriptProcessorNode: bufferSize chosen so we collect enough samples for resampling
		const bufSize = 4096;
		this.processor = this.captureCtx.createScriptProcessor(bufSize, 1, 1);

		let residual = new Float32Array(0);

		this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
			const input = e.inputBuffer.getChannelData(0);

			// Resample from sourceRate to TARGET_SAMPLE_RATE (linear interpolation)
			const ratio = TARGET_SAMPLE_RATE / sourceRate;
			const outLen = Math.floor(input.length * ratio);
			const resampled = new Float32Array(outLen);
			for (let i = 0; i < outLen; i++) {
				const pos = i / ratio;
				const idx = Math.floor(pos);
				const frac = pos - idx;
				const a = input[idx] ?? 0;
				const b = input[idx + 1] ?? 0;
				resampled[i] = a + frac * (b - a);
			}

			// Concatenate with residual
			const combined = new Float32Array(residual.length + resampled.length);
			combined.set(residual);
			combined.set(resampled, residual.length);

			// Emit 20ms frames
			let offset = 0;
			while (offset + FRAME_SAMPLES <= combined.length) {
				const frame = combined.slice(offset, offset + FRAME_SAMPLES);
				const int16 = float32ToInt16(frame);
				onFrame(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength) as ArrayBuffer);
				offset += FRAME_SAMPLES;
			}
			residual = combined.slice(offset);
		};

		this.inputGainNode.connect(this.processor);
		this.processor.connect(this.captureCtx.destination);
	}

	stopCapture(): void {
		this.disableMonitor();
		if (this.processor) {
			this.processor.disconnect();
			this.processor = null;
		}
		if (this.captureStream) {
			this.captureStream.getTracks().forEach((t) => t.stop());
			this.captureStream = null;
		}
		if (this.captureCtx) {
			this.captureCtx.close().catch(() => {/* ignore */ });
			this.captureCtx = null;
		}
		this.inputGainNode = null;
	}

	setInputGain(value: number): void {
		if (this.inputGainNode) this.inputGainNode.gain.value = value;
	}

	// ── Playback ─────────────────────────────────────────────────────────────

	async startPlayback(deviceId: string): Promise<void> {
		this.stopPlayback();
		this.playbackSink = deviceId;
		this.playbackCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
		this.outputGainNode = this.playbackCtx.createGain();
		this.outputGainNode.connect(this.playbackCtx.destination);
		this.nextPlayTime = this.playbackCtx.currentTime + 0.06; // 60ms initial buffer

		// setSinkId is supported in Chrome/Electron for output device selection
		if (deviceId && deviceId !== 'default' && typeof (this.playbackCtx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId === 'function') {
			try {
				await (this.playbackCtx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
			} catch {
				console.warn('[audio] setSinkId not available, using default output');
			}
		}
	}

	enqueueFrame(buf: ArrayBuffer): void {
		if (!this.playbackCtx || !this.outputGainNode) return;
		const ctx = this.playbackCtx;
		const pcm = new Int16Array(buf);
		const float32 = new Float32Array(pcm.length);
		for (let i = 0; i < pcm.length; i++) {
			float32[i] = pcm[i] / 32768;
		}

		const audioBuffer = ctx.createBuffer(1, float32.length, TARGET_SAMPLE_RATE);
		audioBuffer.copyToChannel(float32, 0);

		const src = ctx.createBufferSource();
		src.buffer = audioBuffer;
		src.connect(this.outputGainNode);

		const startAt = Math.max(this.nextPlayTime, ctx.currentTime + 0.005);
		src.start(startAt);
		this.nextPlayTime = startAt + audioBuffer.duration;
	}

	stopPlayback(): void {
		if (this.playbackCtx) {
			this.playbackCtx.close().catch(() => {/* ignore */ });
			this.playbackCtx = null;
		}
		this.outputGainNode = null;
		this.nextPlayTime = 0;
		this.jitterBuffer = [];
	}

	setOutputGain(value: number): void {
		if (this.outputGainNode) this.outputGainNode.gain.value = value;
	}

	// ── Monitor (sidetone) ──────────────────────────────────────────────────

	async enableMonitor(inputDeviceId: string, outputDeviceId: string): Promise<void> {
		this.disableMonitor();
		this.monitorEnabled = true;

		// Capture mic independently (don't rely on captureStream from WS bridge)
		const constraints: MediaStreamConstraints = {
			audio: inputDeviceId && inputDeviceId !== 'default'
				? { deviceId: { exact: inputDeviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
				: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
		};
		this.monitorStream = await navigator.mediaDevices.getUserMedia(constraints);

		this.monitorCtx = new AudioContext();
		this.monitorSource = this.monitorCtx.createMediaStreamSource(this.monitorStream);
		this.monitorGain = this.monitorCtx.createGain();
		this.monitorGain.gain.value = 0.8;
		this.monitorSource.connect(this.monitorGain);
		this.monitorGain.connect(this.monitorCtx.destination);

		// Route monitor to the selected output device
		if (outputDeviceId && outputDeviceId !== 'default' &&
			typeof (this.monitorCtx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId === 'function') {
			try {
				await (this.monitorCtx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(outputDeviceId);
			} catch {
				console.warn('[audio] monitor setSinkId not available, using default output');
			}
		}
	}

	disableMonitor(): void {
		this.monitorEnabled = false;
		if (this.monitorSource) {
			this.monitorSource.disconnect();
			this.monitorSource = null;
		}
		if (this.monitorGain) {
			this.monitorGain.disconnect();
			this.monitorGain = null;
		}
		if (this.monitorStream) {
			this.monitorStream.getTracks().forEach((t) => t.stop());
			this.monitorStream = null;
		}
		if (this.monitorCtx) {
			this.monitorCtx.close().catch(() => {/* ignore */ });
			this.monitorCtx = null;
		}
	}

	isMonitorEnabled(): boolean {
		return this.monitorEnabled;
	}

	setMonitorGain(value: number): void {
		if (this.monitorGain) this.monitorGain.gain.value = value;
	}

	// ── Feedback detection ───────────────────────────────────────────────────

	static checkFeedback(inputId: string, outputId: string): boolean {
		return Boolean(inputId) && inputId === outputId && inputId !== 'default';
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function float32ToInt16(float32: Float32Array): Int16Array {
	const int16 = new Int16Array(float32.length);
	for (let i = 0; i < float32.length; i++) {
		const s = Math.max(-1, Math.min(1, float32[i]));
		int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return int16;
}
