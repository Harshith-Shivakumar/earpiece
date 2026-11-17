#!/usr/bin/env node
// Earpiece bridge entry point: HTTP server with GET /health and the phone WebSocket at /ws.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { detectAddresses } from './addresses.js';
import { loadConfig } from './config.js';
import { PairSecrets, PhoneStore, loadKeys } from './keys.js';
import { createLogger } from './log.js';
import { pairingText } from './pairing.js';
import { b64url } from './noise.js';
import { RelayClient } from './relay.js';

/** SPEC 12.5 banner line. */
export function relayLine(relay) {
  if (!relay) return 'not configured';
  return relay.status === 'connected' ? `connected to ${relay.host}` : `connecting to ${relay.host} (not connected yet)`;
}

function waitForRelay(relay, ms) {
  if (relay.status === 'connected') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      relay.off('status', onStatus);
      resolve();
    }
    function onStatus(s) {
      if (s === 'connected') done();
    }
    relay.on('status', onStatus);
  });
}
import { Session } from './session.js';
import { handleUpgrade } from './ws.js';

/** Start a bridge. `overrides` use camelCase config keys (tests pass port 0, a temp home, ...). */
export async function startBridge(overrides = {}) {
  const config = loadConfig(overrides);
  const log = overrides.log ?? createLogger({ quiet: config.quiet });
  const session = new Session(config, log);
  await session.startMcp(); // SPEC 13.2: the voice host's tools (127.0.0.1 only)
  // SPEC 12.1: keys are generated on first start, whether or not the relay is configured.
  const keys = loadKeys(config.home);
  const phones = new PhoneStore(config.home);
  const secrets = new PairSecrets(config.home, { ttlMs: config.pairSecretTtlMs });
  let relay = null;

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://bridge').pathname;
    } catch {
      /* keep '/' */
    }
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, state: session.state, name: config.name, bridge_id: config.bridgeId, relay: relay?.status ?? 'off' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found. The phone connects to /ws; GET /health checks reachability.\n');
  });
  // Long-lived sockets: no request/idle timeouts on our side (the WebSocket heartbeat handles dead peers).
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://bridge').pathname;
    } catch {
      /* reject below */
    }
    if (pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (!config.direct) {
      // SPEC 12.5: direct connections switched off; only the relay is used.
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const conn = handleUpgrade(req, socket, head, { maxPayload: config.maxPayload });
    if (conn) session.onConnection(conn);
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address();

  if (config.relay) {
    relay = new RelayClient({
      url: config.relay,
      bridgeId: config.bridgeId,
      bridgeName: config.name,
      keys,
      phones,
      secrets,
      onConnection: (conn) => session.onConnection(conn),
      log,
      backoffBaseMs: config.relayBackoffMs,
      pingMs: config.relayPingMs,
      pongTimeoutMs: config.relayPongTimeoutMs,
      phonesPollMs: config.phonesPollMs,
    }).start();
  }

  let closing = null;
  const close = () => {
    closing ??= (async () => {
      relay?.stop();
      await session.shutdown();
      await Promise.race([
        new Promise((r) => server.close(() => r())),
        new Promise((r) => setTimeout(r, 2000).unref()),
      ]);
      server.closeAllConnections?.();
    })();
    return closing;
  };

  return { server, session, config, port, log, close, keys, phones, secrets, get relay() { return relay; } };
}

async function main() {
  let bridge;
  try {
    bridge = await startBridge();
  } catch (err) {
    console.error(`earpiece: could not start: ${err.message}`);
    process.exit(1);
  }
  const { config, port, log } = bridge;
  const out = (s = '') => process.stdout.write(`${s}\n`);
  // Never blocks startup for long: the Tailscale lookup gives up after 1.5 s, the relay wait after 3 s.
  const [addresses] = await Promise.all([
    detectAddresses({ host: config.host, port, timeoutMs: 1500 }),
    bridge.relay ? waitForRelay(bridge.relay, 3000) : null,
  ]);
  const tty = !!process.stdout.isTTY;
  // A pairing secret is only created when it can be shown (a terminal), never written to a log.
  const secret = bridge.relay && tty ? bridge.secrets.create() : null;
  out('');
  out(`Earpiece bridge listening on ${config.host}:${port}${config.direct ? '' : ' (direct connections off: relay only)'}`);
  // The pairing link carries the token or the pairing secret: show it only on a terminal.
  out(
    pairingText({
      name: config.name,
      bridgeId: config.bridgeId,
      token: config.token,
      addresses,
      ansi: tty,
      showSecret: tty,
      relay: config.relay,
      relayStatus: relayLine(bridge.relay),
      key: b64url(bridge.keys.noise.publicKey),
      secret: secret?.secret,
      secretExpiresAt: secret?.expiresAt,
      direct: config.direct,
    }),
  );
  out(`Health check: ${addresses[0].url.replace(/^ws:/, 'http:').replace(/\/ws$/, '/health')}`);
  out(`Voice host: ${config.voiceHost ? `on (model ${config.hostModel})${bridge.session.mcp ? '' : ', but its tool server failed to start'}` : 'off (basic mode)'}`);
  out(`Token: saved in ${config.configPath}${config.tokenGenerated ? ' (generated now)' : ''}`);
  out(`Data dir: ${config.home}`);
  out(`Chats: ${config.claudeProjects}`);
  out(`Claude CLI: ${config.claudeBin}${config.model ? ` (model ${config.model})` : ''}; start dir ${config.startDir}`);
  out('');

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) {
      log(`${signal} again: exiting now`);
      process.exit(1);
    }
    stopping = true;
    log(`${signal}: shutting down`);
    try {
      await bridge.close();
    } catch (err) {
      log(`shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // A personal always-on service: log unexpected errors instead of dying mid-drive.
  process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack ?? err}`));
}

/** Node 22+ is required: the relay client uses Node's built-in WebSocket (absent before 22). */
export function nodeVersionProblem(version = process.versions.node, hasWebSocket = typeof globalThis.WebSocket === 'function') {
  const major = Number(String(version).split('.')[0]);
  if (major >= 22 && hasWebSocket) return null;
  return `Earpiece needs Node 22 or newer (this is Node ${version}). ` +
    'Install Node 22 (for example "brew install node@22" or "nvm install 22") and start the bridge with it.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = nodeVersionProblem();
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  main();
}
