# GSM Call Manager

A cross-platform Electron desktop application that bridges a USB GSM modem (via serial AT commands) to a WebSocket audio server. Receive and answer phone calls from your computer, with real-time PCM16 audio streaming over WebSocket.

---

## Features

- **Serial port management** — auto-detect GSM modems, reconnect on disconnect
- **AT command console** — send arbitrary AT commands, one-click shortcuts
- **WebSocket audio bridge** — stream 16 kHz / 8 kHz PCM16 mono audio bidirectionally
- **Caller ID display** — parses `+CLIP` unsolicited result codes
- **Auto-answer** — configurable ring count before automatic answer
- **Persistent settings** — all configuration saved to disk via `electron-store`
- **Dark UI** — fully styled dark theme with live status indicators and stats bar

---

## Requirements

- **Node.js** ≥ 18
- **npm** ≥ 9
- A USB GSM modem that exposes a serial port (e.g. Huawei, Quectel, SIM7600, ZTE, etc.)

---

## Installation

```bash
git clone https://github.com/your-org/electron-call-manager.git
cd electron-call-manager
npm install
```

---

## Build

```bash
npm run build
```

This compiles:
- `src/main/main.ts` → `dist/main/main.js` (Electron main process)
- `src/preload/preload.ts` → `dist/preload/preload.js` (context bridge)
- `src/renderer/renderer.ts` + `src/renderer/index.html` → `dist/renderer/` (UI)

---

## Run

```bash
npm start        # build then launch Electron
# or after building:
npm run dev      # launch Electron directly (skips rebuild)
```

---

## Hardware Setup

1. Plug in your USB GSM modem.
2. On Linux: add your user to the `dialout` group — `sudo usermod -aG dialout $USER` (re-login required).
3. On Windows: install manufacturer drivers; the modem should appear as `COMx`.
4. On macOS: the modem appears as `/dev/tty.usbmodemXXX` or `/dev/tty.usbserial-XXX`.
5. In the app, click **↻** to refresh ports, select the modem port, and click **Connect**.

### Recommended AT command sequence

```
AT          → OK  (modem alive)
ATI         → modem info
AT+CGMI     → manufacturer
AT+CSQ      → signal strength (0-31, 99=unknown)
AT+CREG?    → network registration status
AT+COPS?    → current operator
AT+CLIP=1   → enable caller ID (done automatically)
```

---

## WebSocket Audio Protocol

Connect to a WebSocket server that speaks the following protocol:

| Direction | Format | Description |
|-----------|--------|-------------|
| App → Server | Binary | PCM16 LE mono, 16 kHz (or 8 kHz), 20 ms frames (320 samples) |
| Server → App | Binary | PCM16 LE mono frames for playback |
| App → Server | JSON `{"type":"hello",...}` | Sent on connection with session metadata |
| Server → App | JSON | Control messages (logged to console) |

---

## Project Structure

```
src/
  main/
    main.ts        — Electron main process, IPC handlers, app lifecycle
    serial.ts      — SerialPort v12 manager with auto-reconnect
    wsbridge.ts    — WebSocket client with auto-reconnect and stats
  preload/
    preload.ts     — contextBridge API exposed to renderer
  renderer/
    renderer.ts    — UI logic, event wiring
    audio.ts       — Web Audio capture/playback engine
    index.html     — Application UI
  types/
    ipc.ts         — Shared TypeScript types and IPC channel constants
```

---

## License

MIT