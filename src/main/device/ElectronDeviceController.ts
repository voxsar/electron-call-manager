// ---------------------------------------------------------------------------
// ElectronDeviceController – fallback implementation that wraps the existing
// SerialManager / modem logic already in the Electron main process.
//
// This controller is used when the C# native service is not running.
// It keeps full backward compatibility with the original serial/modem flow.
// ---------------------------------------------------------------------------

import type { IDeviceController } from './DeviceController';
import type { SerialManager } from '../serial';
import type { DeviceInfo, OperationResult, StatusResponse } from './types';

export class ElectronDeviceController implements IDeviceController {
  readonly name = 'ElectronDeviceController';

  constructor(private readonly serial: SerialManager) {}

  async getStatus(): Promise<StatusResponse> {
    return {
      running: true,
      devicesConnected: this.serial.isOpen() ? 1 : 0,
      version: 'electron-fallback',
    };
  }

  async getDevices(): Promise<DeviceInfo[]> {
    const ports = await this.serial.listPorts();
    return ports.map((p) => ({
      id:        p.path,
      name:      p.manufacturer ?? p.path,
      type:      'serial' as const,
      connected: this.serial.isOpen(),
      address:   null,
    }));
  }

  async connect(deviceId: string): Promise<OperationResult> {
    try {
      await this.serial.open(deviceId);
      return { success: true, message: `Opened serial port ${deviceId}.`, deviceId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to open ${deviceId}: ${message}` };
    }
  }

  async disconnect(deviceId: string): Promise<OperationResult> {
    try {
      await this.serial.close();
      return { success: true, message: `Closed serial port ${deviceId}.`, deviceId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Failed to close ${deviceId}: ${message}` };
    }
  }

  async answerCall(_deviceId?: string): Promise<OperationResult> {
    this.serial.sendATA();
    return { success: true, message: 'ATA sent.' };
  }

  async hangupCall(_deviceId?: string): Promise<OperationResult> {
    this.serial.sendATH();
    return { success: true, message: 'ATH sent.' };
  }

  async shutdown(): Promise<void> {
    // Serial is closed by the main process lifecycle; nothing to do here.
  }
}
