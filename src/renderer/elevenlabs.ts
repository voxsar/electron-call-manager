/**
 * ElevenLabs Conversational AI – renderer-side session manager.
 *
 * Uses the official @elevenlabs/client SDK `Conversation` class which handles
 * WebSocket connection, mic capture, audio playback, ping/pong, and event
 * routing automatically.  We wire callbacks to drive the chat UI.
 */

import { Conversation } from '@elevenlabs/client';
import type { Status, Mode, DisconnectionDetails } from '@elevenlabs/client';
import type { MessagePayload } from '@elevenlabs/types';

export type ELStatus = Status; // 'disconnected' | 'connecting' | 'connected' | 'disconnecting'

export interface ChatMessage {
	role: 'user' | 'agent';
	text: string;
	ts: number;
}

type StatusCallback = (status: ELStatus) => void;
type ChatCallback = (msg: ChatMessage) => void;
type ModeCallback = (mode: Mode) => void;
type ErrorCallback = (message: string) => void;

export class ElevenLabsSession {
	private conversation: Conversation | null = null;
	private currentStatus: ELStatus = 'disconnected';
	private inputDeviceId: string | undefined;
	private outputDeviceId: string | undefined;

	// Callbacks set by the renderer
	private onStatus: StatusCallback = () => { };
	private onChat: ChatCallback = () => { };
	private onMode: ModeCallback = () => { };
	private onError: ErrorCallback = () => { };

	setCallbacks(cbs: {
		onStatus?: StatusCallback;
		onChat?: ChatCallback;
		onMode?: ModeCallback;
		onError?: ErrorCallback;
	}): void {
		if (cbs.onStatus) this.onStatus = cbs.onStatus;
		if (cbs.onChat) this.onChat = cbs.onChat;
		if (cbs.onMode) this.onMode = cbs.onMode;
		if (cbs.onError) this.onError = cbs.onError;
	}

	getStatus(): ELStatus { return this.currentStatus; }

	// ── Start session ──────────────────────────────────────────────────────

	async start(agentId: string, inputDeviceId?: string, outputDeviceId?: string): Promise<string> {
		if (this.conversation) {
			await this.stop();
		}

		this.inputDeviceId = inputDeviceId;
		this.outputDeviceId = outputDeviceId;

		// Request mic permission before SDK session (required)
		const micConstraints: MediaStreamConstraints = {
			audio: inputDeviceId && inputDeviceId !== 'default'
				? { deviceId: { exact: inputDeviceId } }
				: true,
		};
		await navigator.mediaDevices.getUserMedia(micConstraints).then(s => s.getTracks().forEach(t => t.stop()));

		this.setStatus('connecting');

		const conversation = await Conversation.startSession({
			agentId,
			connectionType: 'websocket',
			// Route audio to the user-selected devices
			...(inputDeviceId && inputDeviceId !== 'default' ? { inputDeviceId } : {}),
			...(outputDeviceId && outputDeviceId !== 'default' ? { outputDeviceId } : {}),

			onConnect: ({ conversationId }) => {
				console.log('[EL] connected, id:', conversationId);
				this.setStatus('connected');
			},

			onDisconnect: (details: DisconnectionDetails) => {
				console.log('[EL] disconnected:', details.reason);
				this.conversation = null;
				this.setStatus('disconnected');
			},

			onError: (message: string) => {
				console.error('[EL] error:', message);
				this.onError(message);
			},

			onMessage: (payload: MessagePayload) => {
				// The SDK delivers finalized user & agent messages here
				this.onChat({
					role: payload.role,
					text: payload.message,
					ts: Date.now(),
				});
			},

			onModeChange: ({ mode }) => {
				this.onMode(mode);
			},

			onStatusChange: ({ status }) => {
				this.setStatus(status);
			},
		});

		this.conversation = conversation;
		return conversation.getId();
	}

	// ── Stop session ───────────────────────────────────────────────────────

	async stop(): Promise<void> {
		if (!this.conversation) return;
		await this.conversation.endSession();
		this.conversation = null;
		this.setStatus('disconnected');
	}

	// ── Delegated methods ──────────────────────────────────────────────────

	setVolume(volume: number): void {
		this.conversation?.setVolume({ volume });
	}

	sendUserMessage(text: string): void {
		this.conversation?.sendUserMessage(text);
	}

	sendContextualUpdate(text: string): void {
		this.conversation?.sendContextualUpdate(text);
	}

	sendFeedback(like: boolean): void {
		this.conversation?.sendFeedback(like);
	}

	// ── Internal ───────────────────────────────────────────────────────────

	private setStatus(s: ELStatus): void {
		this.currentStatus = s;
		this.onStatus(s);
	}
}
