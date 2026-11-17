// Bridge keys, paired phones, pairing secrets and the responder decision (SPEC 12.1, 12.3, 12.4).

import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PairSecrets, PhoneStore, loadKeys } from '../src/keys.js';
import { HandshakeIK, b64url, x25519KeyPair } from '../src/noise.js';
import { respondToPhone } from '../src/tunnel.js';
import { tempHome } from './helpers.js';

describe('keys.json', () => {
  it('is generated once with mode 0600 and reloaded unchanged', () => {
    const home = tempHome();
    const a = loadKeys(home);
    assert.equal(a.generated, true);
    assert.equal(statSync(a.path).mode & 0o777, 0o600);
    const b = loadKeys(home);
    assert.equal(b.generated, false);
    assert.deepEqual(b.noise.publicKey, a.noise.publicKey);
    assert.deepEqual(b.relay.publicKey, a.relay.publicKey);
    assert.equal(a.noise.publicKey.length, 32);
    assert.equal(a.relay.publicKey.length, 32);
  });
});

describe('phones.json', () => {
  it('adds, finds, touches and removes phones', () => {
    const home = tempHome();
    const store = new PhoneStore(home);
    assert.deepEqual(store.list(), []);
    const k1 = b64url(x25519KeyPair().publicKey);
    const k2 = b64url(x25519KeyPair().publicKey);
    store.add({ phone_id: 'p1', name: 'Work iPhone', noise_pub: k1 });
    store.add({ phone_id: 'p2', name: 'Spare', noise_pub: k2 });
    assert.equal(statSync(store.path).mode & 0o777, 0o600);
    assert.equal(store.findByKey(k1).phone_id, 'p1');
    assert.equal(store.touch(k1, 'Renamed').name, 'Renamed');
    assert.deepEqual(Object.keys(store.list()[0]).sort(), ['last_seen', 'name', 'noise_pub', 'paired_at', 'phone_id']);
    // Re-pairing the same phone_id with a new key replaces the entry.
    const k3 = b64url(x25519KeyPair().publicKey);
    store.add({ phone_id: 'p1', name: 'Work iPhone', noise_pub: k3 });
    assert.equal(store.list().length, 2);
    assert.equal(store.findByKey(k1), null);
    assert.match(store.remove('nobody').error, /No paired phone/);
    assert.equal(store.remove('spare').removed[0].phone_id, 'p2', 'by name, case-insensitive');
    assert.equal(store.remove('p1').removed[0].phone_id, 'p1');
    assert.deepEqual(store.list(), []);
  });

  it('refuses an ambiguous name', () => {
    const store = new PhoneStore(tempHome());
    store.add({ phone_id: 'a', name: 'iPhone', noise_pub: 'k1' });
    store.add({ phone_id: 'b', name: 'iPhone', noise_pub: 'k2' });
    assert.match(store.remove('iPhone').error, /use the phone_id/);
  });
});

describe('pairing secret', () => {
  it('is 16 random bytes, single use, and expires', () => {
    const home = tempHome();
    const secrets = new PairSecrets(home);
    const { secret } = secrets.create();
    assert.equal(Buffer.from(secret, 'base64url').length, 16);
    assert.equal(statSync(secrets.path).mode & 0o777, 0o600);
    assert.equal(secrets.consume('wrong-secret-xxxxxxxxx'), false);
    assert.equal(secrets.consume(secret), true);
    assert.equal(secrets.consume(secret), false, 'single use');
    const short = new PairSecrets(home, { ttlMs: -1 });
    const expired = short.create().secret;
    assert.equal(short.consume(expired), false, 'expired');
    writeFileSync(secrets.path, 'garbage');
    assert.equal(secrets.current(), null);
  });

  it('a new secret replaces the previous one', () => {
    const secrets = new PairSecrets(tempHome());
    const a = secrets.create().secret;
    const b = secrets.create().secret;
    assert.equal(secrets.consume(a), false);
    assert.equal(secrets.consume(b), true);
  });
});

describe('responder decision', () => {
  const setup = () => {
    const home = tempHome();
    return { home, noiseKey: x25519KeyPair(), phones: new PhoneStore(home), secrets: new PairSecrets(home) };
  };
  const msg1 = (bridgePub, phoneKey, payload) => {
    const hs = new HandshakeIK({ initiator: true, s: phoneKey, rs: bridgePub });
    return { hs, msg1: hs.writeMessage1(Buffer.from(JSON.stringify(payload))) };
  };
  const run = (ctx, payload, phoneKey = x25519KeyPair()) => {
    const m = msg1(ctx.noiseKey.publicKey, phoneKey, payload);
    const r = respondToPhone({ msg1: m.msg1, noiseKey: ctx.noiseKey, phones: ctx.phones, secrets: ctx.secrets, bridgeName: 'Desk', bridgeId: 'bid' });
    return { r, reply: JSON.parse(m.hs.readMessage2(r.msg2).toString()), phoneKey };
  };

  it('pairs with a valid secret, then knows the phone by its key', () => {
    const ctx = setup();
    const { secret } = ctx.secrets.create();
    const first = run(ctx, { phone_id: 'p1', name: 'My iPhone', pair_secret: secret });
    assert.equal(first.r.ok, true);
    assert.equal(first.r.how, 'paired');
    assert.deepEqual(first.reply, { ok: true, name: 'Desk', bridge_id: 'bid' });
    assert.equal(ctx.phones.list()[0].noise_pub, b64url(first.phoneKey.publicKey));
    const again = run(ctx, { phone_id: 'p1', name: 'My iPhone' }, first.phoneKey);
    assert.equal(again.r.how, 'known');
  });

  it('answers not_paired for an unknown phone, a reused secret and an expired secret', () => {
    const ctx = setup();
    assert.deepEqual(run(ctx, { phone_id: 'x', name: 'Stranger' }).reply, { ok: false, reason: 'not_paired' });
    const { secret } = ctx.secrets.create();
    assert.equal(run(ctx, { phone_id: 'p1', name: 'A', pair_secret: secret }).r.ok, true);
    assert.deepEqual(run(ctx, { phone_id: 'p2', name: 'B', pair_secret: secret }).reply, { ok: false, reason: 'not_paired' }, 'reused');
    const expiring = new PairSecrets(ctx.home, { ttlMs: -1 });
    const old = expiring.create().secret;
    assert.deepEqual(run(ctx, { phone_id: 'p3', name: 'C', pair_secret: old }).reply, { ok: false, reason: 'not_paired' }, 'expired');
    assert.equal(ctx.phones.list().length, 1);
  });

  it('throws for a message 1 made for another bridge key', () => {
    const ctx = setup();
    const m = msg1(x25519KeyPair().publicKey, x25519KeyPair(), { phone_id: 'p' });
    assert.throws(() => respondToPhone({ msg1: m.msg1, noiseKey: ctx.noiseKey, phones: ctx.phones, secrets: ctx.secrets, bridgeName: 'D', bridgeId: 'b' }));
  });
});
