// ---------------------------------------------------------------------------
// DeviceServiceClient – thin HTTP client that talks to the C# native service.
//
// All methods return `null` (instead of throwing) so callers can decide how
// to handle unavailability and fall back gracefully.
// ---------------------------------------------------------------------------

import * as http from 'http';
import type {
  DevicesResponse,
  OperationResult,
  StatusResponse,
} from './types';

const DEFAULT_PORT = 8765;
const DEFAULT_HOST = '127.0.0.1';
/** Milliseconds before a request is considered timed out. */
const REQUEST_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------

/** Lightweight HTTP client for the native device service. */
export class DeviceServiceClient {
  private readonly baseUrl: string;

  constructor(
    private readonly host = DEFAULT_HOST,
    private readonly port = DEFAULT_PORT,
  ) {
    this.baseUrl = `http://${host}:${port}`;
  }

  // ── Low-level request helpers ────────────────────────────────────────────

  /**
   * Perform a GET request and parse the JSON response.
   * Returns `null` on any network/parse error.
   */
  private async get<T>(path: string): Promise<T | null> {
    return this.request<T>('GET', path, null);
  }

  /**
   * Perform a POST request with a JSON body and parse the JSON response.
   * Returns `null` on any network/parse error.
   */
  private async post<T>(path: string, body: unknown): Promise<T | null> {
    return this.request<T>('POST', path, body);
  }

  /** Generic HTTP request wrapper with timeout support. */
  private request<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      const payload = body != null ? JSON.stringify(body) : null;
      const options: http.RequestOptions = {
        hostname: this.host,
        port:     this.port,
        path,
        method,
        headers: {
          'Accept': 'application/json',
          ...(payload != null && {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }),
        },
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(JSON.parse(text) as T);
          } catch {
            resolve(null);
          }
        });
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        resolve(null);
      });

      req.on('error', () => resolve(null));

      if (payload != null) req.write(payload);
      req.end();
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** GET /status – check whether the service is alive. */
  async getStatus(): Promise<StatusResponse | null> {
    return this.get<StatusResponse>('/status');
  }

  /** GET /devices – list all known devices. */
  async getDevices(): Promise<DevicesResponse | null> {
    return this.get<DevicesResponse>('/devices');
  }

  /** POST /connect – connect a device by ID. */
  async connect(deviceId: string): Promise<OperationResult | null> {
    return this.post<OperationResult>('/connect', { deviceId });
  }

  /** POST /disconnect – disconnect a device by ID. */
  async disconnect(deviceId: string): Promise<OperationResult | null> {
    return this.post<OperationResult>('/disconnect', { deviceId });
  }

  /** POST /answer-call – answer the active incoming call. */
  async answerCall(deviceId?: string): Promise<OperationResult | null> {
    return this.post<OperationResult>('/answer-call', { deviceId });
  }

  /** POST /hangup-call – hang up the active call. */
  async hangupCall(deviceId?: string): Promise<OperationResult | null> {
    return this.post<OperationResult>('/hangup-call', { deviceId });
  }
}
