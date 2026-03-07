// ─── ElevenLabs Conversational AI – WebSocket event types ────────────────────

// ── Server → Client events ──────────────────────────────────────────────────

type BaseEvent = { type: string };

export type UserTranscriptEvent = BaseEvent & {
	type: 'user_transcript';
	user_transcription_event: {
		user_transcript: string;
	};
};

export type AgentResponseEvent = BaseEvent & {
	type: 'agent_response';
	agent_response_event: {
		agent_response: string;
	};
};

export type AgentResponseCorrectionEvent = BaseEvent & {
	type: 'agent_response_correction';
	agent_response_correction_event: {
		original_agent_response: string;
		corrected_agent_response: string;
	};
};

export type AudioResponseEvent = BaseEvent & {
	type: 'audio';
	audio_event: {
		audio_base_64: string;
		event_id: number;
		alignment?: {
			chars: string[];
			char_durations_ms: number[];
			char_start_times_ms: number[];
		};
	};
};

export type InterruptionEvent = BaseEvent & {
	type: 'interruption';
	interruption_event: {
		reason: string;
	};
};

export type PingEvent = BaseEvent & {
	type: 'ping';
	ping_event: {
		event_id: number;
		ping_ms?: number;
	};
};

export type ConversationInitiationMetadataEvent = BaseEvent & {
	type: 'conversation_initiation_metadata';
	conversation_initiation_metadata_event: {
		conversation_id: string;
		agent_output_audio_format: string;
	};
};

export type ElevenLabsServerEvent =
	| UserTranscriptEvent
	| AgentResponseEvent
	| AgentResponseCorrectionEvent
	| AudioResponseEvent
	| InterruptionEvent
	| PingEvent
	| ConversationInitiationMetadataEvent;

// ── Client → Server events ──────────────────────────────────────────────────

export interface UserAudioChunkMessage {
	user_audio_chunk: string; // base64-encoded PCM16 audio
}

export interface PongMessage {
	type: 'pong';
	event_id: number;
}

export interface ConversationInitiationClientData {
	type: 'conversation_initiation_client_data';
	conversation_config_override?: {
		agent?: {
			prompt?: { prompt?: string };
			first_message?: string;
			language?: string;
		};
		tts?: {
			voice_id?: string;
		};
	};
	custom_llm_extra_body?: Record<string, unknown>;
	dynamic_variables?: Record<string, string>;
}

export type ElevenLabsClientMessage =
	| UserAudioChunkMessage
	| PongMessage
	| ConversationInitiationClientData;

// ── Conversation state ──────────────────────────────────────────────────────

export type ElevenLabsConnectionStatus =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'error';
