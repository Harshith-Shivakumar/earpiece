// Drive folders and files (SPEC section 6): transcript.md, events.jsonl, notes.md, summary.md.
// Writes are synchronous appends: low volume, and nothing is lost if the process is killed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pad = (n) => String(n).padStart(2, '0');

export function driveStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function clock(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function singleLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return max && s.length > max ? `${s.slice(0, max)}…` : s;
}

export class Drive {
  constructor({ home, cwd, now = new Date(), onError = () => {} }) {
    const root = join(home, 'drives');
    mkdirSync(root, { recursive: true });
    let id = driveStamp(now);
    let dir = join(root, id);
    for (let n = 2; existsSync(dir); n++) {
      id = `${driveStamp(now)}-${n}`;
      dir = join(root, id);
    }
    mkdirSync(dir);
    this.id = id;
    this.dir = dir;
    this.transcriptPath = join(dir, 'transcript.md');
    this.eventsPath = join(dir, 'events.jsonl');
    this.notesPath = join(dir, 'notes.md');
    this.summaryPath = join(dir, 'summary.md');
    this.onError = onError;
    this.closed = false;
    this.writeFailed = false;
    writeFileSync(this.transcriptPath, `# Earpiece drive ${id}\n\nStarted ${now.toString()} in \`${cwd}\`.\n\n`);
    writeFileSync(this.eventsPath, '');
    writeFileSync(this.notesPath, `# Notes for drive ${id}\n\n`);
  }

  _append(path, text) {
    try {
      appendFileSync(path, text);
    } catch (err) {
      if (!this.writeFailed) this.onError(`cannot write ${path}: ${err.message}`);
      this.writeFailed = true;
    }
  }

  /** One raw event per line. source: phone | claude | to_claude | bridge | claude_stderr | claude_unparsed */
  event(source, data) {
    this._append(this.eventsPath, `${JSON.stringify({ ts: new Date().toISOString(), source, data })}\n`);
  }

  _line(text) {
    if (this.closed) return;
    this._append(this.transcriptPath, `- ${clock()} ${text}\n`);
  }

  driver(text) {
    this._line(`**Driver:** ${singleLine(text)}`);
  }

  spoken(kind, text) {
    this._line(`**Earpiece** (${kind}): ${singleLine(text)}`);
  }

  tool(name, detail) {
    this._line(`Tool: ${name}${detail ? ` ${singleLine(detail, 200)}` : ''}`);
  }

  toolResult(text) {
    this._line(`Result: ${singleLine(text, 500)}`);
  }

  claudeText(text) {
    this._line(`Claude: ${singleLine(text, 300)}`);
  }

  answer(text) {
    this._line(`**Answer:** ${singleLine(text)}`);
  }

  note(text) {
    this._line(`_${singleLine(text)}_`);
  }

  /** Claude's full, uncleaned final text for a turn. */
  final(text, meta = {}) {
    if (this.closed) return;
    const bits = [];
    if (meta.subtype && meta.subtype !== 'success') bits.push(meta.subtype);
    if (typeof meta.total_cost_usd === 'number') bits.push(`$${meta.total_cost_usd.toFixed(4)}`);
    if (typeof meta.duration_ms === 'number') bits.push(`${(meta.duration_ms / 1000).toFixed(1)} s`);
    const body = String(text ?? '').trim() || '(no text)';
    this._append(
      this.transcriptPath,
      `\n**${clock()} Claude, final reply**${bits.length ? ` (${bits.join(', ')})` : ''}:\n\n${body}\n\n`,
    );
  }

  close(reason) {
    if (this.closed) return;
    this._append(this.transcriptPath, `\nEnded ${new Date().toString()}${reason ? ` (${reason})` : ''}.\n`);
    this.closed = true;
  }

  readTranscript() {
    return readFileSync(this.transcriptPath, 'utf8');
  }

  /**
   * runner(transcriptText, cwd) -> Promise<string>. Failures are written into summary.md.
   * `preamble` (the bridge's own "Continue at your desk" section) always comes first.
   */
  async writeSummary(runner, { preamble = '' } = {}) {
    let content;
    try {
      const out = await runner(this.readTranscript(), this.dir);
      content = String(out ?? '').trim() || '(The summarizer returned nothing.)';
    } catch (err) {
      content = `# Summary failed\n\n${err?.message ?? err}`;
    }
    if (preamble) content = `${preamble.trimEnd()}\n\n${content}`;
    try {
      writeFileSync(this.summaryPath, `${content}\n`);
    } catch (err) {
      this.onError(`cannot write ${this.summaryPath}: ${err.message}`);
    }
  }
}
