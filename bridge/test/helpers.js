// Shared test helpers: a bridge on a random port with a temp EARPIECE_HOME and the mock CLI,
// and a fake phone built on Node's global WebSocket client.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../src/server.js';

export const MOCK = fileURLToPath(new URL('./mock-claude.js', import.meta.url));
export const TOKEN = 'test-token-123';

const tempDirs = [];
process.on('exit', () => {
  if (process.env.EARPIECE_KEEP_TEST_DIRS) return;
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

export function tempHome(prefix = 'earpiece-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export const FAST = {
  holdMs: 150,
  progressDelayMs: 60,
  progressIntervalMs: 250,
  interruptTimeoutMs: 600,
  killGraceMs: 300,
  closeWaitMs: 200,
  initTimeoutMs: 2000,
  restartDelayMs: 50,
  staleGraceMs: 500,
  cancelGraceMs: 400,
  summaryTimeoutMs: 10_000,
  voiceOffTimeoutMs: 3000,
  chatSettleMs: 150,
};

export async function bridge(overrides = {}) {
  const home = overrides.home ?? tempHome();
  const work = join(home, 'work');
  mkdirSync(work, { recursive: true });
  // Never touch the real ~/.claude/projects: the bridge lists, and the mock writes, chats here.
  const projects = overrides.claudeProjects ?? join(home, 'projects');
  process.env.MOCK_PROJECTS_DIR = projects;
  const b = await startBridge({
    claudeProjects: projects,
    home,
    port: 0,
    host: '127.0.0.1',
    token: TOKEN,
    claudeBin: MOCK,
    startDir: work,
    roots: [home],
    quiet: true,
    voiceHost: false, // the v1/v2 tests run without the voice host (SPEC 13.1 EARPIECE_HOST=off)
    ...FAST,
    ...overrides,
  });
  b.home = home;
  b.work = work;
  b.projects = projects;
  b.url = `ws://127.0.0.1:${b.port}/ws`;
  return b;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn, { timeout = 4000, interval = 20, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

export class Phone {
  constructor(url) {
    this.url = url;
    this.messages = [];
    this.cursor = 0;
    this.closed = null;
    this.waiters = new Set();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('websocket error'));
    });
    this.ws.onerror = () => {};
    this.ws.onmessage = (ev) => {
      this.messages.push(JSON.parse(ev.data));
      this._wake();
    };
    this.ws.onclose = (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
      this._wake();
    };
    return this;
  }

  _wake() {
    for (const w of [...this.waiters]) w();
  }

  send(obj) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  hello({ token = TOKEN, last_seq = 0 } = {}) {
    this.send({ type: 'hello', token, last_seq, client: 'test-phone' });
  }

  say(text) {
    this.send({ type: 'utterance', text });
  }

  control(action) {
    this.send({ type: 'control', action });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  /** Wait for the next message (after the cursor) matching pred; advances the cursor past it. */
  next(pred, { timeout = 4000, label } = {}) {
    const test = typeof pred === 'function' ? pred : (m) => Object.entries(pred).every(([k, v]) => (v instanceof RegExp ? v.test(m[k]) : m[k] === v));
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = this.cursor; i < this.messages.length; i++) {
          if (test(this.messages[i])) {
            this.cursor = i + 1;
            cleanup();
            resolve(this.messages[i]);
            return true;
          }
        }
        return false;
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      const timer = setTimeout(() => {
        cleanup();
        const recent = this.messages.slice(-12).map((m) => JSON.stringify(m)).join('\n  ');
        reject(new Error(`timed out waiting for ${label ?? JSON.stringify(pred, (k, v) => (v instanceof RegExp ? String(v) : v))}\n  recent:\n  ${recent}`));
      }, timeout);
      if (!check()) this.waiters.add(check);
    });
  }

  nextSay(kind, text, opts) {
    return this.next((m) => m.type === 'say' && (!kind || m.kind === kind) && (!text || (text instanceof RegExp ? text.test(m.text) : m.text === text)), {
      label: `say ${kind ?? '*'} ${text ?? ''}`,
      ...opts,
    });
  }

  nextState(state, opts) {
    return this.next((m) => m.type === 'state' && m.state === state, { label: `state ${state}`, ...opts });
  }

  says(kind) {
    return this.messages.filter((m) => m.type === 'say' && (!kind || m.kind === kind));
  }

  get lastSeq() {
    return this.messages.filter((m) => m.type === 'say').reduce((a, m) => Math.max(a, m.seq), 0);
  }

  waitClosed(timeout = 3000) {
    return waitUntil(() => this.closed, { timeout, label: 'socket close' });
  }
}

export async function phone(b, { hello = true } = {}) {
  const p = await new Phone(b.url).connect();
  if (hello) {
    p.hello();
    await p.next({ type: 'welcome' });
  }
  return p;
}

export function driveDirs(home) {
  const root = join(home, 'drives');
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().map((d) => join(root, d));
}

export function readEvents(dir) {
  return readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** control_response objects the bridge wrote to claude's stdin. */
export function controlResponses(dir) {
  return readEvents(dir)
    .filter((e) => e.source === 'to_claude' && e.data.type === 'control_response')
    .map((e) => e.data.response);
}

// ---- fixture chat files (Claude Code's ~/.claude/projects layout)

export const user = (cwd, content, extra = {}) => ({ type: 'user', cwd, entrypoint: 'cli', isSidechain: false, sessionId: 'x', timestamp: new Date().toISOString(), message: { role: 'user', content }, ...extra });
export const assistant = (cwd, text) => ({ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text }] } });

/** Write <root>/<project>/<id>.jsonl from entries (objects or raw strings) and set its mtime. */
export function writeChatFile(root, { project = 'proj', id, entries, ageMs = 10 * 60_000 }) {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n')}\n`);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}
