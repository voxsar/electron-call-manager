// ---------------------------------------------------------------------------
// DeviceController – abstract base that defines the device-management contract.
//
// Two concrete implementations exist:
//   • NativeDeviceController  – delegates to the C# native-device-service
//   • ElectronDeviceController – falls back to the existing serial/modem logic
//
// The factory function `createDeviceController()` in main.ts selects the
// appropriate implementation at startup.
// ---------------------------------------------------------------------------

import type { DeviceInfo, OperationResult, StatusResponse } from './types';

/** Public interface every device controller must satisfy. */
export interface IDeviceController {
  /** Unique name used for logging. */
  readonly name: string;

  /** List all known devices. */
  getDevices(): Promise<DeviceInfo[]>;

  /** Connect to a device by its opaque ID. */
  connect(deviceId: string): Promise<OperationResult>;

  /** Disconnect a device by its opaque ID. */
  disconnect(deviceId: string): Promise<OperationResult>;

  /** Answer the current incoming call. */
  answerCall(deviceId?: string): Promise<OperationResult>;

  /** Hang up the active call. */
  hangupCall(deviceId?: string): Promise<OperationResult>;

  /**
   * Optional: return a status snapshot.
   * Controllers that don't expose status may return `null`.
   */
  getStatus?(): Promise<StatusResponse | null>;

  /**
   * Perform any clean-up needed before Electron quits.
   * Safe to call even if the controller was never fully initialised.
   */
  shutdown(): Promise<void>;
}
