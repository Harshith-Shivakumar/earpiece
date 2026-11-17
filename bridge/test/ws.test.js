// WebSocket framing: real Node WebSocket client against ws.js, plus raw-socket protocol checks.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { acceptKey, encodeFrame, handleUpgrade } from '../src/ws.js';

let server;
let port;
const sockets = new Set();

before(async () => {
  server = http.createServer((req, res) => res.end('plain http'));
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const conn = handleUpgrade(req, socket, head, { maxPayload: 1024 * 1024 });
    if (!conn) return;
    conn.on('message', (data, isBinary) => {
      if (isBinary) conn.send(Buffer.from(data));
      else if (data === 'close-me') conn.close(4001, 'asked to close');
      else conn.send(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => new Promise((r) => {
  for (const s of sockets) s.destroy();
  server.closeAllConnections?.();
  server.close(() => r());
}));

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    inbox.push(e.data);
    while (waiters.length && inbox.length) waiters.shift()(inbox.shift());
  };
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)));
  const open = new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error('ws error'));
  });
  return { ws, next, open };
}

describe('ws.js with the Node WebSocket client', () => {
  it('echoes small, 16-bit, 64-bit and multi-byte text messages', async () => {
    const c = client();
    await c.open;
    for (const msg of ['hi', 'a'.repeat(200), 'b'.repeat(70_000), 'héllo wörld, ✓ 你好 🚗'.repeat(50), 'z'.repeat(1024 * 1024 - 10)]) {
      c.ws.send(msg);
      assert.equal(await c.next(), msg);
    }
    c.ws.close();
  });

  it('echoes binary messages and closes with the server code', async () => {
    const c = client();
    await c.open;
    c.ws.binaryType = 'arraybuffer';
    const bytes = randomBytes(300);
    c.ws.send(bytes);
    const got = Buffer.from(await c.next());
    assert.deepEqual(got, bytes);
    const closed = new Promise((r) => (c.ws.onclose = r));
    c.ws.send('close-me');
    const ev = await closed;
    assert.equal(ev.code, 4001);
    assert.equal(ev.reason, 'asked to close');
  });
});

/** Raw TCP client to send hand-built frames. */
async function raw() {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const key = randomBytes(16).toString('base64');
  sock.write(
    `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  const frames = [];
  let headerDone = false;
  let header = '';
  let ended = false;
  const waiters = new Set();
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (!headerDone) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      header = buf.subarray(0, i).toString();
      buf = buf.subarray(i + 4);
      headerDone = true;
    }
    for (;;) {
      if (buf.length < 2) break;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = buf.readUInt32BE(6);
        off = 10;
      }
      if (buf.length < off + len) break;
      frames.push({ fin: !!(buf[0] & 0x80), opcode: buf[0] & 0x0f, masked: !!(buf[1] & 0x80), payload: buf.subarray(off, off + len) });
      buf = buf.subarray(off + len);
    }
    for (const w of [...waiters]) w();
  });
  sock.on('close', () => {
    ended = true;
    for (const w of [...waiters]) w();
  });
  const until = (pred, ms = 2000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const v = pred();
        if (v) {
          waiters.delete(check);
          clearTimeout(t);
          resolve(v);
        }
      };
      const t = setTimeout(() => {
        waiters.delete(check);
        reject(new Error('raw client timed out'));
      }, ms);
      waiters.add(check);
      check();
    });
  await until(() => headerDone);
  const mask = () => randomBytes(4);
  return {
    sock,
    key,
    header: () => header,
    frames,
    until,
    ended: () => ended,
    send: (op, payload, fin = true) => sock.write(encodeFrame(op, Buffer.from(payload), { fin, mask: mask() })),
    sendRaw: (b) => sock.write(b),
  };
}

describe('ws.js protocol details (raw socket)', () => {
  it('returns the RFC 6455 accept key', async () => {
    const r = await raw();
    assert.match(r.header(), /^HTTP\/1\.1 101/);
    assert.ok(r.header().includes(`Sec-WebSocket-Accept: ${acceptKey(r.key)}`));
    // Known vector from RFC 6455 section 1.3.
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    r.sock.destroy();
  });

  it('reassembles fragmented text with a ping in the middle', async () => {
    const r = await raw();
    r.send(0x1, 'Hello, ', false);
    r.send(0x9, 'are you there');
    r.send(0x0, 'frag', false);
    r.send(0x0, 'mented world', true);
    const pong = await r.until(() => r.frames.find((f) => f.opcode === 0xa));
    assert.equal(pong.payload.toString(), 'are you there');
    const text = await r.until(() => r.frames.find((f) => f.opcode === 0x1));
    assert.equal(text.payload.toString(), 'Hello, fragmented world');
    assert.equal(text.masked, false, 'server frames are never masked');
    r.sock.destroy();
  });

  it('answers a close frame with a close frame', async () => {
    const r = await raw();
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1000);
    r.send(0x8, payload);
    const close = await r.until(() => r.frames.find((f) => f.opcode === 0x8));
    assert.equal(close.payload.readUInt16BE(0), 1000);
    await r.until(() => r.ended());
  });

  it('rejects unmasked client frames with 1002', async () => {
    const r = await raw();
    r.sendRaw(encodeFrame(0x1, Buffer.from('not masked')));
    const close = await r.until(() => r.frames.find((f) => f.opcode === 0x8));
    assert.equal(close.payload.readUInt16BE(0), 1002);
    await r.until(() => r.ended());
  });

  it('rejects messages over 1 MB with 1009 (single frame and fragmented)', async () => {
    const r = await raw();
    // Only the header is needed: the length is checked before the payload arrives.
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(1024 * 1024 + 1, 6);
    r.sendRaw(header);
    const close = await r.until(() => r.frames.find((f) => f.opcode === 0x8));
    assert.equal(close.payload.readUInt16BE(0), 1009);

    const r2 = await raw();
    r2.send(0x1, Buffer.alloc(700_000, 97), false);
    r2.send(0x0, Buffer.alloc(400_000, 97), true);
    const close2 = await r2.until(() => r2.frames.find((f) => f.opcode === 0x8));
    assert.equal(close2.payload.readUInt16BE(0), 1009);
  });

  it('rejects invalid UTF-8 with 1007 and a stray continuation with 1002', async () => {
    const r = await raw();
    r.send(0x1, Buffer.from([0xc3, 0x28]));
    const close = await r.until(() => r.frames.find((f) => f.opcode === 0x8));
    assert.equal(close.payload.readUInt16BE(0), 1007);
    const r2 = await raw();
    r2.send(0x0, 'orphan');
    const close2 = await r2.until(() => r2.frames.find((f) => f.opcode === 0x8));
    assert.equal(close2.payload.readUInt16BE(0), 1002);
  });

  it('rejects a bad handshake with 400', async () => {
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n');
    const reply = await new Promise((r) => sock.once('data', (d) => r(d.toString())));
    assert.match(reply, /^HTTP\/1\.1 400/);
    sock.destroy();
  });
});
