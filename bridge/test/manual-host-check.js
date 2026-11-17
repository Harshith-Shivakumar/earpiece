#!/usr/bin/env node
// Manual end-to-end check of the voice host through a REAL relay and a REAL running bridge
// (not part of npm test). Acts as a paired phone over Noise and has a short spoken-style
// conversation, printing every spoken line with timestamps.
// Usage: EARPIECE_HOME=<bridge home> node test/manual-host-check.js wss://<relay>
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { PairSecrets, loadKeys } from '../src/keys.js';
import { HandshakeIK, b64url, fromB64url, x25519KeyPair } from '../src/noise.js';

const relay = (process.argv[2] || '').replace(/\/$/, '');
const config = loadConfig();
const keys = loadKeys(config.home);
const secret = new PairSecrets(config.home, { ttlMs: config.pairSecretTtlMs }).create();
const hs = new HandshakeIK({ initiator: true, s: x25519KeyPair(), rs: keys.noise.publicKey });
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (...a) => console.log(ts(), ...a);

let transport = null;
let state = 'idle';
let lastSayAt = Date.now();
const says = [];
const waiters = [];
const ws = new WebSocket(`${relay}/v1/phone/${config.bridgeId}`);
const send = (obj) => ws.send(JSON.stringify({ t: 'data', d: b64url(transport.encrypt(Buffer.from(JSON.stringify(obj)))) }));
const say = (text) => { log(`DRIVER: ${text}`); send({ type: 'utterance', text }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (pred, ms = 180000) => new Promise((res) => {
  const w = { pred, res };
  waiters.push(w);
  setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null); } }, ms);
});
const settle = async (quietMs = 5000, ms = 240000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (state !== 'working' && Date.now() - lastSayAt > quietMs) return true;
    await sleep(250);
  }
  return false;
};

ws.onopen = () => setInterval(() => { try { ws.send('{"t":"ping"}'); } catch {} }, 25000) && setTimeout(() => {
  const payload = { phone_id: randomUUID(), name: 'Host check phone', pair_secret: secret.secret };
  ws.send(JSON.stringify({ t: 'data', d: b64url(hs.writeMessage1(Buffer.from(JSON.stringify(payload)))) }));
}, 300);
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.t === 'bridge_offline') return log('relay: bridge offline');
  if (m.t !== 'data') return;
  const bytes = fromB64url(m.d);
  if (!transport) {
    const p = JSON.parse(hs.readMessage2(bytes).toString());
    transport = hs.transport;
    log(`paired via relay: ${p.ok}`);
    return send({ type: 'hello', last_seq: 0, client: 'host-check' });
  }
  const msg = JSON.parse(transport.decrypt(bytes).toString());
  if (msg.type === 'say') { lastSayAt = Date.now(); says.push(msg); log(`  ${msg.kind.toUpperCase()}: ${msg.text}`); }
  else if (msg.type === 'state') state = msg.state;
  else if (msg.type === 'drive_ended') log(`  drive_ended (${msg.chats.length} chat)`);
  for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.res(msg); }
};

await waitFor((m) => m.type === 'welcome', 20000);
if (!process.env.SKIP_INTRO) {
  say("hey, quick one, what's a race condition, in a sentence?");
  await settle();
  say('what files are in this folder?');
  await waitFor((m) => m.type === 'state' && m.state === 'working', 60000);
  await settle();
}
say('make a new markdown file for my plans, and ask me whether to call it plans or roadmap');
// Either the host or Claude Code asks; wait for a spoken question, then answer it.
await waitFor((m) => m.type === 'say' && /\?\s*$/.test(m.text), 180000);
await settle(3000);
say('roadmap');
await sleep(2000);
await settle(6000);
const work = config.startDir;
log(`roadmap.md created: ${existsSync(join(work, 'roadmap.md'))}`);
say('and drive');
await waitFor((m) => m.type === 'drive_ended', 120000);
ws.close();
process.exit(0);
