// Claude Code chats on this machine (SPEC 10.2). The JSONL format is undocumented, so everything
// that reads it lives here and fails soft: unreadable files and bad lines are skipped.
//
// Layout: <projects root>/<project-dir>/<session-id>.jsonl (top level only; sub-folders such as
// <id>/subagents/ are ignored). Entries used:
//   {"type":"custom-title","customTitle":"..."}
//   {"type":"user","cwd":"...","entrypoint":"cli","isMeta":true?,"message":{"content": string | blocks}}
// Any entry may carry "cwd".

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { EARPIECE_PREFIX } from './prompt.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const LIST_MAX_AGE_MS = 30 * DAY_MS;
export const LIST_LIMIT = 20;
export const RECENTLY_ACTIVE_MS = 120_000;
const TITLE_MAX = 60;
const KEEP = 8; // how many trailing candidate lines to remember per field

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const USER_RE = /"type"\s*:\s*"user"/;
const CWD_RE = /"cwd"\s*:/;

/** Chat ids come from the phone and end up in a path and a CLI flag: only allow safe characters. */
export function isChatId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function dirExists(p) {
  if (typeof p !== 'string' || !p) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parse(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function remember(list, line) {
  list.push(line);
  if (list.length > KEEP) list.shift();
}

/** Text of a real driver/user message, or null for meta entries, tool results and our own messages. */
export function realUserText(entry) {
  if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  if (entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return null;
  const content = entry.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((b) => b?.type === 'tool_result')) return null;
    text = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith(EARPIECE_PREFIX)) return null;
  // Slash commands, their captured output, background-task notices and reminders are recorded as
  // user entries too, and so is the CLI's own marker when a turn is interrupted.
  if (/^<(command-|local-command-|task-notification|system-reminder)/.test(text)) return null;
  if (/^\[Request interrupted by user/.test(text)) return null;
  return text;
}

export function cutTitle(text, max = TITLE_MAX) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/** Read one chat file. Returns null if unreadable. */
export async function readChat(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let customTitle = null;
  let firstText = null;
  let lastText = null;
  let originCwd = null;
  const cwdLines = [];
  const userLines = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    if (line.includes('"custom-title"')) {
      const e = parse(line);
      if (e?.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) customTitle = e.customTitle.trim();
    }
    if (CWD_RE.test(line)) {
      if (originCwd === null) {
        const e = parse(line);
        if (typeof e?.cwd === 'string' && e.cwd) originCwd = e.cwd;
      }
      remember(cwdLines, line);
    }
    if (USER_RE.test(line)) {
      const e = parse(line);
      const t = realUserText(e);
      if (t) {
        firstText ??= t;
        lastText = t;
      }
      remember(userLines, line);
    }
  }
  let cwd = null;
  for (let i = cwdLines.length - 1; i >= 0 && cwd === null; i--) {
    const e = parse(cwdLines[i]);
    if (typeof e?.cwd === 'string' && e.cwd) cwd = e.cwd;
  }
  let source = null;
  for (let i = userLines.length - 1; i >= 0; i--) {
    const e = parse(userLines[i]);
    if (e?.type === 'user') {
      source = typeof e.entrypoint === 'string' ? e.entrypoint : null;
      break;
    }
  }
  return {
    title: customTitle ?? (firstText ? cutTitle(firstText) : 'Untitled chat'),
    hasRealMessage: firstText !== null,
    lastText,
    cwd: cwd ?? originCwd,
    originCwd,
    source,
  };
}

// Parsed files keyed by path; reused while mtime and size are unchanged (desk chats can be many MB).
const cache = new Map();
const CACHE_MAX = 500;

async function readChatCached({ path, mtimeMs, size }) {
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.info;
  const info = await readChat(path);
  if (info) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(path, { mtimeMs, size, info });
  }
  return info;
}

function toItem({ id, path, mtimeMs }, info, { now, currentId }) {
  // A chat's home is where it started: desk sessions record every folder the agent cd'd into,
  // so the last cwd is often a sub-folder. Fall back to the last cwd only if the origin is gone.
  const cwd = dirExists(info.originCwd) ? info.originCwd : info.cwd;
  return {
    id,
    title: info.title,
    cwd,
    origin_cwd: info.originCwd,
    folder: cwd ? basename(cwd) : '',
    source: info.source,
    updated_at: new Date(mtimeMs).toISOString(),
    recently_active: now - mtimeMs <= RECENTLY_ACTIVE_MS && id !== currentId,
    current: id === currentId,
    lastText: info.lastText,
    path,
    mtimeMs,
  };
}

async function chatFiles(root) {
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    let entries;
    try {
      entries = await readdir(join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const id = f.name.slice(0, -'.jsonl'.length);
      if (!isChatId(id)) continue;
      const path = join(root, d.name, f.name);
      try {
        const st = await stat(path);
        files.push({ id, path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
  }
  return files;
}

/**
 * Recent chats, newest first: modified in the last 30 days, at most 20, skipping chats with no real
 * user message and chats whose cwd and origin cwd both no longer exist.
 */
export async function listChats({ root, currentId = null, now = Date.now(), limit = LIST_LIMIT, maxAgeMs = LIST_MAX_AGE_MS, excludeDirs = [] } = {}) {
  const files = (await chatFiles(root)).filter((f) => now - f.mtimeMs <= maxAgeMs).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    if (out.length >= limit) break;
    if (seen.has(f.id)) continue;
    const info = await readChatCached(f);
    if (!info || !info.hasRealMessage) continue;
    if (!dirExists(info.cwd) && !dirExists(info.originCwd)) continue;
    // Chats run inside the bridge's data dir are Earpiece's own (old drive summaries), not the driver's.
    if (isUnder(info.originCwd, excludeDirs)) continue;
    seen.add(f.id);
    out.push(toItem(f, info, { now, currentId }));
  }
  return out;
}

/** One chat by id, any age (null if there is no such file or it cannot be read). */
export async function findChat({ root, id, currentId = null, now = Date.now() }) {
  if (!isChatId(id)) return null;
  const matches = (await chatFiles(root)).filter((f) => f.id === id).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!matches.length) return null;
  const info = await readChatCached(matches[0]);
  return info ? toItem(matches[0], info, { now, currentId }) : null;
}

/** The fields sent to the phone in a `chats` message (SPEC 10.3). */
export function publicChat(c) {
  return {
    id: c.id,
    title: c.title,
    cwd: c.cwd,
    folder: c.folder,
    source: c.source,
    updated_at: c.updated_at,
    recently_active: c.recently_active,
    current: c.current,
  };
}

/** Where to run a chat: where it started if that still exists, else its last cwd, else the fallback. */
export function chatCwd(c, fallback) {
  if (dirExists(c?.origin_cwd)) return c.origin_cwd;
  if (dirExists(c?.cwd)) return c.cwd;
  return fallback;
}

/** True when dir is one of the excluded folders or inside one (e.g. the bridge's own data dir). */
export function isUnder(dir, excludeDirs = []) {
  if (typeof dir !== 'string' || !dir) return false;
  return excludeDirs.some((x) => x && (dir === x || dir.startsWith(x.endsWith('/') ? x : `${x}/`)));
}

// ---------------------------------------------------------------- changed-elsewhere guard (SPEC 10.8)

/** Path of a chat's file by session id (newest if more than one), or null. Synchronous. */
export function findChatFileSync({ root, id }) {
  if (!isChatId(id)) return null;
  let best = null;
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    const path = join(root, d.name, `${id}.jsonl`);
    try {
      const st = statSync(path);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: st.mtimeMs };
    } catch {
      /* not in this project */
    }
  }
  return best?.path ?? null;
}

export function fileSize(path) {
  if (!path) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * Real user texts in complete lines written after byte `from`. Returns { texts, end } where `end`
 * is the byte offset just after the last complete line (a line still being written is left for later).
 */
export function readUserTextsSince(path, from = 0) {
  const size = fileSize(path);
  if (size === null) return { texts: [], end: from };
  const start = size < from ? 0 : from; // the file shrank: start over
  if (size === start) return { texts: [], end: start };
  const buf = Buffer.alloc(size - start);
  let fd;
  try {
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, buf.length, start);
  } catch {
    return { texts: [], end: from };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { texts: [], end: start };
  const texts = [];
  for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
    if (!line || !USER_RE.test(line)) continue;
    const t = realUserText(parse(line));
    if (t) texts.push(t);
  }
  return { texts, end: start + lastNl + 1 };
}

/** Same normalisation as realUserText, for comparing what the bridge sent with what is in the file. */
export function normalizeSent(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}
