// Bridge over the relay (SPEC 12.2-12.5) end to end: fake relay, Noise initiator phone, mock claude.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { x25519KeyPair } from '../src/noise.js';
import { Phone, bridge, sleep, waitUntil } from './helpers.js';
import { FakeRelay, TunnelPhone } from './relay-helpers.js';

async function setup(t, overrides = {}) {
  const relay = await new FakeRelay().start();
  const b = await bridge({ holdMs: 60, relay: relay.url, relayBackoffMs: 50, phonesPollMs: 50, ...overrides });
  t.after(async () => {
    await b.close();
    await relay.stop();
  });
  await waitUntil(() => b.relay.status === 'connected', { label: 'relay connected' });
  const phoneFor = (opts = {}) =>
    new TunnelPhone(relay.url, { bridgeId: b.config.bridgeId, bridgeKey: b.keys.noise.publicKey, ...opts }).connect();
  const pairedPhone = async (opts = {}) => {
    const p = await phoneFor({ secret: b.secrets.create().secret, ...opts });
    assert.equal((await p.handshake()).ok, true);
    return p;
  };
  return { relay, b, phoneFor, pairedPhone };
}

describe('relay client', () => {
  it('authenticates with Ed25519 (TOFU), reports status in /health and pings', async (t) => {
    const { relay, b } = await setup(t, { relayPingMs: 50 });
    assert.equal(relay.auths, 1);
    assert.equal(relay.lastQueryId, b.config.bridgeId);
    assert.deepEqual(relay.keys.get(b.config.bridgeId), b.keys.relay.publicKey);
    const health = await (await fetch(`http://127.0.0.1:${b.port}/health`)).json();
    assert.equal(health.relay, 'connected');
    await waitUntil(() => relay.pings > 0, { label: 'ping' });
  });

  it('keeps the socket while pongs come back, and reconnects when they stop', async (t) => {
    const { relay, b, pairedPhone } = await setup(t, { relayPingMs: 40, relayPongTimeoutMs: 250 });
    await sleep(500);
    assert.equal(relay.auths, 1, 'pongs answered: no reconnect');
    assert.ok(relay.pings >= 5);
    const p = await pairedPhone();
    p.hello();
    await p.next({ type: 'welcome' });
    assert.equal(b.relay.sessions().length, 1);
    relay.answerPings = false; // the relay goes silent but keeps the TCP connection open
    await waitUntil(() => b.relay.status === 'connecting', { timeout: 3000, label: 'dead socket noticed' });
    assert.equal(b.relay.sessions().length, 0, 'sessions over the dead socket are dropped');
    relay.answerPings = true;
    await waitUntil(() => relay.auths === 2 && b.relay.status === 'connected', { timeout: 4000, label: 'reconnected after missing pongs' });
  });

  it('reconnects after losing the relay and serves phones again', async (t) => {
    const { relay, b, pairedPhone } = await setup(t);
    relay.kickBridge(b.config.bridgeId);
    await waitUntil(() => b.relay.status === 'connecting', { label: 'noticed the drop' });
    await waitUntil(() => b.relay.status === 'connected' && relay.auths === 2, { timeout: 5000, label: 'reconnected' });
    const p = await pairedPhone();
    p.hello();
    await p.next({ type: 'welcome' });
  });

  it('phones waiting while the bridge is offline get through when it comes back', async (t) => {
    const { relay, b, phoneFor } = await setup(t);
    const secret = b.secrets.create().secret;
    await b.close(); // stop the bridge's relay client
    const relay2 = relay; // same relay, bridge gone
    const p = await phoneFor({ secret });
    await waitUntil(() => p.relayFrames.some((f) => f.t === 'bridge_offline'), { label: 'bridge_offline' });
    const b2 = await bridge({ home: b.home, relay: relay2.url, relayBackoffMs: 50, holdMs: 60 });
    t.after(() => b2.close());
    await waitUntil(() => p.relayFrames.some((f) => f.t === 'bridge_online'), { label: 'bridge_online' });
    assert.equal((await p.handshake()).ok, true);
  });
});

describe('pairing over the relay', () => {
  it('pairs with a fresh secret, then reconnects by key alone; a full chat round trip works without a token', async (t) => {
    const { b, phoneFor } = await setup(t);
    const phoneKey = x25519KeyPair();
    const p = await phoneFor({ secret: b.secrets.create().secret, phoneKey, name: 'Road iPhone' });
    assert.deepEqual(await p.handshake(), { ok: true, name: b.config.name, bridge_id: b.config.bridgeId });
    assert.equal(b.phones.list()[0].name, 'Road iPhone');
    p.send({ type: 'hello', last_seq: 0, client: 'tunnel-test' }); // no token
    const w = await p.next({ type: 'welcome' });
    assert.equal(w.bridge_id, b.config.bridgeId);
    p.say('fix the bug');
    await p.nextSay('ack', 'Heard: fix the bug. Starting.');
    assert.equal((await p.nextSay('reply')).text, 'Done: fix the bug.');
    p.close();
    // Same key later, no secret: known phone.
    const again = await phoneFor({ phoneKey });
    assert.equal((await again.handshake()).ok, true);
  });

  it('rejects an unknown phone, a reused secret and an expired secret with not_paired, then closes', async (t) => {
    const { b, phoneFor, pairedPhone } = await setup(t);
    const stranger = await phoneFor();
    assert.deepEqual(await stranger.handshake(), { ok: false, reason: 'not_paired' });
    await stranger.waitClosed();
    const secret = b.secrets.create().secret;
    assert.equal((await (await phoneFor({ secret })).handshake()).ok, true);
    const reuse = await phoneFor({ secret });
    assert.deepEqual(await reuse.handshake(), { ok: false, reason: 'not_paired' });
    const b2secrets = new (b.secrets.constructor)(b.home, { ttlMs: -1 });
    const expired = await phoneFor({ secret: b2secrets.create().secret });
    assert.deepEqual(await expired.handshake(), { ok: false, reason: 'not_paired' });
    assert.equal(b.phones.list().length, 1);
    await pairedPhone(); // a fresh secret still works
  });

  it('closes without a reply for the wrong bridge key or a tampered message', async (t) => {
    const { b, phoneFor } = await setup(t);
    const wrong = await phoneFor({ secret: b.secrets.create().secret });
    assert.ok((await wrong.handshake({ wrongKey: true })).closed, 'closed, no message 2');
    const tampered = await phoneFor({ secret: b.secrets.create().secret });
    assert.ok((await tampered.handshake({ tamper: true })).closed);
    assert.equal(b.phones.list().length, 0);
  });

  it('closes the connection on a replayed transport message', async (t) => {
    const { pairedPhone } = await setup(t);
    const p = await pairedPhone();
    p.hello();
    await p.next({ type: 'welcome' });
    p.sendCiphertext(p.lastCiphertext);
    await p.waitClosed();
  });
});

describe('virtual phone connections', () => {
  it('a second phone replaces the first, as with direct connections', async (t) => {
    const { pairedPhone } = await setup(t);
    const a = await pairedPhone({ name: 'A' });
    a.hello();
    await a.next({ type: 'welcome' });
    const c = await pairedPhone({ name: 'B' });
    c.hello();
    await c.next({ type: 'welcome' });
    await a.waitClosed();
    c.send({ type: 'ping' });
    await c.next({ type: 'pong' });
  });

  it('unpairing closes that phone\'s open session at once and tells it why', async (t) => {
    const { b, pairedPhone } = await setup(t);
    const p = await pairedPhone({ name: 'Old phone' });
    p.hello();
    await p.next({ type: 'welcome' });
    assert.equal(b.phones.remove('Old phone').removed.length, 1); // what `npm run unpair` does
    const err = await p.next({ type: 'error' }, { timeout: 3000 });
    assert.equal(err.code, 'not_paired');
    await p.waitClosed();
  });

  it('with direct off, /ws is refused and the relay still works', async (t) => {
    const { b, pairedPhone } = await setup(t, { direct: false });
    await assert.rejects(new Phone(b.url).connect());
    const p = await pairedPhone();
    p.hello();
    await p.next({ type: 'welcome' });
  });

  it('direct connections still need the token', async (t) => {
    const { b } = await setup(t);
    const p = await new Phone(b.url).connect();
    p.hello({ token: 'wrong' });
    assert.equal((await p.next({ type: 'error' })).code, 'auth');
    await sleep(10);
  });
});
