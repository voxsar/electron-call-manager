// ─── IPC channel name constants ──────────────────────────────────────────────

/** Channels used for main → renderer push events (webContents.send). */
export const IPC = {
  PORT_LIST:   'port:list',
  PORT_OPENED: 'port:opened',
  PORT_CLOSED: 'port:closed',
  PORT_ERROR:  'port:error',
  SERIAL_DATA: 'serial:data',
  CALL_STATE:  'call:state',
  WS_STATUS:   'ws:status',
  STATS:       'stats:update',
  AUDIO_FRAME: 'audio:frame',
} as const;

/** Channels used for renderer → main request/response (ipcMain.handle). */
export const INVOKE = {
  GET_PORTS:     'invoke:getPorts',
  OPEN_PORT:     'invoke:openPort',
  CLOSE_PORT:    'invoke:closePort',
  SEND_AT:       'invoke:sendAt',
  WS_CONNECT:    'invoke:wsConnect',
  WS_DISCONNECT: 'invoke:wsDisconnect',
  SEND_AUDIO:    'invoke:sendAudio',
  GET_SETTINGS:  'invoke:getSettings',
  SAVE_SETTINGS: 'invoke:saveSettings',
  HANGUP:        'invoke:hangup',
  ANSWER:        'invoke:answer',
} as const;

// ─── Shared types ─────────────────────────────────────────────────────────────

export type CallState = 'idle' | 'ringing' | 'answered';
export type WsStatus  = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface PortInfo {
  path:         string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?:        string;
  locationId?:   string;
  productId?:    string;
  vendorId?:     string;
}

export interface AppSettings {
  selectedPort:    string;
  baud:            number;
  wsUrl:           string;
  inputDeviceId:   string;
  outputDeviceId:  string;
  autoAnswer:      boolean;
  answerAfterRings: number;
  detectCallerId:  boolean;
  sampleRate:      16000 | 8000;
}

export interface CallStatePayload {
  state:    CallState;
  callerId: string;
}

export interface StatsUpdate {
  bytesSent:        number;
  bytesReceived:    number;
  packetsSent:      number;
  packetsReceived:  number;
  latencyMs:        number;
}
