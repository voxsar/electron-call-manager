// ---------------------------------------------------------------------------
// Shared TypeScript interfaces – mirror the C# ApiModels in native-device-service.
// These types are used by both the Electron app and any other TypeScript consumer.
// ---------------------------------------------------------------------------

// ── Status ──────────────────────────────────────────────────────────────────

/** Response shape for GET /status */
export interface StatusResponse {
  /** Whether the native service process is alive. */
  running: boolean;
  /** Number of devices currently connected. */
  devicesConnected: number;
  /** Semantic version of the native service binary. */
  version: string;
}

// ── Devices ─────────────────────────────────────────────────────────────────

/** Type discriminator for a device entry. */
export type DeviceType = 'bluetooth' | 'audio' | 'serial';

/** A single discovered peripheral. */
export interface DeviceInfo {
  /** Opaque unique identifier (address, device-path, etc.). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Category of device. */
  type: DeviceType;
  /** Whether this device is currently connected. */
  connected: boolean;
  /** Bluetooth MAC address, or null for non-Bluetooth devices. */
  address: string | null;
}

/** Response shape for GET /devices */
export interface DevicesResponse {
  devices: DeviceInfo[];
  total: number;
}

// ── Connection ───────────────────────────────────────────────────────────────

/** Request body for POST /connect and POST /disconnect */
export interface DeviceRequest {
  deviceId: string;
}

/** Generic operation result returned by most POST endpoints. */
export interface OperationResult {
  success: boolean;
  message: string;
  /** The device ID affected, if applicable. */
  deviceId?: string;
}

// ── Call control ─────────────────────────────────────────────────────────────

/** Optional request body for POST /answer-call */
export interface AnswerCallRequest {
  /** If provided, answer using this specific device. */
  deviceId?: string;
}

/** Optional request body for POST /hangup-call */
export interface HangupCallRequest {
  /** If provided, hang up on this specific device. */
  deviceId?: string;
}

// ── Client-side types ────────────────────────────────────────────────────────

/** All routes exposed by the native device service. */
export type NativeServiceRoute =
  | '/status'
  | '/devices'
  | '/connect'
  | '/disconnect'
  | '/answer-call'
  | '/hangup-call';

/** The default port on which the native service listens. */
export const NATIVE_SERVICE_PORT = 8765 as const;

/** The base URL used when the service runs on the default port. */
export const NATIVE_SERVICE_BASE_URL = `http://localhost:${NATIVE_SERVICE_PORT}` as const;
