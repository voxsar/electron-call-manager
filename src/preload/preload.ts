/**
 * Preload script – runs in the renderer context with Node.js access.
 * Uses contextBridge to expose a safe, whitelisted API to the renderer.
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC, INVOKE } from '../types/ipc';
import type { PortInfo, AppSettings, StatsUpdate, CallStatePayload } from '../types/ipc';

// ── Whitelist sets ──────────────────────────────────────────────────────────

const ALLOWED_INVOKE = new Set<string>(Object.values(INVOKE));
const ALLOWED_IPC = new Set<string>(Object.values(IPC));

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
	if (!ALLOWED_INVOKE.has(channel)) {
		return Promise.reject(new Error(`[preload] Disallowed invoke channel: ${channel}`));
	}
	return ipcRenderer.invoke(channel, ...args);
}

type CleanupFn = () => void;

function onChannel<T>(channel: string, cb: (data: T) => void): CleanupFn {
	if (!ALLOWED_IPC.has(channel)) {
		console.warn(`[preload] Disallowed IPC channel: ${channel}`);
		return () => { /* noop */ };
	}
	const handler = (_evt: IpcRendererEvent, data: T) => cb(data);
	ipcRenderer.on(channel, handler as (...args: unknown[]) => void);
	return () => ipcRenderer.removeListener(channel, handler as (...args: unknown[]) => void);
}

// ── Exposed API ──────────────────────────────────────────────────────────────

const electronAPI = {
	// ── Invoke (renderer → main, returns Promise) ──────────────────────────
	getPorts: () => safeInvoke(INVOKE.GET_PORTS) as Promise<PortInfo[]>,
	openPort: (path: string, baud: number) => safeInvoke(INVOKE.OPEN_PORT, path, baud),
	closePort: () => safeInvoke(INVOKE.CLOSE_PORT),
	sendAt: (cmd: string) => safeInvoke(INVOKE.SEND_AT, cmd),
	wsConnect: (url: string, settings: AppSettings) => safeInvoke(INVOKE.WS_CONNECT, url, settings),
	wsDisconnect: () => safeInvoke(INVOKE.WS_DISCONNECT),
	sendAudio: (buffer: ArrayBuffer) => safeInvoke(INVOKE.SEND_AUDIO, buffer),
	getSettings: () => safeInvoke(INVOKE.GET_SETTINGS) as Promise<AppSettings>,
	saveSettings: (settings: Partial<AppSettings>) => safeInvoke(INVOKE.SAVE_SETTINGS, settings),
	hangup: () => safeInvoke(INVOKE.HANGUP),
	answer: () => safeInvoke(INVOKE.ANSWER),
	getBtDevices: () => safeInvoke(INVOKE.GET_BT_DEVICES) as Promise<{ success: boolean; devices: unknown[]; error?: string }>,
	btConnect: (deviceId: string) => safeInvoke(INVOKE.BT_CONNECT, deviceId),
	btDisconnect: (deviceId: string) => safeInvoke(INVOKE.BT_DISCONNECT, deviceId),
	getDeviceStatus: () => safeInvoke(INVOKE.GET_DEVICE_STATUS),

	// ── Event subscriptions (main → renderer, returns cleanup fn) ─────────
	onPortList: (cb: (ports: PortInfo[]) => void) => onChannel<PortInfo[]>(IPC.PORT_LIST, cb),
	onPortOpened: (cb: (path: string) => void) => onChannel<string>(IPC.PORT_OPENED, cb),
	onPortClosed: (cb: () => void) => {
		const handler = () => cb();
		ipcRenderer.on(IPC.PORT_CLOSED, handler);
		return () => ipcRenderer.removeListener(IPC.PORT_CLOSED, handler);
	},
	onPortError: (cb: (error: string) => void) => onChannel<string>(IPC.PORT_ERROR, cb),
	onSerialData: (cb: (line: string) => void) => onChannel<string>(IPC.SERIAL_DATA, cb),
	onCallState: (cb: (payload: CallStatePayload) => void) => onChannel<CallStatePayload>(IPC.CALL_STATE, cb),
	onWsStatus: (cb: (status: string) => void) => onChannel<string>(IPC.WS_STATUS, cb),
	onStats: (cb: (stats: StatsUpdate) => void) => onChannel<StatsUpdate>(IPC.STATS, cb),
	onAudioFrame: (cb: (buf: Uint8Array) => void) => {
		const handler = (_evt: IpcRendererEvent, data: unknown) => {
			if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
				cb(data as Uint8Array);
			}
		};
		ipcRenderer.on(IPC.AUDIO_FRAME, handler as (...args: unknown[]) => void);
		return () => ipcRenderer.removeListener(IPC.AUDIO_FRAME, handler as (...args: unknown[]) => void);
	},
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
