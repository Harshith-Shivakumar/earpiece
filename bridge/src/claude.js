// ALL Claude Code CLI wire handling lives here (SPEC section 4), so it is easy to adjust.
//
// ClaudeProcess wraps one long-lived `claude -p --input-format stream-json ...` child.
// Events it emits (all already parsed; the session never touches raw CLI JSON):
//   'spawn'        { pid, cwd, cmd, args }
//   'event'        raw parsed stdout object (for events.jsonl)
//   'stdin'        object written to the child's stdin (for events.jsonl)
//   'bad_line'     stdout line that is not JSON
//   'stderr'       stderr text chunk
//   'log'          short diagnostic string
//   'init'         { ok, error } outcome of the initialize request
//   'turn_start'   { sessionId, cwd, model } for every system/init (the CLI emits one per turn)
//   'tool_use'     { id, name, input, parentToolUseId }
//   'text'         { text, parentToolUseId }
//   'tool_result'  { text, isError, toolUseId, parentToolUseId }
//   'task_summary' { detail }
//   'post_turn_summary' { statusCategory, statusDetail, needsAction }
//   'rate_limit'   rate_limit_info object
//   'result'       raw result event
//   'can_use_tool' { requestId, toolName, displayName, input, toolUseId, description, proc }
//   'cancel_request' requestId
//   'session'      session id (whenever it is learned or changes)
//   'exit'         { code, signal, error, expected }
//   'stream'       the inner event of a stream_event (--include-partial-messages), e.g. content_block_delta

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const SUMMARY_PROMPT =
  'Summarize this voice coding session for the driver to read at their desk: what was asked, what was done (files changed, commands run), decisions made, open questions, and suggested next steps. Use short markdown sections.';

// No --append-system-prompt (SPEC 10.4): voice rules are sent as a message inside the chat.
export function buildArgs({ model, resume } = {}) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'auto',
    '--permission-prompt-tool', 'stdio',
  ];
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  return args;
}

/** A .js bin (the test mock) is run with this Node; anything else is executed directly. */
export function commandFor(bin, args) {
  if (/\.(c|m)?js$/.test(bin)) return { cmd: process.execPath, args: [bin, ...args] };
  return { cmd: bin, args };
}

let counter = 0;
export function newRequestId() {
  counter += 1;
  return `earpiece_${Date.now().toString(36)}_${counter.toString(36)}_${randomBytes(3).toString('hex')}`;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c?.text === 'string' ? c.text : `[${c?.type ?? 'content'}]`))
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

export class ClaudeProcess extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.bin
   * @param {string} o.cwd
   * @param {string} [o.model]
   * @param {string} [o.resume]  session id for --resume
   */
  constructor(o) {
    super();
    this.opts = {
      initTimeoutMs: 10_000,
      interruptTimeoutMs: 5000,
      killGraceMs: 3000,
      closeWaitMs: 1500,
      ...o,
    };
    this.cwd = o.cwd;
    this.child = null;
    this.started = false;
    this.exited = false;
    this.expectedExit = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.sessionId = o.resume || null;
    this.pending = new Map(); // request_id -> callback(response) for requests we sent
    this.resultWaiters = new Set();
    this.buf = '';
    this.ready = new Promise((r) => (this._resolveReady = r));
    this.exitPromise = new Promise((r) => (this._resolveExit = r));
  }

  get alive() {
    return this.started && !this.exited;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // o.args replaces the worker launch flags (the voice host, SPEC 13.1, has its own).
    const args = this.opts.args ?? buildArgs({ model: this.opts.model, resume: this.opts.resume });
    const { cmd, args: argv } = commandFor(this.opts.bin, args);
    try {
      this.child = spawn(cmd, argv, {
        cwd: this.cwd,
        env: { ...process.env, ...(this.opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._onExit(null, null, err);
      return;
    }
    const child = this.child;
    this.emit('spawn', { pid: child.pid, cwd: this.cwd, cmd, args });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onStdout(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => this.emit('stderr', d));
    child.stdin.on('error', (err) => this.emit('log', `claude stdin: ${err.message}`));
    child.on('error', (err) => this._onExit(null, null, err));
    child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      // 'close' normally follows once stdio drains; don't wait forever if a grandchild holds it.
      const t = setTimeout(() => this._onExit(code, signal), 1000);
      t.unref?.();
    });
    child.on('close', (code, signal) => this._onExit(code ?? this.exitCode, signal ?? this.exitSignal));

    // SPEC 4.1: initialize, wait up to initTimeoutMs, continue anyway on error or timeout.
    const id = newRequestId();
    const timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.pending.delete(id);
      this.emit('init', { ok: false, error: `no initialize response within ${this.opts.initTimeoutMs} ms` });
      this._resolveReady();
    }, this.opts.initTimeoutMs);
    timer.unref?.();
    this.pending.set(id, (resp) => {
      clearTimeout(timer);
      const ok = resp?.subtype === 'success';
      this.emit('init', { ok, error: ok ? null : resp?.error ?? 'initialize failed' });
      this._resolveReady();
    });
    this._write({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
  }

  /** Queue a user message; it is written once initialize has finished (or timed out). */
  sendUser(text) {
    this.ready.then(() => {
      this._write({
        type: 'user',
        message: { role: 'user', content: String(text) },
        parent_tool_use_id: null,
        session_id: this.sessionId ?? '',
      });
    });
  }

  allow(requestId, updatedInput) {
    return this._write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput } },
    });
  }

  deny(requestId, message) {
    return this._write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } },
    });
  }

  /**
   * SPEC 4.4. Resolves true when a control_response or a result arrives (or the process exits),
   * false after interruptTimeoutMs with neither. The caller decides to kill and respawn.
   */
  interrupt() {
    if (!this.alive) return Promise.resolve(true);
    const id = newRequestId();
    return new Promise((resolve) => {
      let done = false;
      const onResult = () => finish(true);
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.resultWaiters.delete(onResult);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), this.opts.interruptTimeoutMs);
      timer.unref?.();
      this.pending.set(id, () => finish(true));
      this.resultWaiters.add(onResult);
      this._write({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
    });
  }

  /**
   * Stop the process. graceful: close stdin and give it closeWaitMs to exit on its own first.
   * Then SIGTERM, then SIGKILL after killGraceMs. Resolves when it has exited.
   */
  stop({ graceful = true } = {}) {
    this.expectedExit = true;
    if (!this.started) {
      this.started = true;
      this.exited = true;
      this._resolveReady();
      this._resolveExit();
      return this.exitPromise;
    }
    if (this.exited) return this.exitPromise;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const term = () => {
      if (this.exited) return;
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.killTimer = setTimeout(() => {
        if (this.exited) return;
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, this.opts.killGraceMs);
      this.killTimer.unref?.();
    };
    if (graceful) {
      this.termTimer = setTimeout(term, this.opts.closeWaitMs);
      this.termTimer.unref?.();
    } else {
      term();
    }
    return this.exitPromise;
  }

  _write(obj) {
    const child = this.child;
    if (!child || this.exited || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      this.emit('log', `dropped ${obj.type} for claude: process not running`);
      return false;
    }
    this.emit('stdin', obj);
    try {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (err) {
      this.emit('log', `claude stdin write failed: ${err.message}`);
      return false;
    }
  }

  _onStdout(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this._onLine(line);
    }
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      this.emit('bad_line', trimmed);
      return;
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      this.emit('bad_line', trimmed);
      return;
    }
    this.emit('event', ev);
    try {
      this._dispatch(ev);
    } catch (err) {
      this.emit('log', `error handling claude ${ev.type} event: ${err.stack ?? err}`);
    }
  }

  _setSession(id) {
    if (id && id !== this.sessionId) {
      this.sessionId = id;
      this.emit('session', id);
    }
  }

  _dispatch(ev) {
    switch (ev.type) {
      case 'system':
        return this._onSystem(ev);
      case 'assistant': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        const parentToolUseId = ev.parent_tool_use_id ?? null;
        for (const block of content) {
          if (block?.type === 'tool_use') {
            this.emit('tool_use', { id: block.id, name: block.name, input: block.input ?? {}, parentToolUseId });
          } else if (block?.type === 'text' && block.text) {
            this.emit('text', { text: block.text, parentToolUseId });
          }
        }
        return;
      }
      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type !== 'tool_result') continue;
          this.emit('tool_result', {
            text: toolResultText(block.content),
            isError: !!block.is_error,
            toolUseId: block.tool_use_id,
            parentToolUseId: ev.parent_tool_use_id ?? null,
          });
        }
        return;
      }
      case 'result':
        this._setSession(ev.session_id);
        for (const w of [...this.resultWaiters]) w();
        this.emit('result', ev);
        return;
      case 'rate_limit_event':
        if (ev.rate_limit_info && typeof ev.rate_limit_info === 'object') this.emit('rate_limit', ev.rate_limit_info);
        return;
      case 'control_request':
        return this._onControlRequest(ev);
      case 'control_response': {
        const r = ev.response ?? {};
        const cb = this.pending.get(r.request_id);
        if (cb) {
          this.pending.delete(r.request_id);
          cb(r);
        }
        return;
      }
      case 'stream_event':
        if (ev.event && typeof ev.event === 'object') this.emit('stream', ev.event);
        return;
      case 'control_cancel_request':
        this.emit('cancel_request', ev.request_id ?? ev.request?.request_id);
        return;
      default:
        return; // keep_alive, unknown: ignored (still logged via 'event')
    }
  }

  _onSystem(ev) {
    switch (ev.subtype) {
      case 'init':
        // Emitted at the start of every turn, including turns Claude starts on its own.
        this._setSession(ev.session_id);
        this.emit('turn_start', { sessionId: ev.session_id, cwd: ev.cwd, model: ev.model });
        return;
      case 'task_summary':
        if (typeof ev.detail === 'string' && ev.detail.trim()) this.emit('task_summary', { detail: ev.detail });
        return;
      case 'post_turn_summary':
        this.emit('post_turn_summary', {
          statusCategory: ev.status_category ?? null,
          statusDetail: typeof ev.status_detail === 'string' ? ev.status_detail : null,
          needsAction: ev.needs_action ?? null,
        });
        return;
      default:
        // hook_started, hook_response, thinking_tokens, background_tasks_changed, task_started,
        // task_updated, task_notification, compact_boundary, status, ...: logged only.
        return;
    }
  }

  _onControlRequest(ev) {
    const id = ev.request_id;
    const req = ev.request ?? {};
    if (req.subtype === 'can_use_tool' && this.listenerCount('can_use_tool') > 0) {
      this.emit('can_use_tool', {
        requestId: id,
        toolName: req.tool_name,
        displayName: req.display_name ?? null,
        input: req.input && typeof req.input === 'object' ? req.input : {},
        toolUseId: req.tool_use_id ?? null,
        description: req.description ?? null,
        proc: this,
      });
      return;
    }
    this._write({
      type: 'control_response',
      response: { subtype: 'error', request_id: id, error: 'unsupported by earpiece' },
    });
  }

  _onExit(code, signal, err) {
    if (this.exited) return;
    this.exited = true;
    if (this.buf.trim()) {
      const rest = this.buf;
      this.buf = '';
      this._onLine(rest);
    }
    clearTimeout(this.killTimer);
    clearTimeout(this.termTimer);
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const cb of callbacks) cb({ subtype: 'error', error: 'process exited' });
    for (const w of [...this.resultWaiters]) w();
    this._resolveReady();
    this.emit('exit', { code, signal, error: err?.message ?? null, expected: this.expectedExit });
    this._resolveExit();
  }
}

export const SUMMARY_ARGS = ['-p', '--model', 'haiku', '--output-format', 'text', '--no-session-persistence'];

/**
 * SPEC 6 + 10.2: `CLAUDE_BIN -p --model haiku --output-format text --no-session-persistence "<prompt>"`
 * with the transcript on stdin (so summaries never show up as chats). Resolves with stdout.
 */
export function runSummary({ bin, transcript, cwd, timeoutMs = 180_000, signal }) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = commandFor(bin, [...SUMMARY_ARGS, SUMMARY_PROMPT]);
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], signal });
    } catch (err) {
      reject(err);
      return;
    }
    let out = '';
    let errText = '';
    let settled = false;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      settle(reject, new Error(`summary timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (errText += d));
    child.on('error', (err) => settle(reject, new Error(`could not run ${bin}: ${err.message}`)));
    child.on('close', (code, sig) => {
      if (code === 0) settle(resolve, out);
      else settle(reject, new Error(`${bin} exited with ${code ?? sig}: ${errText.trim().slice(-800) || out.trim().slice(-800)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(transcript);
  });
}
