import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import type { PortInfo } from '../types/ipc';

export class SerialManager extends EventEmitter {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private currentPath = '';
  private currentBaud = 115200;
  private ringCount = 0;
  private ringDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private ringStormTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRingTime = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;

  async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path:         p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId:        p.pnpId,
      locationId:   p.locationId,
      productId:    p.productId,
      vendorId:     p.vendorId,
    }));
  }

  async open(portPath: string, baud = 115200): Promise<void> {
    if (this.port?.isOpen) await this.close();
    this.manualClose = false;
    this.currentPath = portPath;
    this.currentBaud = baud;

    return new Promise((resolve, reject) => {
      const sp = new SerialPort({ path: portPath, baudRate: baud, autoOpen: false });
      this.port = sp;
      this.parser = sp.pipe(new ReadlineParser({ delimiter: '\r\n' }));

      this.parser.on('data', (line: string) => this.handleLine(line.trim()));
      sp.on('error', (err: Error) => this.emit('error', err));
      sp.on('close', () => {
        this.emit('closed');
        if (!this.manualClose) this.scheduleReconnect();
      });

      sp.open((err) => {
        if (err) { reject(err); return; }
        this.emit('opened', portPath);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.manualClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (!this.port?.isOpen) return;
    return new Promise((resolve) => {
      this.port!.close(() => resolve());
    });
  }

  isOpen(): boolean {
    return this.port?.isOpen ?? false;
  }

  sendCommand(cmd: string): void {
    if (!this.port?.isOpen) return;
    this.port.write(`${cmd}\r\n`);
  }

  enableCLIP(): void    { this.sendCommand('AT+CLIP=1'); }
  enableAutoAnswer(rings = 1): void { this.sendCommand(`ATS0=${rings}`); }
  sendATA(): void { this.sendCommand('ATA'); }
  sendATH(): void {
    this.sendCommand('ATH');
    this.ringCount = 0;
  }

  private handleLine(line: string): void {
    if (!line) return;
    this.emit('line', line);

    if (line === 'RING') {
      const now = Date.now();
      if (now - this.lastRingTime < 200) return; // ring storm protection
      this.lastRingTime = now;

      this.ringCount++;
      this.emit('ring', this.ringCount);

      // Reset ring counter after 6 seconds of silence
      if (this.ringDebounceTimer) clearTimeout(this.ringDebounceTimer);
      this.ringDebounceTimer = setTimeout(() => { this.ringCount = 0; }, 6000);
      return;
    }

    if (line.startsWith('+CLIP:')) {
      this.emit('clip', line);
      return;
    }

    if (line === 'NO CARRIER' || line === 'BUSY' || line === 'NO ANSWER') {
      this.ringCount = 0;
      if (this.ringDebounceTimer) { clearTimeout(this.ringDebounceTimer); this.ringDebounceTimer = null; }
      this.emit('callEnded');
    }
  }

  private scheduleReconnect(delay = 3000): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.open(this.currentPath, this.currentBaud);
      } catch {
        this.scheduleReconnect(Math.min(delay * 2, 30000));
      }
    }, delay);
  }
}
