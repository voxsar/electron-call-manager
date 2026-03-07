import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { SerialManager } from './serial';
import { WsBridge } from './wsbridge';
import { IPC, INVOKE } from '../types/ipc';
import type { AppSettings, CallState, StatsUpdate, CallStatePayload } from '../types/ipc';
import { DeviceManager } from './device/DeviceManager';

// ── Persistent settings ──────────────────────────────────────────────────────

const defaultSettings: AppSettings = {
	selectedPort: '',
	baud: 115200,
	wsUrl: 'ws://localhost:8080',
	inputDeviceId: 'default',
	outputDeviceId: 'default',
	autoAnswer: false,
	answerAfterRings: 2,
	detectCallerId: true,
	sampleRate: 16000,
	elevenLabsAgentId: 'agent_9201kj20p7psenytqjqcmfw698zb',
	autoAgent: true,
	desktopSpeakerId: 'default',
};

// electron-store v8 ships with a CJS build; esModuleInterop handles the import.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = new (Store as any)({ defaults: defaultSettings }) as {
	get(key: string, defaultValue?: unknown): unknown;
	set(key: string, value: unknown): void;
	store: Record<string, unknown>;
};

function getSettings(): AppSettings {
	const s = store.store;
	return {
		selectedPort: (s['selectedPort'] as string) || '',
		baud: (s['baud'] as number) || 115200,
		wsUrl: (s['wsUrl'] as string) || 'ws://localhost:8080',
		inputDeviceId: (s['inputDeviceId'] as string) || 'default',
		outputDeviceId: (s['outputDeviceId'] as string) || 'default',
		autoAnswer: Boolean(s['autoAnswer']),
		answerAfterRings: (s['answerAfterRings'] as number) || 2,
		detectCallerId: s['detectCallerId'] !== false,
		sampleRate: ((s['sampleRate'] as number) === 8000 ? 8000 : 16000),
		elevenLabsAgentId: (s['elevenLabsAgentId'] as string) || 'agent_9201kj20p7psenytqjqcmfw698zb',
		autoAgent: Boolean(s['autoAgent']),
		desktopSpeakerId: (s['desktopSpeakerId'] as string) || 'default',
	};
}

// ── Singletons ───────────────────────────────────────────────────────────────

let win: BrowserWindow | null = null;
const serial        = new SerialManager();
const wsBridge      = new WsBridge();
const deviceManager = new DeviceManager(serial);

// ── Call state machine ───────────────────────────────────────────────────────

let callState: CallState = 'idle';
let callerId = '';
let autoAnswerTimer: ReturnType<typeof setTimeout> | null = null;

function pushCallState(state: CallState, cid?: string): void {
	callState = state;
	if (cid !== undefined) callerId = cid;
	sendToRenderer(IPC.CALL_STATE, { state: callState, callerId } as CallStatePayload);
}

// ── Renderer helpers ─────────────────────────────────────────────────────────

function sendToRenderer(channel: string, ...args: unknown[]): void {
	if (win && !win.isDestroyed()) {
		win.webContents.send(channel, ...args);
	}
}

// ── Window factory ───────────────────────────────────────────────────────────

function createWindow(): void {
	win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 900,
		minHeight: 600,
		backgroundColor: '#1a1a2e',
		title: 'GSM Call Manager',
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(__dirname, '../preload/preload.js'),
		},
	});

	win.loadFile(path.join(__dirname, '../renderer/index.html'));

	win.on('closed', () => { win = null; });
}

// ── Serial event forwarding ───────────────────────────────────────────────────

serial.on('line', (line: string) => {
	sendToRenderer(IPC.SERIAL_DATA, line);
});

serial.on('opened', (portPath: string) => {
	sendToRenderer(IPC.PORT_OPENED, portPath);
	const settings = getSettings();
	if (settings.detectCallerId) serial.enableCLIP();
});

serial.on('closed', () => {
	sendToRenderer(IPC.PORT_CLOSED);
	pushCallState('idle');
});

serial.on('error', (err: Error) => {
	sendToRenderer(IPC.PORT_ERROR, err.message);
});

serial.on('ring', (count: number) => {
	if (callState === 'idle') {
		pushCallState('ringing', callerId);
	}
	const settings = getSettings();
	if (settings.autoAnswer && count >= settings.answerAfterRings) {
		if (autoAnswerTimer) clearTimeout(autoAnswerTimer);
		autoAnswerTimer = setTimeout(() => {
			serial.sendATA();
			pushCallState('answered');
			autoAnswerTimer = null;
		}, 500);
	}
});

serial.on('clip', (line: string) => {
	// +CLIP: "number",type,...
	const m = line.match(/\+CLIP:\s*"([^"]*)"/);
	if (m) {
		callerId = m[1];
		if (callState === 'ringing') {
			sendToRenderer(IPC.CALL_STATE, { state: callState, callerId } as CallStatePayload);
		}
	}
});

serial.on('callEnded', () => {
	callerId = '';
	pushCallState('idle');
});

// ── WsBridge event forwarding ─────────────────────────────────────────────────

wsBridge.on('status', (status: string) => {
	sendToRenderer(IPC.WS_STATUS, status);
});

wsBridge.on('audioFrame', (buf: Buffer) => {
	sendToRenderer(IPC.AUDIO_FRAME, buf);
});

wsBridge.on('control', (msg: unknown) => {
	console.log('[WsBridge] control message:', msg);
});

// ── Stats timer ───────────────────────────────────────────────────────────────

let statsTimer: ReturnType<typeof setInterval> | null = null;

function startStatsTimer(): void {
	if (statsTimer) clearInterval(statsTimer);
	statsTimer = setInterval(() => {
		const s = wsBridge.getStats();
		const update: StatsUpdate = {
			bytesSent: s.bytesSent,
			bytesReceived: s.bytesReceived,
			packetsSent: s.packetsSent,
			packetsReceived: s.packetsReceived,
			latencyMs: 0,
		};
		sendToRenderer(IPC.STATS, update);
	}, 2000);
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle(INVOKE.GET_PORTS, async () => serial.listPorts());

ipcMain.handle(INVOKE.OPEN_PORT, async (_evt, portPath: string, baud: number) => {
	try {
		await serial.open(portPath, baud);
		store.set('selectedPort', portPath);
		store.set('baud', baud);
		return { success: true };
	} catch (err: unknown) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
});

ipcMain.handle(INVOKE.CLOSE_PORT, async () => {
	await serial.close();
});

ipcMain.handle(INVOKE.SEND_AT, async (_evt, cmd: string) => {
	serial.sendCommand(cmd);
});

ipcMain.handle(INVOKE.WS_CONNECT, async (_evt, url: string, settings: AppSettings) => {
	try {
		store.set('wsUrl', url);
		await wsBridge.connect(url, settings);
		return { success: true };
	} catch (err: unknown) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
});

ipcMain.handle(INVOKE.WS_DISCONNECT, async () => {
	wsBridge.disconnect();
});

ipcMain.handle(INVOKE.SEND_AUDIO, async (_evt, buf: Buffer | Uint8Array) => {
	const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as Uint8Array);
	wsBridge.sendAudio(buffer);
});

ipcMain.handle(INVOKE.GET_SETTINGS, async () => getSettings());

ipcMain.handle(INVOKE.SAVE_SETTINGS, async (_evt, newSettings: Partial<AppSettings>) => {
	for (const [key, value] of Object.entries(newSettings)) {
		store.set(key, value);
	}
});

ipcMain.handle(INVOKE.HANGUP, async () => {
	serial.sendATH();
	pushCallState('idle');
});

ipcMain.handle(INVOKE.ANSWER, async () => {
	serial.sendATA();
	pushCallState('answered');
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
	createWindow();
	startStatsTimer();

	// Push initial port list as soon as renderer is ready.
	win?.webContents.once('did-finish-load', async () => {
		try {
			const ports = await serial.listPorts();
			sendToRenderer(IPC.PORT_LIST, ports);

			// Auto-probe: try each port to find a modem that responds to AT
			if (!serial.isOpen()) {
				const settings = getSettings();
				console.log('[auto-probe] Probing', ports.length, 'ports for AT modem...');
				for (const p of ports) {
					try {
						const ok = await SerialManager.probePort(p.path, settings.baud);
						if (ok) {
							console.log('[auto-probe] Modem found on', p.path);
							// Small delay to ensure probe port is fully released by OS
							await new Promise(r => setTimeout(r, 500));
							await serial.open(p.path, settings.baud);
							store.set('selectedPort', p.path);
							break;
						}
					} catch {
						// port not usable, continue
					}
				}
				if (!serial.isOpen()) {
					console.log('[auto-probe] No AT modem found on any port');
				}
			}
		} catch (err) {
			console.error('[auto-probe] error:', err);
		}
	});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on('before-quit', async (evt) => {
	evt.preventDefault();
	if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
	if (serial.isOpen()) await serial.close().catch(console.error);
	wsBridge.disconnect();
	app.exit(0);
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
