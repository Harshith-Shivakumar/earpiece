#!/usr/bin/env node
// Print this bridge's pairing details (SPEC 11.3, 12.4): name, relay, addresses (Tailscale marked),
// the earpiece://pair link and its QR code. With a relay configured this creates a new pairing
// secret (valid 10 minutes, one phone) and prints a v2 link; without one, a v1 (direct) link.
//
//   node bin/pair.js [--no-color]      (npm run pair)

import { detectAddresses } from '../src/addresses.js';
import { loadConfig } from '../src/config.js';
import { PairSecrets, loadKeys } from '../src/keys.js';
import { b64url } from '../src/noise.js';
import { pairingText } from '../src/pairing.js';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: node bin/pair.js [--no-color]\nPrints the pairing link and QR code for the Earpiece iPhone app.');
  process.exit(0);
}
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`earpiece: ${err.message}`);
  process.exit(1);
}
const keys = loadKeys(config.home);
const secret = config.relay ? new PairSecrets(config.home, { ttlMs: config.pairSecretTtlMs }).create() : null;
const addresses = await detectAddresses({ host: config.host, port: config.port, timeoutMs: 1500 });
const ansi = !!process.stdout.isTTY && !args.includes('--no-color');
process.stdout.write(
  `${pairingText({
    name: config.name,
    bridgeId: config.bridgeId,
    token: config.token,
    addresses,
    ansi,
    relay: config.relay,
    key: b64url(keys.noise.publicKey),
    secret: secret?.secret,
    secretExpiresAt: secret?.expiresAt,
    direct: config.direct,
  })}\n`,
);
if (secret) console.log('A new pairing secret replaces any earlier one. A running bridge picks it up at once.');
