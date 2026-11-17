// End to end: the Node relay with Node 22's global WebSocket as bridge and phone clients.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CLOSE } from '../core/index.js';
import { createRelay } from '../node/server.js';
import { encodeFrame } from '../node/ws.js';
import { BRIDGE_ID, b64, bridgeKey } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'earpiece-relay-'));
const statePath = path.join(dir, 'state.json');
let relay;
let base;
let key;

/** A WebSocket client with an inbox of parsed JSON messages and a close promise. */
function client(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    inbox.push(JSON.parse(e.data));
    while (waiters.length && inbox.length) waiters.shift()(inbox.shift());
  };
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ws error'));
  });
  const closed = new Promise((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  const next = (ms = 2000) =>
    inbox.length
      ? Promise.resolve(inbox.shift())
      : new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
          waiters.push((m) => {
            clearTimeout(t);
            resolve(m);
          });
        });
  const send = (obj) => ws.send(JSON.stringify(obj));
  return { ws, inbox, next, send, opened, closed };
}

async function bridge(k = key, id = BRIDGE_ID) {
  const b = client(`${base.replace('http', 'ws')}/v1/bridge?id=${id}`);
  const challenge = await b.next();
  assert.equal(challenge.t, 'challenge');
  b.send(await k.auth(challenge.nonce, id));
  return b;
}

function phone(id = BRIDGE_ID) {
  return client(`${base.replace('http', 'ws')}/v1/phone/${id}`);
}

before(async () => {
  key = await bridgeKey();
  relay = createRelay({ port: 0, host: '127.0.0.1', statePath, log: () => {} });
  const port = await relay.listen();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await relay.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('node relay', () => {
  it('serves /health and rejects bad paths', async () => {
    const res = await fetch(`${base}/health`);
    assert.deepEqual(await res.json(), { ok: true, v: 1 });
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/v1/bridge`)).status, 400);
    assert.equal((await fetch(`${base}/v1/bridge?id=${BRIDGE_ID}`)).status, 426);
    const noId = client(`${base.replace('http', 'ws')}/v1/bridge`);
    await assert.rejects(noId.opened);
  });

  it('carries data both ways between a bridge and two phones, through a bridge restart', async () => {
    const b = await bridge();
    assert.deepEqual(await b.next(), { t: 'ready' });
    assert.ok(fs.readFileSync(statePath, 'utf8').includes(key.pub), 'TOFU key persisted');

    const p1 = phone();
    const p2 = phone();
    await Promise.all([p1.opened, p2.opened]);
    const o1 = await b.next();
    const o2 = await b.next();
    assert.equal(o1.t, 'open');
    assert.equal(o2.t, 'open');

    // Map each c to its phone by sending from p1 first and waiting for it.
    p1.send({ t: 'data', d: b64('hello from p1') });
    const d1 = await b.next();
    assert.equal(d1.d, b64('hello from p1'));
    const c1 = d1.c;
    const c2 = c1 === o1.c ? o2.c : o1.c;
    p2.send({ t: 'data', d: b64('hello from p2') });
    assert.deepEqual(await b.next(), { t: 'data', c: c2, d: b64('hello from p2') });

    b.send({ t: 'data', c: c2, d: b64('to p2') });
    b.send({ t: 'data', c: c1, d: b64('to p1') });
    assert.deepEqual(await p1.next(), { t: 'data', d: b64('to p1') });
    assert.deepEqual(await p2.next(), { t: 'data', d: b64('to p2') });

    // Keepalive.
    p1.ws.send('{"t":"ping"}');
    assert.deepEqual(await p1.next(), { t: 'pong' });

    // Bridge process dies: phones hear bridge_offline and stay connected.
    b.ws.close();
    await b.closed;
    assert.deepEqual(await p1.next(), { t: 'bridge_offline' });
    assert.deepEqual(await p2.next(), { t: 'bridge_offline' });

    // Bridge restarts: phones hear bridge_online, the bridge gets new opens, data flows again.
    const b2 = await bridge();
    assert.deepEqual(await b2.next(), { t: 'ready' });
    assert.deepEqual(await p1.next(), { t: 'bridge_online' });
    assert.deepEqual(await p2.next(), { t: 'bridge_online' });
    const reopened = [await b2.next(), await b2.next()];
    assert.ok(reopened.every((m) => m.t === 'open' && m.c !== c1 && m.c !== c2));
    p2.send({ t: 'data', d: b64('again') });
    const again = await b2.next();
    assert.equal(again.d, b64('again'));
    b2.send({ t: 'data', c: again.c, d: b64('welcome back') });
    assert.deepEqual(await p2.next(), { t: 'data', d: b64('welcome back') });

    // Bridge closes p1's session: p1 gets {t:"close"} and a 1000 close.
    const c1new = reopened.find((m) => m.c !== again.c).c;
    b2.send({ t: 'close', c: c1new });
    assert.deepEqual(await p1.next(), { t: 'close' });
    assert.equal((await p1.closed).code, 1000);

    // Phone hangs up: the bridge hears close c.
    p2.ws.close();
    assert.deepEqual(await b2.next(), { t: 'close', c: again.c });

    b2.ws.close();
    await b2.closed;
  });

  it('a phone waits through bridge_offline until the bridge connects', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const p = phone(id);
    assert.deepEqual(await p.next(), { t: 'bridge_offline' });
    p.send({ t: 'data', d: b64('sent while offline') }); // dropped, not queued
    p.ws.send('{"t":"ping"}');
    assert.deepEqual(await p.next(), { t: 'pong' }, 'the phone is still connected');
    const k = await bridgeKey();
    const b = await bridge(k, id);
    assert.deepEqual(await b.next(), { t: 'ready' });
    assert.deepEqual(await p.next(), { t: 'bridge_online' });
    const open = await b.next();
    assert.equal(open.t, 'open');
    p.send({ t: 'data', d: b64('noise msg 1') });
    assert.deepEqual(await b.next(), { t: 'data', c: open.c, d: b64('noise msg 1') });
    b.ws.close();
    p.ws.close();
    await Promise.all([b.closed, p.closed]);
  });

  it('replaces an older bridge socket, and closes an impostor key with 4003 even after a restart', async () => {
    const b1 = await bridge();
    assert.deepEqual(await b1.next(), { t: 'ready' });
    const b2 = await bridge();
    assert.deepEqual(await b2.next(), { t: 'ready' });
    assert.equal((await b1.closed).code, CLOSE.REPLACED);

    const impostor = await bridge(await bridgeKey());
    assert.equal((await impostor.closed).code, CLOSE.KEY_MISMATCH);
    b2.ws.close();
    await b2.closed;

    // A second relay process reading the same state file still knows the key.
    const second = createRelay({ port: 0, host: '127.0.0.1', statePath, log: () => {} });
    const port = await second.listen();
    try {
      const url = `ws://127.0.0.1:${port}/v1/bridge?id=${BRIDGE_ID}`;
      const c = client(url);
      const challenge = await c.next();
      c.send(await (await bridgeKey()).auth(challenge.nonce));
      assert.equal((await c.closed).code, CLOSE.KEY_MISMATCH);
      const ok = client(url);
      ok.send(await key.auth((await ok.next()).nonce));
      assert.deepEqual(await ok.next(), { t: 'ready' });
      ok.ws.close();
      await ok.closed;
    } finally {
      await second.close();
    }
  });

  it('answers WebSocket protocol pings as well as {"t":"ping"}', async () => {
    const port = new URL(base).port;
    const sock = net.connect(Number(port), '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => (buf = Buffer.concat([buf, d])));
    const waitFor = async (pred) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(pred());
    };
    sock.write(
      `GET /v1/phone/${BRIDGE_ID} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await waitFor(() => buf.includes('\r\n\r\n'));
    buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
    await waitFor(() => buf.includes('bridge_offline'));
    buf = Buffer.alloc(0);
    sock.write(encodeFrame(0x9, Buffer.from('hb'), { mask: randomBytes(4) }));
    await waitFor(() => buf.length >= 4);
    assert.equal(buf[0], 0x8a, 'pong frame');
    assert.equal(buf.subarray(2, 4).toString(), 'hb');
    sock.destroy();
  });

  it('rate-limits new connections per IP with HTTP 429', async () => {
    const limited = createRelay({ port: 0, host: '127.0.0.1', log: () => {}, limits: { RATE_LIMIT: 3 } });
    const port = await limited.listen();
    try {
      const url = `ws://127.0.0.1:${port}/v1/phone/${BRIDGE_ID}`;
      const ok = [client(url), client(url), client(url)];
      await Promise.all(ok.map((c) => c.opened));
      const fourth = client(url);
      await assert.rejects(fourth.opened);
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200, '/health is not limited');
      for (const c of ok) c.ws.close();
      await Promise.all(ok.map((c) => c.closed));
    } finally {
      await limited.close();
    }
  });
});
