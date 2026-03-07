// ---------------------------------------------------------------------------
// NativeDeviceController – routes all device commands through the C# service.
// ---------------------------------------------------------------------------

import type { IDeviceController } from './DeviceController';
import { DeviceServiceClient } from './DeviceServiceClient';
import type { DeviceInfo, OperationResult, StatusResponse } from './types';

export class NativeDeviceController implements IDeviceController {
  readonly name = 'NativeDeviceController';

  private readonly client: DeviceServiceClient;

  constructor(client?: DeviceServiceClient) {
    this.client = client ?? new DeviceServiceClient();
  }

  async getStatus(): Promise<StatusResponse | null> {
    return this.client.getStatus();
  }

  async getDevices(): Promise<DeviceInfo[]> {
    const res = await this.client.getDevices();
    return res?.devices ?? [];
  }

  async connect(deviceId: string): Promise<OperationResult> {
    const res = await this.client.connect(deviceId);
    return res ?? { success: false, message: 'Native service unreachable.' };
  }

  async disconnect(deviceId: string): Promise<OperationResult> {
    const res = await this.client.disconnect(deviceId);
    return res ?? { success: false, message: 'Native service unreachable.' };
  }

  async answerCall(deviceId?: string): Promise<OperationResult> {
    const res = await this.client.answerCall(deviceId);
    return res ?? { success: false, message: 'Native service unreachable.' };
  }

  async hangupCall(deviceId?: string): Promise<OperationResult> {
    const res = await this.client.hangupCall(deviceId);
    return res ?? { success: false, message: 'Native service unreachable.' };
  }

  async shutdown(): Promise<void> {
    // No persistent connection to close – HTTP is stateless.
  }
}
