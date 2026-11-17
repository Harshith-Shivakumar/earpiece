// Address ordering, Tailscale detection (fail soft), pairing link and pairing text (SPEC 11.2, 11.3).

import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  TAILSCALE_APP_CLI, detectAddresses, findTailscaleCli, isTailscaleIPv4, listAddresses, parseTailscaleStatus, tailscaleStatus, wsUrl,
} from '../src/addresses.js';
import { pairingLink, pairingLinkV2, pairingText, qrLink, qrLinkV2 } from '../src/pairing.js';
import { MAX_BYTES } from '../src/qr.js';
import { tempHome } from './helpers.js';

// Trimmed `tailscale status --json` output (CLI 1.7x shape).
const STATUS_FIXTURE = JSON.stringify({
  Version: '1.76.6-t1234',
  BackendState: 'Running',
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  Self: {
    ID: 'nABC123',
    HostName: 'Harshiths-MacBook-Pro',
    DNSName: 'harshiths-macbook-pro.tail1234.ts.net.',
    OS: 'macOS',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    Online: true,
  },
  MagicDNSSuffix: 'tail1234.ts.net',
  Peer: {},
});

const IFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
  en15: [{ address: '169.254.49.111', family: 'IPv4', internal: false }],
  en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.20', family: 'IPv4', internal: false }],
  utun4: [{ address: '100.101.102.103', family: 4, internal: false }],
};

describe('addresses', () => {
  it('recognises the Tailscale range 100.64.0.0/10', () => {
    for (const ip of ['100.64.0.1', '100.101.102.103', '100.127.255.255']) assert.equal(isTailscaleIPv4(ip), true, ip);
    for (const ip of ['100.63.255.255', '100.128.0.1', '10.0.0.1', '192.168.1.20', 'nope', '']) assert.equal(isTailscaleIPv4(ip), false, ip);
  });

  it('orders MagicDNS, Tailscale IPs, LAN, then link-local', () => {
    const list = listAddresses({ interfaces: IFACES, tailscale: parseTailscaleStatus(STATUS_FIXTURE) });
    assert.deepEqual(list.map((a) => [a.host, a.kind, a.iface]), [
      ['harshiths-macbook-pro.tail1234.ts.net', 'tailscale', 'MagicDNS'],
      ['100.101.102.103', 'tailscale', 'utun4'],
      ['192.168.1.20', 'lan', 'en0'],
      ['169.254.49.111', 'lan', 'en15'],
    ]);
  });

  it('falls back to the Tailscale IP without a CLI, and to LAN without Tailscale', () => {
    assert.deepEqual(listAddresses({ interfaces: IFACES }).map((a) => a.host), ['100.101.102.103', '192.168.1.20', '169.254.49.111']);
    const noTs = { en0: IFACES.en0 };
    assert.deepEqual(listAddresses({ interfaces: noTs, tailscale: { dnsName: 'x.ts.net', running: false } }).map((a) => a.host), ['192.168.1.20']);
    assert.deepEqual(listAddresses({ interfaces: { lo0: IFACES.lo0 } }).map((a) => [a.host, a.kind]), [['127.0.0.1', 'local']]);
  });

  it('uses only the configured host when one is set', () => {
    assert.deepEqual(listAddresses({ interfaces: IFACES, host: '100.70.1.2' }), [{ host: '100.70.1.2', kind: 'tailscale', iface: 'configured host' }]);
    assert.equal(wsUrl('192.168.1.20', 8787), 'ws://192.168.1.20:8787/ws');
    assert.equal(wsUrl('fd00::1', 8787), 'ws://[fd00::1]:8787/ws');
  });
});

describe('Tailscale CLI', () => {
  it('parses MagicDNS from status JSON and drops the trailing dot', () => {
    assert.deepEqual(parseTailscaleStatus(STATUS_FIXTURE), { dnsName: 'harshiths-macbook-pro.tail1234.ts.net', running: true });
    assert.deepEqual(parseTailscaleStatus('{"BackendState":"Stopped","Self":{"DNSName":""}}'), { dnsName: null, running: false });
    assert.deepEqual(parseTailscaleStatus('{}'), { dnsName: null, running: false });
    assert.equal(parseTailscaleStatus('Tailscale is stopped.'), null);
  });

  it('finds the CLI on PATH, then in the app bundle', () => {
    assert.equal(findTailscaleCli({ env: { PATH: '/a:/b' }, exists: (p) => p === '/b/tailscale' }), '/b/tailscale');
    assert.equal(findTailscaleCli({ env: { PATH: '/a' }, exists: (p) => p === TAILSCALE_APP_CLI }), TAILSCALE_APP_CLI);
    assert.equal(findTailscaleCli({ env: { PATH: '/a' }, exists: () => false }), null);
  });

  it('runs the CLI, and fails soft when it is missing, broken or slow', async () => {
    const dir = tempHome();
    const fixture = join(dir, 'status.json');
    writeFileSync(fixture, STATUS_FIXTURE);
    const good = join(dir, 'tailscale-good');
    writeFileSync(good, `#!/bin/sh\n[ "$1 $2" = "status --json" ] || exit 9\ncat '${fixture}'\n`);
    const broken = join(dir, 'tailscale-broken');
    writeFileSync(broken, '#!/bin/sh\necho "failed to connect to local tailscaled" >&2\nexit 1\n');
    const slow = join(dir, 'tailscale-slow');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\necho "{}"\n');
    for (const f of [good, broken, slow]) chmodSync(f, 0o755);

    assert.deepEqual(await tailscaleStatus({ cli: good }), { dnsName: 'harshiths-macbook-pro.tail1234.ts.net', running: true });
    assert.equal(await tailscaleStatus({ cli: broken }), null);
    assert.equal(await tailscaleStatus({ cli: join(dir, 'missing') }), null);
    assert.equal(await tailscaleStatus({ cli: null }), null);
    const t0 = Date.now();
    assert.equal(await tailscaleStatus({ cli: slow, timeoutMs: 300 }), null);
    assert.ok(Date.now() - t0 < 2000, 'gave up on time');

    const list = await detectAddresses({ port: 8787, interfaces: IFACES, cli: good });
    assert.equal(list[0].url, 'ws://harshiths-macbook-pro.tail1234.ts.net:8787/ws');
    const noCli = await detectAddresses({ port: 8787, interfaces: IFACES, cli: null });
    assert.equal(noCli[0].url, 'ws://100.101.102.103:8787/ws');
  });
});

describe('pairing link', () => {
  const info = {
    name: "Harshith's Mac & co",
    bridgeId: '3f1c8a2e-6b4d-4e8f-9a1b-2c3d4e5f6a7b',
    token: 'k7xm-p3qa-9zrt-w2hd',
    urls: ['ws://harshiths-macbook-pro.tail1234.ts.net:8787/ws', 'ws://100.101.102.103:8787/ws', 'ws://192.168.1.20:8787/ws'],
  };

  it('builds earpiece://pair with every field URL-encoded and URLs in order', () => {
    const link = pairingLink(info);
    assert.equal(
      link,
      "earpiece://pair?v=1&name=Harshith's%20Mac%20%26%20co&id=3f1c8a2e-6b4d-4e8f-9a1b-2c3d4e5f6a7b&token=k7xm-p3qa-9zrt-w2hd" +
        '&url=ws://harshiths-macbook-pro.tail1234.ts.net:8787/ws&url=ws://100.101.102.103:8787/ws&url=ws://192.168.1.20:8787/ws',
    );
    const u = new URL(link);
    assert.equal(u.protocol, 'earpiece:');
    assert.equal(u.searchParams.get('v'), '1');
    assert.equal(u.searchParams.get('name'), info.name);
    assert.equal(u.searchParams.get('id'), info.bridgeId);
    assert.equal(u.searchParams.get('token'), info.token);
    assert.deepEqual(u.searchParams.getAll('url'), info.urls);
  });

  it('keeps every URL in the QR link when they fit', () => {
    const two = { ...info, urls: info.urls.slice(0, 2) };
    assert.deepEqual(qrLink(two), { link: pairingLink(two), urls: two.urls, urlCount: 2 });
  });

  it('trims the QR link to fit: link-local first, then the Tailscale IP next to MagicDNS', () => {
    // Long enough to overflow version 20-M (666 bytes) only together.
    const long = (i) => `ws://a-really-long-host-name-for-testing-number-${i}.example.internal:8787/ws`;
    const addresses = [
      { url: 'ws://harshiths-macbook-pro.tail1234.ts.net:8787/ws', host: 'harshiths-macbook-pro.tail1234.ts.net', kind: 'tailscale', iface: 'MagicDNS' },
      { url: 'ws://100.101.102.103:8787/ws', host: '100.101.102.103', kind: 'tailscale', iface: 'utun4' },
      ...Array.from({ length: 6 }, (_, i) => ({ url: long(i), host: `h${i}`, kind: 'lan', iface: `en${i}` })),
      { url: 'ws://169.254.49.111:8787/ws', host: '169.254.49.111', kind: 'lan', iface: 'en15' },
    ];
    const full = { ...info, urls: addresses.map((a) => a.url) };
    assert.ok(Buffer.byteLength(pairingLink(full)) > MAX_BYTES);
    const q = qrLink(full, addresses);
    assert.ok(Buffer.byteLength(q.link) <= MAX_BYTES);
    assert.ok(!q.urls.includes('ws://169.254.49.111:8787/ws'), 'link-local went first');
    assert.ok(!q.urls.includes('ws://100.101.102.103:8787/ws'), 'then the Tailscale IP');
    assert.equal(q.urls[0], addresses[0].url, 'MagicDNS kept');
    assert.deepEqual(new URL(q.link).searchParams.getAll('url'), q.urls);
    // Without address kinds, the lowest-priority (last) URLs go first.
    const many = { ...info, urls: Array.from({ length: 12 }, (_, i) => long(i)) };
    const m = qrLink(many);
    assert.ok(m.urlCount > 0 && m.urlCount < 12);
    assert.deepEqual(m.urls, many.urls.slice(0, m.urlCount));
  });

  it('prints name, marked addresses, the link and the QR code; hides the secret when asked', () => {
    const addresses = listAddresses({ interfaces: IFACES, tailscale: parseTailscaleStatus(STATUS_FIXTURE) }).map((a) => ({ ...a, url: wsUrl(a.host, 8787) }));
    const text = pairingText({ name: 'Mac', bridgeId: 'id-1', token: 'tok-secret', addresses });
    assert.match(text, /^Bridge: Mac {2}\(id id-1\)/);
    assert.match(text, /ws:\/\/harshiths-macbook-pro\.tail1234\.ts\.net:8787\/ws {3}\(Tailscale, MagicDNS\)/);
    assert.match(text, /ws:\/\/192\.168\.1\.20:8787\/ws {3}\(LAN, en0\)/);
    assert.ok(text.includes('earpiece://pair?v=1&name=Mac&id=id-1&token=tok-secret&url=ws://harshiths-macbook-pro.tail1234.ts.net:8787/ws'));
    assert.ok(text.includes('█▀▀▀▀▀█'), 'QR code drawn');
    const hidden = pairingText({ name: 'Mac', bridgeId: 'id-1', token: 'tok-secret', addresses, showSecret: false });
    assert.ok(!hidden.includes('tok-secret'));
    assert.match(hidden, /npm run pair/);
    const lanOnly = pairingText({ name: 'Mac', bridgeId: 'id-1', token: 't', addresses: [{ host: '192.168.1.20', kind: 'lan', iface: 'en0', url: 'ws://192.168.1.20:8787/ws' }] });
    assert.match(lanOnly, /No Tailscale address found/);
  });
});

describe('pairing link v2', () => {
  const v2 = { name: 'Mac', bridgeId: 'b-1', relay: 'wss://relay.example.workers.dev', key: 'K'.repeat(43), secret: 'S'.repeat(22), token: 'tok-1' };

  it('carries the token exactly when it carries direct URLs', () => {
    const withUrls = new URL(pairingLinkV2({ ...v2, urls: ['ws://100.101.102.103:8787/ws', 'ws://192.168.1.20:8787/ws'] }));
    assert.equal(withUrls.searchParams.get('v'), '2');
    assert.equal(withUrls.searchParams.get('relay'), v2.relay);
    assert.equal(withUrls.searchParams.get('key'), v2.key);
    assert.equal(withUrls.searchParams.get('secret'), v2.secret);
    assert.equal(withUrls.searchParams.get('token'), 'tok-1');
    assert.deepEqual(withUrls.searchParams.getAll('url'), ['ws://100.101.102.103:8787/ws', 'ws://192.168.1.20:8787/ws']);
    const relayOnly = new URL(pairingLinkV2({ ...v2, urls: [] }));
    assert.equal(relayOnly.searchParams.get('token'), null, 'no token without direct URLs');
    assert.deepEqual(relayOnly.searchParams.getAll('url'), []);
  });

  it('drops direct URLs, and the token with the last of them, when the QR would be too large', () => {
    const long = (i) => `ws://a-really-long-direct-host-name-for-testing-${i}.example.internal:8787/ws`;
    const big = { ...v2, urls: Array.from({ length: 12 }, (_, i) => long(i)) };
    assert.ok(Buffer.byteLength(pairingLinkV2(big)) > MAX_BYTES);
    const q = qrLinkV2(big);
    assert.ok(Buffer.byteLength(q.link) <= MAX_BYTES);
    assert.ok(q.urlCount > 0 && q.urlCount < 12);
    assert.equal(new URL(q.link).searchParams.get('token'), 'tok-1');
    const huge = { ...v2, name: 'x'.repeat(480), urls: [long(0)] }; // only the relay part fits
    const h = qrLinkV2(huge);
    assert.equal(h.urlCount, 0);
    const u = new URL(h.link);
    assert.equal(u.searchParams.get('token'), null);
    assert.deepEqual(u.searchParams.getAll('url'), []);
    assert.equal(u.searchParams.get('secret'), v2.secret);
  });
});
