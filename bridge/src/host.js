// The voice host (SPEC 13): a second, conversational Claude Code session per drive that talks
// with the driver and runs the worker through the Earpiece MCP tools.
//
// Host owns: the host process (a ClaudeProcess with its own flags), the tagged message queue and
// turn triggering (13.3), barge-in interrupts, cutting the streamed reply into spoken sentences
// with the [silent] rule (13.4), and failure detection for the fallback (13.7).
// Events:
//   'say'        sentence to speak (kind reply)
//   'turn_end'   { spoken: string[], dropped, lines }
//   'unavailable' { reason, resetsAt? }  the host gave up; the session falls back to v2
//   'proc_event' raw host stdout event (not stream_event) for the drive log
//   'proc_stdin' object written to the host's stdin
//   'log'        diagnostic string

import { EventEmitter } from 'node:events';
import { ClaudeProcess } from './claude.js';
import { cleanInline } from './speech.js';

/** SPEC 13.1 launch flags, plus the startup flags that skip the driver's hooks, plugins and skills. */
export function hostArgs({ model, systemPrompt, mcpConfig }) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model || 'sonnet',
    '--system-prompt', systemPrompt,
    '--tools', '',
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__earpiece__*',
    '--no-session-persistence',
    // Startup (verified on CLI 2.1.325): no user/project/local settings means no SessionStart
    // hooks, plugins or CLAUDE.md; OAuth login still works. Skills and Chrome are not needed.
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-chrome',
  ];
}

const SILENT = '[silent]';
const ABBREV = /(?:^|\s)(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|approx|no|fig)\.$/i;
const CLOSERS = '"\')]’”';

/** Clean one spoken sentence: markdown safety net, list and heading markers, the silent marker. */
export function cleanSentence(s) {
  let t = String(s ?? '').replace(/\[silent\]/gi, ' ');
  t = t.replace(/^\s*(?:#{1,6}\s+|[-*•+]\s+|\d+[.)]\s+|>\s*)/, '');
  t = t.replace(/^\s*\|.*\|\s*$/, (row) => row.replace(/\|/g, ' ').replace(/-{3,}/g, ' '));
  t = cleanInline(t);
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

/**
 * Cuts streamed text into sentences as they complete. Holds everything while the whole text so far
 * could still be "[silent]", so a silent turn never speaks. Drops fenced code blocks.
 */
export class SentenceStream {
  constructor(emit) {
    this.emit = emit;
    this.all = '';
    this.buf = '';
    this.inFence = false;
    this.count = 0;
  }

  _maybeSilent() {
    const head = this.all.trimStart().toLowerCase();
    return head.length <= SILENT.length && SILENT.startsWith(head);
  }

  push(text) {
    if (!text) return;
    this.all += text;
    this.buf += text;
    if (this._maybeSilent()) return;
    this._scan(false);
  }

  /** The text so far is complete (end of a text block or of the turn): speak what is left. */
  flush() {
    if (this._maybeSilent()) return;
    this._scan(true);
  }

  get silent() {
    const t = this.all.trim().toLowerCase();
    return t === '' || t === SILENT;
  }

  _out(raw) {
    const s = cleanSentence(raw);
    if (!s) return;
    this.count += 1;
    this.emit(s);
  }

  _scan(final) {
    for (;;) {
      if (this.inFence || /^\s*```/.test(this.buf)) {
        const nl = this.buf.indexOf('\n');
        if (nl < 0) {
          if (final) this.buf = '';
          return;
        }
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (/^\s*```/.test(line)) this.inFence = !this.inFence;
        continue;
      }
      const end = this._boundary();
      if (end < 0) break;
      const sentence = this.buf.slice(0, end);
      this.buf = this.buf.slice(end);
      this._out(sentence);
    }
    if (final) {
      const rest = this.buf;
      this.buf = '';
      this._out(rest);
    }
  }

  /** Index just past the first complete sentence or line in buf, or -1. */
  _boundary() {
    const b = this.buf;
    const nl = b.indexOf('\n');
    // A line that starts a fence ends the sentence before it.
    for (let i = 0; i < b.length; i++) {
      if (nl >= 0 && i >= nl) return nl + 1;
      const c = b[i];
      if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue;
      let j = i + 1;
      while (j < b.length && (b[j] === '.' || b[j] === '!' || b[j] === '?' || CLOSERS.includes(b[j]))) j++;
      if (j >= b.length) return nl >= 0 ? nl + 1 : -1; // might continue (e.g. "3." then "5")
      if (!/\s/.test(b[j])) continue;
      if (c === '.' && ABBREV.test(b.slice(0, i + 1))) continue;
      // A list marker at the start of a line ("1. ") is not a sentence.
      const lineStart = b.lastIndexOf('\n', i) + 1;
      if (c === '.' && /^\s*\d+$/.test(b.slice(lineStart, i))) continue;
      return j;
    }
    return nl >= 0 ? nl + 1 : -1;
  }
}

/** The MCP tools the host gets (SPEC 13.2). The session supplies the handlers by name. */
export const TOOL_SPECS = [
  {
    name: 'start_task',
    description:
      'Send an instruction to Claude Code (the coding agent on the driver\'s computer). Use for anything that needs their files, commands, the web or their projects. Write a clear, complete instruction. If Claude Code is busy, it is queued as a follow-up. If no chat is open, a new chat opens in the start folder first.',
    inputSchema: { type: 'object', properties: { instruction: { type: 'string', description: 'The full instruction for Claude Code.' } }, required: ['instruction'] },
  },
  {
    name: 'get_status',
    description: 'What Claude Code is doing: state, current task, elapsed time, last actions, any pending question, chat title and folder.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'answer_question',
    description:
      'Answer Claude Code\'s pending question. For a question with options, pass one option label (several for a multi-select question, as an array) or free text. For a permission request, pass "yes" or "no", or free text to deny with that reason.',
    inputSchema: {
      type: 'object',
      properties: { answer: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
      required: ['answer'],
    },
  },
  { name: 'stop_task', description: 'Stop what Claude Code is doing right now.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'end_drive',
    description:
      'End the drive: Claude Code leaves voice mode, the summary is saved and the bridge says goodbye. If Claude Code is still working, this fails unless force is true (which stops the task first).',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
  },
  { name: 'list_chats', description: 'The 5 most recent Claude Code chats: id, title, folder and when they were last used.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'switch_chat',
    description:
      'Open another Claude Code chat by id (from list_chats) or by title (fuzzy). If the title is ambiguous, the candidates are returned. If the chat was used on the computer moments ago, it asks for confirm true.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, confirm: { type: 'boolean' } } },
  },
  {
    name: 'new_chat',
    description: 'Start a new Claude Code chat, in the given folder or else in the current folder.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string' } } },
  },
  { name: 'which_chat', description: 'The current Claude Code chat: title and folder.', inputSchema: { type: 'object', properties: {} } },
];

export class Host extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.bin
   * @param {string} o.cwd
   * @param {string} o.model
   * @param {string} o.systemPrompt
   * @param {string} o.mcpConfig
   * @param {(ev:object)=>({resetsAt?:any}|null)} [o.limitOf]  usage-limit detection for a result
   * @param {()=>boolean} [o.canProgress]  false while paused or not working
   */
  constructor(o) {
    super();
    this.opts = {
      progressMs: 60_000,
      crashWindowMs: 120_000,
      interruptTimeoutMs: 5000,
      staleGraceMs: 3000,
      killGraceMs: 3000,
      closeWaitMs: 1500,
      initTimeoutMs: 10_000,
      limitOf: () => null,
      canProgress: () => true,
      ...o,
    };
    this.proc = null;
    this.queue = []; // { line, trigger, tag }
    this.turn = null;
    this.failures = [];
    this.dead = false;
    this.muted = false;
    this.stopped = false;
    this.startedAt = null;
    this.readyAt = null;
    this.lastSpokeAt = 0;
    this.progress = [];
    this.toolSteps = [];
    this.workerSince = null;
    this.lastDigestAt = 0;
    this.progressTimer = null;
  }

  get up() {
    return !this.dead && !this.stopped;
  }

  get busy() {
    return !!this.turn;
  }

  start() {
    if (this.proc || !this.up) return;
    this.startedAt = Date.now();
    const proc = new ClaudeProcess({
      bin: this.opts.bin,
      cwd: this.opts.cwd,
      args: hostArgs(this.opts),
      initTimeoutMs: this.opts.initTimeoutMs,
      interruptTimeoutMs: this.opts.interruptTimeoutMs,
      killGraceMs: this.opts.killGraceMs,
      closeWaitMs: this.opts.closeWaitMs,
    });
    this.proc = proc;
    proc.initOk = false;
    const on = (name, fn) =>
      proc.on(name, (arg) => {
        if (this.proc !== proc) return;
        try {
          fn(arg);
        } catch (err) {
          this.emit('log', `host: error in ${name}: ${err?.stack ?? err}`);
        }
      });
    on('spawn', (info) => this.emit('log', `voice host started (pid ${info.pid})`));
    on('init', ({ ok, error }) => {
      proc.initOk = ok || proc.alive; // a timed-out initialize still counts as started
      this.readyAt = Date.now();
      this.emit('log', `voice host ready in ${this.readyAt - this.startedAt} ms${ok ? '' : ` (initialize: ${error})`}`);
      this.emit('ready', { ms: this.readyAt - this.startedAt, ok });
    });
    on('event', (ev) => ev.type !== 'stream_event' && this.emit('proc_event', ev));
    on('stdin', (obj) => this.emit('proc_stdin', obj));
    on('stderr', (text) => this.emit('proc_event', { type: 'host_stderr', text }));
    on('log', (m) => this.emit('log', `host: ${m}`));
    on('stream', (ev) => this._onStream(ev));
    on('text', ({ text, parentToolUseId }) => {
      const t = this.turn;
      if (!t || t.dropped || parentToolUseId || t.sawDelta) return;
      t.stream.push(text);
      t.stream.flush();
    });
    on('rate_limit', (info) => {
      if (info && info.status && !['allowed', 'allowed_warning'].includes(info.status)) {
        this._giveUp('limit', info.resetsAt);
      }
    });
    on('result', (ev) => this._onResult(ev));
    on('exit', (info) => this._onExit(proc, info));
    proc.start();
  }

  /** Queue a tagged line (13.3). trigger: run a host turn for it (now, or after the current turn). */
  post(tag, text, { trigger = false } = {}) {
    if (!this.up) return null;
    const body = String(text ?? '').trim();
    const item = { tag, text: body, line: body ? `[${tag}] ${body}` : `[${tag}]`, trigger, done: false };
    this.queue.push(item);
    if (trigger) this._pump();
    return item;
  }

  /** A driver utterance: barge in on a running turn (drop its unspoken text), then send. */
  driver(text) {
    if (!this.up) return null;
    this.interruptTurn();
    return this.post('driver', text, { trigger: true });
  }

  /** Stop the running host turn and drop what it has not spoken yet. */
  interruptTurn() {
    const t = this.turn;
    if (!t || t.dropped) return;
    t.dropped = true;
    const proc = this.proc;
    this.emit('log', 'host turn interrupted (barge-in)');
    proc
      .interrupt()
      .then((ok) => {
        if (this.proc !== proc || this.turn !== t) return;
        if (!ok) {
          this.emit('log', 'host interrupt timed out; restarting the voice host');
          this._restart();
          return;
        }
        // The interrupted turn's result normally follows at once; don't wait for it forever.
        t.graceTimer = setTimeout(() => {
          if (this.turn === t) this._endTurn();
        }, this.opts.staleGraceMs);
        t.graceTimer.unref?.();
      })
      .catch(() => {});
  }

  /** After end_drive: say nothing more. */
  mute() {
    this.muted = true;
    if (this.turn) this.turn.dropped = true;
  }

  /** Items queued or in a turn that has not finished. */
  undelivered() {
    return [...(this.turn?.items ?? []), ...this.queue].filter((i) => !i.done);
  }

  // ---- worker progress digests (13.3)

  workerStarted() {
    if (this.workerSince === null) {
      this.workerSince = Date.now();
      this.lastDigestAt = Date.now();
      this.progress = [];
      this.toolSteps = [];
    }
    if (!this.progressTimer && this.up) {
      const every = Math.max(20, Math.floor(this.opts.progressMs / 6));
      this.progressTimer = setInterval(() => this._progressTick(), every);
      this.progressTimer.unref?.();
    }
  }

  workerStopped() {
    this.workerSince = null;
    this.progress = [];
    this.toolSteps = [];
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  /** A worker step: task_summary lines (summary) are preferred; tool descriptions fill in without them. */
  workerProgress(line, { summary = false } = {}) {
    const s = String(line ?? '').trim();
    const list = summary ? this.progress : this.toolSteps;
    if (!s || list[list.length - 1] === s) return;
    list.push(s);
    if (list.length > 8) list.shift();
  }

  _progressTick() {
    if (!this.up || this.workerSince === null || this.turn) return;
    if (!this.progress.length && !this.toolSteps.length) return;
    const now = Date.now();
    if (now - this.lastDigestAt < this.opts.progressMs || now - this.lastSpokeAt < this.opts.progressMs) return;
    if (!this.opts.canProgress()) return;
    const lines = this.progress.length ? this.progress : this.toolSteps.slice(-3);
    this.progress = [];
    this.toolSteps = [];
    this.lastDigestAt = now;
    this.post('worker progress', lines.join(' '), { trigger: true });
  }

  // ---- turns

  _pump() {
    if (this.turn || !this.proc || !this.up) return;
    if (!this.queue.some((i) => i.trigger)) return;
    const items = this.queue;
    this.queue = [];
    const t = {
      items,
      dropped: this.muted,
      sawDelta: false,
      spoken: [],
      graceTimer: null,
      stream: null,
    };
    t.stream = new SentenceStream((s) => {
      if (t.dropped || this.turn !== t) return;
      t.spoken.push(s);
      this.lastSpokeAt = Date.now();
      this.emit('say', s);
    });
    this.turn = t;
    this.proc.sendUser(items.map((i) => i.line).join('\n'));
  }

  _onStream(ev) {
    const t = this.turn;
    if (!t || t.dropped) return;
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      t.sawDelta = true;
      t.stream.push(ev.delta.text);
    } else if (ev.type === 'content_block_stop' || ev.type === 'message_stop') {
      t.stream.flush();
    }
  }

  _onResult(ev) {
    const t = this.turn;
    if (!t) return;
    if (!t.dropped) {
      const limit = this.opts.limitOf(ev);
      if (limit) {
        this._endTurn();
        this._giveUp('limit', limit.resetsAt);
        return;
      }
      if (ev.is_error) {
        this.emit('log', `voice host turn failed: ${String(ev.result ?? ev.subtype ?? '').slice(0, 200)}`);
        // Count it like a crash (two within 2 minutes give up), and give the lines one more try.
        const retry = !t.items.some((i) => i.retried);
        if (this._failed()) return;
        clearTimeout(t.graceTimer);
        this.turn = null;
        if (retry) {
          for (const i of t.items) i.retried = true;
          this.queue.unshift(...t.items);
        } else {
          for (const i of t.items) i.done = true;
        }
        this.emit('turn_end', { spoken: t.spoken, dropped: true, silent: true, lines: t.items.map((i) => i.line) });
        this._pump();
        return;
      }
      if (!t.sawDelta && typeof ev.result === 'string' && !t.stream.all) t.stream.push(ev.result);
      t.stream.flush();
    }
    this._endTurn();
  }

  _endTurn() {
    const t = this.turn;
    if (!t) return;
    clearTimeout(t.graceTimer);
    this.turn = null;
    for (const i of t.items) i.done = true;
    this.emit('turn_end', { spoken: t.spoken, dropped: t.dropped, silent: t.stream.silent, lines: t.items.map((i) => i.line) });
    this._pump();
  }

  /** Record a failure; true when that makes two within the crash window (SPEC 13.7). */
  _failed() {
    const now = Date.now();
    this.failures = this.failures.filter((at) => now - at < this.opts.crashWindowMs);
    this.failures.push(now);
    if (this.failures.length >= 2) {
      this._giveUp('crashed twice within 2 minutes');
      return true;
    }
    return false;
  }

  _onExit(proc, { code, signal, error, expected }) {
    this.proc = null;
    if (expected || this.stopped) return;
    this.emit('log', `voice host exited unexpectedly (code ${code ?? '-'}, signal ${signal ?? '-'}${error ? `, ${error}` : ''})`);
    if (!proc.initOk) {
      this._giveUp(error ? `could not start: ${error}` : 'could not start');
      return;
    }
    if (this._failed()) return;
    const lost = this.turn ? this.turn.items : [];
    if (this.turn) {
      clearTimeout(this.turn.graceTimer);
      this.turn = null;
    }
    // Respawn and give the lost lines to the new process (its context starts over).
    for (const i of lost) i.done = false;
    this.queue.unshift({ tag: 'event', line: '[event] The voice assistant restarted; earlier conversation context was lost.', trigger: false, done: false }, ...lost);
    if (lost.length) this.queue.find((i) => i.tag !== 'event').trigger = lost.some((i) => i.trigger);
    this.start();
    this._pump();
  }

  _restart() {
    const old = this.proc;
    const lost = this.turn ? this.turn.items.filter((i) => i.tag === 'driver' || i.trigger) : [];
    if (this.turn) clearTimeout(this.turn.graceTimer);
    this.turn = null;
    this.proc = null;
    old?.stop({ graceful: false });
    if (!this.up) return;
    this.queue.unshift({ tag: 'event', line: '[event] The voice assistant restarted; earlier conversation context was lost.', trigger: false, done: false }, ...lost);
    this.start();
    this._pump();
  }

  _giveUp(reason, resetsAt) {
    if (this.dead || this.stopped) return;
    this.dead = true;
    this.emit('log', `voice host unavailable: ${reason}`);
    this.workerStopped();
    const pending = this.undelivered();
    const proc = this.proc;
    this.proc = null;
    if (this.turn) clearTimeout(this.turn.graceTimer);
    this.turn = null;
    this.queue = [];
    proc?.stop({ graceful: false });
    this.emit('unavailable', { reason, resetsAt, pending });
  }

  stop() {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    this.workerStopped();
    if (this.turn) clearTimeout(this.turn.graceTimer);
    this.turn = null;
    const proc = this.proc;
    this.proc = null;
    return proc ? proc.stop({ graceful: false }) : Promise.resolve();
  }
}
