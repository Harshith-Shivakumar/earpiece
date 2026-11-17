// Progress lines built from Claude's tool_use blocks (SPEC 3.3), with throttling.
// A non-null `task_summary.detail` from the CLI is preferred over the tool templates when one
// arrived since the last progress line.

import { basename } from 'node:path';
import { asSentence, cleanInline, stripEnd } from './speech.js';

function base(p) {
  return typeof p === 'string' && p ? basename(p) || p : null;
}

function humanize(name) {
  return String(name ?? 'a tool').replace(/^mcp__/, '').replace(/_+/g, ' ').trim();
}

/** Fixed template for one tool_use. Returns null for tools that are not narrated. */
export function describeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Read':
      return `Reading ${base(i.file_path) ?? 'a file'}.`;
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${base(i.file_path ?? i.notebook_path) ?? 'a file'}.`;
    case 'Grep':
    case 'Glob':
      return 'Searching the code.';
    case 'Bash': {
      const d = typeof i.description === 'string' ? cleanInline(i.description) : '';
      return d ? asSentence(stripEnd(d)) : 'Running a command.';
    }
    case 'WebSearch':
      return i.query ? `Searching the web for ${stripEnd(cleanInline(String(i.query)))}.` : 'Searching the web.';
    case 'WebFetch':
      return 'Reading a web page.';
    case 'Task':
    case 'Agent':
      return i.description
        ? `Started a helper agent: ${stripEnd(cleanInline(String(i.description)))}.`
        : 'Started a helper agent.';
    case 'TodoWrite':
    case 'AskUserQuestion': // the question itself is spoken; "Using AskUserQuestion" would be noise
      return null;
    default:
      return `Using ${humanize(name)}.`;
  }
}

export class Narrator {
  /**
   * @param {object} o
   * @param {number} o.delayMs     quiet period at the start of each turn (6 s)
   * @param {number} o.intervalMs  minimum gap between progress lines (35 s)
   * @param {(text:string)=>void} o.emit
   * @param {()=>boolean} o.canSpeak  false while paused, holding or waiting_for_you
   */
  constructor({ delayMs = 6000, intervalMs = 35_000, emit = () => {}, canSpeak = () => true, now = () => Date.now() } = {}) {
    this.delayMs = delayMs;
    this.intervalMs = intervalMs;
    this.emit = emit;
    this.canSpeak = canSpeak;
    this.now = now;
    this.active = false;
    this.timer = null;
    this.lastAction = null; // { line, at } for the status control
    this._reset();
  }

  _reset() {
    this.turnStart = this.now();
    this.steps = 0;
    this.sinceLast = 0;
    this.latest = null;
    this.summary = null; // task_summary detail that arrived since the last line
    this.lastEmit = null;
  }

  startTurn() {
    this.endTurn();
    this._reset();
    this.lastAction = null;
    this.active = true;
  }

  endTurn() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  onToolUse(name, input) {
    const line = describeTool(name, input);
    if (!line) return null;
    this.lastAction = { line, at: this.now() };
    if (!this.active) return line;
    this.steps += 1;
    this.sinceLast += 1;
    this.latest = line;
    this._schedule();
    return line;
  }

  onTaskSummary(detail) {
    if (typeof detail !== 'string' || !detail.trim()) return;
    const line = asSentence(stripEnd(cleanInline(detail)));
    if (!line) return;
    this.lastAction = { line, at: this.now() };
    if (!this.active) return;
    this.summary = line;
    this._schedule();
  }

  /** Drop actions not yet narrated (e.g. when Claude asks a question, they are old news after the answer). */
  clearPending() {
    clearTimeout(this.timer);
    this.timer = null;
    this.sinceLast = 0;
    this.summary = null;
  }

  /** Re-check after something that blocked speaking (pause, question) is over. */
  poke() {
    this._schedule();
  }

  _due() {
    return this.active && (this.sinceLast > 0 || this.summary !== null);
  }

  _schedule() {
    if (!this._due() || this.timer) return;
    const earliest = Math.max(
      this.turnStart + this.delayMs,
      this.lastEmit === null ? -Infinity : this.lastEmit + this.intervalMs,
    );
    const wait = earliest - this.now();
    if (wait <= 0) {
      this._flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flush();
    }, wait);
    this.timer.unref?.();
  }

  _flush() {
    if (!this._due()) return;
    if (!this.canSpeak()) return; // keep what we have; the next action or poke() reschedules
    const body = this.summary ?? this.latest;
    const prefix = this.sinceLast > 1 ? `${this.steps} steps so far. ` : '';
    this.lastEmit = this.now();
    this.sinceLast = 0;
    this.summary = null;
    this.emit(prefix + body);
  }
}
