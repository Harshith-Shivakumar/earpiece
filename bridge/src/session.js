// The bridge's session: phone connection, state machine (SPEC 3.1-3.5), replay (5), drives (6),
// and chats (10): opening, voice mode on/off, switching by screen or voice, folder switches.
// All CLI wire details are in claude.js and all chat-file reading is in chats.js.

import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path';
import {
  chatCwd, cutTitle, dirExists, fileSize, findChat, findChatFileSync, isChatId, listChats, normalizeSent, publicChat,
  readUserTextsSince,
} from './chats.js';
import { ClaudeProcess, runSummary } from './claude.js';
import { expandHome } from './config.js';
import { Drive } from './drive.js';
import { Host, TOOL_SPECS } from './host.js';
import { McpServer } from './mcp.js';
import { Narrator } from './narrator.js';
import { HOST_SYSTEM_PROMPT, continueSection, deskLine, folderSwitchMessage, resumeCommand, voiceOffMessage, voiceOnMessage } from './prompt.js';
import { classifyYesNo, formatQuestion, matchAnswer, normalize, permissionSummary, pickFromList } from './questions.js';
import { cleanForSpeech, cleanInline, errorReason, extractSwitch, stripEnd } from './speech.js';

const CONTROL_ACTIONS = new Set([
  'cancel', 'stop', 'status', 'repeat', 'pause', 'resume', 'end_drive', 'switch_chat', 'new_chat', 'which_chat',
]);
const MAX_SAY_LOG = 200;
const REPLAY_NOTICE_OVER = 5;
const NEW_CHAT_TITLE = 'New chat';
const BUSY_LINE = 'Claude is still working. Say stop first, or wait.';
const CHANGED_LINE = 'This chat changed on the laptop. Picking up the latest.';
const STILL_WORKING_LINE = 'Claude is still working. Say stop first, or keep going.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPOKEN_NUMBERS = ['One', 'Two', 'Three'];
const HOST_DOWN_LINE = 'Voice assistant unavailable. Using basic mode.';
const PHONE_COMMANDS = {
  cancel: 'cancel', stop: 'stop', status: 'status', repeat: 'repeat', pause: 'pause', resume: "I'm back",
  end_drive: 'end drive', switch_chat: 'switch chat', new_chat: 'new chat', which_chat: 'which chat',
};

export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function shortTask(text, maxWords = 15) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  return stripEnd(words.slice(0, maxWords).join(' '));
}

/** A chat title as spoken: cleaned, at most 8 words. */
export function spokenTitle(title) {
  return shortTask(cleanInline(title ?? ''), 8) || 'an untitled chat';
}

function lowerFirst(s) {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

function ago(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m === 1 ? '1 minute ago' : `${m} minutes ago`;
}

/** "just now", "10 minutes ago", "2 hours ago", "yesterday", "4 days ago" (SPEC 10.5). */
export function chatAgo(at, now = Date.now()) {
  const m = Math.floor(Math.max(0, now - at) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (new Date(at).toDateString() === yesterday.toDateString()) return 'yesterday';
  const d = Math.max(2, Math.round((now - at) / 86_400_000));
  return `${d} days ago`;
}

export function isAllowedStatus(status) {
  // "allowed_warning" means close to a limit, not over it.
  return status === undefined || status === null || String(status).startsWith('allowed');
}

/** "4:30 PM", "9:00 AM tomorrow", or "4:30 PM on Tuesday" for a unix time in seconds (or ms). */
export function resetTimeText(resetsAt, now = new Date()) {
  const n = Number(resetsAt);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n > 1e12 ? n : n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/[  ]/g, ' ');
  if (d.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return `${time} on ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;
}

/** Does a result event say a rate or usage limit was hit? Returns { resetsAt? } or null. */
export function limitFromResult(ev = {}) {
  const text = typeof ev.result === 'string' ? ev.result : '';
  const legacy = text.match(/usage limit reached\|(\d{9,13})/i); // older CLIs: "Claude AI usage limit reached|<epoch>"
  if (legacy) return { resetsAt: Number(legacy[1]) };
  if (!ev.is_error) return null;
  const status = ev.api_error_status;
  if (status === 429 || /429|rate|limit/i.test(String(status ?? ''))) return {};
  if (/\b(rate|usage|session|weekly)[ _-]?limit|limit (reached|exceeded)|hit your (usage )?limit|too many requests|\b429\b/i.test(text)) {
    return {};
  }
  return null;
}

function toolDetail(input = {}) {
  for (const k of ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) return input[k];
  }
  return '';
}

const NEW_CHAT_RE = /\b(new|fresh) (chat|one|conversation)\b|^new$/;
const STAY_WORDS = ['cancel', 'never mind', 'nevermind', 'stay', 'stay here', 'no', 'nope', 'none', 'neither', 'nothing', 'forget it'];

/** answer_question labels: exact option labels (case-insensitive), else the words as free text. */
export function mapLabels(parts, options, multiSelect) {
  const labels = options.map((o) => o?.label).filter((l) => typeof l === 'string');
  const key = (t) => String(t).toLowerCase().replace(/[.!?]+$/, '').trim();
  const find = (t) => labels.find((l) => key(l) === key(t));
  let items = parts;
  if (items.length === 1 && multiSelect && !find(items[0])) items = items[0].split(/\s*(?:,|;|\band\b)\s*/i).filter(Boolean);
  const picks = items.map(find);
  if (picks.length && picks.every(Boolean) && (multiSelect || picks.length === 1)) return { answer: [...new Set(picks)].join(', '), free: false };
  return { answer: parts.join(', '), free: true };
}

/** Chats ranked by how many words of the spoken title they share (13.2 fuzzy title match). */
export function rankChats(title, chats) {
  const words = (t) => normalize(t).split(' ').filter((w) => w.length > 1 && !['the', 'chat', 'about', 'one', 'my'].includes(w));
  const want = words(title);
  const whole = normalize(title);
  const ranked = [];
  for (const chat of chats) {
    const have = new Set(words(chat.title));
    let score = want.filter((w) => have.has(w)).length;
    if (whole && normalize(chat.title).includes(whole)) score += 2;
    if (score > 0) ranked.push({ chat, score });
  }
  return ranked.sort((a, b) => b.score - a.score);
}

export class Session {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.state = 'idle';
    this.seq = 0;
    this.sayLog = [];
    this.lastSpoken = null; // last reply or question entry, for `repeat`
    this.conn = null;
    this.drive = null;
    this.claude = null;
    this.claudeDead = false;
    this.chat = null; // { id, title, isNew } of the chat the bridge is running
    // SPEC 10.8: what the bridge sent into the open chat and how far its file has been checked.
    this.track = null; // { id, file, offset, sent: Set<normalised text> }
    this.settleTimer = null;
    this.driveChats = new Map(); // chats used in this drive: id -> { id, title, cwd } (SPEC 10.9)
    this.pendingDriveEnded = null; // { msg, conn, sentAt, undelivered } (SPEC 11.5 replay)
    this.switching = false;
    this.leftChats = new Map(); // chat id -> when the bridge left it (its own last write)
    this.cwd = this._startDir();
    this.sessionId = null;
    this.pendingTask = null;
    this.holdTimer = null;
    this.holdExpiredAt = 0;
    this.currentTask = null;
    this.followUps = [];
    this.questions = []; // pending can_use_tool requests and bridge-local questions, oldest first
    this.paused = false;
    this.crashTimes = [];
    this.restartTimer = null;
    // Turn accounting for the current claude process.
    this.pendingSends = 0; // user messages written whose turn has not started yet
    this.turnActive = false; // a turn started (system/init) and has no result yet
    this.stale = 0; // results still expected from turns the driver stopped
    this.silentResults = 0; // results to keep quiet (the greeting of a chat opened by a task)
    this.interrupting = null;
    this.deferred = []; // messages to send once an interrupt has settled
    this.limitAnnounced = false;
    this.rateLimit = null;
    this.lastTurnSummary = null;
    this.shuttingDown = false;
    this.abort = new AbortController();
    this.summaries = new Set();
    this.noPhoneSince = Date.now();
    this.idleSince = Date.now();
    // SPEC 13: the voice host.
    this.mcp = null; // McpServer serving the Earpiece tools (one per bridge run)
    this.mcpError = null;
    this.host = null; // Host of the current drive
    this.hostFailed = false; // fell back to v2 for the rest of this drive (13.7)
    this.hostSwitchReply = false; // the next result is the voice-on reply of a chat switch
    this.recentActions = []; // last 5 worker actions, for get_status
    this.taskStartedAt = null;

    this.narrator = new Narrator({
      delayMs: config.progressDelayMs,
      intervalMs: config.progressIntervalMs,
      emit: (text) => this.say(text, 'progress'),
      canSpeak: () => !this.paused && this.state === 'working' && !this._hostOn(),
    });

    const every = Math.max(50, Math.min(60_000, Math.floor(config.driveIdleMs / 4)));
    this.idleCheck = setInterval(() => this._safe(() => this._checkIdleDrive()), every);
    this.idleCheck.unref?.();
  }

  _safe(fn) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((err) => this.log(`internal error: ${err?.stack ?? err}`));
    } catch (err) {
      this.log(`internal error: ${err?.stack ?? err}`);
    }
  }

  _startDir() {
    return dirExists(this.config.startDir) ? this.config.startDir : homedir();
  }

  _chatInfo() {
    return this.chat ? { id: this.chat.id, title: this.chat.title } : null;
  }

  // ---------------------------------------------------------------- phone connection

  onConnection(conn) {
    conn.authed = false;
    conn.helloTimer = setTimeout(() => {
      if (conn.authed) return;
      this._sendTo(conn, { type: 'error', code: 'auth', message: 'No hello received.' });
      conn.close(1008, 'no hello');
    }, this.config.helloTimeoutMs);
    conn.helloTimer.unref?.();
    conn.on('message', (data, isBinary) => this._safe(() => this.onMessage(conn, data, isBinary)));
    conn.on('close', () => this._safe(() => this.onDisconnect(conn)));
    conn.on('socketError', (err) => this.log(`socket error: ${err.message}`));
    conn.startHeartbeat(this.config.wsPingMs, this.config.wsIdleMs);
  }

  _sendTo(conn, obj) {
    if (conn && conn.readyState === 'open') conn.send(JSON.stringify(obj));
  }

  _send(obj) {
    if (this.conn) this._sendTo(this.conn, obj);
  }

  _protocolError(conn, code, message) {
    this._sendTo(conn, { type: 'error', code, message });
  }

  onMessage(conn, data, isBinary) {
    if (isBinary) return this._protocolError(conn, 'bad_message', 'Binary frames are not supported.');
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this._protocolError(conn, 'bad_json', 'Message is not valid JSON.');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return this._protocolError(conn, 'bad_message', 'Message must be a JSON object with a type.');
    }
    if (conn.replaced) return; // superseded by a newer phone connection; it is being closed
    if (msg.type === 'ping') return this._sendTo(conn, { type: 'pong' });
    if (msg.type === 'hello') return this.onHello(conn, msg);
    if (!conn.authed) {
      this._protocolError(conn, 'auth', 'Send hello first.');
      conn.close(1008, 'auth');
      return;
    }
    if (conn !== this.conn) return; // replaced by a newer connection; it is being closed
    // An utterance starts the drive (SPEC 10.3), so open it first and the utterance is logged in it.
    if (msg.type === 'utterance' && typeof msg.text === 'string' && msg.text.trim()) this.ensureDrive();
    this.drive?.event('phone', msg);
    switch (msg.type) {
      case 'utterance':
        if (typeof msg.text !== 'string') return this._protocolError(conn, 'bad_message', 'utterance needs a text string.');
        return this.onUtterance(msg.text);
      case 'control':
        if (!CONTROL_ACTIONS.has(msg.action)) {
          return this._protocolError(conn, 'bad_message', `Unknown control action: ${String(msg.action)}.`);
        }
        return this.onControl(msg.action, { force: msg.force === true });
      case 'list_chats':
        return this.onListChats();
      case 'open_chat':
        if (!isChatId(msg.id)) return this._protocolError(conn, 'bad_message', 'open_chat needs a valid chat id.');
        return this.onOpenChat(msg.id);
      case 'new_chat':
        if (msg.cwd !== undefined && msg.cwd !== null && typeof msg.cwd !== 'string') {
          return this._protocolError(conn, 'bad_message', 'new_chat cwd must be a string.');
        }
        return this.onNewChat(msg.cwd ?? null);
      default:
        return this._protocolError(conn, 'bad_message', `Unknown message type: ${msg.type}.`);
    }
  }

  onHello(conn, msg) {
    // Over the relay the Noise session already authenticated the phone (SPEC 12.3): no token there.
    if (!conn.tunnel && !tokenMatches(msg.token, this.config.token)) {
      this.log(`phone rejected: wrong token (${conn.remoteAddress ?? 'unknown address'})`);
      this._protocolError(conn, 'auth', 'Wrong token.');
      conn.close(1008, 'auth');
      return;
    }
    clearTimeout(conn.helloTimer);
    if (this.conn && this.conn !== conn) {
      const old = this.conn;
      this.conn = null;
      old.authed = false;
      old.replaced = true;
      this._driveEndedSocketLost(old);
      old.close(4000, 'replaced by a new connection');
    }
    conn.authed = true;
    this.conn = conn;
    this.noPhoneSince = null;
    // SPEC 10.3: no drive starts here; it starts on the first open_chat, new_chat or utterance.
    const client = typeof msg.client === 'string' ? msg.client.slice(0, 80) : 'unknown';
    this.drive?.event('phone', { ...msg, token: '<redacted>' });
    this.drive?.note(`Phone connected (${client}).`);
    const lastSeq = Number.isSafeInteger(msg.last_seq) && msg.last_seq > 0 ? msg.last_seq : 0;
    // After a bridge restart the phone may be ahead of us; jump so new lines are never "old".
    if (lastSeq > this.seq) this.seq = lastSeq;
    this.log(`phone connected (${client}) ${conn.tunnel ? 'via' : 'from'} ${conn.remoteAddress ?? '?'}, last_seq ${lastSeq}`);
    this._send({
      type: 'welcome',
      drive_id: this.drive?.id ?? null,
      cwd: this.cwd,
      state: this.state,
      seq: this.seq,
      name: this.config.name,
      bridge_id: this.config.bridgeId,
      chat: this._chatInfo(),
    });
    this.replay(lastSeq);
    this._replayDriveEnded();
    if (this._hostOn()) this.host.post('event', 'The phone reconnected.');
  }

  onDisconnect(conn) {
    clearTimeout(conn.helloTimer);
    this._driveEndedSocketLost(conn);
    if (conn !== this.conn) return;
    this.conn = null;
    this.noPhoneSince = Date.now();
    this.log('phone disconnected');
    this.drive?.note('Phone disconnected.');
  }

  // ---------------------------------------------------------------- say / state / replay

  say(text, kind) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const entry = { seq: ++this.seq, text: clean, kind, ts: Date.now() };
    this.sayLog.push(entry);
    if (this.sayLog.length > MAX_SAY_LOG) this.sayLog.shift();
    if (kind === 'reply' || kind === 'question') this.lastSpoken = entry;
    this.drive?.spoken(kind, clean);
    this.drive?.event('bridge', { type: 'say', seq: entry.seq, kind, text: clean });
    this.log(`say #${entry.seq} ${kind}: ${clean}`);
    this._send({ type: 'say', seq: entry.seq, text: clean, kind });
    return entry;
  }

  /** Re-send an earlier line with a fresh seq (it moves to the end of the history). */
  _resend(entry) {
    const i = this.sayLog.indexOf(entry);
    if (i >= 0) this.sayLog.splice(i, 1);
    entry.seq = ++this.seq;
    this.sayLog.push(entry);
    if (this.sayLog.length > MAX_SAY_LOG) this.sayLog.shift();
    this.drive?.event('bridge', { type: 'resay', seq: entry.seq, kind: entry.kind, text: entry.text });
    this._send({ type: 'say', seq: entry.seq, text: entry.text, kind: entry.kind });
  }

  setState(state, { force = false } = {}) {
    if (state === this.state && !force) return;
    const prev = this.state;
    this.state = state;
    if (state === 'idle') this.idleSince = Date.now();
    if (prev !== state) this.log(`state ${prev} -> ${state}`);
    if (this.chat?.id && this.drive) this.driveChats.set(this.chat.id, { id: this.chat.id, title: this.chat.title, cwd: this.cwd });
    const msg = { type: 'state', state, cwd: this.cwd, chat: this._chatInfo() };
    this.drive?.event('bridge', msg);
    this._send(msg);
    if (state === 'working') this.narrator.poke();
    if (state === 'working') this.host?.workerStarted();
    else if (state === 'idle') this.host?.workerStopped();
  }

  _pushState() {
    this.setState(this.state, { force: true });
  }

  /** SPEC 5. Replayed lines get fresh seq numbers so they play in order after the notice. */
  replay(lastSeq) {
    const pending = this.questions[0]?.entry ?? null;
    let lines = this.sayLog.filter((e) => e.seq > lastSeq && e.kind !== 'progress' && e !== pending);
    if (lines.length > REPLAY_NOTICE_OVER) {
      this.say('While you were away:', 'notice');
      lines = lines.filter((e) => e.kind === 'reply' || e.kind === 'question' || e.kind === 'error');
    }
    for (const e of lines) this._resend(e);
    if (pending) this._resend(pending);
    if (lines.length || pending) this.log(`replayed ${lines.length + (pending ? 1 : 0)} line(s) after seq ${lastSeq}`);
  }

  // ---------------------------------------------------------------- drives

  /** Open a drive if none is open. Does not start Claude (that happens when a chat opens). */
  ensureDrive() {
    if (this.drive) return this.drive;
    this.drive = new Drive({ home: this.config.home, cwd: this.cwd, onError: (m) => this.log(m) });
    this.driveChats = new Map();
    this.pendingDriveEnded = null; // the phone drops the old card when a new drive starts
    this.crashTimes = [];
    this.claudeDead = false;
    this.log(`drive ${this.drive.id} started (${this.drive.dir})`);
    if (this.conn) this.drive.note('Phone connected.');
    this.hostFailed = false;
    this._startHost();
    return this.drive;
  }

  _checkIdleDrive() {
    if (!this.drive || this.conn || this.state !== 'idle' || this.shuttingDown || this.switching) return;
    const since = Math.max(this.noPhoneSince ?? 0, this.idleSince ?? 0);
    if (Date.now() - since >= this.config.driveIdleMs) {
      this._safe(() => this.finalizeDrive('no phone connection and Claude idle for 30 minutes'));
    }
  }

  async finalizeDrive(reason) {
    const drive = this.drive;
    if (!drive) return;
    this.drive = null;
    this._stopHost();
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.pendingTask = null;
    this.questions = [];
    this.followUps = [];
    this.deferred = [];
    const chatsUsed = [...this.driveChats.values()];
    const detached = this._detachClaude();
    this.sessionId = null;
    this.currentTask = null;
    this.lastTurnSummary = null;
    this.cwd = this._startDir();
    this.setState('idle', { force: true });
    if (detached.chat) drive.note(`Leaving chat: ${detached.chat.title} (${detached.chat.id ?? 'new'}). Voice mode off.`);
    await this._retire(detached, { voiceOff: true, drive });
    drive.close(reason);
    this.log(`drive ${drive.id} ended (${reason}); writing summary`);
    const job = drive
      .writeSummary(
        (transcript, cwd) =>
          runSummary({
            bin: this.config.claudeBin,
            transcript,
            cwd,
            timeoutMs: this.config.summaryTimeoutMs,
            signal: this.abort.signal,
          }),
        { preamble: continueSection(chatsUsed) },
      )
      .then(() => this.log(`summary written: ${drive.summaryPath}`));
    this._sendDriveEnded(drive.id, chatsUsed);
    this.summaries.add(job);
    job.finally(() => this.summaries.delete(job));
    await job;
  }

  // ---------------------------------------------------------------- claude process

  /**
   * Create (not start) a claude process. adopt=false makes a side process that never drives the
   * session (used to send voice-off to a reloaded chat while leaving it).
   */
  _createClaude({ resume = null, adopt = true, cwd = this.cwd, drive = this.drive } = {}) {
    const proc = new ClaudeProcess({
      bin: this.config.claudeBin,
      cwd,
      model: this.config.model,
      resume,
      initTimeoutMs: this.config.initTimeoutMs,
      interruptTimeoutMs: this.config.interruptTimeoutMs,
      killGraceMs: this.config.killGraceMs,
      closeWaitMs: this.config.closeWaitMs,
    });
    proc.fresh = true; // has not finished a turn yet, so it loaded the chat file recently
    proc.on('result', () => (proc.fresh = false));
    if (adopt) {
      this.claude = proc;
      this.pendingSends = 0;
      this.turnActive = false;
      this.stale = 0;
      this.silentResults = 0;
    }
    const current = () => adopt && this.claude === proc;
    const on = (name, fn) => proc.on(name, (arg) => this._safe(() => fn(arg)));

    on('spawn', (info) => {
      this.log(`claude started (pid ${info.pid}) in ${info.cwd}${resume ? ` resuming ${resume}` : ' (new chat)'}`);
      drive?.event('bridge', { type: 'spawn', ...info });
    });
    on('event', (ev) => drive?.event('claude', ev));
    on('stdin', (obj) => drive?.event('to_claude', obj));
    on('bad_line', (line) => {
      this.log(`claude printed a non-JSON line: ${line}`);
      drive?.event('claude_unparsed', { line });
    });
    on('stderr', (text) => drive?.event('claude_stderr', { text }));
    on('log', (m) => this.log(m));
    on('init', ({ ok, error }) => {
      if (!ok) this.log(`claude initialize: ${error} (continuing)`);
      drive?.event('bridge', { type: 'initialize', ok, error });
    });
    on('session', (id) => current() && this.onSessionId(id));
    on('turn_start', () => current() && this.onTurnStart());
    on('tool_use', (t) => current() && this.onToolUse(t));
    on('text', (t) => current() && this.drive?.claudeText(t.text));
    on('tool_result', (r) => current() && this.drive?.toolResult(r.text));
    on('task_summary', ({ detail }) => current() && this.onTaskSummary(detail));
    on('post_turn_summary', (s) => current() && s.statusDetail && (this.lastTurnSummary = s.statusDetail));
    on('rate_limit', (info) => current() && this.onRateLimit(info));
    on('result', (ev) => current() && this.onResult(ev));
    on('can_use_tool', (req) => this.onCanUseTool(req));
    on('cancel_request', (id) => current() && this.onCancelRequest(id));
    on('exit', (info) => this.onClaudeExit(proc, info, drive));
    return proc;
  }

  /** Start a process for the open chat. It loads the chat file now, so the check starts from here. */
  _startProc(proc) {
    if (this.track?.id) this.track.offset = fileSize(this._trackFile(this.track)) ?? 0;
    proc.start();
  }

  // ---------------------------------------------------------------- changed-elsewhere guard (10.8)

  _newTrack(id = null, file = null) {
    return { id, file, offset: 0, sent: new Set() };
  }

  _trackFile(track) {
    if (!track?.id) return null;
    if (track.file && fileSize(track.file) !== null) return track.file;
    track.file = findChatFileSync({ root: this.config.claudeProjects, id: track.id });
    return track.file;
  }

  /** Real user texts written to the chat file since the last check that the bridge did not send. */
  _foreignTexts(track) {
    const file = this._trackFile(track);
    if (!file) return [];
    const { texts, end } = readUserTextsSince(file, track.offset);
    const foreign = texts.filter((t) => !track.sent.has(t));
    if (!foreign.length) track.offset = end; // nothing foreign: no need to read this part again
    return foreign;
  }

  /** After a result, move the checked offset forward once the file stops growing (~1 s). */
  _scheduleSettle() {
    clearTimeout(this.settleTimer);
    const track = this.track;
    if (!track) return;
    const settleMs = this.config.chatSettleMs;
    const pollMs = Math.max(20, Math.min(250, Math.floor(settleMs / 4)));
    const giveUpAt = Date.now() + Math.max(30_000, settleMs * 10);
    let lastSize = -1;
    let stableSince = Date.now();
    const tick = () => {
      this.settleTimer = null;
      if (this.track !== track || Date.now() > giveUpAt) return;
      const size = fileSize(this._trackFile(track));
      if (size !== lastSize) {
        lastSize = size;
        stableSince = Date.now();
      } else if (size !== null && Date.now() - stableSince >= settleMs) {
        this._foreignTexts(track); // advances the offset only if nothing foreign is there
        return;
      }
      this.settleTimer = setTimeout(tick, pollMs);
      this.settleTimer.unref?.();
    };
    tick();
  }

  _announceReload(foreign, drive = this.drive, chat = this.chat) {
    this.say(CHANGED_LINE, 'notice');
    drive?.note('Chat changed elsewhere; reloaded.');
    drive?.event('bridge', { type: 'chat_changed_elsewhere', chat: chat ? { id: chat.id, title: chat.title } : null, foreign: foreign.map((t) => t.slice(0, 300)) });
    this.log(`chat changed elsewhere (${foreign.length} new message(s)); reloading`);
  }

  /** SPEC 10.8 steps 1-4: close, respawn with --resume, reload voice-on (spoken), then the pending message. */
  _reloadChat(pending, foreign) {
    this._announceReload(foreign);
    const old = this.claude;
    const next = this._createClaude({ resume: this.chat.id });
    this._deliver(
      voiceOnMessage({ notesPath: this.drive.notesPath, roots: this.config.roots, existing: true, folder: basename(this.cwd), reload: true, host: this._hostOn() }),
    );
    this._deliver(pending);
    this._safe(async () => {
      await old.stop({ graceful: true });
      if (this.claude === next && !this.shuttingDown) this._startProc(next);
    });
  }

  /** Stop treating the running process as current. Returns what is needed to retire it. */
  _detachClaude() {
    // Results the process still owes (a stopped or queued turn) come before the voice-off reply.
    const owed = (this.turnActive ? 1 : 0) + this.pendingSends;
    const detached = { proc: this.claude, chat: this.chat, track: this.track, owed };
    this.claude = null;
    this.chat = null;
    this.track = null;
    clearTimeout(this.settleTimer);
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.narrator.endTurn();
    this.pendingSends = 0;
    this.turnActive = false;
    this.stale = 0;
    this.silentResults = 0;
    return detached;
  }

  /**
   * SPEC 10.4 "Leaving a chat": send voice-off, wait for its result (at most voiceOffTimeoutMs,
   * never spoken), then close the process (stdin close, then the kill fallback).
   */
  async _retire({ proc, chat, track, owed = 0 }, { voiceOff = true, drive = this.drive } = {}) {
    if (!proc) return;
    let target = proc;
    if (voiceOff && chat && proc.alive && drive) {
      // SPEC 10.8: if the chat changed at a screen, voice-off goes to a fresh process (no voice-on).
      if (chat.id && track && !proc.fresh) {
        const foreign = this._foreignTexts(track);
        if (foreign.length) {
          this._announceReload(foreign, drive, chat);
          await proc.stop({ graceful: true });
          target = this._createClaude({ resume: chat.id, adopt: false, cwd: proc.cwd, drive });
          target.start();
        }
      }
      track?.sent.add(normalizeSent(voiceOffMessage({ notesPath: drive.notesPath })));
      const reply = await new Promise((resolve) => {
        let timer = null;
        const finish = (v) => {
          clearTimeout(timer);
          target.off('result', onResult);
          target.off('exit', onExit);
          resolve(v);
        };
        let skip = target === proc ? owed : 0;
        const onResult = (ev) => {
          if (skip > 0) {
            skip -= 1;
            return;
          }
          finish(typeof ev.result === 'string' ? ev.result : '');
        };
        const onExit = () => finish(null);
        target.on('result', onResult);
        target.on('exit', onExit);
        timer = setTimeout(() => finish(null), this.config.voiceOffTimeoutMs);
        timer.unref?.();
        target.sendUser(voiceOffMessage({ notesPath: drive.notesPath }));
      });
      drive.note(reply === null ? 'No reply to voice mode off; closed the chat anyway.' : `Voice mode off acknowledged: ${reply.trim() || '(empty)'}`);
      this.log(reply === null ? `no reply to voice mode off from ${chat.title}` : `voice mode off acknowledged by ${chat.title}`);
    }
    await target.stop({ graceful: true });
    if (target !== proc) await proc.stop({ graceful: true });
    if (chat?.id) this.leftChats.set(chat.id, Date.now());
  }

  /** Make sure a process runs for the active chat (or open a new chat if there is none). */
  ensureClaude() {
    if (this.claude) return;
    this.ensureDrive();
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.claudeDead) {
      this.claudeDead = false;
      this.crashTimes = [];
    }
    if (!this.chat) {
      this._startImplicitChat();
      return;
    }
    this._startProc(this._createClaude({ resume: this.chat.id ?? this.sessionId }));
  }

  /** SPEC 10.3: a task with no active chat starts a new chat in EARPIECE_START_DIR, then runs. */
  _startImplicitChat() {
    this.ensureDrive();
    this.cwd = this._startDir();
    this.sessionId = null;
    this.chat = { id: null, title: NEW_CHAT_TITLE, isNew: true };
    this.track = this._newTrack();
    this.lastTurnSummary = null;
    this.drive.note(`Opened chat: ${NEW_CHAT_TITLE} (new) in ${this.cwd}.`);
    this._startProc(this._createClaude({ resume: null }));
    // The greeting ("New chat in X. What should we work on?") is not spoken: the driver already said.
    this.silentResults = 1;
    this.sendToClaude(voiceOnMessage({ notesPath: this.drive.notesPath, roots: this.config.roots, existing: false, folder: basename(this.cwd), host: this._hostOn() }));
  }

  sendToClaude(text) {
    if (this.interrupting) {
      this.deferred.push(text);
      return;
    }
    this.ensureClaude();
    // SPEC 10.8: before writing into a chat this process loaded earlier, check it did not move on elsewhere.
    const proc = this.claude;
    if (proc.alive && !proc.fresh && this.chat?.id && this.track) {
      const foreign = this._foreignTexts(this.track);
      if (foreign.length) {
        this._reloadChat(text, foreign);
        return;
      }
    }
    this._deliver(text);
  }

  _deliver(text) {
    this.pendingSends += 1;
    this.limitAnnounced = false;
    this.narrator.startTurn();
    this.track?.sent.add(normalizeSent(text));
    this.claude.sendUser(text);
  }

  onSessionId(id) {
    this.sessionId = id;
    if (this.track && this.track.id !== id) {
      if (this.track.id) this.track.offset = 0; // the CLI forked the chat into a new file
      this.track.id = id;
      this.track.file = null;
    }
    if (!this.chat || this.chat.id === id) return;
    const was = this.chat.id;
    this.chat.id = id;
    this.drive?.note(was ? `Chat id changed from ${was} to ${id}.` : `New chat id: ${id}.`);
    this._pushState();
  }

  onClaudeExit(proc, { code, signal, error, expected }, drive = this.drive) {
    drive?.event('bridge', { type: 'claude_exit', pid: proc.pid, code, signal, error, expected });
    this.log(`claude exited (code ${code ?? '-'}, signal ${signal ?? '-'}${error ? `, ${error}` : ''})${expected ? '' : ' unexpectedly'}`);
    if (this.claude !== proc) return;
    this.claude = null;
    if (expected || this.shuttingDown) return;

    // SPEC 4.5
    const wasHolding = this.state === 'holding';
    this.narrator.endTurn();
    this.questions = this.questions.filter((q) => q.kind === 'local');
    this.followUps = [];
    this.pendingSends = 0;
    this.turnActive = false;
    this.stale = 0;
    this.silentResults = 0;
    // A chat that never got an id was never created; the next task starts a new one.
    if (this.chat && !this.chat.id) this.chat = null;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.config.crashWindowMs);
    this.crashTimes.push(now);
    this.drive?.note(`Claude Code exited unexpectedly (code ${code ?? '-'}, signal ${signal ?? '-'}${error ? `, ${error}` : ''}).`);
    if (this.crashTimes.length >= 3) {
      this.claudeDead = true;
      this._sayOrHost('Claude Code keeps crashing. Check the server.', 'error');
      if (!wasHolding && !this.questions.length) this.setState('idle');
      return;
    }
    this._sayOrHost('Claude Code stopped unexpectedly. Restarting.', 'error');
    if (!wasHolding && !this.questions.length) this.setState('idle');
    if (!this.chat) return; // restarted lazily with the next task
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.drive && this.chat && !this.claude && !this.shuttingDown) {
        this._startProc(this._createClaude({ resume: this.chat.id ?? this.sessionId }));
      }
    }, this.config.restartDelayMs);
    this.restartTimer.unref?.();
  }

  // ---------------------------------------------------------------- driver input

  onUtterance(raw) {
    const text = String(raw).replace(/\s+/g, ' ').trim();
    if (!text) return;
    this.ensureDrive();
    this.drive.driver(text);
    if (this._hostOn()) {
      // SPEC 13.3. A bridge-local question (the spoken chat list) is still answered here.
      if (this.questions[0]?.kind === 'local') {
        this.host.post('event', `The driver answered the bridge's question: "${text}".`);
        return this.answerQuestion(text);
      }
      this.host.driver(text);
      return undefined;
    }
    switch (this.state) {
      case 'idle':
        return this.startHold(text);
      case 'holding':
        this.pendingTask = `${this.pendingTask} ${text}`;
        this.say(`Added: ${stripEnd(text)}.`, 'ack');
        this._armHold();
        return;
      case 'working':
        this.followUps.push(text);
        this.say("Noted. I'll pass that on when this step finishes.", 'ack');
        return;
      case 'waiting_for_you':
        return this.answerQuestion(text);
      default:
        return undefined;
    }
  }

  startHold(text) {
    this.pendingTask = text;
    this.say(`Heard: ${stripEnd(text)}. Starting.`, 'ack');
    this.setState('holding');
    this._armHold();
  }

  _armHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this._safe(() => this.onHoldExpired()), this.config.holdMs);
  }

  onHoldExpired() {
    this.holdTimer = null;
    if (this.state !== 'holding' || !this.pendingTask) return;
    const task = this.pendingTask;
    this.pendingTask = null;
    this.currentTask = task;
    this.holdExpiredAt = Date.now();
    if (!this.chat && !this.claude) this.ensureClaude(); // opens a new chat in the start folder
    if (this.chat?.isNew && this.chat.title === NEW_CHAT_TITLE) this.chat.title = cutTitle(task);
    this.drive?.note(`Sent to Claude: ${task}`);
    this.setState('working', { force: true });
    this.sendToClaude(task);
    if (this.questions.length) this.askNext(); // a question arrived while we were holding
  }

  onControl(action, { force = false } = {}) {
    this.log(`control ${action}`);
    this.drive?.note(`Control: ${action}.`);
    if (this._hostOn()) {
      const host = this.host;
      if (action === 'status' || action === 'which_chat') {
        host.interruptTurn();
        host.post('event', action === 'status' ? 'The driver asked for a status update (phone command "status"). Use get_status and tell them.' : 'The driver asked which chat this is (phone command "which chat"). Use which_chat and tell them.', { trigger: true });
        return undefined;
      }
      if (action === 'stop' || action === 'end_drive') host.interruptTurn();
      host.post('event', `The driver used the phone command "${PHONE_COMMANDS[action] ?? action}"; the bridge handled it.`);
    }
    switch (action) {
      case 'cancel':
        return this.onCancel();
      case 'stop':
        return this.abortTurn('Stopped.');
      case 'status':
        this.say(this.statusLine(), 'notice');
        return undefined;
      case 'repeat':
        return this.onRepeat();
      case 'pause':
        this.paused = true;
        return undefined;
      case 'resume':
        this.paused = false;
        this.narrator.poke();
        return undefined;
      case 'end_drive':
        return this.onEndDrive({ force });
      case 'switch_chat':
        return this.onSwitchChatVoice();
      case 'new_chat':
        return this.onNewChat(null);
      case 'which_chat':
        return this.onWhichChat();
      default:
        return undefined;
    }
  }

  onCancel() {
    if (this.state === 'holding') {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
      this.pendingTask = null;
      this.say('Cancelled.', 'ack');
      this.setState('idle');
      return;
    }
    // Speech-to-text needs ~1 s to finish a turn, so "cancel" often lands just after the hold
    // expired. Treat that as cancelling the task that was just sent.
    if (this.state === 'working' && this.holdExpiredAt && Date.now() - this.holdExpiredAt <= this.config.cancelGraceMs) {
      this.abortTurn('Cancelled.');
      return;
    }
    this.say('Nothing to cancel.', 'notice');
  }

  abortTurn(line) {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.pendingTask = null;
    this.holdExpiredAt = 0;
    for (const q of this.questions) q.proc?.deny(q.requestId, 'The driver stopped the task.');
    this.questions = [];
    this.followUps = [];
    this.deferred = [];
    this.narrator.endTurn();
    const busy = this.turnActive || this.pendingSends > 0;
    if (line) this.say(line, 'ack');
    this.setState('idle');
    if (busy && this.claude) {
      this.stale = (this.turnActive ? 1 : 0) + this.pendingSends;
      this.stopMark = { results: 0, starts: 0 };
      this.silentResults = 0;
      this._interrupt();
    }
  }

  _interrupt() {
    const proc = this.claude;
    const job = (async () => {
      const ok = await proc.interrupt();
      if (this.claude !== proc || this.shuttingDown) return;
      if (ok) {
        // Normally the interrupted turn's result follows right away. If it never does, stop
        // waiting for it so the next task's result is not swallowed.
        const t = setTimeout(() => {
          if (this.claude !== proc || this.stale <= 0) return;
          const m = this.stopMark;
          // Only the interrupted turn itself may never report back; queued turns still will.
          if (this.turnActive && m && m.results === 0 && m.starts === 0) {
            this.turnActive = false;
            this.stale -= 1;
          }
          this.stale = Math.max(0, Math.min(this.stale, (this.turnActive ? 1 : 0) + this.pendingSends));
        }, this.config.staleGraceMs);
        t.unref?.();
        return;
      }
      // SPEC 4.4: no answer within the timeout -> kill and respawn with --resume, same cwd.
      this.log('interrupt timed out; restarting Claude Code');
      this.drive?.note('Interrupt timed out; restarted Claude Code.');
      const next = this._createClaude({ resume: this.chat?.id ?? this.sessionId ?? proc.sessionId });
      await proc.stop({ graceful: false });
      if (this.claude === next && !this.shuttingDown) this._startProc(next);
    })();
    this.interrupting = job;
    job
      .catch((err) => this.log(`interrupt failed: ${err?.message ?? err}`))
      .finally(() => {
        if (this.interrupting !== job) return;
        this.interrupting = null;
        const queued = this.deferred;
        this.deferred = [];
        for (const text of queued) this.sendToClaude(text);
      });
  }

  onRepeat() {
    const e = this.lastSpoken;
    if (!e) {
      this.say('Nothing to repeat yet.', 'notice');
      return;
    }
    this.drive?.note('Repeated the last line.');
    this._resend(e);
  }

  _busyForEnd() {
    return this.state === 'working' || this.switching || (this.state === 'waiting_for_you' && !this._onlyLocalQuestions());
  }

  /** SPEC 3.2 and 11.5: end the drive; while Claude works, refuse (busy) unless force is set. */
  onEndDrive({ force = false } = {}) {
    if (this._busyForEnd()) {
      if (!force) {
        this.say(STILL_WORKING_LINE, 'notice');
        this._send({ type: 'error', code: 'busy', message: STILL_WORKING_LINE });
        return;
      }
      this._safe(() => this._forceEndDrive());
      return;
    }
    this._endDrive();
  }

  /** "Stop and end": interrupt as for stop (3.2), then end normally. */
  async _forceEndDrive() {
    this.log('end drive with force: stopping Claude first');
    if (this.state !== 'idle' || this.turnActive || this.pendingSends) this.abortTurn('Stopped.');
    if (this.interrupting) await this.interrupting.catch(() => {});
    // A chat switch in progress is finished first; its voice-off cannot be cut short safely.
    const until = Date.now() + 70_000;
    while (this.switching && Date.now() < until) await sleep(100);
    if (this.state !== 'idle' && (this.turnActive || this.pendingSends)) this.abortTurn('Stopped.');
    this._endDrive();
  }

  _endDrive() {
    if (!this.drive) {
      this.say('No drive is open.', 'notice');
      // The phone waits for drive_ended before it stops audio; don't make it wait for nothing.
      this._send({ type: 'drive_ended', drive_id: null, chats: [] });
      return;
    }
    this.say('Drive saved. Summary is on the server.', 'notice');
    if (this.chat) this.say(deskLine(basename(this.cwd) || this.cwd), 'notice');
    this._safe(() => this.finalizeDrive('ended by the driver'));
  }

  /** SPEC 11.5: every chat used in the drive, in order of first use, with its resume command. */
  _sendDriveEnded(driveId, chatsUsed) {
    const seen = new Set();
    const chats = [];
    for (const c of chatsUsed) {
      if (!c.id || seen.has(c.id)) continue;
      seen.add(c.id);
      chats.push({ id: c.id, title: c.title, cwd: c.cwd, folder: basename(c.cwd) || c.cwd, resume_cmd: resumeCommand(c.cwd, c.id) });
    }
    const msg = { type: 'drive_ended', drive_id: driveId, chats };
    this.pendingDriveEnded = { msg, conn: this.conn, sentAt: Date.now(), undelivered: !this.conn };
    this.log(`drive_ended for ${driveId} (${chats.length} chat(s))${this.conn ? '' : '; the phone gets it on its next hello'}`);
    this._send(msg);
  }

  /** The socket a drive_ended went out on closed (or was replaced) soon after: it may not have arrived. */
  _driveEndedSocketLost(conn) {
    const p = this.pendingDriveEnded;
    if (p && p.conn === conn && Date.now() - p.sentAt < this.config.driveEndedConfirmMs) p.undelivered = true;
  }

  /** On hello: send a drive_ended the phone may have missed, once. */
  _replayDriveEnded() {
    const p = this.pendingDriveEnded;
    if (!p) return;
    this.pendingDriveEnded = null;
    if (p.undelivered) {
      this.log(`re-sending drive_ended for ${p.msg.drive_id}`);
      this._send(p.msg);
    }
  }

  statusLine() {
    const where = basename(this.cwd) || this.cwd;
    let line;
    switch (this.state) {
      case 'holding':
        line = `About to start: ${shortTask(this.pendingTask)}. Say cancel to drop it.`;
        break;
      case 'working': {
        const what = this.currentTask
          ? `Working on: ${shortTask(this.currentTask)}.`
          : 'Claude is working on something on its own.';
        const last = this.narrator.lastAction;
        line = last ? `${what} Last step: ${lowerFirst(stripEnd(last.line))}, ${ago(last.at)}.` : `${what} No steps yet.`;
        break;
      }
      case 'waiting_for_you':
        line = `Waiting for your answer: ${this.questions[0]?.entry?.text ?? 'Claude has a question.'}`;
        break;
      default: {
        const last = this.lastTurnSummary ? ` Last turn: ${stripEnd(cleanInline(this.lastTurnSummary))}.` : '';
        line = this.claudeDead
          ? `Idle in ${where}. Claude Code is not running; your next task will restart it.${last}`
          : `Idle in ${where}.${last} Ready for a task.`;
      }
    }
    const rl = this.rateLimit;
    if (rl && !isAllowedStatus(rl.status)) {
      const resetsMs = Number(rl.resetsAt) > 1e12 ? Number(rl.resetsAt) : Number(rl.resetsAt) * 1000;
      const t = resetTimeText(rl.resetsAt);
      if (t && resetsMs > Date.now()) line += ` Usage limit resets at ${t}.`;
    }
    return line;
  }

  // ---------------------------------------------------------------- chats (SPEC 10)

  _onlyLocalQuestions() {
    return this.questions.length > 0 && this.questions.every((q) => q.kind === 'local');
  }

  /** open_chat, new_chat and the voice switch are only allowed while idle (or answering our own question). */
  _canSwitch() {
    if (this.switching || this.shuttingDown) return false;
    return this.state === 'idle' || (this.state === 'waiting_for_you' && this._onlyLocalQuestions());
  }

  _dropLocalQuestions() {
    this.questions = this.questions.filter((q) => q.kind !== 'local');
  }

  async recentChats() {
    const items = await listChats({ root: this.config.claudeProjects, currentId: this.chat?.id ?? null, excludeDirs: [join(this.config.home, "drives")] });
    for (const c of items) {
      // Our own voice-off write is not "someone else using it".
      const left = this.leftChats.get(c.id);
      if (c.recently_active && left && c.mtimeMs <= left + 5000) c.recently_active = false;
    }
    return items;
  }

  async onListChats() {
    const items = await this.recentChats();
    this._send({ type: 'chats', items: items.map(publicChat) });
  }

  async onOpenChat(id) {
    if (!this._canSwitch()) return void this.say(BUSY_LINE, 'notice');
    const chat = await findChat({ root: this.config.claudeProjects, id, currentId: this.chat?.id ?? null });
    if (!this._canSwitch()) return void this.say(BUSY_LINE, 'notice');
    if (!chat) return void this.say("I couldn't find that chat.", 'notice');
    const left = this.leftChats.get(chat.id);
    if (chat.recently_active && left && chat.mtimeMs <= left + 5000) chat.recently_active = false;
    this._dropLocalQuestions();
    if (chat.id === this.chat?.id) {
      this.say(`You're already in ${spokenTitle(chat.title)}.`, 'notice');
      if (this.state === 'waiting_for_you') this.askNext();
      return;
    }
    this._openWithGuard(chat);
  }

  onNewChat(cwd) {
    if (!this._canSwitch()) return void this.say(BUSY_LINE, 'notice');
    this._dropLocalQuestions();
    this._safe(() => this.switchChat({ cwd: this._newChatDir(cwd) }));
  }

  /** SPEC 10.3: the given folder, else the current chat's folder, else EARPIECE_START_DIR. */
  _newChatDir(cwd) {
    if (typeof cwd === 'string' && cwd.trim()) {
      const c = resolvePath(expandHome(cwd.trim()));
      if (dirExists(c)) return c;
      this.log(`new_chat: ${c} is not a folder; using the default`);
    }
    return this.chat && dirExists(this.cwd) ? this.cwd : this._startDir();
  }

  onWhichChat() {
    if (!this.chat) return void this.say('No chat open yet.', 'notice');
    this.say(`You're in ${spokenTitle(this.chat.title)}, in ${basename(this.cwd) || this.cwd}.`, 'notice');
  }

  async onSwitchChatVoice() {
    if (!this._canSwitch()) return void this.say(BUSY_LINE, 'notice');
    const items = (await this.recentChats()).filter((c) => !c.current).slice(0, 3);
    if (!this._canSwitch()) return void this.say(BUSY_LINE, 'notice');
    this._dropLocalQuestions();
    if (!items.length) {
      this.say('No other recent chats. Say new chat to start one.', 'notice');
      if (this.state === 'waiting_for_you') this.askNext();
      return;
    }
    const parts = items.map((c, i) => `${SPOKEN_NUMBERS[i]}: ${spokenTitle(c.title)}, ${chatAgo(c.mtimeMs)}.`);
    this._askLocal({ subtype: 'chat_pick', items, text: `Recent chats. ${parts.join(' ')} Or say new chat.` });
  }

  _askLocal(q) {
    this.questions.unshift({ kind: 'local', entry: null, ...q });
    this.askNext();
  }

  /** SPEC 10.5 recently-active guard, then the switch. */
  _openWithGuard(chat) {
    if (chat.recently_active) {
      this._askLocal({
        subtype: 'confirm_open',
        chat,
        text: `This chat was active ${ago(chat.mtimeMs)} on this machine. Continue it anyway?`,
      });
      return;
    }
    this._safe(() => this.switchChat({ chat }));
  }

  _answerLocal(q, text) {
    this.questions.shift();
    this.drive?.answer(text);
    if (q.subtype === 'confirm_open') {
      if (classifyYesNo(text) === 'yes') {
        this._safe(() => this.switchChat({ chat: q.chat }));
        return;
      }
      this.say('Okay, not opening it.', 'ack');
      this.askNext();
      return;
    }
    // chat_pick
    const norm = normalize(text);
    if (NEW_CHAT_RE.test(norm)) {
      this._safe(() => this.switchChat({ cwd: this._newChatDir(null) }));
      return;
    }
    const stay = STAY_WORDS.some((w) => norm === w || (norm.startsWith(`${w} `) && norm.split(' ').length <= 4));
    if (stay) {
      this.say(this.chat ? `Staying in ${spokenTitle(this.chat.title)}.` : 'Okay, staying here.', 'ack');
      this.askNext();
      return;
    }
    const i = pickFromList(text, q.items.map((c) => c.title));
    if (i < 0) {
      this.questions.unshift(q);
      q.entry = this.say(`Sorry, I didn't catch which chat. ${q.text}`, 'question');
      return;
    }
    this._openWithGuard(q.items[i]);
  }

  /** Open an existing chat ({ chat }) or start a new one ({ cwd }). SPEC 10.4. */
  async switchChat(target) {
    if (this.switching) return;
    this.switching = true;
    try {
      this.ensureDrive();
      const isNew = !target.chat;
      this.questions = this.questions.filter((q) => q.kind !== 'local');
      if (!target.quiet) this.say(`Switching to ${isNew ? 'a new chat' : spokenTitle(target.chat.title)}.`, 'notice');
      this.currentTask = isNew ? 'starting a new chat' : `opening ${spokenTitle(target.chat.title)}`;
      this.setState('working');
      const detached = this._detachClaude();
      if (detached.chat) this.drive.note(`Leaving chat: ${detached.chat.title} (${detached.chat.id ?? 'new'}). Voice mode off.`);
      await this._retire(detached, { voiceOff: true, drive: this.drive });
      if (this.shuttingDown || !this.drive) return;

      this.cwd = isNew ? target.cwd : chatCwd(target.chat, this._startDir());
      this.sessionId = isNew ? null : target.chat.id;
      this.chat = isNew
        ? { id: null, title: NEW_CHAT_TITLE, isNew: true }
        : { id: target.chat.id, title: target.chat.title, isNew: false };
      this.track = isNew ? this._newTrack() : this._newTrack(target.chat.id, target.chat.path ?? null);
      this.lastTurnSummary = null;
      this.drive.note(`Opened chat: ${this.chat.title} (${this.chat.id ?? 'new'}) in ${this.cwd}.`);
      this.drive.event('bridge', { type: 'open_chat', chat: this._chatInfo(), cwd: this.cwd });
      this.log(`opened chat ${this.chat.title} (${this.chat.id ?? 'new'}) in ${this.cwd}`);
      this._startProc(this._createClaude({ resume: this.chat.id }));
      this.hostSwitchReply = this._hostOn();
      this.setState('working', { force: true }); // tells the phone the new chat and cwd
      this.sendToClaude(
        voiceOnMessage({ notesPath: this.drive.notesPath, roots: this.config.roots, existing: !isNew, folder: basename(this.cwd), host: this._hostOn() }),
      );
    } finally {
      this.switching = false;
    }
  }

  // ---------------------------------------------------------------- claude events

  onTurnStart() {
    if (this.stopMark) this.stopMark.starts += 1;
    this.limitAnnounced = false;
    if (this.pendingSends > 0) this.pendingSends -= 1;
    this.turnActive = true;
    if (this.stale > 0) return; // part of a turn the driver stopped
    this.narrator.startTurn();
    if (this.state === 'idle') {
      // No user message from us: Claude started a turn on its own (e.g. a background task finished).
      this.currentTask = null;
      this.taskStartedAt = Date.now();
      this.drive?.note('Claude started working on its own.');
      if (this._hostOn()) this.host.post('worker started', '(on its own, for example a background command finished)');
      this.setState('working');
    }
  }

  onToolUse({ name, input, parentToolUseId }) {
    this.drive?.tool(`${parentToolUseId ? '(helper) ' : ''}${name}`, toolDetail(input));
    if (this.stale > 0) return;
    const line = this.narrator.onToolUse(name, input);
    if (line) this._noteAction(line, false);
  }

  onTaskSummary(detail) {
    this.narrator.onTaskSummary(detail);
    const line = cleanInline(String(detail ?? ''));
    if (line) this._noteAction(line, true);
  }

  _noteAction(text, summary) {
    this.recentActions.push({ text, at: Date.now() });
    if (this.recentActions.length > 5) this.recentActions.shift();
    this.host?.workerProgress(text, { summary });
  }

  onRateLimit(info) {
    this.rateLimit = { ...info, receivedAt: Date.now() };
    if (isAllowedStatus(info.status)) return;
    this.announceLimit(info.resetsAt);
  }

  announceLimit(resetsAt) {
    if (this.limitAnnounced) return;
    this.limitAnnounced = true;
    const t = resetTimeText(resetsAt ?? this.rateLimit?.resetsAt);
    this._sayOrHost(t ? `You've hit your Claude usage limit. It resets at ${t}.` : "You've hit your Claude usage limit. Try again later.", 'error');
    this.followUps = [];
    this.narrator.endTurn();
    if (this.state === 'working' && !this.questions.length) this.setState('idle');
  }

  onResult(ev) {
    if (this.stopMark) this.stopMark.results += 1;
    this._scheduleSettle();
    if (this.turnActive) this.turnActive = false;
    else if (this.pendingSends > 0) this.pendingSends -= 1;
    const full = typeof ev.result === 'string' ? ev.result : '';
    this.drive?.final(full, ev);
    if (this.stale > 0) {
      this.stale -= 1;
      this.log('result of a stopped turn (not spoken)');
      return;
    }
    this.narrator.endTurn();
    // Claude's own pending requests belonged to the turn that just ended.
    this.questions = this.questions.filter((q) => q.kind === 'local');

    const limit = limitFromResult(ev);
    if (this.silentResults > 0 && !ev.is_error && !limit) {
      this.silentResults -= 1;
      this.log('greeting of the new chat (not spoken)');
      this._afterTurn();
      return;
    }
    let limited = false;
    let switchPath = null;
    if (limit || (ev.is_error && this.limitAnnounced)) {
      this.announceLimit(limit?.resetsAt);
      limited = true;
    } else if (ev.is_error) {
      this._sayOrHost(`Claude hit an error: ${errorReason(ev)}.`, 'error');
    } else if (this._hostOn()) {
      switchPath = this._finishedToHost(full);
    } else {
      const spoken = cleanForSpeech(full);
      switchPath = spoken.switchPath;
      if (spoken.text) this.say(spoken.text, 'reply');
      else if (!switchPath) this.say('Done.', 'reply');
    }

    if (switchPath) {
      const dir = this.resolveDir(switchPath);
      if (dir) {
        this._safe(() => this.switchFolder(dir));
        return;
      }
      if (this._hostOn()) this.host.post('event', `Claude Code asked to switch to the folder ${basename(switchPath) || switchPath}, but it does not exist.`);
      else this.say(`I couldn't find the folder ${basename(switchPath) || switchPath}.`, 'notice');
    }
    this._afterTurn({ limited });
  }

  _afterTurn({ limited = false } = {}) {
    if (this.state === 'holding') return; // the driver is already dictating the next task
    if (this.questions.length) {
      if (this.state !== 'waiting_for_you') this.askNext();
      return;
    }
    if (limited) {
      this.followUps = [];
      this.setState('idle');
      return;
    }
    if (this.turnActive || this.pendingSends > 0) {
      this.setState('working');
      return;
    }
    if (this.followUps.length) {
      const text = this.followUps.join(' ');
      this.followUps = [];
      this.currentTask = text;
      if (this.chat?.isNew && this.chat.title === NEW_CHAT_TITLE) {
        this.chat.title = cutTitle(text);
        this._pushState();
      }
      this.drive?.note(`Passed on to Claude: ${text}`);
      this.taskStartedAt = Date.now();
      if (this._hostOn()) this.host.post('worker started', text);
      this.setState('working');
      this.sendToClaude(text);
      return;
    }
    this.setState('idle');
  }

  resolveDir(p) {
    const tries = [p, p.replace(/\.$/, '')];
    for (let c of tries) {
      c = expandHome(c);
      if (!isAbsolute(c)) c = resolvePath(this.cwd, c);
      try {
        if (statSync(c).isDirectory()) return c;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** SPEC 10.6: EARPIECE_SWITCH keeps the chat; restart with --resume <chat id> in the new cwd. */
  async switchFolder(dir) {
    const name = basename(dir) || dir;
    const hostOn = this._hostOn();
    if (hostOn) this.host.post('event', `Claude Code is switching to the folder ${name} (same chat).`);
    else this.say(`Switching to ${name}.`, 'notice');
    const old = this.claude;
    const chatId = this.chat?.id ?? this.sessionId;
    this.cwd = dir;
    this.drive?.note(`Switched folder to ${dir} (same chat).`);
    this.drive?.event('bridge', { type: 'switch_folder', cwd: dir, chat: this._chatInfo() });
    const next = this._createClaude({ resume: chatId });
    if (hostOn) this.silentResults += 1; // "Ready in <folder>." adds nothing for the host
    this.currentTask = `getting ready in ${name}`;
    this.setState('working', { force: true }); // also tells the phone the new cwd
    this.sendToClaude(folderSwitchMessage({ path: dir, folder: name }));
    if (old) await old.stop({ graceful: true });
    if (this.claude === next && !this.shuttingDown) this._startProc(next);
  }

  onCanUseTool(req) {
    const label = req.toolName === 'AskUserQuestion' ? 'question' : `permission for ${req.toolName}`;
    this.drive?.note(`Claude asks: ${label}.`);
    if (req.proc !== this.claude || this.stale > 0) {
      req.proc.deny(req.requestId, 'The driver stopped the task.');
      return;
    }
    const isAsk = req.toolName === 'AskUserQuestion';
    let list = null;
    if (isAsk) {
      list = Array.isArray(req.input?.questions)
        ? req.input.questions.filter((q) => q && typeof q.question === 'string' && q.question.trim())
        : [];
      if (!list.length) {
        req.proc.deny(req.requestId, 'Earpiece could not read the question. Ask again with the AskUserQuestion format.');
        return;
      }
    }
    this.questions.push({ ...req, kind: isAsk ? 'ask' : 'permission', list, index: 0, answers: {}, entry: null });
    if (this.questions.length === 1 && this.state !== 'holding') this.askNext();
  }

  askNext() {
    const q = this.questions[0];
    if (!q) {
      if (this.state === 'waiting_for_you') this.setState(this.turnActive || this.pendingSends ? 'working' : 'idle');
      return;
    }
    if (q.kind !== 'local' && this._hostOn()) {
      if (!q.hostPosted) {
        q.hostPosted = true;
        this.host.post('worker question', this._hostQuestionText(q), { trigger: true });
      }
      this.narrator.clearPending();
      this.setState('waiting_for_you');
      return;
    }
    let text;
    if (q.kind === 'local') text = q.text;
    else if (q.kind === 'ask') text = formatQuestion(q.list[q.index]);
    else text = `Claude wants to ${permissionSummary(q.toolName, q.input, q.displayName)}. Allow?`;
    this.narrator.clearPending();
    q.entry = this.say(text, 'question');
    this.setState('waiting_for_you');
  }

  answerQuestion(text) {
    const q = this.questions[0];
    if (!q) {
      this.setState(this.turnActive || this.pendingSends ? 'working' : 'idle');
      this.onUtterance(text);
      return;
    }
    if (q.kind === 'local') {
      this._answerLocal(q, text);
      return;
    }
    if (q.kind === 'ask') {
      const item = q.list[q.index];
      const m = matchAnswer(text, item.options ?? [], !!item.multiSelect);
      q.answers[item.question] = m.answer;
      this.drive?.answer(`${item.question} -> ${m.answer}${m.free ? ' (free text)' : ''}`);
      this.say(`Got it: ${m.free ? 'your answer' : stripEnd(m.answer)}.`, 'ack');
      q.index += 1;
      if (q.index < q.list.length) {
        this.askNext();
        return;
      }
      q.proc.allow(q.requestId, { ...q.input, answers: q.answers });
    } else {
      const verdict = classifyYesNo(text);
      this.drive?.answer(`${text} (${verdict})`);
      if (verdict === 'yes') {
        q.proc.allow(q.requestId, q.input);
        this.say('Allowed.', 'ack');
      } else if (verdict === 'no') {
        q.proc.deny(q.requestId, 'The driver said no.');
        this.say('Denied.', 'ack');
      } else {
        q.proc.deny(q.requestId, `The driver replied: ${text}`);
        this.say('Passed your reply to Claude.', 'ack');
      }
    }
    this.questions.shift();
    if (this.questions.length) {
      this.askNext();
      return;
    }
    this.setState('working');
  }

  onCancelRequest(requestId) {
    const i = this.questions.findIndex((q) => q.requestId === requestId);
    if (i < 0) return;
    this.questions.splice(i, 1);
    this.drive?.note('Claude withdrew a pending question.');
    if (i === 0) {
      this.say('Claude withdrew the question.', 'notice');
      if (this.questions.length) this.askNext();
      else if (this.state === 'waiting_for_you') this.setState('working');
    }
  }

  // ---------------------------------------------------------------- voice host (SPEC 13)

  /** Start the MCP server for the host's tools (once per bridge run, 127.0.0.1, random port and secret). */
  async startMcp() {
    if (!this.config.voiceHost || this.mcp) return;
    const handlers = this._toolHandlers();
    const tools = TOOL_SPECS.map((t) => ({
      ...t,
      handler: async (args) => {
        this.drive?.event('bridge', { type: 'host_tool', name: t.name, args });
        this.log(`host tool ${t.name} ${JSON.stringify(args).slice(0, 200)}`);
        if (!this._hostOn() || this.host.muted) return { ok: false, message: 'The voice assistant is not active.' };
        const out = await handlers[t.name](args ?? {});
        this.drive?.event('bridge', { type: 'host_tool_result', name: t.name, result: out });
        return out;
      },
    }));
    const mcp = new McpServer({ tools, log: (m) => this.log(m) });
    try {
      await mcp.start();
      this.mcp = mcp;
      this.log(`voice host tools on 127.0.0.1:${mcp.port}`);
    } catch (err) {
      this.mcpError = err.message;
      this.log(`voice host tools could not start: ${err.message}`);
    }
  }

  /** The host owns the conversation: on in config, started for this drive, not fallen back. */
  _hostOn() {
    return !!(this.config.voiceHost && this.host && this.host.up && !this.hostFailed);
  }

  _startHost() {
    if (!this.config.voiceHost || this.shuttingDown) return;
    const drive = this.drive;
    if (!this.mcp) {
      this._hostUnavailable({ reason: `tool server not running${this.mcpError ? ` (${this.mcpError})` : ''}` });
      return;
    }
    const cwd = join(this.config.home, 'host');
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      /* the spawn fails and we fall back */
    }
    const c = this.config;
    const host = new Host({
      bin: c.claudeBin,
      cwd,
      model: c.hostModel,
      systemPrompt: HOST_SYSTEM_PROMPT,
      mcpConfig: this.mcp.mcpConfig(),
      progressMs: c.hostProgressMs,
      crashWindowMs: c.crashWindowMs,
      interruptTimeoutMs: c.interruptTimeoutMs,
      staleGraceMs: c.staleGraceMs,
      killGraceMs: c.killGraceMs,
      closeWaitMs: c.closeWaitMs,
      initTimeoutMs: c.initTimeoutMs,
      limitOf: (ev) => limitFromResult(ev),
      canProgress: () => !this.paused && this.state === 'working',
    });
    this.host = host;
    const on = (name, fn) => host.on(name, (arg) => this._safe(() => this.host === host && fn(arg)));
    on('say', (s) => this.say(s, 'reply'));
    on('turn_end', (t) => {
      // `repeat` re-sends the whole last host reply, not only its last sentence.
      if (t.spoken.length > 1 && !t.dropped) this.lastSpoken = { seq: 0, text: t.spoken.join(' '), kind: 'reply', ts: Date.now() };
      drive?.event('bridge', { type: 'host_turn_end', spoken: t.spoken.length, silent: t.silent, dropped: t.dropped });
    });
    on('ready', ({ ms }) => drive?.note(`Voice assistant ready in ${ms} ms.`));
    on('unavailable', (info) => this._hostUnavailable(info));
    on('proc_event', (ev) => drive?.event('host', ev));
    on('proc_stdin', (obj) => drive?.event('to_host', obj));
    host.on('log', (m) => this.log(m));
    host.start();
    // Context for the first turn: where the worker is (the host's own cwd is a scratch folder).
    host.post('event', `Drive started. Claude Code works in the folder ${basename(this.cwd) || this.cwd} (${this.cwd}). ${this.chat ? `Open chat: "${this.chat.title}".` : 'No chat is open yet; start_task opens one there.'}`);
  }

  _stopHost() {
    const h = this.host;
    this.host = null;
    this.hostSwitchReply = false;
    if (h) h.stop().catch(() => {});
  }

  /** SPEC 13.7: say so once and use the v2 behaviour for the rest of the drive. */
  _hostUnavailable({ reason = 'unknown', resetsAt = null, pending = [] } = {}) {
    if (this.hostFailed) return;
    this.hostFailed = true;
    this._stopHost();
    this.log(`voice assistant unavailable (${reason}); basic mode for this drive`);
    this.drive?.note(`Voice assistant unavailable (${reason}). Basic mode.`);
    if (reason === 'limit') {
      const t = resetTimeText(resetsAt ?? this.rateLimit?.resetsAt);
      this.say(t ? `You've hit your Claude usage limit. It resets at ${t}.` : "You've hit your Claude usage limit. Try again later.", 'error');
    }
    this.say(HOST_DOWN_LINE, 'notice');
    // Never leave the driver without a path: speak what the host still owed them, v2 style.
    const finished = pending.filter((i) => i.tag === 'worker finished' && i.raw !== undefined).pop();
    if (finished) {
      const spoken = cleanForSpeech(finished.raw);
      this.say(spoken.text || 'Done.', 'reply');
    }
    const q = this.questions[0];
    if (q && q.kind !== 'local') this.askNext();
    else if (this.state === 'working') this.narrator.poke();
    // What the driver said that the host never answered goes through the v2 path (read-back, hold).
    const unanswered = pending.filter((i) => i.tag === 'driver' && i.text).map((i) => i.text);
    if (unanswered.length && this.drive) this.onUtterance(unanswered.join(' '));
  }

  /** Bridge lines that the host says in its own words when it is up (worker errors and limits). */
  _sayOrHost(text, kind) {
    if (this._hostOn()) {
      this.host.post('worker error', text, { trigger: true });
      return;
    }
    this.say(text, kind);
  }

  /** A worker result for the host: [worker finished] with the whole text, or a chat-switch recap. */
  _finishedToHost(full) {
    const { path, text } = extractSwitch(full);
    const body = text.trim();
    if (this.hostSwitchReply) {
      this.hostSwitchReply = false;
      const where = basename(this.cwd) || this.cwd;
      this.host.post('event', `Chat switched to "${this.chat?.title ?? 'a chat'}" in ${where}. Claude Code says: ${body || '(nothing)'}`, { trigger: true });
    } else {
      const item = this.host.post('worker finished', body || '(no text)', { trigger: true });
      if (item) item.raw = full;
    }
    return path;
  }

  _hostQuestionText(q) {
    if (q.kind === 'ask') {
      const item = q.list[q.index];
      const opts = (item.options ?? []).map((o) => (o.description ? `${o.label} (${o.description})` : o.label));
      const count = q.list.length > 1 ? ` (question ${q.index + 1} of ${q.list.length})` : '';
      return `${item.question}${count} Options: ${opts.join('; ') || 'none, free text'}.${item.multiSelect ? ' More than one can be picked.' : ''}`;
    }
    return `Claude Code asks permission to ${permissionSummary(q.toolName, q.input, q.displayName)}. Answer yes or no.`;
  }

  _workerBusy() {
    return this.switching || this.turnActive || this.pendingSends > 0 || this.questions.some((q) => q.kind !== 'local');
  }

  _toolHandlers() {
    return {
      start_task: ({ instruction }) => {
        const task = String(instruction ?? '').replace(/\s+/g, ' ').trim();
        if (!task) return { ok: false, message: 'The instruction is empty.' };
        this.ensureDrive();
        this.drive.note(`Voice assistant task: ${task}`);
        if (this._workerBusy()) {
          this.followUps.push(task);
          return { ok: true, queued: true, message: 'Claude Code is busy; this is queued as a follow-up.' };
        }
        this._dropLocalQuestions();
        this.currentTask = task;
        this.taskStartedAt = Date.now();
        this.recentActions = [];
        if (!this.chat && !this.claude) this.ensureClaude(); // opens a new chat in the start folder
        if (this.chat?.isNew && this.chat.title === NEW_CHAT_TITLE) this.chat.title = cutTitle(task);
        this.drive.note(`Sent to Claude: ${task}`);
        this.setState('working', { force: true });
        this.sendToClaude(task);
        this.host?.post('worker started', task);
        return { ok: true, started: true, chat: this.chat?.title ?? null, folder: basename(this.cwd) };
      },
      get_status: () => {
        const q = this.questions.find((x) => x.kind !== 'local');
        const now = Date.now();
        return {
          state: this.state,
          task: this.currentTask,
          elapsed_seconds: this.taskStartedAt && this.state !== 'idle' ? Math.round((now - this.taskStartedAt) / 1000) : null,
          last_actions: this.recentActions.map((a) => `${a.text} (${Math.round((now - a.at) / 1000)} s ago)`),
          pending_question: q ? this._hostQuestionText(q) : null,
          queued_follow_ups: this.followUps.length,
          last_turn_summary: this.lastTurnSummary,
          chat: this.chat?.title ?? null,
          folder: basename(this.cwd) || this.cwd,
        };
      },
      answer_question: ({ answer }) => this._hostAnswer(answer),
      stop_task: () => {
        const busy = this.state !== 'idle' || this.turnActive || this.pendingSends > 0;
        this.abortTurn(null);
        return { ok: true, message: busy ? 'Stopped Claude Code.' : 'Claude Code was not working.' };
      },
      end_drive: ({ force }) => {
        if (!this.drive) return { ok: false, message: 'No drive is open.' };
        const busy = this._busyForEnd();
        if (busy && force !== true) {
          return { ok: false, busy: true, message: 'Claude Code is still working. Ask the driver whether to stop it and end the drive; if yes, call end_drive with force true.' };
        }
        this.host.mute();
        // After the tool result is on its way: the drive ends and the host process stops.
        setTimeout(() => this._safe(() => (busy ? this._forceEndDrive() : this._endDrive())), 0);
        return { ok: true, message: 'The drive is ending and the bridge says goodbye. Reply [silent].' };
      },
      list_chats: async () => {
        const items = (await this.recentChats()).slice(0, 5);
        return { chats: items.map((c) => ({ id: c.id, title: c.title, folder: c.folder ?? basename(c.cwd), last_used: chatAgo(c.mtimeMs), current: !!c.current })) };
      },
      switch_chat: async ({ id, title, confirm }) => {
        if (!this._canSwitch()) return { ok: false, message: BUSY_LINE };
        let chat = null;
        if (typeof id === 'string' && id.trim()) {
          if (!isChatId(id.trim())) return { ok: false, message: 'That is not a chat id.' };
          chat = await findChat({ root: this.config.claudeProjects, id: id.trim(), currentId: this.chat?.id ?? null });
        } else if (typeof title === 'string' && title.trim()) {
          const items = await this.recentChats();
          const ranked = rankChats(title, items);
          const brief = (c) => ({ id: c.id, title: c.title, folder: c.folder ?? basename(c.cwd), last_used: chatAgo(c.mtimeMs) });
          if (!ranked.length) return { ok: false, message: 'No recent chat matches that title.', recent: items.slice(0, 5).map(brief) };
          const top = ranked.filter((r) => r.score === ranked[0].score);
          if (top.length > 1) return { ok: false, ambiguous: true, message: 'Several chats match. Ask the driver which one.', candidates: top.slice(0, 5).map((r) => brief(r.chat)) };
          chat = ranked[0].chat;
        } else {
          return { ok: false, message: 'Pass a chat id or a title.' };
        }
        if (!chat) return { ok: false, message: "I couldn't find that chat." };
        if (!this._canSwitch()) return { ok: false, message: BUSY_LINE };
        if (chat.id === this.chat?.id) return { ok: true, message: `Already in ${chat.title}.` };
        const left = this.leftChats.get(chat.id);
        if (chat.recently_active && left && chat.mtimeMs <= left + 5000) chat.recently_active = false;
        if (chat.recently_active && confirm !== true) {
          return { ok: false, needs_confirmation: true, message: `This chat was active ${ago(chat.mtimeMs)} on this machine. Ask the driver; call switch_chat again with confirm true to open it anyway.` };
        }
        this._dropLocalQuestions();
        this._safe(() => this.switchChat({ chat, quiet: true }));
        return { ok: true, message: `Opening "${chat.title}". Its recap follows as an [event].` };
      },
      new_chat: ({ folder }) => {
        if (!this._canSwitch()) return { ok: false, message: BUSY_LINE };
        const cwd = this._newChatDir(typeof folder === 'string' ? folder : null);
        this._dropLocalQuestions();
        this._safe(() => this.switchChat({ cwd, quiet: true }));
        return { ok: true, folder: basename(cwd) || cwd, message: 'Opening a new chat.' };
      },
      which_chat: () =>
        this.chat
          ? { chat: this.chat.title, folder: basename(this.cwd) || this.cwd, id: this.chat.id }
          : { chat: null, message: 'No chat open yet.', folder: basename(this.cwd) || this.cwd },
    };
  }

  /** answer_question (13.2): option labels (mapped, else free text), or yes / no for a permission. */
  _hostAnswer(answer) {
    const q = this.questions.find((x) => x.kind !== 'local');
    if (!q) return { ok: false, message: 'Claude Code has no pending question.' };
    const parts = (Array.isArray(answer) ? answer : [answer]).map((a) => String(a ?? '').trim()).filter(Boolean);
    if (!parts.length) return { ok: false, message: 'The answer is empty.' };
    let answered;
    if (q.kind === 'ask') {
      const item = q.list[q.index];
      const m = mapLabels(parts, item.options ?? [], !!item.multiSelect);
      q.answers[item.question] = m.answer;
      answered = m.answer;
      this.drive?.answer(`${item.question} -> ${m.answer}${m.free ? ' (free text)' : ''}`);
      q.index += 1;
      if (q.index < q.list.length) return { ok: true, answered, next_question: this._hostQuestionText(q) };
      q.proc.allow(q.requestId, { ...q.input, answers: q.answers });
    } else {
      const text = parts.join(' ');
      const word = text.toLowerCase().replace(/[.!]+$/, '');
      this.drive?.answer(text);
      if (['yes', 'y', 'allow', 'approve'].includes(word)) {
        q.proc.allow(q.requestId, q.input);
        answered = 'allowed';
      } else if (['no', 'n', 'deny'].includes(word)) {
        q.proc.deny(q.requestId, 'The driver said no.');
        answered = 'denied';
      } else {
        q.proc.deny(q.requestId, `The driver replied: ${text}`);
        answered = 'denied, with the driver\'s reply passed on';
      }
    }
    this.questions.splice(this.questions.indexOf(q), 1);
    const next = this.questions.find((x) => x.kind !== 'local');
    if (next) {
      next.hostPosted = true;
      return { ok: true, answered, next_question: this._hostQuestionText(next) };
    }
    this.setState('working');
    return { ok: true, answered };
  }

  // ---------------------------------------------------------------- shutdown

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.idleCheck);
    clearTimeout(this.holdTimer);
    clearTimeout(this.restartTimer);
    this.narrator.endTurn();
    this.abort.abort();
    this._stopHost();
    this.mcp?.close();
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      c.close(1001, 'bridge shutting down');
      setTimeout(() => c.terminate(), 300).unref?.();
    }
    const idle = this.state === 'idle' && !this.turnActive && !this.pendingSends && !this.switching;
    const detached = this._detachClaude();
    if (detached.proc) {
      if (idle && detached.chat && this.drive) {
        // SPEC 10.4: voice-off on a graceful shutdown while Claude is idle.
        this.log('sending voice mode off before exiting (press Ctrl-C again to quit now)');
        this.drive.note(`Leaving chat: ${detached.chat.title} (${detached.chat.id ?? 'new'}). Voice mode off.`);
        await this._retire(detached, { voiceOff: true, drive: this.drive });
      } else {
        await detached.proc.stop({ graceful: false });
      }
    }
    if (this.drive) {
      this.drive.note('Bridge shut down.');
      this.drive.close('bridge shut down');
    }
    await Promise.allSettled([...this.summaries]);
  }
}
