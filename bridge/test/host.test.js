// Voice host pieces without a process: sentence streaming, [silent], launch flags, answer mapping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SentenceStream, cleanSentence, hostArgs } from '../src/host.js';
import { mapLabels, rankChats } from '../src/session.js';

function run(chunks, { flushEach = false } = {}) {
  const out = [];
  const s = new SentenceStream((x) => out.push(x));
  for (const c of chunks) {
    s.push(c);
    if (flushEach) s.flush();
  }
  const before = [...out];
  s.flush();
  return { out, before, silent: s.silent };
}

test('sentences are emitted as soon as they complete', () => {
  const { out, before } = run(['Sure, I', "'ll check. The te", 'sts pass', 'ed! Anything else?']);
  assert.deepEqual(before, ["Sure, I'll check.", 'The tests passed!']);
  assert.deepEqual(out, ["Sure, I'll check.", 'The tests passed!', 'Anything else?']);
});

test('no split inside numbers, abbreviations or list markers', () => {
  assert.deepEqual(run(['Version 3', '.5 is out, e.g. for Node. Done.']).out, ['Version 3.5 is out, e.g. for Node.', 'Done.']);
  assert.deepEqual(run(['Two things:\n1. Fix the test.\n2. Push it.']).out, ['Two things:', 'Fix the test.', 'Push it.']);
});

test('[silent] is never spoken, even when streamed in pieces', () => {
  const a = run(['[sil', 'ent', ']']);
  assert.deepEqual(a.out, []);
  assert.equal(a.silent, true);
  assert.deepEqual(run(['  [SILENT]  '], { flushEach: true }).out, []);
  assert.equal(run(['']).silent, true);
  // Text that only starts like the marker is spoken.
  assert.deepEqual(run(['[s', 'o] fine.']).out, ['[so] fine.']);
});

test('markdown is stripped and code blocks dropped as a safety net', () => {
  assert.deepEqual(run(['## Result\n**Fixed** the `upload` bug in /Users/me/app/src/upload.js.\n```js\nconsole.log(1)\n```\n- Next: run tests.']).out, [
    'Result',
    'Fixed the upload bug in upload.js.',
    'Next: run tests.',
  ]);
  assert.equal(cleanSentence('---'), '');
});

test('host launch flags (SPEC 13.1) plus the fast-start flags', () => {
  const a = hostArgs({ model: 'haiku', systemPrompt: 'P', mcpConfig: '{}' });
  const val = (f) => a[a.indexOf(f) + 1];
  assert.equal(val('--model'), 'haiku');
  assert.equal(val('--system-prompt'), 'P');
  assert.equal(val('--tools'), '');
  assert.equal(val('--mcp-config'), '{}');
  assert.equal(val('--allowedTools'), 'mcp__earpiece__*');
  assert.equal(val('--setting-sources'), '');
  for (const f of ['--include-partial-messages', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('--bare'));
  assert.equal(hostArgs({ systemPrompt: 'P', mcpConfig: '{}' })[a.indexOf('--model') + 1], 'sonnet');
});

test('answer_question label mapping falls back to free text', () => {
  const opts = [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'Unit tests' }];
  assert.deepEqual(mapLabels(['sqlite'], opts, false), { answer: 'SQLite', free: false });
  assert.deepEqual(mapLabels(['Postgres', 'SQLite'], opts, true), { answer: 'Postgres, SQLite', free: false });
  assert.deepEqual(mapLabels(['postgres and unit tests'], opts, true), { answer: 'Postgres, Unit tests', free: false });
  assert.deepEqual(mapLabels(['Postgres', 'SQLite'], opts, false), { answer: 'Postgres, SQLite', free: true });
  assert.deepEqual(mapLabels(['whatever is fastest'], opts, false), { answer: 'whatever is fastest', free: true });
});

test('switch_chat title matching ranks by shared words', () => {
  const chats = [{ title: 'Fix upload timeouts' }, { title: 'Upload page redesign' }, { title: 'Release notes' }];
  const r = rankChats('the upload timeouts one', chats);
  assert.equal(r[0].chat.title, 'Fix upload timeouts');
  assert.ok(r[0].score > r[1].score);
  const tie = rankChats('upload', chats);
  assert.equal(tie[0].score, tie[1].score);
  assert.deepEqual(rankChats('banana', chats), []);
});
