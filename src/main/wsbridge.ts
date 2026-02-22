import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import type { AppSettings, WsStatus } from '../types/ipc';
import { version } from '../../package.json';

interface BridgeStats {
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
}

export class WsBridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private status: WsStatus = 'disconnected';
  private sessionId = randomUUID();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionalClose = false;
  private connectUrl = '';
  private connectSettings: AppSettings | null = null;

  private stats: BridgeStats = {
    bytesSent: 0,
    bytesReceived: 0,
    packetsSent: 0,
    packetsReceived: 0,
  };

  async connect(url: string, settings: AppSettings): Promise<void> {
    this.intentionalClose = false;
    this.connectUrl = url;
    this.connectSettings = settings;
    this.reconnectDelay = 1000;
    return this.doConnect(url, settings);
  }

  private doConnect(url: string, settings: AppSettings): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.terminate();
        this.ws = null;
      }

      this.setStatus('connecting');
      const ws = new WebSocket(url);
      this.ws = ws;

      const onOpenError = (err: Error) => {
        reject(err);
      };

      ws.once('error', onOpenError);

      ws.on('open', () => {
        ws.removeListener('error', onOpenError);
        this.setStatus('connected');
        this.reconnectDelay = 1000;
        this.sendHello(settings);
        ws.on('error', (err) => {
          console.error('[WsBridge] error:', err.message);
          this.setStatus('error');
        });
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          this.stats.bytesReceived += buf.length;
          this.stats.packetsReceived++;
          this.emit('audioFrame', buf);
        } else {
          const text = data.toString();
          this.stats.bytesReceived += text.length;
          try {
            const msg = JSON.parse(text) as unknown;
            this.emit('control', msg);
          } catch {
            this.emit('control', { raw: text });
          }
        }
      });

      ws.on('close', () => {
        if (this.status !== 'error') this.setStatus('disconnected');
        if (!this.intentionalClose) this.scheduleReconnect();
      });
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  sendAudio(buffer: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
      this.stats.bytesSent += buffer.length;
      this.stats.packetsSent++;
    }
  }

  sendControl(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const text = JSON.stringify(msg);
      this.ws.send(text);
      this.stats.bytesSent += text.length;
    }
  }

  getStats(): BridgeStats {
    return { ...this.stats };
  }

  private sendHello(settings: AppSettings): void {
    this.sendControl({
      type: 'hello',
      version,
      sessionId: this.sessionId,
      inputDevice: settings.inputDeviceId,
      outputDevice: settings.outputDeviceId,
      sampleRate: settings.sampleRate,
    });
  }

  private setStatus(s: WsStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.intentionalClose || !this.connectUrl) return;
      try {
        await this.doConnect(this.connectUrl, this.connectSettings!);
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }
}
