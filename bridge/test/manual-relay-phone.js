#!/usr/bin/env node
// Manual end-to-end check through a REAL relay and a REAL running bridge (not part of npm test).
// Acts as a phone: creates a fresh pairing secret, pairs over Noise IK through the relay, sends
// hello and list_chats, prints what comes back, then exits. Unpair afterwards with
//   npm run unpair -- "Relay test phone"
// Usage: node test/manual-relay-phone.js ws://<relay-host>:8790
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { PairSecrets, loadKeys } from '../src/keys.js';
import { HandshakeIK, b64url, fromB64url, x25519KeyPair } from '../src/noise.js';

const relay = (process.argv[2] || 'ws://127.0.0.1:8790').replace(/\/$/, '');
const config = loadConfig();
const keys = loadKeys(config.home);
const secret = new PairSecrets(config.home, { ttlMs: config.pairSecretTtlMs }).create();
const phone = x25519KeyPair();
const hs = new HandshakeIK({ initiator: true, s: phone, rs: keys.noise.publicKey });
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(2).padStart(6), ...a);

const ws = new WebSocket(`${relay}/v1/phone/${config.bridgeId}`);
let transport = null;
const sendApp = (obj) => {
  log('>> (encrypted)', JSON.stringify(obj));
  ws.send(JSON.stringify({ t: 'data', d: b64url(transport.encrypt(Buffer.from(JSON.stringify(obj)))) }));
};
const sendMsg1 = () => {
  if (sent1) return;
  sent1 = true;
  const payload = { phone_id: randomUUID(), name: 'Relay test phone', pair_secret: secret.secret ?? secret };
  ws.send(JSON.stringify({ t: 'data', d: b64url(hs.writeMessage1(Buffer.from(JSON.stringify(payload)))) }));
  log('>> Noise message 1 (pairing)');
};
let sent1 = false;
ws.onopen = () => { log('relay socket open'); setTimeout(() => { if (!sent1) sendMsg1(); }, 300); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === 'bridge_offline') return log('<< bridge_offline');
  if (m.t === 'bridge_online' || (m.t !== 'data' && !transport && m.t !== 'pong')) log('<<', m.t);
  if (m.t === 'bridge_online') return sendMsg1();
  if (m.t !== 'data') return;
  const bytes = fromB64url(m.d);
  if (!transport) {
    const payload = JSON.parse(hs.readMessage2(bytes).toString());
    log('<< Noise message 2', JSON.stringify(payload));
    transport = hs.transport;
    if (!payload.ok) process.exit(1);
    return sendApp({ type: 'hello', last_seq: 0, client: 'relay-test' });
  }
  const msg = JSON.parse(transport.decrypt(bytes).toString());
  if (msg.type === 'welcome') { log('<< welcome', `name=${msg.name} state=${msg.state}`); return sendApp({ type: 'list_chats' }); }
  if (msg.type === 'chats') {
    log('<< chats:', msg.items.length);
    for (const c of msg.items.slice(0, 3)) log('     ', c.folder, '|', c.title);
    ws.close();
    process.exit(0);
  }
  log('<<', msg.type);
};
setTimeout(() => { log('TIMEOUT'); process.exit(1); }, 15000);
