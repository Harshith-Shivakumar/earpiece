// Core relay logic: parsing, base64url, auth, rate limit, and the room state machine.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUTH_PREFIX,
  CLOSE,
  LIMITS,
  RateLimiter,
  Room,
  authMessage,
  decodeBase64url,
  decodeBase64urlBytes,
  encodeBase64url,
  isConnId,
  parseFrame,
  parseRoute,
  utf8Length,
  verifyAuthSignature,
} from '../core/index.js';
import { BRIDGE_ID, FakeSocket, MemoryStore, OTHER_ID, b64, bridgeKey, clock, connectBridge, deliver, fakeIo } from './helpers.js';

function makeRoom(opts = {}) {
  const c = opts.clock || clock();
  const logs = [];
  const room = new Room({
    bridgeId: BRIDGE_ID,
    io: fakeIo(),
    store: opts.store || new MemoryStore(),
    now: c.now,
    log: (event, fields) => logs.push({ event, ...fields }),
    limits: opts.limits,
  });
  return { room, clock: c, logs };
}

describe('base64url', () => {
  it('round-trips and has no padding', () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32, 64, 1000]) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      const s = encodeBase64url(bytes);
      assert.doesNotMatch(s, /[=+/]/);
      if (n) assert.deepEqual(decodeBase64url(s), bytes);
    }
  });

  it('rejects bad characters, padding, impossible lengths and non-canonical forms', () => {
    assert.equal(decodeBase64url('ab+c'), null);
    assert.equal(decodeBase64url('ab/c'), null);
    assert.equal(decodeBase64url('YQ=='), null);
    assert.equal(decodeBase64url('abcde'), null); // length % 4 == 1
    assert.equal(decodeBase64url('YR'), null); // 'a' is YQ; YR has non-zero trailing bits
    assert.equal(decodeBase64url(''), null);
    assert.deepEqual(decodeBase64url('YQ'), new Uint8Array([0x61]));
    assert.equal(decodeBase64urlBytes(encodeBase64url(new Uint8Array(31)), 32), null);
    assert.equal(decodeBase64urlBytes(encodeBase64url(new Uint8Array(32)), 32).length, 32);
  });
});

describe('parsing', () => {
  it('parses frames and reports the close code for bad ones', () => {
    assert.deepEqual(parseFrame('{"t":"data","d":"YQ"}'), { ok: true, msg: { t: 'data', d: 'YQ' } });
    assert.equal(parseFrame(new Uint8Array(3)).code, CLOSE.UNSUPPORTED);
    assert.equal(parseFrame('nope').code, CLOSE.BAD_MESSAGE);
    assert.equal(parseFrame('[1]').code, CLOSE.BAD_MESSAGE);
    assert.equal(parseFrame('null').code, CLOSE.BAD_MESSAGE);
    assert.equal(parseFrame('{"x":1}').code, CLOSE.BAD_MESSAGE);
    assert.equal(parseFrame('{"t":"data","d":"' + 'a'.repeat(LIMITS.MAX_FRAME) + '"}').code, CLOSE.TOO_BIG);
    // Multi-byte characters count as bytes, not UTF-16 units.
    const multi = '{"t":"x","pad":"' + 'é'.repeat(LIMITS.MAX_FRAME / 2) + '"}';
    assert.ok(multi.length < LIMITS.MAX_FRAME);
    assert.equal(parseFrame(multi).code, CLOSE.TOO_BIG);
    assert.equal(utf8Length('aé✓🚗'), 1 + 2 + 3 + 4);
  });

  it('routes URLs, requiring ?id= on the bridge path and canonicalizing case', () => {
    const r = (p) => parseRoute(new URL(p, 'https://relay.example'));
    assert.deepEqual(r('/health'), { kind: 'health' });
    assert.deepEqual(r(`/v1/bridge?id=${BRIDGE_ID}`), { kind: 'bridge', bridgeId: BRIDGE_ID });
    assert.deepEqual(r(`/v1/bridge?id=${BRIDGE_ID.toUpperCase()}`), { kind: 'bridge', bridgeId: BRIDGE_ID });
    assert.deepEqual(r(`/v1/phone/${BRIDGE_ID}`), { kind: 'phone', bridgeId: BRIDGE_ID });
    assert.deepEqual(r(`/v1/phone/${BRIDGE_ID.toUpperCase()}`), { kind: 'phone', bridgeId: BRIDGE_ID });
    assert.equal(r('/v1/bridge').status, 400);
    assert.equal(r('/v1/bridge?id=nope').status, 400);
    assert.equal(r('/v1/phone/nope').status, 400);
    assert.equal(r(`/v1/phone/${BRIDGE_ID}/x`).status, 400);
    assert.equal(r('/v2/bridge').status, 404);
    assert.equal(r('/').status, 404);
  });
});

describe('auth signature', () => {
  it('signs earpiece-relay-auth/1: followed by the raw nonce bytes', async () => {
    const key = await bridgeKey();
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = encodeBase64url(nonceBytes);
    const msg = authMessage(nonceBytes);
    assert.equal(new TextDecoder().decode(msg.subarray(0, AUTH_PREFIX.length)), 'earpiece-relay-auth/1:');
    assert.deepEqual(msg.subarray(AUTH_PREFIX.length), nonceBytes);
    // Independent check: sign the bytes by hand and verify through the core.
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.privateKey, msg));
    assert.equal(await verifyAuthSignature(nonce, decodeBase64url(key.pub), sig), true);
    const auth = await key.auth(nonce);
    assert.equal(await verifyAuthSignature(nonce, decodeBase64url(key.pub), decodeBase64url(auth.sig)), true);
    // A different nonce fails.
    const other = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
    assert.equal(await verifyAuthSignature(other, decodeBase64url(key.pub), sig), false);
  });
});

describe('rate limiter', () => {
  it('allows 20 per minute per key, then recovers as the window slides', () => {
    const rl = new RateLimiter();
    let t = 0;
    for (let i = 0; i < 20; i++) assert.equal(rl.hit('1.2.3.4', (t += 100)), true);
    assert.equal(rl.hit('1.2.3.4', (t += 100)), false);
    assert.equal(rl.hit('5.6.7.8', t), true, 'other IPs are independent');
    assert.equal(rl.hit('1.2.3.4', 60_099), false, 'first hit (t=100) is still inside the window');
    assert.equal(rl.hit('1.2.3.4', 60_100), true);
  });

  it('bounds memory by pruning keys', () => {
    const rl = new RateLimiter({ maxKeys: 100 });
    for (let i = 0; i < 1000; i++) rl.hit(`10.0.${i >> 8}.${i & 255}`, i);
    assert.ok(rl.hits.size <= 100);
  });
});

describe('room: bridge auth', () => {
  it('challenges, accepts a valid auth and stores the key on first use', async () => {
    const { room } = makeRoom();
    const key = await bridgeKey();
    const sock = new FakeSocket('bridge');
    room.addBridge(sock);
    const [challenge] = sock.take();
    assert.equal(challenge.t, 'challenge');
    assert.equal(decodeBase64url(challenge.nonce).length, 32);
    await deliver(room, sock, await key.auth(challenge.nonce));
    assert.deepEqual(sock.take(), [{ t: 'ready' }]);
    assert.equal(sock.closed, null);
    assert.equal(room.store.keys.get(BRIDGE_ID), key.pub);
    assert.equal(room.bridge, sock);
  });

  it('rejects a bad signature with 4001', async () => {
    const { room } = makeRoom();
    const key = await bridgeKey();
    const sock = new FakeSocket('bridge');
    room.addBridge(sock);
    sock.take();
    const wrongNonce = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
    await deliver(room, sock, await key.auth(wrongNonce));
    assert.equal(sock.closed.code, CLOSE.AUTH_FAILED);
    assert.equal(room.bridge, null);
    assert.equal(room.store.keys.size, 0, 'nothing is stored for a failed auth');
  });

  it('rejects a bridge_id that differs from the room, a wrong v, bad fields and non-auth first messages', async () => {
    const key = await bridgeKey();
    const cases = [
      async (n) => key.auth(n, OTHER_ID),
      async (n) => ({ ...(await key.auth(n)), v: 2 }),
      async (n) => ({ ...(await key.auth(n)), pub: 'short' }),
      async (n) => ({ ...(await key.auth(n)), sig: undefined }),
      async () => ({ t: 'data', c: 'x', d: 'YQ' }),
    ];
    const codes = [];
    for (const make of cases) {
      const { room } = makeRoom();
      const sock = new FakeSocket('bridge');
      room.addBridge(sock);
      await deliver(room, sock, await make(sock.take()[0].nonce));
      codes.push(sock.closed?.code);
    }
    assert.deepEqual(codes, [CLOSE.AUTH_FAILED, CLOSE.AUTH_FAILED, CLOSE.AUTH_FAILED, CLOSE.AUTH_FAILED, CLOSE.BAD_MESSAGE]);
  });

  it('accepts the bridge_id in any case', async () => {
    const { room } = makeRoom();
    const key = await bridgeKey();
    const sock = new FakeSocket('bridge');
    room.addBridge(sock);
    await deliver(room, sock, await key.auth(sock.take()[0].nonce, BRIDGE_ID.toUpperCase()));
    assert.deepEqual(sock.take(), [{ t: 'ready' }]);
  });

  it('closes with 4003 when the key differs from the one first seen (TOFU)', async () => {
    const store = new MemoryStore();
    const { room } = makeRoom({ store });
    const first = await bridgeKey();
    const second = await bridgeKey();
    const b1 = await connectBridge(room, first);
    assert.deepEqual(b1.take(), [{ t: 'ready' }]);
    const b2 = await connectBridge(room, second, 'impostor');
    assert.equal(b2.closed.code, CLOSE.KEY_MISMATCH);
    assert.equal(room.bridge, b1, 'the real bridge keeps the room');
    assert.equal(b1.closed, null);
    assert.equal(store.keys.get(BRIDGE_ID), first.pub);
  });

  it('first key wins when two different keys race to authenticate', async () => {
    const store = new MemoryStore();
    const { room } = makeRoom({ store });
    const [k1, k2] = [await bridgeKey(), await bridgeKey()];
    const s1 = new FakeSocket('b1');
    const s2 = new FakeSocket('b2');
    room.addBridge(s1);
    room.addBridge(s2);
    const [a1, a2] = [await k1.auth(s1.take()[0].nonce), await k2.auth(s2.take()[0].nonce)];
    await Promise.all([deliver(room, s1, a1), deliver(room, s2, a2)]);
    const winner = store.keys.get(BRIDGE_ID) === k1.pub ? s1 : s2;
    const loser = winner === s1 ? s2 : s1;
    assert.equal(room.bridge, winner);
    assert.equal(loser.closed.code, CLOSE.KEY_MISMATCH);
  });

  it('closes with 4006 if no auth arrives in time, and 4000 for messages before ready', async () => {
    const { room, clock: c } = makeRoom();
    const slow = new FakeSocket('slow');
    room.addBridge(slow);
    c.advance(LIMITS.AUTH_TIMEOUT_MS - 1);
    room.sweep(c.now());
    assert.equal(slow.closed, null);
    c.advance(1);
    room.sweep(c.now());
    assert.equal(slow.closed.code, CLOSE.AUTH_TIMEOUT);

    const key = await bridgeKey();
    const eager = new FakeSocket('eager');
    room.addBridge(eager);
    const pending = deliver(room, eager, await key.auth(eager.take()[0].nonce));
    await deliver(room, eager, { t: 'data', c: 'AAAAAAAAAAAAAAAAAAAAAA', d: 'YQ' }); // while verifying
    await pending;
    assert.equal(eager.closed.code, CLOSE.BAD_MESSAGE);
    assert.equal(room.bridge, null);
  });

  it('a newer authenticated bridge socket replaces the older one', async () => {
    const { room } = makeRoom();
    const key = await bridgeKey();
    const old = await connectBridge(room, key, 'old');
    old.take();
    const p1 = new FakeSocket('p1');
    room.addPhone(p1);
    const firstC = old.take()[0].c;
    const fresh = await connectBridge(room, key, 'new');
    assert.equal(old.closed.code, CLOSE.REPLACED);
    assert.equal(room.bridge, fresh);
    const msgs = fresh.take();
    assert.equal(msgs[0].t, 'ready');
    assert.equal(msgs[1].t, 'open');
    assert.notEqual(msgs[1].c, firstC, 'each bridge socket sees new connection ids');
    assert.deepEqual(p1.take(), [{ t: 'bridge_online' }], 'the phone learns it must start a new handshake');
    // The old socket's late close event changes nothing.
    room.onClose(old);
    assert.equal(room.bridge, fresh);
    assert.deepEqual(p1.take(), []);
    // Data from the phone goes to the new bridge with the new c.
    await deliver(room, p1, { t: 'data', d: b64('hi') });
    assert.deepEqual(fresh.take(), [{ t: 'data', c: msgs[1].c, d: b64('hi') }]);
    assert.deepEqual(old.take(), []);
  });
});

describe('room: phones', () => {
  it('routes data both ways with c added for the bridge and stripped for the phone', async () => {
    const { room } = makeRoom();
    const bridge = await connectBridge(room, await bridgeKey());
    bridge.take();
    const p1 = new FakeSocket('p1');
    const p2 = new FakeSocket('p2');
    room.addPhone(p1);
    room.addPhone(p2);
    const [o1, o2] = bridge.take();
    assert.equal(o1.t, 'open');
    assert.equal(o2.t, 'open');
    assert.ok(isConnId(o1.c) && isConnId(o2.c) && o1.c !== o2.c);
    assert.deepEqual(p1.take(), [], 'phones get nothing on connect while the bridge is online');

    await deliver(room, p1, { t: 'data', d: b64('from p1') });
    await deliver(room, p2, { t: 'data', d: b64('from p2'), c: o1.c }); // a phone cannot pick its c
    assert.deepEqual(bridge.take(), [
      { t: 'data', c: o1.c, d: b64('from p1') },
      { t: 'data', c: o2.c, d: b64('from p2') },
    ]);

    await deliver(room, bridge, { t: 'data', c: o2.c, d: b64('to p2') });
    await deliver(room, bridge, { t: 'data', c: o1.c, d: b64('to p1') });
    assert.deepEqual(p1.take(), [{ t: 'data', d: b64('to p1') }]);
    assert.deepEqual(p2.take(), [{ t: 'data', d: b64('to p2') }]);
  });

  it('handles close from either side, and data for an unknown c', async () => {
    const { room } = makeRoom();
    const bridge = await connectBridge(room, await bridgeKey());
    bridge.take();
    const p1 = new FakeSocket('p1');
    const p2 = new FakeSocket('p2');
    room.addPhone(p1);
    room.addPhone(p2);
    const [o1, o2] = bridge.take();

    // Bridge closes p1 (e.g. not_paired after handshake message 2).
    await deliver(room, bridge, { t: 'data', c: o1.c, d: b64('msg2') });
    await deliver(room, bridge, { t: 'close', c: o1.c });
    assert.deepEqual(p1.take(), [{ t: 'data', d: b64('msg2') }, { t: 'close' }]);
    assert.equal(p1.closed.code, CLOSE.NORMAL);
    assert.deepEqual(bridge.take(), [], 'no close is echoed back');

    // Phone p2 hangs up: the bridge hears close c.
    room.onClose(p2);
    assert.deepEqual(bridge.take(), [{ t: 'close', c: o2.c }]);

    // A phone may also send {t:"close"}.
    const p3 = new FakeSocket('p3');
    room.addPhone(p3);
    const [o3] = bridge.take();
    await deliver(room, p3, { t: 'close' });
    assert.equal(p3.closed.code, CLOSE.NORMAL);
    assert.deepEqual(bridge.take(), [{ t: 'close', c: o3.c }]);

    // Data for a connection that is gone: the bridge is told to close it.
    await deliver(room, bridge, { t: 'data', c: o1.c, d: b64('late') });
    assert.deepEqual(bridge.take(), [{ t: 'close', c: o1.c }]);
    assert.equal(room.isEmpty(), false);
  });

  it('caps a room at 4 phones, evicting only a stale one', async () => {
    const { room, clock: c } = makeRoom();
    const bridge = await connectBridge(room, await bridgeKey());
    const phones = [1, 2, 3, 4].map((i) => new FakeSocket(`p${i}`));
    for (const p of phones) assert.equal(room.addPhone(p), true);
    bridge.take();
    const fifth = new FakeSocket('p5');
    assert.equal(room.addPhone(fifth), false);
    assert.equal(fifth.closed.code, CLOSE.ROOM_FULL);
    assert.deepEqual(bridge.take(), [], 'the bridge never hears about a rejected phone');

    // p1..p3 keep pinging; p4 goes silent (dead socket after a network change).
    c.advance(LIMITS.STALE_MS);
    for (const p of phones.slice(0, 3)) await deliver(room, p, { t: 'ping' });
    const sixth = new FakeSocket('p6');
    assert.equal(room.addPhone(sixth), true);
    assert.equal(phones[3].closed.code, CLOSE.IDLE);
    const msgs = bridge.take();
    assert.equal(msgs[0].t, 'close');
    assert.equal(msgs[1].t, 'open');
    assert.equal(room.stats().phones, 4);
  });

  it('a phone waits through bridge_offline and is opened when the bridge comes online', async () => {
    const { room } = makeRoom();
    const p1 = new FakeSocket('p1');
    room.addPhone(p1);
    assert.deepEqual(p1.take(), [{ t: 'bridge_offline' }]);
    await deliver(room, p1, { t: 'data', d: b64('dropped') }); // no bridge: dropped
    assert.equal(p1.closed, null);

    const key = await bridgeKey();
    const bridge = await connectBridge(room, key);
    const msgs = bridge.take();
    assert.deepEqual(msgs.map((m) => m.t), ['ready', 'open'], 'data sent while offline was dropped, not queued');
    assert.deepEqual(p1.take(), [{ t: 'bridge_online' }]);

    // Bridge goes away: phone hears bridge_offline and stays connected.
    room.onClose(bridge);
    assert.deepEqual(p1.take(), [{ t: 'bridge_offline' }]);
    assert.equal(p1.closed, null);

    // Bridge returns: new c.
    const again = await connectBridge(room, key, 'again');
    const m2 = again.take();
    assert.equal(m2[1].t, 'open');
    assert.notEqual(m2[1].c, msgs[1].c);
    assert.deepEqual(p1.take(), [{ t: 'bridge_online' }]);
  });

  it('answers pings, and closes idle sockets after 90 s', async () => {
    const { room, clock: c } = makeRoom();
    const bridge = await connectBridge(room, await bridgeKey());
    bridge.take();
    const p1 = new FakeSocket('p1');
    room.addPhone(p1);
    await deliver(room, p1, '{"t":"ping"}');
    assert.deepEqual(p1.take(), [{ t: 'pong' }]);
    c.advance(LIMITS.IDLE_MS - 1000);
    await deliver(room, bridge, { t: 'ping' });
    c.advance(1000);
    const next = room.sweep(c.now());
    assert.equal(p1.closed.code, CLOSE.IDLE);
    assert.equal(bridge.closed, null);
    assert.equal(next, c.now() + LIMITS.IDLE_MS - 1000, 'next sweep is when the bridge would go idle');
    c.advance(LIMITS.IDLE_MS);
    room.sweep(c.now());
    assert.equal(bridge.closed.code, CLOSE.IDLE);
    assert.equal(room.sweep(c.now()), null);
  });
});

describe('room: limits and bad input', () => {
  it('closes on oversize frames and oversize d', async () => {
    const { room } = makeRoom();
    const bridge = await connectBridge(room, await bridgeKey());
    bridge.take();
    const p1 = new FakeSocket('p1');
    room.addPhone(p1);
    await deliver(room, p1, '{"t":"data","d":"' + 'A'.repeat(LIMITS.MAX_FRAME) + '"}');
    assert.equal(p1.closed.code, CLOSE.TOO_BIG);

    const p2 = new FakeSocket('p2');
    room.addPhone(p2);
    const o2 = bridge.take().filter((m) => m.t === 'open').pop();
    await deliver(room, p2, { t: 'data', d: 'A'.repeat(LIMITS.MAX_D) }); // largest allowed
    const fwd = bridge.take()[0];
    assert.equal(fwd.c, o2.c);
    assert.ok(JSON.stringify(fwd).length <= LIMITS.MAX_FRAME, 'forwarded frame still fits');
    await deliver(room, p2, { t: 'data', d: 'A'.repeat(LIMITS.MAX_D + 4) });
    assert.equal(p2.closed.code, CLOSE.TOO_BIG);
  });

  it('closes on malformed messages, binary frames and invalid fields, and ignores unknown types', async () => {
    const { room } = makeRoom();
    const bridge = await connectBridge(room, await bridgeKey());
    bridge.take();
    const cases = [
      ['not json', CLOSE.BAD_MESSAGE],
      [new Uint8Array([1, 2, 3]), CLOSE.UNSUPPORTED],
      [{ t: 'data', d: 'not base64url!' }, CLOSE.BAD_MESSAGE],
      [{ t: 'data', d: 12 }, CLOSE.BAD_MESSAGE],
      [{ t: 'data' }, CLOSE.BAD_MESSAGE],
    ];
    for (const [msg, code] of cases) {
      const p = new FakeSocket('p');
      room.addPhone(p);
      await (msg instanceof Uint8Array ? room.onMessage(p, msg) : deliver(room, p, msg));
      assert.equal(p.closed?.code, code, JSON.stringify(msg));
    }
    const p = new FakeSocket('p');
    room.addPhone(p);
    await deliver(room, p, { t: 'future_thing', x: 1 });
    assert.equal(p.closed, null);
    await deliver(room, bridge, { t: 'future_thing' });
    assert.equal(bridge.closed, null);
    await deliver(room, bridge, { t: 'data', c: 'short', d: 'YQ' });
    assert.equal(bridge.closed.code, CLOSE.BAD_MESSAGE);
  });

  it('never logs payloads', async () => {
    const { room, logs } = makeRoom();
    const bridge = await connectBridge(room, await bridgeKey());
    const p = new FakeSocket('p');
    room.addPhone(p);
    const secret = b64('top secret ciphertext');
    await deliver(room, p, { t: 'data', d: secret });
    await deliver(room, bridge, { t: 'data', c: bridge.messages.find((m) => m.t === 'open').c, d: secret });
    room.onClose(p);
    room.onClose(bridge);
    const text = JSON.stringify(logs);
    assert.doesNotMatch(text, new RegExp(secret));
    assert.doesNotMatch(text, new RegExp(BRIDGE_ID), 'logs show only a short room tag');
    assert.ok(logs.some((l) => l.event === 'phone_close' && l.bytes_in > 0));
  });
});

describe('room: hibernation restore', () => {
  it('rebuilds routing from saved socket metadata', async () => {
    const store = new MemoryStore();
    const { room, clock: c } = makeRoom({ store });
    const key = await bridgeKey();
    const bridge = await connectBridge(room, key);
    const p1 = new FakeSocket('p1');
    const p2 = new FakeSocket('p2');
    room.addPhone(p1);
    room.addPhone(p2);
    const opens = bridge.take().filter((m) => m.t === 'open');
    const pending = new FakeSocket('pending');
    room.addBridge(pending);
    const nonce = pending.take()[0].nonce;

    // "Hibernate": a brand-new Room sees only the sockets and their saved attachments.
    const revived = new Room({ bridgeId: BRIDGE_ID, io: fakeIo(), store, now: c.now });
    revived.restore([bridge, p1, p2, pending].map((s) => [s, s.saved]));
    assert.equal(revived.bridge, bridge);
    assert.deepEqual(revived.stats(), { bridge: 1, pending: 1, phones: 2 });
    await deliver(revived, p2, { t: 'data', d: b64('after wake') });
    assert.deepEqual(bridge.take(), [{ t: 'data', c: opens[1].c, d: b64('after wake') }]);
    await deliver(revived, bridge, { t: 'data', c: opens[0].c, d: b64('to p1') });
    assert.deepEqual(p1.take(), [{ t: 'data', d: b64('to p1') }]);
    // The pending bridge socket can still finish auth across the wake-up, replacing the old one.
    await deliver(revived, pending, await key.auth(nonce));
    assert.equal(revived.bridge, pending);
    assert.equal(bridge.closed.code, CLOSE.REPLACED);
    // Replaced or closed sockets are not resurrected by a later restore.
    const again = new Room({ bridgeId: BRIDGE_ID, io: fakeIo(), store, now: c.now });
    again.restore([bridge, p1, p2, pending].map((s) => [s, s.saved]));
    assert.equal(again.bridge, pending);
    assert.deepEqual(again.stats(), { bridge: 1, pending: 0, phones: 2 });
  });
});
