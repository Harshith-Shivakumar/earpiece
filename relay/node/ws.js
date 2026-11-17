// Minimal RFC 6455 WebSocket server side, built on node:http 'upgrade'.
// Supports: handshake, masked client frames, text/binary messages, fragmentation,
// ping/pong, close handshake, 7/16/64-bit payload lengths, a max message size.
// No extensions (permessage-deflate is simply not negotiated).

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode one frame. Server frames are unmasked; pass `mask` (4 bytes) to build client frames in tests. */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = null } = {}) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([header, payload]);
  header[1] |= 0x80;
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, body]);
}

function rejectHandshake(socket, status, text, extra = '') {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

/**
 * Complete the WebSocket handshake for an http 'upgrade' event.
 * Returns a WebSocketConnection, or null if the request was rejected (the socket is closed).
 */
export function handleUpgrade(req, socket, head, { maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase();
  const version = req.headers['sec-websocket-version'];
  let keyOk = false;
  if (typeof key === 'string') {
    try {
      keyOk = Buffer.from(key, 'base64').length === 16;
    } catch {
      keyOk = false;
    }
  }
  if (req.method !== 'GET' || !upgrade.includes('websocket') || !connection.includes('upgrade') || !keyOk) {
    rejectHandshake(socket, 400, 'Bad Request');
    return null;
  }
  if (version !== '13') {
    rejectHandshake(socket, 426, 'Upgrade Required', 'Sec-WebSocket-Version: 13\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const conn = new WebSocketConnection(socket, { maxPayload });
  if (head && head.length) conn._onData(head);
  return conn;
}

function validCloseCode(code) {
  return (
    (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

/**
 * Events: 'message' (data: string | Buffer, isBinary: boolean), 'pong', 'close' (code, reason),
 * 'socketError' (err). Never emits 'error', so a missing listener cannot crash the process.
 */
export class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = 'open'; // open | closing | closed
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.fragmentOpcode = 0;
    this.fragmentSize = 0;
    this.lastSeen = Date.now();
    this.closeCode = 1006;
    this.closeReason = '';
    this.closeTimer = null;
    this.heartbeat = null;
    this.remoteAddress = socket.remoteAddress;

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.setKeepAlive(true, 30_000);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('socketError', err));
    socket.on('close', () => this._finish());
  }

  send(data) {
    if (this.readyState !== 'open') return false;
    const isBinary = Buffer.isBuffer(data);
    const payload = isBinary ? data : Buffer.from(String(data), 'utf8');
    return this._write(encodeFrame(isBinary ? OP_BINARY : OP_TEXT, payload));
  }

  ping(payload = Buffer.alloc(0)) {
    if (this.readyState !== 'open') return false;
    return this._write(encodeFrame(OP_PING, payload));
  }

  /** Start the closing handshake. The socket is destroyed if the peer does not answer within 2 s. */
  close(code = 1000, reason = '') {
    if (this.readyState !== 'open') return;
    this.readyState = 'closing';
    const reasonBuf = Buffer.from(String(reason), 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.closeCode = code;
    this.closeReason = String(reason);
    this._write(encodeFrame(OP_CLOSE, payload));
    this.closeTimer = setTimeout(() => this.socket.destroy(), 2000);
    this.closeTimer.unref?.();
  }

  terminate() {
    this.socket.destroy();
  }

  /** Ping every intervalMs; drop the connection if nothing was received for timeoutMs. */
  startHeartbeat(intervalMs, timeoutMs) {
    if (!intervalMs || this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.readyState !== 'open') return;
      if (timeoutMs && Date.now() - this.lastSeen > timeoutMs) {
        this.terminate();
        return;
      }
      this.ping();
    }, intervalMs);
    this.heartbeat.unref?.();
  }

  _write(buf) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  _fail(code, reason) {
    // Protocol error: send a close frame and drop the connection.
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    if (this.readyState === 'open') {
      this.close(code, reason);
    }
    this.readyState = 'closing';
    const t = setTimeout(() => this.socket.destroy(), 100);
    t.unref?.();
    return null;
  }

  _onData(chunk) {
    if (this.readyState === 'closed') return;
    this.lastSeen = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.readyState !== 'closed' && this.buffer.length) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      const hi = buf.readUInt32BE(2);
      const lo = buf.readUInt32BE(6);
      if (hi > 0) return this._fail(1009, 'message too big');
      len = lo;
      off = 10;
    }
    if (rsv) return this._fail(1002, 'reserved bits set');
    if (!masked) return this._fail(1002, 'client frames must be masked');
    const isControl = opcode >= 0x8;
    if (![OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) {
      return this._fail(1002, 'unknown opcode');
    }
    if (isControl && (!fin || len > 125)) return this._fail(1002, 'bad control frame');
    if (len > this.maxPayload) return this._fail(1009, 'message too big');
    if (opcode === OP_CONT && this.fragmentSize + len > this.maxPayload) {
      return this._fail(1009, 'message too big');
    }
    if (buf.length < off + 4 + len) return null;
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.buffer = buf.subarray(off + 4 + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragments) return this._fail(1002, 'expected a continuation frame');
        if (fin) return this._deliver(opcode, payload);
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
        this.fragmentSize = payload.length;
        return;
      case OP_CONT: {
        if (!this.fragments) return this._fail(1002, 'unexpected continuation frame');
        this.fragments.push(payload);
        this.fragmentSize += payload.length;
        if (!fin) return;
        const data = Buffer.concat(this.fragments);
        const op = this.fragmentOpcode;
        this.fragments = null;
        this.fragmentSize = 0;
        return this._deliver(op, data);
      }
      case OP_PING:
        if (this.readyState === 'open') this._write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG:
        this.emit('pong', payload);
        return;
      case OP_CLOSE:
        return this._onCloseFrame(payload);
      default:
        return this._fail(1002, 'unknown opcode');
    }
  }

  _deliver(opcode, data) {
    if (this.readyState !== 'open') return;
    if (opcode === OP_TEXT) {
      let text;
      try {
        text = utf8.decode(data);
      } catch {
        return this._fail(1007, 'invalid utf-8');
      }
      this.emit('message', text, false);
    } else {
      this.emit('message', data, true);
    }
  }

  _onCloseFrame(payload) {
    let code = 1005;
    let reason = '';
    if (payload.length === 1) return this._fail(1002, 'bad close frame');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      reason = payload.subarray(2).toString('utf8');
    }
    if (this.readyState === 'open') {
      // Peer initiated: echo the close, then end our side.
      this.readyState = 'closing';
      const reply = Buffer.alloc(2);
      reply.writeUInt16BE(code === 1005 ? 1000 : validCloseCode(code) ? code : 1002, 0);
      this._write(encodeFrame(OP_CLOSE, reply));
      this.closeCode = code;
      this.closeReason = reason;
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => this.socket.destroy(), 1000);
    t.unref?.();
  }

  _finish() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    clearTimeout(this.closeTimer);
    clearInterval(this.heartbeat);
    this.emit('close', this.closeCode, this.closeReason);
  }
}
