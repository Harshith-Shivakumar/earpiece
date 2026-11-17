// Reachable addresses in priority order (SPEC 11.2): Tailscale first (MagicDNS name, then
// 100.64.0.0/10 addresses), then LAN. Tailscale detection fails soft: a missing, stopped or slow
// CLI (1.5 s timeout) just means no MagicDNS name.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { delimiter, join } from 'node:path';

export const TAILSCALE_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** True for addresses in Tailscale's CGNAT range 100.64.0.0/10 (100.64.0.0 to 100.127.255.255). */
export function isTailscaleIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip ?? ''));
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

export function isLinkLocal(ip) {
  return /^169\.254\./.test(String(ip ?? '')) ? 1 : 0;
}

export function findTailscaleCli({ env = process.env, exists = existsSync } = {}) {
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const p = join(dir, 'tailscale');
    if (exists(p)) return p;
  }
  return exists(TAILSCALE_APP_CLI) ? TAILSCALE_APP_CLI : null;
}

/** Parse `tailscale status --json`. Returns { dnsName, running } or null if it is not usable JSON. */
export function parseTailscaleStatus(text) {
  let s;
  try {
    s = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  const raw = typeof s.Self?.DNSName === 'string' ? s.Self.DNSName.trim() : '';
  return { dnsName: raw.replace(/\.$/, '') || null, running: s.BackendState === 'Running' };
}

/** Run the Tailscale CLI with a hard timeout. Never throws; resolves null on any problem. */
export function tailscaleStatus({ cli = findTailscaleCli(), timeoutMs = 1500 } = {}) {
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    let child;
    try {
      child = execFile(cli, ['status', '--json'], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        finish(stdout ? parseTailscaleStatus(stdout) : null);
      });
      child.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

export function wsUrl(host, port) {
  return `ws://${host.includes(':') ? `[${host}]` : host}:${port}/ws`;
}

/**
 * Addresses in priority order: [{ host, kind: 'tailscale' | 'lan' | 'local', iface }].
 * `tailscale` is the parsed status (or null); its MagicDNS name is used when Tailscale is up.
 */
export function listAddresses({ interfaces = networkInterfaces(), host = '0.0.0.0', tailscale = null } = {}) {
  if (host && host !== '0.0.0.0' && host !== '::') {
    return [{ host, kind: isTailscaleIPv4(host) ? 'tailscale' : 'lan', iface: 'configured host' }];
  }
  const ts = [];
  const lan = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const a of addrs ?? []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      if (isTailscaleIPv4(a.address)) ts.push({ host: a.address, kind: 'tailscale', iface: name });
      else lan.push({ host: a.address, kind: 'lan', iface: name });
    }
  }
  // Link-local addresses (169.254/16, e.g. a Thunderbolt bridge) rarely reach a phone: list them last.
  lan.sort((x, y) => isLinkLocal(x.host) - isLinkLocal(y.host));
  const out = [];
  if (tailscale?.dnsName && (ts.length || tailscale.running)) out.push({ host: tailscale.dnsName, kind: 'tailscale', iface: 'MagicDNS' });
  for (const a of [...ts, ...lan]) if (!out.some((o) => o.host === a.host)) out.push(a);
  if (!out.length) out.push({ host: '127.0.0.1', kind: 'local', iface: 'loopback only' });
  return out;
}

/** Addresses with URLs, including the (time-limited) Tailscale lookup. Never rejects. */
export async function detectAddresses({ host, port, timeoutMs = 1500, interfaces, cli } = {}) {
  let tailscale = null;
  try {
    tailscale = await tailscaleStatus({ cli: cli === undefined ? findTailscaleCli() : cli, timeoutMs });
  } catch {
    tailscale = null;
  }
  return listAddresses({ interfaces, host, tailscale }).map((a) => ({ ...a, url: wsUrl(a.host, port) }));
}
