// AskUserQuestion and permission requests spoken aloud, and matching the driver's answer (SPEC 3.4).

import { basename } from 'node:path';
import { cleanInline, stripEnd } from './speech.js';

const SPOKEN_ORDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9, '10th': 10,
};
// Speech-to-text homophones, only trusted right after "option" / "number" / "choice".
const HOMOPHONES = { won: 1, to: 2, too: 2, for: 4, fore: 4, tree: 3, free: 3 };
const CUES = new Set(['option', 'number', 'choice']);
// "one" is a number only at the start or after these words; elsewhere it is a pronoun
// ("the second one", "that one", "the uploader one").
const ONE_AS_NUMBER_AFTER = new Set([
  'option', 'number', 'choice', 'chat', 'and', 'or', 'take', 'pick', 'choose', 'open', 'want', 'use',
  'with', 'try', 'do', 'say', 'is',
]);

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function spokenOrdinal(i) {
  return SPOKEN_ORDINALS[i] ?? String(i + 1);
}

function labelOf(option) {
  if (option && typeof option === 'object') return String(option.label ?? '').trim();
  return String(option ?? '').trim();
}

/** Spoken form of one AskUserQuestion item. Labels only, never descriptions. */
export function formatQuestion(q) {
  const question = cleanInline(q?.question ?? '').trim() || 'Claude has a question.';
  const options = Array.isArray(q?.options) ? q.options : [];
  const parts = [/[?.!]$/.test(question) ? question : `${question}?`];
  options.forEach((o, i) => {
    const label = stripEnd(cleanInline(labelOf(o)));
    if (label) parts.push(`Option ${spokenOrdinal(i)}: ${label}.`);
  });
  if (q?.multiSelect) parts.push('You can pick more than one.');
  return parts.join(' ');
}

/** Option numbers (1-based) mentioned in the answer, in the order spoken. */
export function findNumbers(norm, count) {
  const toks = norm.split(' ').filter(Boolean);
  // Long free-text answers only count numbers that follow "option"/"number"/"choice",
  // so "use two workers and retry" is not read as "option two".
  const short = toks.length <= 6;
  const picks = [];
  toks.forEach((t, i) => {
    const prev = toks[i - 1];
    const cued = CUES.has(prev);
    let n = /^\d+$/.test(t) ? parseInt(t, 10) : NUMBER_WORDS[t];
    if (n === undefined && cued) n = HOMOPHONES[t];
    if (n === undefined) return;
    if (t === 'one' && prev && !ONE_AS_NUMBER_AFTER.has(prev)) return;
    if (!short && !cued) return;
    if (n >= 1 && n <= count && !picks.includes(n)) picks.push(n);
  });
  return picks;
}

function labelMatches(norm, normLabels, multi) {
  let remaining = ` ${norm} `;
  const byLength = normLabels
    .map((l, i) => [l, i])
    .filter(([l]) => l)
    .sort((a, b) => b[0].length - a[0].length);
  const picks = [];
  for (const [l, i] of byLength) {
    const needle = ` ${l} `;
    if (remaining.includes(needle)) {
      picks.push(i);
      remaining = remaining.replace(needle, ' | ');
    }
  }
  if (picks.length) return multi ? picks : [picks[0]];
  if (norm.length >= 3) {
    const i = normLabels.findIndex((l) => l && l.includes(norm));
    if (i >= 0) return [i];
  }
  return [];
}

/**
 * Match a spoken answer against the options.
 * Returns { answer: string, free: boolean, picks: number[] (0-based) }.
 */
export function matchAnswer(answer, options = [], multiSelect = false) {
  const text = String(answer ?? '').trim();
  const norm = normalize(text);
  const labels = (Array.isArray(options) ? options : []).map(labelOf);
  const normLabels = labels.map(normalize);
  const result = (picks) => ({ picks, free: false, answer: picks.map((i) => labels[i]).join(', ') });

  if (!norm || !labels.length) return { picks: [], free: true, answer: text };

  // An answer that is exactly one label always means that label (e.g. option "Python 3").
  const exact = normLabels.findIndex((l) => l && l === norm);
  if (exact >= 0) return result([exact]);

  const numbers = findNumbers(norm, labels.length).map((n) => n - 1);
  if (!multiSelect) {
    if (numbers.length) return result([numbers[0]]);
    const byLabel = labelMatches(norm, normLabels, false);
    if (byLabel.length) return result(byLabel);
    return { picks: [], free: true, answer: text };
  }
  const all = [...new Set([...numbers, ...labelMatches(norm, normLabels, true)])].sort((a, b) => a - b);
  if (all.length) return result(all);
  return { picks: [], free: true, answer: text };
}

const WORD_STOP = new Set([
  'the', 'and', 'one', 'chat', 'that', 'this', 'about', 'with', 'for', 'let', "let's", 'lets', 'switch',
  'open', 'want', 'were', 'was', 'please', 'back', 'thing', 'where', 'what', 'which', 'go', 'into', 'from',
]);

/** Index of the label sharing the most meaningful words with the answer; -1 if none or a tie. */
export function matchByWords(answer, labels) {
  const words = normalize(answer).split(' ').filter((w) => w.length >= 3 && !WORD_STOP.has(w));
  if (!words.length) return -1;
  const scores = labels.map((label) => {
    const lw = normalize(label).split(' ').filter(Boolean);
    return words.filter((w) => lw.some((x) => x === w || (w.length >= 4 && x.length >= 4 && (x.startsWith(w) || w.startsWith(x))))).length;
  });
  const best = Math.max(...scores);
  if (best <= 0 || scores.filter((s) => s === best).length > 1) return -1;
  return scores.indexOf(best);
}

/** Pick one item from a spoken list: number words first, then the label rules of 3.4, then title words. */
export function pickFromList(answer, labels) {
  const norm = normalize(answer);
  if (!norm || !labels.length) return -1;
  const numbers = findNumbers(norm, labels.length);
  if (numbers.length) return numbers[0] - 1;
  const m = matchAnswer(answer, labels.map((label) => ({ label })), false);
  if (!m.free) return m.picks[0];
  return matchByWords(answer, labels);
}

const YES = ['yes', 'yeah', 'yep', 'yup', 'allow', 'go ahead', 'do it', 'sure', 'okay', 'ok', 'absolutely', 'go for it', 'alright', 'all right', 'approve', 'approved'];
const NO = ['no', 'nope', "don't", 'dont', 'do not', 'deny', 'stop', 'skip', 'nah', 'negative', 'cancel'];
const YES_TAIL = new Set([
  'please', 'thanks', 'thank', 'you', 'go', 'ahead', 'do', 'it', 'sure', 'that', "that's", 'is', 'fine',
  'yes', 'yeah', 'yep', 'okay', 'ok', 'allow', 'absolutely', 'of', 'course', 'claude', 'then', 'sounds',
  'good', 'right', 'alright', 'thing', 'for', 'great', 'perfect', 'and',
]);
const NO_TAIL = new Set([
  'please', 'thanks', 'thank', 'you', "don't", 'dont', 'do', 'not', 'it', 'that', "that's", 'no', 'nope',
  'deny', 'skip', 'stop', 'way', 'claude', 'this', 'one', 'for', 'now', 'and',
]);

function leadingPhrase(norm, phrases) {
  let best = null;
  for (const p of phrases) {
    if ((norm === p || norm.startsWith(`${p} `)) && (!best || p.length > best.length)) best = p;
  }
  return best;
}

/** 'yes' | 'no' | 'other' for a reply to a permission request. */
export function classifyYesNo(text) {
  const norm = normalize(text);
  if (!norm) return 'other';
  const y = leadingPhrase(norm, YES);
  const n = leadingPhrase(norm, NO);
  if (!y && !n) return 'other';
  const phrase = n && (!y || n.length >= y.length) ? n : y;
  const cls = phrase === n ? 'no' : 'yes';
  const rest = norm.slice(phrase.length).trim().split(' ').filter(Boolean);
  const tail = cls === 'yes' ? YES_TAIL : NO_TAIL;
  if (rest.length <= 4 && rest.every((w) => tail.has(w))) return cls;
  return 'other';
}

function humanizeTool(name) {
  return String(name ?? 'a tool')
    .replace(/^mcp__/, '')
    .replace(/_+/g, ' ')
    .trim();
}

function shortInput(input = {}) {
  const pathish = input.file_path ?? input.notebook_path ?? input.path;
  if (typeof pathish === 'string' && pathish) return basename(pathish) || pathish;
  if (typeof input.url === 'string') {
    try {
      return new URL(input.url).hostname;
    } catch {
      /* fall through */
    }
  }
  for (const k of ['query', 'pattern', 'description', 'prompt', 'command']) {
    if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim().slice(0, 60);
  }
  const firstString = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return firstString ? firstString.trim().slice(0, 60) : '';
}

/** "run: <description or first 80 chars of command>" or "use <tool> on <basename or short input>". */
export function permissionSummary(toolName, input = {}, displayName) {
  if (toolName === 'Bash') {
    const desc = typeof input.description === 'string' ? input.description.trim() : '';
    const s = desc || String(input.command ?? '').trim().slice(0, 80);
    return `run: ${stripEnd(cleanInline(s)) || 'a command'}`;
  }
  const name = humanizeTool(displayName || toolName);
  const target = stripEnd(cleanInline(shortInput(input ?? {})));
  return target ? `use ${name} on ${target}` : `use ${name}`;
}
