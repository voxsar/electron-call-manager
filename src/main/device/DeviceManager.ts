// ---------------------------------------------------------------------------
// DeviceManager – selects and bootstraps the correct IDeviceController.
//
// Strategy (in order):
//   1. Probe http://localhost:8765/status – if it responds, use NativeDeviceController.
//   2. Try to spawn the native service binary and wait for it to become ready.
//   3. Fall back to ElectronDeviceController (wraps existing serial logic).
//
// The manager also owns the child process and cleans it up on shutdown.
// ---------------------------------------------------------------------------

import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

import type { IDeviceController } from './DeviceController';
import { DeviceServiceClient }   from './DeviceServiceClient';
import { NativeDeviceController } from './NativeDeviceController';
import { ElectronDeviceController } from './ElectronDeviceController';
import type { SerialManager } from '../serial';

/** How long (ms) to wait for the native service to become ready after spawn. */
const SPAWN_READY_TIMEOUT_MS = 8_000;
/** How often (ms) to poll the /status endpoint while waiting for readiness. */
const SPAWN_POLL_INTERVAL_MS = 300;

// ---------------------------------------------------------------------------

export class DeviceManager {
  private controller: IDeviceController | null = null;
  private nativeProcess: child_process.ChildProcess | null = null;
  private readonly client = new DeviceServiceClient();

  constructor(private readonly serial: SerialManager) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Return the active controller (throws if not yet initialised). */
  get activeController(): IDeviceController {
    if (!this.controller) throw new Error('DeviceManager not initialised – call init() first.');
    return this.controller;
  }

  /**
   * Initialise the manager.  Must be called once during app startup.
   * Always resolves – never rejects.
   */
  async init(): Promise<void> {
    // 1. Is the service already running?
    if (await this.probeService()) {
      console.log('[DeviceManager] Native service already running – using NativeDeviceController.');
      this.controller = new NativeDeviceController(this.client);
      return;
    }

    // 2. Try to spawn the binary.
    const binaryPath = this.findNativeBinary();
    if (binaryPath) {
      console.log(`[DeviceManager] Spawning native service: ${binaryPath}`);
      const ready = await this.spawnAndWait(binaryPath);
      if (ready) {
        console.log('[DeviceManager] Native service started – using NativeDeviceController.');
        this.controller = new NativeDeviceController(this.client);
        return;
      }
      console.warn('[DeviceManager] Native service did not become ready in time; falling back.');
    } else {
      console.log('[DeviceManager] Native service binary not found; using Electron fallback.');
    }

    // 3. Fallback.
    this.controller = new ElectronDeviceController(this.serial);
    console.log(`[DeviceManager] Active controller: ${this.controller.name}`);
  }

  /** Gracefully stop everything. */
  async shutdown(): Promise<void> {
    await this.controller?.shutdown();
    this.stopNativeProcess();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Returns true if the native service is reachable. */
  private async probeService(): Promise<boolean> {
    const status = await this.client.getStatus();
    return status?.running === true;
  }

  /**
   * Resolve the path to the native service executable.
   *
   * Search order:
   *   a) Packaged app: `<resources>/native-device-service/NativeDeviceService.exe`
   *   b) Development: `<repo>/native-device-service/bin/publish/NativeDeviceService.exe`
   */
  private findNativeBinary(): string | null {
    const exeName = process.platform === 'win32'
      ? 'NativeDeviceService.exe'
      : 'NativeDeviceService';

    const candidates: string[] = [
      // Packaged Electron app (resources/ lives next to the app.asar)
      path.join(process.resourcesPath ?? '', 'native-device-service', exeName),
      // Development layout: project root → native-device-service/bin/publish/
      path.join(__dirname, '..', '..', '..', 'native-device-service', 'bin', 'publish', exeName),
      // Flat layout beside the Electron binary
      path.join(path.dirname(process.execPath), exeName),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Spawn the native service binary and poll until it returns a valid /status
   * response or the timeout expires.
   */
  private spawnAndWait(binaryPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = child_process.spawn(binaryPath, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: false,
      });
      this.nativeProcess = proc;

      // Forward native service logs to our stdout with a prefix.
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
          console.log(`[NativeService] ${line}`);
        }
      });
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
          console.error(`[NativeService:err] ${line}`);
        }
      });

      proc.on('error', (err) => {
        console.error('[DeviceManager] Failed to spawn native service:', err.message);
        cleanup();
        resolve(false);
      });

      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.warn(`[DeviceManager] Native service exited unexpectedly with code ${code}`);
        }
      });

      let settled = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

      /** Cancel all timers and mark as settled (idempotent). */
      const cleanup = (): void => {
        if (pollTimer)    { clearInterval(pollTimer);  pollTimer    = null; }
        if (deadlineTimer){ clearTimeout(deadlineTimer); deadlineTimer = null; }
        settled = true;
      };

      // Hard deadline – cancel polling and resolve false if we haven't heard back.
      deadlineTimer = setTimeout(() => {
        if (!settled) {
          cleanup();
          resolve(false);
        }
      }, SPAWN_READY_TIMEOUT_MS);

      // Give the process a moment to bind to the port, then start polling.
      setTimeout(() => {
        if (settled) return;

        pollTimer = setInterval(async () => {
          if (settled) return;
          if (await this.probeService()) {
            cleanup();
            resolve(true);
          }
        }, SPAWN_POLL_INTERVAL_MS);
      }, 500);
    });
  }

  /** Terminate the spawned native service process if we own it. */
  private stopNativeProcess(): void {
    if (!this.nativeProcess) return;
    try {
      this.nativeProcess.kill('SIGTERM');
    } catch {
      // Process may have already exited.
    }
    this.nativeProcess = null;
  }
}
