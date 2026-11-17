// Pairing link and QR code (SPEC 11.3). The token is only ever printed to a local terminal.

import { MAX_BYTES, encodeQR, renderHalfBlocks } from './qr.js';

// URLs keep ':' and '/' unescaped (legal in a query, RFC 3986) so more of them fit in the QR code.
function encUrl(u) {
  return encodeURIComponent(u).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}

/** earpiece://pair?v=1&name=..&id=..&token=..&url=..&url=.. (Tailscale URLs first, as given). */
export function pairingLink({ name, bridgeId, token, urls = [] }) {
  let q = `v=1&name=${encodeURIComponent(name)}&id=${encodeURIComponent(bridgeId)}&token=${encodeURIComponent(token)}`;
  for (const u of urls) q += `&url=${encUrl(u)}`;
  return `earpiece://pair?${q}`;
}

/**
 * SPEC 12.4 link v2: earpiece://pair?v=2&name=&id=&relay=&key=&secret=[&token=]&url=...
 * `token` is only included together with direct URLs: a direct WebSocket still needs it (12.3).
 */
export function pairingLinkV2({ name, bridgeId, relay, key, secret, token = null, urls = [] }) {
  let q = `v=2&name=${encodeURIComponent(name)}&id=${encodeURIComponent(bridgeId)}&relay=${encUrl(relay)}`;
  q += `&key=${encodeURIComponent(key)}&secret=${encodeURIComponent(secret)}`;
  if (urls.length && token) q += `&token=${encodeURIComponent(token)}`;
  for (const u of urls) q += `&url=${encUrl(u)}`;
  return `earpiece://pair?${q}`;
}

/** The v2 link for the QR code: direct URLs are dropped first (last first) if it would not fit. */
export function qrLinkV2(info) {
  const urls = [...(info.urls ?? [])];
  for (let n = urls.length; n >= 0; n--) {
    const link = pairingLinkV2({ ...info, urls: urls.slice(0, n) });
    if (Buffer.byteLength(link) <= MAX_BYTES) return { link, urls: urls.slice(0, n), urlCount: n };
  }
  return { link: null, urls: [], urlCount: 0 };
}

/**
 * The link for the QR code. All URLs if they fit in the largest QR code; otherwise URLs
 * are dropped in this order until it fits: link-local addresses, Tailscale IPs when a MagicDNS name
 * is present (it reaches the same machine), then the lowest-priority ones. Order is kept.
 * `addresses` (optional) gives each URL's kind; returns { link, urls, urlCount }.
 */
export function qrLink(info, addresses = null) {
  const urls = [...(info.urls ?? [])];
  const meta = urls.map((u) => addresses?.find((a) => a.url === u) ?? null);
  const hasMagicDns = meta.some((a) => a?.iface === 'MagicDNS');
  const rank = (i) => {
    const a = meta[i];
    if (a?.kind === 'lan' && /^169\.254\./.test(a.host)) return 0;
    if (hasMagicDns && a?.kind === 'tailscale' && a.iface !== 'MagicDNS') return 1;
    return 2;
  };
  const dropOrder = urls.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || b - a);
  const keep = new Set(urls.map((_, i) => i));
  for (let k = 0; k <= dropOrder.length; k++) {
    const kept = urls.filter((_, i) => keep.has(i));
    const link = pairingLink({ ...info, urls: kept });
    if (Buffer.byteLength(link) <= MAX_BYTES) return { link, urls: kept, urlCount: kept.length };
    if (k < dropOrder.length) keep.delete(dropOrder[k]);
  }
  return { link: null, urls: [], urlCount: 0 };
}

const KIND_LABEL = { tailscale: 'Tailscale', lan: 'LAN', local: 'this machine only' };

/** URL lines for banners: "ws://...  (Tailscale, MagicDNS)". */
export function addressLines(addresses) {
  return addresses.map((a) => `  ${a.url}   (${KIND_LABEL[a.kind] ?? a.kind}, ${a.iface})`);
}

/**
 * The pairing block printed by `npm run pair` and by the server on start (in a terminal).
 * ansi: colour the QR black on white so it scans on dark terminals.
 * With `relay` (and `key`, `secret`, `secretExpiresAt`) it prints a v2 link (SPEC 12.4); `direct`
 * false leaves the direct URLs out of it.
 */
export function pairingText({ name, bridgeId, token, addresses, ansi = false, showSecret = true, relay = null, relayStatus = null, key = null, secret = null, secretExpiresAt = null, direct = true }) {
  const urls = addresses.map((a) => a.url);
  const lines = [`Bridge: ${name}  (id ${bridgeId})`, `Relay: ${relayStatus ?? relay ?? 'not configured'}`, 'Addresses (Tailscale first):', ...addressLines(addresses)];
  if (relay) {
    if (!showSecret) {
      lines.push('Pairing: run "npm run pair" in a terminal to show the pairing link and QR code.');
      return lines.join('\n');
    }
    const info = { name, bridgeId, relay, key, secret, token, urls: direct ? urls : [] };
    const until = secretExpiresAt ? new Date(secretExpiresAt).toLocaleTimeString() : 'in 10 minutes';
    lines.push('', `Pairing link (one phone, valid until ${until}; keep it private):`, pairingLinkV2(info), '');
    const q = qrLinkV2(info);
    if (!q.link) {
      lines.push('The pairing link is too long for a QR code.');
      return lines.join('\n');
    }
    lines.push('Scan with the iPhone Camera app:', renderHalfBlocks(encodeQR(q.link), { ansi }));
    if (q.urlCount < info.urls.length) lines.push(`(The QR code leaves out ${info.urls.length - q.urlCount} direct address(es) to fit; the link above has them.)`);
    return lines.join('\n');
  }
  if (!addresses.some((a) => a.kind === 'tailscale')) {
    lines.push('  No Tailscale address found: the phone must be on the same network. Install Tailscale for a stable address.');
  }
  if (!showSecret) {
    lines.push('Pairing: run "npm run pair" in a terminal to show the pairing link and QR code.');
    return lines.join('\n');
  }
  lines.push('', 'Pairing link (contains the token; keep it private):', pairingLink({ name, bridgeId, token, urls }), '');
  const { link, urlCount } = qrLink({ name, bridgeId, token, urls }, addresses);
  if (!link) {
    lines.push('The pairing link is too long for a QR code; add the connection by hand.');
    return lines.join('\n');
  }
  lines.push('Scan with the iPhone Camera app:', renderHalfBlocks(encodeQR(link), { ansi }));
  if (urlCount < urls.length) {
    lines.push(`(The QR code carries ${urlCount} of the ${urls.length} addresses, to fit; the link above has all of them.)`);
  }
  return lines.join('\n');
}
