#!/usr/bin/env node
// Paired phones (SPEC 12.4).
//   node bin/phones.js                         list paired phones           (npm run phones)
//   node bin/phones.js unpair <phone_id|name>  revoke a phone                (npm run unpair -- <phone_id|name>)
// A running bridge notices the change within a second and closes that phone's open sessions.

import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { PhoneStore } from '../src/keys.js';

const [cmd, ...rest] = process.argv.slice(2);
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`earpiece: ${err.message}`);
  process.exit(1);
}
const store = new PhoneStore(config.home);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
const fingerprint = (pub) => createHash('sha256').update(pub).digest('hex').slice(0, 8);

if (!cmd || cmd === 'list') {
  const phones = store.list();
  if (!phones.length) {
    console.log('No paired phones. Run "npm run pair" and scan the QR code with the phone.');
    process.exit(0);
  }
  console.log(`Paired phones (${store.path}):`);
  for (const p of phones) {
    console.log(`- ${p.name}  id ${p.phone_id}  key ${fingerprint(p.noise_pub)}  paired ${when(p.paired_at)}  last seen ${when(p.last_seen)}`);
  }
} else if (cmd === 'unpair') {
  const target = rest.join(' ').trim();
  if (!target) {
    console.error('Usage: npm run unpair -- <phone_id or name>');
    process.exit(2);
  }
  const { removed, error } = store.remove(target);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  console.log(`Unpaired ${removed[0].name} (${removed[0].phone_id}). Its open sessions will be closed.`);
} else {
  console.error('Usage: node bin/phones.js [list | unpair <phone_id or name>]');
  process.exit(2);
}
