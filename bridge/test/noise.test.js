// Noise IK: the committed interop vectors, the official cacophony vector, and failure cases.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  HandshakeIK, PROTOCOL_NAME, aeadDecrypt, aeadEncrypt, b64url, dh, ed25519KeyPair, ed25519Sign, ed25519Verify, fromB64url, hkdf, x25519KeyPair,
} from '../src/noise.js';
import { AUTH_PREFIX, authSignature, bridgeEndpoint } from '../src/relay.js';
import { VECTORS_PATH, buildVectors } from './gen-noise-vectors.js';

const H = (s) => Buffer.from(s, 'hex');

describe('interop vectors (earpiece/spec/noise-vectors.json)', () => {
  const v = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));

  it('the committed file is exactly what the generator produces', () => {
    assert.deepEqual(v, JSON.parse(JSON.stringify(buildVectors())));
  });

  it('replays: both handshake messages, the hash, the keys and all six transport messages', () => {
    const phone = new HandshakeIK({ initiator: true, s: x25519KeyPair(H(v.phone_static_private)), e: x25519KeyPair(H(v.phone_ephemeral_private)), rs: H(v.bridge_static_public) });
    const bridge = new HandshakeIK({ initiator: false, s: x25519KeyPair(H(v.bridge_static_private)), e: x25519KeyPair(H(v.bridge_ephemeral_private)) });
    assert.equal(x25519KeyPair(H(v.phone_static_private)).publicKey.toString('hex'), v.phone_static_public);
    assert.equal(b64url(H(v.bridge_static_public)), v.bridge_static_public_b64url);
    assert.equal(phone.writeMessage1(Buffer.from(v.msg1_payload)).toString('hex'), v.msg1);
    assert.equal(bridge.readMessage1(H(v.msg1)).toString(), v.msg1_payload);
    assert.equal(bridge.rs.toString('hex'), v.phone_static_public);
    assert.equal(bridge.writeMessage2(Buffer.from(v.msg2_payload)).toString('hex'), v.msg2);
    assert.equal(phone.readMessage2(H(v.msg2)).toString(), v.msg2_payload);
    assert.equal(phone.handshakeHash.toString('hex'), v.handshake_hash);
    assert.equal(bridge.handshakeHash.toString('hex'), v.handshake_hash);
    assert.equal(phone.transport.send.k.toString('hex'), v.phone_to_bridge_key);
    assert.equal(bridge.transport.recv.k.toString('hex'), v.phone_to_bridge_key);
    assert.equal(bridge.transport.send.k.toString('hex'), v.bridge_to_phone_key);
    assert.equal(v.transport.length, 6);
    for (const m of v.transport) {
      const [from, to] = m.direction === 'phone_to_bridge' ? [phone, bridge] : [bridge, phone];
      assert.equal(from.transport.encrypt(Buffer.from(m.plaintext)).toString('hex'), m.ciphertext);
      assert.equal(to.transport.decrypt(H(m.ciphertext)).toString(), m.plaintext);
      // The stated key and nonce decrypt it directly too.
      const key = H(m.direction === 'phone_to_bridge' ? v.phone_to_bridge_key : v.bridge_to_phone_key);
      assert.equal(aeadDecrypt(key, m.nonce, Buffer.alloc(0), H(m.ciphertext)).toString(), m.plaintext);
    }
    assert.equal(v.protocol_name, PROTOCOL_NAME);
    assert.equal(v.prologue, 'earpiece/2');
    assert.ok(Array.isArray(v.format) && v.format.length > 5);
  });
});

describe('official cacophony vector Noise_IK_25519_ChaChaPoly_SHA256', () => {
  // From haskell-cryptography/cacophony vectors/cacophony.txt. The two handshake ciphertexts are
  // not copied here; the handshake hash commits to both, and messages 3-6 depend on Split().
  it('gives the published handshake hash and transport ciphertexts', () => {
    const prologue = H('4a6f686e2047616c74'); // "John Galt"
    const initS = x25519KeyPair(H('e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1'));
    const initE = x25519KeyPair(H('893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a'));
    const respS = x25519KeyPair(H('4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893'));
    const respE = x25519KeyPair(H('bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b'));
    assert.equal(respS.publicKey.toString('hex'), '31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62', 'init_remote_static');
    const i = new HandshakeIK({ initiator: true, s: initS, e: initE, rs: respS.publicKey, prologue });
    const r = new HandshakeIK({ initiator: false, s: respS, e: respE, prologue });
    assert.equal(r.readMessage1(i.writeMessage1(H('4c756477696720766f6e204d69736573'))).toString('hex'), '4c756477696720766f6e204d69736573');
    assert.equal(i.readMessage2(r.writeMessage2(H('4d757272617920526f746862617264'))).toString('hex'), '4d757272617920526f746862617264');
    assert.equal(i.handshakeHash.toString('hex'), '0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7');
    const msgs = [
      [i, '462e20412e20486179656b', '050e9f3c8fac16b68dbce8f8c4bfbf6617c897f9ada4aa29aa19c8'],
      [r, '4361726c204d656e676572', '344233a6cabb7141d80f3da2fedc311d9646bbb0f505afe403a667'],
      [i, '4a65616e2d426170746973746520536179', '62cdeeb172ad7ade7aa7d9e069da5790f12331bfa00177787a1d0810c67dc3b2b4'],
      [r, '457567656e2042f6686d20766f6e2042617765726b', '029bead1b40992327044d409d9a1f3ad8f36c3c452775d557e18bbeb2e8dfcead32d514024'],
    ];
    for (const [from, payload, ct] of msgs) assert.equal(from.transport.encrypt(H(payload)).toString('hex'), ct);
  });
});

describe('failure cases', () => {
  const pair = () => {
    const phone = x25519KeyPair();
    const bridge = x25519KeyPair();
    return {
      phone,
      bridge,
      i: new HandshakeIK({ initiator: true, s: phone, rs: bridge.publicKey }),
      r: new HandshakeIK({ initiator: false, s: bridge }),
    };
  };

  it('a phone using the wrong bridge key cannot get through message 1', () => {
    const bridge = x25519KeyPair();
    const i = new HandshakeIK({ initiator: true, s: x25519KeyPair(), rs: x25519KeyPair().publicKey });
    const r = new HandshakeIK({ initiator: false, s: bridge });
    assert.throws(() => r.readMessage1(i.writeMessage1(Buffer.from('{}'))), /decryption failed/);
  });

  it('a tampered message 1 or 2 fails', () => {
    for (const idx of [0, 40, 90]) {
      const { i, r } = pair();
      const m1 = i.writeMessage1(Buffer.from('{"phone_id":"x"}'));
      m1[idx] ^= 1;
      assert.throws(() => r.readMessage1(m1), /decryption failed/, `byte ${idx}`);
    }
    const { i, r } = pair();
    r.readMessage1(i.writeMessage1(Buffer.from('a')));
    const m2 = r.writeMessage2(Buffer.from('b'));
    m2[m2.length - 1] ^= 0x80;
    assert.throws(() => i.readMessage2(m2), /decryption failed/);
    assert.throws(() => new HandshakeIK({ initiator: false, s: x25519KeyPair() }).readMessage1(Buffer.alloc(40)), /too short/);
  });

  it('a replayed or reordered transport message fails and does not move the counter', () => {
    const { i, r } = pair();
    r.readMessage1(i.writeMessage1(Buffer.alloc(0)));
    i.readMessage2(r.writeMessage2(Buffer.alloc(0)));
    const a = i.transport.encrypt(Buffer.from('one'));
    const b = i.transport.encrypt(Buffer.from('two'));
    assert.throws(() => r.transport.decrypt(b), /decryption failed/, 'out of order');
    assert.equal(r.transport.decrypt(a).toString(), 'one');
    assert.throws(() => r.transport.decrypt(a), /decryption failed/, 'replay');
    assert.equal(r.transport.decrypt(b).toString(), 'two');
  });

  it('rejects handshake calls out of order and a low-order public key', () => {
    const { i, r } = pair();
    assert.throws(() => i.readMessage2(Buffer.alloc(64)), /out of order/);
    assert.throws(() => r.writeMessage2(Buffer.alloc(0)), /out of order/);
    assert.throws(() => dh(x25519KeyPair().privateKey, Buffer.alloc(32)));
  });
});

describe('primitives', () => {
  it('HKDF and ChaChaPoly behave as specified', () => {
    const [a, b, c] = hkdf(Buffer.alloc(32), Buffer.from('ikm'), 3);
    assert.equal(a.length, 32);
    assert.notDeepEqual(a, b);
    assert.notDeepEqual(b, c);
    const k = Buffer.alloc(32, 7);
    const ct = aeadEncrypt(k, 5, Buffer.from('ad'), Buffer.from('hello'));
    assert.equal(ct.length, 5 + 16);
    assert.equal(aeadDecrypt(k, 5, Buffer.from('ad'), ct).toString(), 'hello');
    assert.throws(() => aeadDecrypt(k, 6, Buffer.from('ad'), ct), /decryption failed/);
    assert.throws(() => aeadDecrypt(k, 5, Buffer.from('xx'), ct), /decryption failed/);
  });

  it('base64url, Ed25519 and the relay auth signature', () => {
    const kp = ed25519KeyPair();
    assert.equal(fromB64url(b64url(kp.publicKey), 32).toString('hex'), kp.publicKey.toString('hex'));
    assert.throws(() => fromB64url('abc=', 32));
    assert.throws(() => fromB64url(b64url(Buffer.alloc(31)), 32));
    const nonce = Buffer.alloc(32, 9);
    const sig = authSignature(kp.privateKey, nonce);
    assert.equal(sig.length, 64);
    assert.equal(ed25519Verify(kp.publicKey, Buffer.concat([Buffer.from('earpiece-relay-auth/1:'), nonce]), sig), true);
    assert.equal(ed25519Verify(kp.publicKey, Buffer.concat([AUTH_PREFIX, Buffer.alloc(32)]), sig), false);
    assert.deepEqual(ed25519Sign(kp.privateKey, Buffer.from('x')), ed25519Sign(kp.privateKey, Buffer.from('x')), 'deterministic');
    // RFC 8032 section 7.1, test 1 (empty message).
    const rfc = ed25519KeyPair(H('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
    assert.equal(rfc.publicKey.toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    assert.equal(
      ed25519Sign(rfc.privateKey, Buffer.alloc(0)).toString('hex'),
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
  });

  it('builds the relay bridge endpoint', () => {
    assert.equal(bridgeEndpoint('wss://relay.example.workers.dev', 'b1'), 'wss://relay.example.workers.dev/v1/bridge?id=b1');
    assert.equal(bridgeEndpoint('ws://127.0.0.1:8790/', 'b1'), 'ws://127.0.0.1:8790/v1/bridge?id=b1');
    assert.equal(bridgeEndpoint('ws://127.0.0.1:8790/v1/bridge', 'b1'), 'ws://127.0.0.1:8790/v1/bridge?id=b1');
  });
});
