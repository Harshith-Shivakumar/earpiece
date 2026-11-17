// End-to-end sessions over the relay (SPEC 12.3): the Noise IK responder decision, and a virtual
// phone connection with the same interface as a direct WebSocketConnection, so the session code
// (hello, replay, one active phone, drive_ended re-send) handles both the same way.

import { EventEmitter } from 'node:events';
import { HandshakeIK, b64url, fromB64url } from './noise.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Process handshake message 1 as the responder.
 * Returns { ok: true, msg2, transport, phone, how: 'known' | 'paired' } or
 * { ok: false, reason: 'not_paired', msg2 } (send msg2, then close). Throws if message 1 cannot be
 * read at all (wrong bridge key, tampered or truncated message): just close the connection.
 */
export function respondToPhone({ msg1, noiseKey, phones, secrets, bridgeName, bridgeId }) {
  const hs = new HandshakeIK({ initiator: false, s: noiseKey });
  const raw = hs.readMessage1(msg1);
  let payload = {};
  try {
    const v = JSON.parse(raw.toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) payload = v;
  } catch {
    payload = {};
  }
  const noisePub = b64url(hs.rs);
  const phoneId = typeof payload.phone_id === 'string' && payload.phone_id.trim() ? payload.phone_id.trim().slice(0, 64) : null;
  const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim().slice(0, 60) : 'iPhone';

  let phone = phones.findByKey(noisePub);
  let how = 'known';
  if (phone) {
    phone = phones.touch(noisePub, name) ?? phone;
  } else if (phoneId && typeof payload.pair_secret === 'string' && secrets.consume(payload.pair_secret)) {
    phone = phones.add({ phone_id: phoneId, name, noise_pub: noisePub });
    how = 'paired';
  }
  if (!phone) {
    const msg2 = hs.writeMessage2(Buffer.from(JSON.stringify({ ok: false, reason: 'not_paired' })));
    return { ok: false, reason: 'not_paired', msg2, noisePub, name };
  }
  const msg2 = hs.writeMessage2(Buffer.from(JSON.stringify({ ok: true, name: bridgeName, bridge_id: bridgeId })));
  return { ok: true, msg2, transport: hs.transport, phone: { phone_id: phone.phone_id, name: phone.name, noise_pub: noisePub }, how };
}

/**
 * A phone connection carried by the relay. Events: 'message' (text, false), 'close' (code, reason),
 * 'socketError'. sendFrame(obj) writes one relay frame ({t:'data'|'close', c, ...}).
 */
export class TunnelConn extends EventEmitter {
  constructor({ c, transport, phone, sendFrame }) {
    super();
    this.c = c;
    this.transport = transport;
    this.phone = phone;
    this.sendFrame = sendFrame;
    this.readyState = 'open';
    this.tunnel = true;
    this.remoteAddress = `relay (${phone.name})`;
  }

  send(text) {
    if (this.readyState !== 'open') return false;
    let ct;
    try {
      ct = this.transport.encrypt(Buffer.from(String(text), 'utf8'));
    } catch (err) {
      this.emit('socketError', err);
      return false;
    }
    return this.sendFrame({ t: 'data', c: this.c, d: b64url(ct) });
  }

  /** A data frame from the relay. A decryption failure closes the connection (SPEC 12.3). */
  receive(d) {
    if (this.readyState !== 'open') return;
    let text;
    try {
      text = utf8.decode(this.transport.decrypt(fromB64url(d)));
    } catch (err) {
      this.emit('socketError', new Error(`tunnel: ${err.message}; closing`));
      this.close(4002, 'decryption failed');
      return;
    }
    this.emit('message', text, false);
  }

  /** Close from our side: tell the relay, then report it like a socket close. */
  close(code = 1000, reason = '') {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.sendFrame({ t: 'close', c: this.c });
    this.emit('close', code, reason);
  }

  /** The relay closed it (phone left, or the relay connection dropped). */
  remoteClosed(reason = 'closed by the relay') {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.emit('close', 1006, reason);
  }

  terminate() {
    this.close(1006, 'terminated');
  }

  ping() {
    return false;
  }

  startHeartbeat() {
    // The relay connection has its own keepalive; nothing per tunnel.
  }
}
