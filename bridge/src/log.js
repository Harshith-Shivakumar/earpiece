// Concise one-line stdout logging. Full detail goes to the drive's events.jsonl instead.

function clock(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

export function oneLine(text, max = 220) {
  const s = String(text).replace(/\s*\n\s*/g, ' | ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function createLogger({ quiet = false } = {}) {
  return (msg) => {
    if (quiet) return;
    process.stdout.write(`${clock()} ${oneLine(msg)}\n`);
  };
}
