import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';
import { loadConfig, resolveDefaultClaude, shortHostName } from '../src/config.js';
import { tempHome } from './helpers.js';

describe('config', () => {
  it('generates a token on first start and saves it to config.json', () => {
    const home = tempHome();
    const a = loadConfig({}, { EARPIECE_HOME: home });
    assert.equal(a.tokenGenerated, true);
    assert.match(a.token, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    const file = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(file.token, a.token);
    assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
    const b = loadConfig({}, { EARPIECE_HOME: home });
    assert.equal(b.tokenGenerated, false);
    assert.equal(b.token, a.token);
  });

  it('applies defaults, then env, then config.json', () => {
    const home = tempHome();
    const d = loadConfig({}, { EARPIECE_HOME: home, EARPIECE_TOKEN: 't', PATH: process.env.PATH });
    assert.equal(d.port, 8787);
    assert.equal(d.host, '0.0.0.0');
    assert.equal(d.holdMs, 3500);
    assert.equal(d.progressIntervalMs, 35_000);
    assert.ok(d.claudeBin === 'claude' || d.claudeBin === join(homedir(), '.local', 'bin', 'claude'));
    assert.equal(d.model, null);
    const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(saved.token, undefined, 'a token from env is not written to the file');
    assert.equal(saved.bridge_id, d.bridgeId, 'bridge_id is generated once and saved');
    assert.equal(loadConfig({}, { EARPIECE_HOME: home, EARPIECE_TOKEN: 't' }).bridgeId, d.bridgeId, 'and stays the same');
    assert.equal(d.name, shortHostName());
    assert.ok(!d.name.includes('.'));

    const env = { EARPIECE_HOME: home, EARPIECE_TOKEN: 't', EARPIECE_PORT: '9000', EARPIECE_HOLD_MS: '1000', EARPIECE_ROOTS: '/a, /b', EARPIECE_MODEL: 'sonnet' };
    const e = loadConfig({}, env);
    assert.equal(e.port, 9000);
    assert.equal(e.holdMs, 1000);
    assert.deepEqual(e.roots, ['/a', '/b']);
    assert.equal(e.model, 'sonnet');

    writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 9100, hold_ms: 2000, claude_bin: '/opt/claude', name: 'Desk Mac', bridge_id: 'fixed-id' }));
    const f = loadConfig({}, env);
    assert.equal(f.port, 9100);
    assert.equal(f.holdMs, 2000);
    assert.equal(f.claudeBin, '/opt/claude');
    assert.equal(f.name, 'Desk Mac');
    assert.equal(f.bridgeId, 'fixed-id');
    assert.equal(loadConfig({}, { ...env, EARPIECE_NAME: 'Env name' }).name, 'Desk Mac', 'config.json wins over env');
  });

  it('refuses a corrupt config.json instead of overwriting it', () => {
    const home = tempHome();
    writeFileSync(join(home, 'config.json'), '{ not json');
    assert.throws(() => loadConfig({}, { EARPIECE_HOME: home }), /Cannot parse/);
  });

  it('falls back to ~/.local/bin/claude only for the bare default when PATH lacks claude', () => {
    const local = join(homedir(), '.local', 'bin', 'claude');
    assert.equal(resolveDefaultClaude('/opt/claude', { PATH: '' }), '/opt/claude');
    assert.equal(resolveDefaultClaude('claude', { PATH: '' }), existsSync(local) ? local : 'claude');
  });
});
