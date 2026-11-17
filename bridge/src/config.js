// Bridge configuration (SPEC section 7).
// Precedence: built-in defaults < EARPIECE_* environment variables < <EARPIECE_HOME>/config.json
// < programmatic overrides (used by tests). config.json keys are the variable names in lowercase
// without the prefix: port, host, token, claude_bin, model, start_dir, roots, hold_ms, ...

import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

// key -> [ENV NAME without EARPIECE_ prefix, type]
const KEYS = {
  port: ['PORT', 'int'],
  host: ['HOST', 'str'],
  token: ['TOKEN', 'str'],
  name: ['NAME', 'str'], // SPEC 11.1
  bridgeId: ['BRIDGE_ID', 'str'], // SPEC 11.1: generated once and saved to config.json
  relay: ['RELAY', 'str'], // SPEC 12.5: relay URL; unset = relay off
  direct: ['DIRECT', 'bool'], // SPEC 12.5: accept direct WebSocket connections on /ws
  claudeBin: ['CLAUDE_BIN', 'bin'],
  model: ['MODEL', 'str'],
  startDir: ['START_DIR', 'path'],
  roots: ['ROOTS', 'list'],
  claudeProjects: ['CLAUDE_PROJECTS', 'path'], // SPEC 10.2: where Claude Code keeps chats
  holdMs: ['HOLD_MS', 'int'],
  progressIntervalMs: ['PROGRESS_INTERVAL_MS', 'int'],
  // SPEC 13.1. The spec names the switch EARPIECE_HOST, but that variable is already the bind
  // address (section 7): EARPIECE_HOST=on|off is accepted as an alias (see loadConfig).
  voiceHost: ['VOICE_HOST', 'bool'],
  hostModel: ['HOST_MODEL', 'str'],
  hostProgressMs: ['HOST_PROGRESS_MS', 'int'], // 13.3: progress digests at most this often
  // Extras (not in the spec table; defaults follow the spec text). Mainly so tests run fast.
  progressDelayMs: ['PROGRESS_DELAY_MS', 'int'],
  interruptTimeoutMs: ['INTERRUPT_TIMEOUT_MS', 'int'],
  killGraceMs: ['KILL_GRACE_MS', 'int'],
  closeWaitMs: ['CLOSE_WAIT_MS', 'int'],
  initTimeoutMs: ['INIT_TIMEOUT_MS', 'int'],
  driveIdleMs: ['DRIVE_IDLE_MS', 'int'],
  cancelGraceMs: ['CANCEL_GRACE_MS', 'int'],
  restartDelayMs: ['RESTART_DELAY_MS', 'int'],
  crashWindowMs: ['CRASH_WINDOW_MS', 'int'],
  staleGraceMs: ['STALE_GRACE_MS', 'int'],
  summaryTimeoutMs: ['SUMMARY_TIMEOUT_MS', 'int'],
  voiceOffTimeoutMs: ['VOICE_OFF_TIMEOUT_MS', 'int'],
  chatSettleMs: ['CHAT_SETTLE_MS', 'int'],
  driveEndedConfirmMs: ['DRIVE_ENDED_CONFIRM_MS', 'int'],
  relayBackoffMs: ['RELAY_BACKOFF_MS', 'int'],
  relayPingMs: ['RELAY_PING_MS', 'int'],
  relayPongTimeoutMs: ['RELAY_PONG_TIMEOUT_MS', 'int'],
  phonesPollMs: ['PHONES_POLL_MS', 'int'],
  pairSecretTtlMs: ['PAIR_SECRET_TTL_MS', 'int'],
  helloTimeoutMs: ['HELLO_TIMEOUT_MS', 'int'],
  wsPingMs: ['WS_PING_MS', 'int'],
  wsIdleMs: ['WS_IDLE_MS', 'int'],
  quiet: ['QUIET', 'bool'],
};

export const DEFAULTS = {
  port: 8787,
  host: '0.0.0.0',
  token: null,
  name: null,
  bridgeId: null,
  relay: null,
  direct: true,
  claudeBin: 'claude',
  model: null,
  startDir: '~',
  roots: ['~'],
  claudeProjects: '~/.claude/projects',
  holdMs: 3500,
  progressIntervalMs: 35_000,
  voiceHost: true,
  hostModel: 'sonnet',
  hostProgressMs: 60_000,
  progressDelayMs: 6000, // "nothing in the first 6 s of a turn"
  interruptTimeoutMs: 5000,
  killGraceMs: 3000,
  closeWaitMs: 1500, // after closing claude's stdin, wait this long before SIGTERM
  initTimeoutMs: 10_000,
  driveIdleMs: 30 * 60_000,
  cancelGraceMs: 3000, // a "cancel" this soon after the hold expired still cancels the task
  restartDelayMs: 1000,
  crashWindowMs: 120_000,
  staleGraceMs: 3000,
  summaryTimeoutMs: 180_000,
  voiceOffTimeoutMs: 60_000, // SPEC 10.4: wait at most 60 s for the voice-off reply
  chatSettleMs: 1000, // SPEC 10.8: the chat file must stop growing this long before the offset moves
  driveEndedConfirmMs: 5000, // SPEC 11.5: a drive_ended whose socket closes this soon is sent again on hello
  relayBackoffMs: 1000, // SPEC 12.5: reconnect after 1, 2, 4, 8 ... max 30 s, plus jitter
  relayPingMs: 25_000, // SPEC 12.2: {t:"ping"} every 25 s
  relayPongTimeoutMs: 60_000, // no {t:"pong"} for this long: the relay socket is dead, reconnect
  phonesPollMs: 500, // how often the bridge notices phones.json changes (unpair)
  pairSecretTtlMs: 10 * 60_000, // SPEC 12.4
  helloTimeoutMs: 10_000,
  wsPingMs: 25_000,
  wsIdleMs: 75_000,
  maxPayload: 1024 * 1024,
  quiet: false,
};

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function parseValue(type, value) {
  if (value === null || value === undefined) return value;
  switch (type) {
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`expected a number, got ${JSON.stringify(value)}`);
      return Math.trunc(n);
    }
    case 'bool':
      return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value));
    case 'list':
      return (Array.isArray(value) ? value : String(value).split(','))
        .map((s) => expandHome(String(s).trim()))
        .filter(Boolean);
    case 'path':
      return expandHome(String(value));
    case 'bin': {
      const s = expandHome(String(value));
      // A bin given as a path is resolved now, because claude runs with a different cwd.
      return s.includes('/') && !isAbsolute(s) ? resolve(s) : s;
    }
    default:
      return String(value);
  }
}

/**
 * The native installer puts claude in ~/.local/bin, which is often missing from PATH for
 * services and fresh shells. When the bin is the bare default "claude" and PATH has no such
 * executable, fall back to ~/.local/bin/claude if it exists.
 */
export function resolveDefaultClaude(bin, env = process.env) {
  if (bin !== 'claude') return bin;
  const dirs = String(env.PATH || '').split(':').filter(Boolean);
  if (dirs.some((d) => existsSync(join(d, 'claude')))) return bin;
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : bin;
}

/** Relay URL as ws(s)://; https:// and http:// are accepted and converted. Null when unset. */
export function normalizeRelayUrl(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  let s = String(v).trim().replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  if (!/^wss?:\/\//i.test(s)) s = `wss://${s}`;
  try {
    return new URL(s).toString().replace(/\/$/, '');
  } catch {
    throw new Error(`relay is not a valid URL: ${v}`);
  }
}

/** The machine's short host name, e.g. "Harshiths-MacBook-Pro" (without ".local"). */
export function shortHostName() {
  return String(hostname() || '').split('.')[0] || 'Earpiece bridge';
}

/** Human-typeable token, e.g. "k7xm-p3qa-9zrt-w2hd" (~80 bits). */
export function generateToken() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join('-');
}

export function loadConfig(overrides = {}, env = process.env) {
  const home = resolve(expandHome(overrides.home ?? (env.EARPIECE_HOME || '~/.earpiece')));
  mkdirSync(home, { recursive: true });
  const configPath = join(home, 'config.json');

  let file = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (err) {
      throw new Error(`Cannot parse ${configPath}: ${err.message}. Fix or delete it.`);
    }
  }

  const cfg = { ...DEFAULTS, roots: [...DEFAULTS.roots] };
  for (const [key, [name, type]] of Object.entries(KEYS)) {
    const envVal = env[`EARPIECE_${name}`];
    if (envVal !== undefined && envVal !== '') cfg[key] = parseValue(type, envVal);
    const fileVal = file[name.toLowerCase()];
    if (fileVal !== undefined && fileVal !== null && fileVal !== '') cfg[key] = parseValue(type, fileVal);
    if (overrides[key] !== undefined) cfg[key] = parseValue(type, overrides[key]);
  }
  // EARPIECE_HOST=on|off (or "host": "off" in config.json) is the voice-host switch, not an address.
  if (typeof cfg.host === 'string' && /^(on|off|true|false)$/i.test(cfg.host.trim())) {
    cfg.voiceHost = parseValue('bool', cfg.host.trim());
    cfg.host = DEFAULTS.host;
  }
  for (const key of ['maxPayload']) if (overrides[key] !== undefined) cfg[key] = overrides[key];
  cfg.startDir = resolve(parseValue('path', cfg.startDir));
  cfg.claudeProjects = resolve(parseValue('path', cfg.claudeProjects));
  cfg.roots = parseValue('list', cfg.roots).map((r) => resolve(r));
  cfg.claudeBin = resolveDefaultClaude(parseValue('bin', cfg.claudeBin), env);
  if (cfg.token !== null && cfg.token !== undefined) cfg.token = String(cfg.token);
  cfg.home = home;
  cfg.configPath = configPath;
  cfg.tokenGenerated = false;

  cfg.name = cfg.name ? String(cfg.name) : shortHostName();
  cfg.relay = normalizeRelayUrl(cfg.relay);
  cfg.bridgeIdGenerated = false;

  let save = false;
  if (!cfg.token) {
    cfg.token = generateToken();
    file.token = cfg.token;
    cfg.tokenGenerated = true;
    save = true;
  }
  if (!cfg.bridgeId) {
    cfg.bridgeId = randomUUID();
    file.bridge_id = cfg.bridgeId;
    cfg.bridgeIdGenerated = true;
    save = true;
  }
  if (save) writeFileSync(configPath, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  return cfg;
}
