// Turning Claude's text into short spoken lines (SPEC 3.5), plus the EARPIECE_SWITCH marker (3.6).

const CODE_MARK = '\u0000code\u0000';
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;
// Absolute (or ~) paths with at least two segments, e.g. /Users/me/app/server.js or ~/code/app.
const PATH_RE = /(^|[\s(\[{"'`=:,])(~?\/(?:[\w.@%+~-]+\/)+[\w.@%+~-]*)/g;

/** Remove the EARPIECE_SWITCH line(s); returns the requested path (or null) and the remaining text. */
export function extractSwitch(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let path = null;
  const kept = [];
  for (const line of lines) {
    const idx = line.indexOf('EARPIECE_SWITCH:');
    if (idx < 0) {
      kept.push(line);
      continue;
    }
    const raw = line.slice(idx + 'EARPIECE_SWITCH:'.length);
    const candidate = raw
      .trim()
      .replace(/^[`'"*_]+|[`'"*_]+$/g, '')
      .replace(/\s+\.$/, '') // the system prompt shows "EARPIECE_SWITCH: /absolute/path ."
      .trim();
    if (candidate) path = candidate;
    const before = line.slice(0, idx).replace(/[`*_\s]+$/, '');
    if (before.trim()) kept.push(before);
  }
  return { path, text: kept.join('\n') };
}

function basenameOf(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/** Inline cleanup used for every spoken fragment: URLs, absolute paths, inline markdown. */
export function cleanInline(text) {
  let s = String(text ?? '');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images -> alt text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links -> text
  s = s.replace(/<(https?:\/\/[^>\s]+)>/gi, '$1'); // autolinks
  s = s.replace(/`([^`]*)`/g, '$1'); // inline code -> text
  s = s.replace(URL_RE, (m) => {
    const trail = m.match(/[.,;:!?]+$/)?.[0] ?? '';
    return `a link${trail}`;
  });
  s = s.replace(PATH_RE, (m, pre, p) => {
    const trail = p.match(/[.,;:!?]+$/)?.[0] ?? '';
    const core = trail ? p.slice(0, -trail.length) : p;
    return `${pre}${basenameOf(core)}${trail}`;
  });
  s = s.replace(/\*\*([^*]+?)\*\*/g, '$1');
  s = s.replace(/__([^_]+?)__/g, '$1');
  s = s.replace(/~~([^~]+?)~~/g, '$1');
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2');
  s = s.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2');
  s = s.replace(/<\/?(br|p|b|i|em|strong|code|kbd)\s*\/?>/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip trailing sentence punctuation (so templates can add their own). */
export function stripEnd(text) {
  return String(text ?? '').trim().replace(/[\s.!?…:;,]+$/, '');
}

/** Ensure a fragment ends as a sentence. */
export function asSentence(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Clean a final reply for speech. Returns { text, droppedCode, truncated, switchPath }.
 * `text` may be empty when nothing speakable is left.
 */
export function cleanForSpeech(input, { maxSentences = 3, maxWords = 60 } = {}) {
  const { path: switchPath, text: withoutSwitch } = extractSwitch(input);
  let droppedCode = false;
  let t = withoutSwitch.replace(/\r\n/g, '\n');

  // Fenced code blocks (``` or ~~~), including an unterminated one at the end.
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*(?:\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)|$)/g, (m, pre) => {
    droppedCode = true;
    return `${pre}\n${CODE_MARK}\n`;
  });

  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push(para.join(' '));
    para = [];
  };
  for (let line of t.split('\n')) {
    line = line.trim();
    if (line === CODE_MARK) {
      // "Here is the fix:" followed by dropped code reads better as "Here is the fix."
      flush();
      if (blocks.length) blocks[blocks.length - 1] = blocks[blocks.length - 1].replace(/:$/, '.');
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      flush();
      continue;
    }
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue; // table separator row
    let structural = false;
    if (/^#{1,6}\s+/.test(line)) {
      line = line.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '');
      structural = true;
    }
    line = line.replace(/^(>\s?)+/, '');
    if (/^([-*+]|\d+[.)])\s+/.test(line)) {
      line = line.replace(/^([-*+]|\d+[.)])\s+/, '');
      structural = true;
    }
    line = line.replace(/^\[[ xX]\]\s+/, '');
    if (/^\|.*\|$/.test(line)) {
      line = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .join(', ');
      structural = true;
    }
    line = cleanInline(line);
    if (!line) continue;
    if (structural) {
      flush();
      blocks.push(line);
    } else {
      para.push(line);
    }
  }
  flush();

  const speech = blocks
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => (/[.!?…:;]$/.test(b) ? b : `${b}.`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = speech ? speech.split(/(?<=[.!?…])\s+/) : [];
  const kept = [];
  let words = 0;
  let truncated = false;
  for (const s of sentences) {
    const w = wordCount(s);
    if (kept.length >= maxSentences) {
      truncated = true;
      break;
    }
    if (words + w > maxWords) {
      if (kept.length === 0) {
        kept.push(asSentence(stripEnd(s.split(/\s+/).slice(0, maxWords).join(' '))));
      }
      truncated = true;
      break;
    }
    kept.push(s);
    words += w;
  }
  const parts = [];
  if (kept.length) parts.push(kept.join(' ').replace(/:$/, '.'));
  if (droppedCode) parts.push('I left code in the notes.');
  if (truncated) parts.push('The rest is in the notes.');
  return { text: parts.join(' '), droppedCode, truncated, switchPath };
}

const SUBTYPE_REASONS = {
  error_max_turns: 'it ran out of turns',
  error_during_execution: 'something failed while it was working',
  error_max_budget_usd: 'it reached its budget limit',
};

/** Short spoken reason for an is_error result. */
export function errorReason(ev = {}) {
  const raw = typeof ev.result === 'string' ? ev.result.trim() : '';
  if (raw) {
    const first = cleanForSpeech(raw, { maxSentences: 1, maxWords: 20 }).text
      .replace(/\s*(I left code in the notes\.|The rest is in the notes\.)/g, '')
      .trim();
    if (first) return stripEnd(first);
  }
  if (Array.isArray(ev.errors) && ev.errors.length) return stripEnd(cleanInline(String(ev.errors[0])).slice(0, 120));
  const sub = String(ev.subtype ?? '');
  return SUBTYPE_REASONS[sub] ?? (sub.replace(/^error_?/, '').replace(/_/g, ' ') || 'an unknown error');
}
