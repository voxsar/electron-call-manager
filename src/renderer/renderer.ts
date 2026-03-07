/**
 * GSM Call Bridge – Renderer process entry point.
 * Wires the UI to the electronAPI exposed by the preload script.
 */
import { AudioEngine } from './audio';
import { ElevenLabsSession } from './elevenlabs';
import type { ChatMessage } from './elevenlabs';
import type { PortInfo, AppSettings, StatsUpdate, CallStatePayload } from '../types/ipc';

declare global {
	interface Window {
		electronAPI: {
			getPorts: () => Promise<PortInfo[]>;
			openPort: (path: string, baud: number) => Promise<{ success: boolean; error?: string }>;
			closePort: () => Promise<void>;
			sendAt: (cmd: string) => Promise<void>;
			wsConnect: (url: string, settings: AppSettings) => Promise<{ success: boolean; error?: string }>;
			wsDisconnect: () => Promise<void>;
			sendAudio: (buffer: ArrayBuffer) => Promise<void>;
			getSettings: () => Promise<AppSettings>;
			saveSettings: (settings: Partial<AppSettings>) => Promise<void>;
			hangup: () => Promise<void>;
			answer: () => Promise<void>;
			onPortList: (cb: (ports: PortInfo[]) => void) => () => void;
			onPortOpened: (cb: (path: string) => void) => () => void;
			onPortClosed: (cb: () => void) => () => void;
			onPortError: (cb: (error: string) => void) => () => void;
			onSerialData: (cb: (line: string) => void) => () => void;
			onCallState: (cb: (payload: CallStatePayload) => void) => () => void;
			onWsStatus: (cb: (status: string) => void) => () => void;
			onStats: (cb: (stats: StatsUpdate) => void) => () => void;
			onAudioFrame: (cb: (buf: Uint8Array) => void) => () => void;
		};
	}
}

// ── Globals ──────────────────────────────────────────────────────────────────

const api = window.electronAPI;
const audio = new AudioEngine();
const elConvo = new ElevenLabsSession();
let settings: AppSettings = {
	selectedPort: '', baud: 115200, wsUrl: 'ws://localhost:8080',
	inputDeviceId: 'default', outputDeviceId: 'default',
	autoAnswer: false, answerAfterRings: 2, detectCallerId: true, sampleRate: 16000,
	elevenLabsAgentId: 'agent_9201kj20p7psenytqjqcmfw698zb',
	autoAgent: true,
	desktopSpeakerId: 'default',
};
let logFilter: 'all' | 'serial' | 'ws' | 'audio' = 'all';
let portConnected = false;
let wsConnected = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

function appendLog(msg: string, category: 'serial' | 'ws' | 'audio' | 'info' = 'info'): void {
	if (logFilter !== 'all' && logFilter !== category) return;
	const log = el('log-output');
	const line = document.createElement('div');
	line.className = `log-line log-${category}`;
	const ts = new Date().toISOString().slice(11, 23);
	line.textContent = `[${ts}] [${category.toUpperCase()}] ${msg}`;
	log.appendChild(line);
	log.scrollTop = log.scrollHeight;
}

function setStatus(id: string, connected: boolean, label?: string): void {
	const dot = el(`${id}-dot`);
	const txt = el(`${id}-text`);
	dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
	if (label !== undefined) txt.textContent = label;
}

function buildSettings(): AppSettings {
	return {
		selectedPort: (el<HTMLSelectElement>('port-select')).value,
		baud: parseInt((el<HTMLInputElement>('baud-input')).value, 10) || 115200,
		wsUrl: (el<HTMLInputElement>('ws-url-input')).value,
		inputDeviceId: (el<HTMLSelectElement>('mic-select')).value,
		outputDeviceId: (el<HTMLSelectElement>('speaker-select')).value,
		autoAnswer: (el<HTMLInputElement>('auto-answer')).checked,
		answerAfterRings: parseInt((el<HTMLInputElement>('answer-rings')).value, 10) || 1,
		detectCallerId: (el<HTMLInputElement>('detect-clip')).checked,
		sampleRate: ((el<HTMLSelectElement>('sample-rate')).value === '8000' ? 8000 : 16000),
		elevenLabsAgentId: (el<HTMLInputElement>('el-agent-id')).value.trim(),
		autoAgent: (el<HTMLInputElement>('auto-agent')).checked,
		desktopSpeakerId: (el<HTMLSelectElement>('desktop-speaker-select')).value,
	};
}

function checkFeedback(): void {
	const mic = (el<HTMLSelectElement>('mic-select')).value;
	const speaker = (el<HTMLSelectElement>('speaker-select')).value;
	const warning = el('feedback-warning');
	if (AudioEngine.checkFeedback(mic, speaker)) {
		warning.style.display = 'block';
	} else {
		warning.style.display = 'none';
	}
}

async function autoSave(): Promise<void> {
	settings = buildSettings();
	await api.saveSettings(settings);
}

// ── Audio device enumeration ──────────────────────────────────────────────────

async function enumerateDevices(): Promise<void> {
	try {
		// Request permissions first
		await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()));
	} catch { /* permissions may not be needed */ }

	const devices = await navigator.mediaDevices.enumerateDevices();
	const micSel = el<HTMLSelectElement>('mic-select');
	const speakerSel = el<HTMLSelectElement>('speaker-select');
	const desktopSpeakerSel = el<HTMLSelectElement>('desktop-speaker-select');

	// Clear existing options except default
	while (micSel.options.length > 1) micSel.remove(1);
	while (speakerSel.options.length > 1) speakerSel.remove(1);
	while (desktopSpeakerSel.options.length > 1) desktopSpeakerSel.remove(1);

	devices.forEach((d) => {
		if (d.kind === 'audioinput') {
			const opt = new Option(d.label || `Microphone ${d.deviceId.slice(0, 8)}`, d.deviceId);
			micSel.add(opt);
		} else if (d.kind === 'audiooutput') {
			const opt = new Option(d.label || `Speaker ${d.deviceId.slice(0, 8)}`, d.deviceId);
			speakerSel.add(opt);
			const opt2 = new Option(d.label || `Speaker ${d.deviceId.slice(0, 8)}`, d.deviceId);
			desktopSpeakerSel.add(opt2);
		}
	});

	// Restore saved selections
	micSel.value = settings.inputDeviceId;
	speakerSel.value = settings.outputDeviceId;
	desktopSpeakerSel.value = settings.desktopSpeakerId;
}

// ── Port management ───────────────────────────────────────────────────────────

function populatePorts(ports: PortInfo[]): void {
	const sel = el<HTMLSelectElement>('port-select');
	const prev = sel.value;
	while (sel.options.length > 1) sel.remove(1);

	const gsmKeywords = ['modem', 'gsm', 'sim', 'huawei', 'sierra', 'telit', 'option', 'zte', 'quectel', 'fibocom'];

	ports.forEach((p) => {
		const mfr = (p.manufacturer || '').toLowerCase();
		const isLikely = gsmKeywords.some((k) => mfr.includes(k));
		const label = `${p.path}${p.manufacturer ? ` (${p.manufacturer})` : ''}${isLikely ? ' ★' : ''}`;
		const opt = new Option(label, p.path);
		if (isLikely) opt.style.fontWeight = 'bold';
		sel.add(opt);
	});

	if (prev && Array.from(sel.options).some((o) => o.value === prev)) {
		sel.value = prev;
	} else if (settings.selectedPort) {
		sel.value = settings.selectedPort;
	}
}

// ── Main init ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
	// Load persisted settings
	settings = await api.getSettings();

	// Restore UI values
	(el<HTMLInputElement>('baud-input')).value = String(settings.baud);
	(el<HTMLInputElement>('ws-url-input')).value = settings.wsUrl;
	(el<HTMLInputElement>('auto-answer')).checked = settings.autoAnswer;
	(el<HTMLInputElement>('answer-rings')).value = String(settings.answerAfterRings);
	(el<HTMLInputElement>('detect-clip')).checked = settings.detectCallerId;
	(el<HTMLSelectElement>('sample-rate')).value = String(settings.sampleRate);
	(el<HTMLInputElement>('el-agent-id')).value = settings.elevenLabsAgentId || 'agent_9201kj20p7psenytqjqcmfw698zb';
	(el<HTMLInputElement>('auto-agent')).checked = settings.autoAgent;
	if (settings.desktopSpeakerId) {
		// Will be set after enumerateDevices populates the dropdown
	}

	await enumerateDevices();

	// ── Port events ─────────────────────────────────────────────────────────

	api.onPortList((ports) => populatePorts(ports));

	api.onPortOpened((path) => {
		portConnected = true;
		setStatus('serial', true, path);
		(el('port-connect-btn') as HTMLButtonElement).textContent = 'Disconnect';
		appendLog(`Port opened: ${path}`, 'serial');
	});

	api.onPortClosed(() => {
		portConnected = false;
		setStatus('serial', false, 'Not connected');
		(el('port-connect-btn') as HTMLButtonElement).textContent = 'Connect';
		appendLog('Port closed', 'serial');
	});

	api.onPortError((err) => {
		appendLog(`Serial error: ${err}`, 'serial');
	});

	// ── Serial data ──────────────────────────────────────────────────────────

	api.onSerialData((line) => {
		appendLog(line, 'serial');
	});

	// ── Call state ───────────────────────────────────────────────────────────

	api.onCallState(async (payload) => {
		const label = payload.callerId
			? `${payload.state} (${payload.callerId})`
			: payload.state;
		setStatus('call', payload.state !== 'idle', label);
		el('caller-id-display').textContent = payload.callerId || '';
		appendLog(`Call state: ${payload.state}${payload.callerId ? ` caller=${payload.callerId}` : ''}`, 'serial');

		// Auto-agent: start ElevenLabs agent 1s after call connects, stop when idle
		const currentSettings = buildSettings();
		if (currentSettings.autoAgent) {
			if (payload.state === 'answered' && elConvo.getStatus() === 'disconnected') {
				const agentId = currentSettings.elevenLabsAgentId;
				if (agentId) {
					appendLog('Auto-agent: call connected, starting agent in 1s...', 'ws');
					setTimeout(async () => {
						// Re-check state — call may have ended during the delay
						if (elConvo.getStatus() !== 'disconnected') return;
						try {
							const s = buildSettings();
							const convId = await elConvo.start(agentId, s.inputDeviceId, s.outputDeviceId);
							appendLog(`Auto-agent: conversation started (${convId})`, 'ws');
							appendLog(`Auto-agent: agent mic=${s.inputDeviceId}, agent spkr=${s.outputDeviceId}, desktop=${s.desktopSpeakerId}`, 'audio');
							audio.enableMonitor(s.inputDeviceId, s.desktopSpeakerId).catch((err: Error) =>
								appendLog(`Monitor error: ${err.message}`, 'audio'));
							(el<HTMLInputElement>('monitor-audio')).checked = true;
							appendLog('Auto-agent: mic monitor enabled on desktop speaker', 'audio');
						} catch (err: unknown) {
							appendLog(`Auto-agent error: ${err instanceof Error ? err.message : String(err)}`, 'ws');
						}
					}, 1000);
				}
			} else if (payload.state === 'idle' && elConvo.getStatus() !== 'disconnected') {
				appendLog('Auto-agent: stopping ElevenLabs agent (call ended)', 'ws');
				elConvo.stop();
				audio.disableMonitor();
				(el<HTMLInputElement>('monitor-audio')).checked = false;
				appendLog('Auto-agent: mic monitor disabled', 'audio');
			}
		}
	});

	// ── WebSocket events ─────────────────────────────────────────────────────

	api.onWsStatus((status) => {
		wsConnected = status === 'connected';
		setStatus('ws', wsConnected, status);
		(el('ws-connect-btn') as HTMLButtonElement).textContent = wsConnected ? 'Disconnect' : 'Connect';
		appendLog(`WebSocket: ${status}`, 'ws');

		if (wsConnected) {
			audio.startCapture(settings.inputDeviceId, (buf) => {
				api.sendAudio(buf).catch(() => {/* ignore */ });
			}).catch((err: Error) => appendLog(`Audio capture error: ${err.message}`, 'audio'));
			audio.startPlayback(settings.outputDeviceId).catch((err: Error) =>
				appendLog(`Playback error: ${err.message}`, 'audio'));
		} else {
			audio.stopCapture();
			audio.stopPlayback();
		}
	});

	api.onAudioFrame((buf) => {
		audio.enqueueFrame(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
	});

	// ── Stats ────────────────────────────────────────────────────────────────

	api.onStats((stats) => {
		el('stat-sent').textContent = formatBytes(stats.bytesSent);
		el('stat-received').textContent = formatBytes(stats.bytesReceived);
		el('stat-pkts-sent').textContent = String(stats.packetsSent);
		el('stat-pkts-recv').textContent = String(stats.packetsReceived);
		el('stat-latency').textContent = `${stats.latencyMs} ms`;
	});

	// ── Buttons ──────────────────────────────────────────────────────────────

	el('port-refresh-btn').addEventListener('click', async () => {
		const ports = await api.getPorts();
		populatePorts(ports);
		appendLog('Port list refreshed', 'serial');
	});

	el('port-connect-btn').addEventListener('click', async () => {
		if (portConnected) {
			await api.closePort();
		} else {
			const path = (el<HTMLSelectElement>('port-select')).value;
			const baud = parseInt((el<HTMLInputElement>('baud-input')).value, 10) || 115200;
			if (!path) { appendLog('Select a port first', 'serial'); return; }
			const result = await api.openPort(path, baud) as { success: boolean; error?: string };
			if (!result.success) appendLog(`Failed to open port: ${result.error}`, 'serial');
		}
	});

	el('ws-connect-btn').addEventListener('click', async () => {
		if (wsConnected) {
			await api.wsDisconnect();
		} else {
			const url = (el<HTMLInputElement>('ws-url-input')).value;
			if (!url) { appendLog('Enter a WebSocket URL', 'ws'); return; }
			const result = await api.wsConnect(url, buildSettings()) as { success: boolean; error?: string };
			if (!result.success) appendLog(`WebSocket error: ${result.error}`, 'ws');
		}
	});

	el('answer-btn').addEventListener('click', () => api.answer());
	el('hangup-btn').addEventListener('click', () => api.hangup());

	el('send-at-btn').addEventListener('click', () => {
		const cmd = (el<HTMLInputElement>('at-input')).value.trim();
		if (cmd) {
			api.sendAt(cmd);
			appendLog(`> ${cmd}`, 'serial');
		}
	});

	(el<HTMLInputElement>('at-input')).addEventListener('keydown', (e) => {
		if (e.key === 'Enter') el('send-at-btn').click();
	});

	// Quick AT shortcut buttons
	document.querySelectorAll<HTMLButtonElement>('[data-at]').forEach((btn) => {
		btn.addEventListener('click', () => {
			const cmd = btn.getAttribute('data-at') ?? '';
			if (cmd) {
				(el<HTMLInputElement>('at-input')).value = cmd;
				el('send-at-btn').click();
			}
		});
	});

	// Log filter tabs
	document.querySelectorAll('.log-tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			document.querySelectorAll('.log-tab').forEach((t) => t.classList.remove('active'));
			tab.classList.add('active');
			logFilter = (tab.getAttribute('data-filter') as typeof logFilter) || 'all';
		});
	});

	el('log-clear-btn').addEventListener('click', () => {
		el('log-output').innerHTML = '';
	});

	// ── ElevenLabs agent conversation ─────────────────────────────────────────

	elConvo.setCallbacks({
		onStatus: (status) => {
			const dot = el('el-dot');
			const txt = el('el-text');
			const isOn = status === 'connected';
			dot.className = `status-dot ${isOn ? 'connected' : 'disconnected'}`;
			txt.textContent = status;

			const startBtn = el<HTMLButtonElement>('el-connect-btn');
			const stopBtn = el<HTMLButtonElement>('el-disconnect-btn');
			const idInput = el<HTMLInputElement>('el-agent-id');

			if (isOn) {
				startBtn.disabled = true;
				stopBtn.disabled = false;
				idInput.disabled = true;
			} else {
				startBtn.disabled = false;
				stopBtn.disabled = true;
				idInput.disabled = false;
			}

			appendLog(`ElevenLabs Agent: ${status}`, 'ws');
		},

		onChat: (msg: ChatMessage) => {
			const container = el('chat-messages');

			if (msg.role === 'agent') {
				// SDK delivers finalized agent messages; always create a new bubble
				const bubble = createChatBubble(msg);
				container.appendChild(bubble);
			} else {
				container.appendChild(createChatBubble(msg));
			}

			container.scrollTop = container.scrollHeight;
		},

		onMode: (mode) => {
			const dot = el('el-dot');
			if (mode === 'speaking') {
				dot.className = 'status-dot ringing'; // pulsing indicator while agent speaks
			} else {
				dot.className = 'status-dot connected';
			}
		},

		onError: (message) => {
			appendLog(`ElevenLabs error: ${message}`, 'ws');
		},
	});

	el('el-connect-btn').addEventListener('click', async () => {
		const agentId = (el<HTMLInputElement>('el-agent-id')).value.trim();
		if (!agentId) { appendLog('Enter an Agent ID first', 'ws'); return; }
		try {
			const currentSettings = buildSettings();
			const convId = await elConvo.start(agentId, currentSettings.inputDeviceId, currentSettings.outputDeviceId);
			appendLog(`ElevenLabs conversation started: ${convId}`, 'ws');
			settings.elevenLabsAgentId = agentId;
			await api.saveSettings({ elevenLabsAgentId: agentId });
		} catch (err: unknown) {
			appendLog(`ElevenLabs error: ${err instanceof Error ? err.message : String(err)}`, 'ws');
		}
	});

	el('el-disconnect-btn').addEventListener('click', () => {
		elConvo.stop();
	});

	el('chat-clear-btn').addEventListener('click', () => {
		el('chat-messages').innerHTML = '';
	});

	// ── Auto-save on any setting change ──────────────────────────────────────

	// ── Monitor toggle ──────────────────────────────────────────────────────

	el('monitor-audio').addEventListener('change', () => {
		const checked = (el<HTMLInputElement>('monitor-audio')).checked;
		if (checked) {
			const micId = (el<HTMLSelectElement>('mic-select')).value;
			const desktopId = (el<HTMLSelectElement>('desktop-speaker-select')).value;
			audio.enableMonitor(micId, desktopId).catch((err: Error) =>
				appendLog(`Monitor error: ${err.message}`, 'audio'));
			appendLog('Audio monitor enabled — you can hear your mic through the desktop speaker', 'audio');
		} else {
			audio.disableMonitor();
			appendLog('Audio monitor disabled', 'audio');
		}
	});

	const watchIds = [
		'baud-input', 'ws-url-input', 'auto-answer', 'answer-rings',
		'detect-clip', 'sample-rate', 'mic-select', 'speaker-select', 'el-agent-id', 'auto-agent',
		'desktop-speaker-select',
	];
	watchIds.forEach((id) => {
		const elem = document.getElementById(id);
		elem?.addEventListener('change', () => {
			checkFeedback();
			autoSave();
		});
	});

	appendLog('GSM Call Manager ready.', 'info');
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createChatBubble(msg: ChatMessage): HTMLElement {
	const bubble = document.createElement('div');
	bubble.className = `chat-bubble ${msg.role}`;

	const role = document.createElement('div');
	role.className = 'chat-role';
	role.textContent = msg.role === 'user' ? 'You' : 'Agent';
	bubble.appendChild(role);

	const text = document.createElement('div');
	text.className = 'chat-text';
	text.textContent = msg.text;
	bubble.appendChild(text);

	const time = document.createElement('div');
	time.className = 'chat-time';
	time.textContent = new Date(msg.ts).toLocaleTimeString();
	bubble.appendChild(time);

	return bubble;
}
