// ---------------------------------------------------------------------------
// Shared TypeScript types for the device layer.
// These mirror the C# ApiModels (native-device-service/Models/ApiModels.cs)
// and the shared-types package, but are inlined here so the Electron build
// has no external package dependency.
// ---------------------------------------------------------------------------

export type DeviceType = 'bluetooth' | 'audio' | 'serial';

export interface DeviceInfo {
	id: string;
	name: string;
	type: DeviceType;
	connected: boolean;
	address: string | null;
}

export interface DevicesResponse {
	devices: DeviceInfo[];
	total: number;
}

export interface OperationResult {
	success: boolean;
	message: string;
	deviceId?: string;
}

export interface StatusResponse {
	running: boolean;
	devicesConnected: number;
	version: string;
	callState: 'idle' | 'ringing' | 'answered' | 'ended';
	callerId: string | null;
	hfpMonitoring: boolean;
}
