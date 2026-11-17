// Bridge integration for SPEC 10.8 (changed-elsewhere guard) and 10.9 (handing back to the desk).
// A "desk" writer is simulated by appending entries to the chat file between voice turns.

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { assistant, bridge, driveDirs, phone, readEvents, sleep, user, waitUntil, writeChatFile } from './helpers.js';

const CHANGED = 'This chat changed on the laptop. Picking up the latest.';
const MIN = 60_000;

async function setup(t, overrides = {}) {
  const b = await bridge({ holdMs: 60, ...overrides });
  t.after(() => b.close());
  const alphaDir = join(b.home, 'alpha');
  mkdirSync(alphaDir, { recursive: true });
  const entries = [user(alphaDir, 'remember the walrus'), assistant(alphaDir, 'ok'), { type: 'custom-title', customTitle: 'Walrus memory test' }];
  const file = writeChatFile(b.projects, { project: 'p-alpha', id: 'alpha-1111', ageMs: 10 * MIN, entries });
  const p = await phone(b);
  return { b, p, file, alphaDir };
}

const desk = (file, entry) => appendFileSync(file, `${JSON.stringify(entry)}\n`);
const toClaude = (b) =>
  readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'to_claude' && e.data.type === 'user').map((e) => e.data.message.content);
const spawns = (b) => readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'bridge' && e.data.type === 'spawn').map((e) => e.data);
const userTexts = (file) =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'user').map((e) => e.message.content);

async function openAlpha(p) {
  p.send({ type: 'open_chat', id: 'alpha-1111' });
  await p.nextSay('notice', 'Switching to Walrus memory test.');
  await p.nextSay('reply');
  await p.nextState('idle');
}

describe('changed-elsewhere guard', () => {
  it('reloads a chat that moved on at the desk: notice, --resume respawn, reload voice-on, then the task', async (t) => {
    const { b, p, file, alphaDir } = await setup(t);
    await openAlpha(p);
    desk(file, user(alphaDir, 'also remember the word dog'));
    p.say('next task');
    await p.nextSay('ack', 'Heard: next task. Starting.');
    await p.nextSay('notice', CHANGED);
    assert.equal((await p.nextSay('reply')).text, 'At the desk you said: also remember the word dog.');
    assert.equal((await p.nextSay('reply')).text, 'Done: next task.');
    await p.nextState('idle');

    const s = spawns(b);
    assert.equal(s.length, 2);
    assert.equal(s[1].args[s[1].args.indexOf('--resume') + 1], 'alpha-1111', 'same chat');
    assert.equal(s[1].cwd, alphaDir, 'same cwd');
    const sent = toClaude(b);
    const reloadAt = sent.findIndex((m) => m.startsWith('[Earpiece] Voice mode ON.') && m.endsWith('The chat continued at a screen since your last voice turn. Reply with one spoken sentence about what changed there.'));
    assert.ok(reloadAt > 0, 'reload voice-on sent');
    assert.equal(sent[reloadAt + 1], 'next task', 'the pending task follows the reload message');
    assert.ok(readFileSync(join(driveDirs(b.home)[0], 'transcript.md'), 'utf8').includes('Chat changed elsewhere; reloaded.'));

    p.say('another task');
    await p.nextSay('reply', 'Done: another task.');
    assert.equal(spawns(b).length, 2, 'no second reload');
    assert.equal(p.says('notice').filter((m) => m.text === CHANGED).length, 1);
  });

  it('ignores the bridge\'s own entries, tool results, meta, Earpiece, command and interrupt entries, and anything before the offset', async (t) => {
    const { b, p, file, alphaDir } = await setup(t);
    desk(file, user(alphaDir, 'written at the desk before the chat was opened'));
    const old = (Date.now() - 10 * MIN) / 1000;
    utimesSync(file, old, old); // not "recently active", so no guard question
    await openAlpha(p);
    p.say('first task');
    await p.nextSay('reply', 'Done: first task.');
    await p.nextState('idle');
    desk(file, user(alphaDir, [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }]));
    desk(file, user(alphaDir, 'Caveat: local command output', { isMeta: true }));
    desk(file, user(alphaDir, '[Earpiece] Voice mode ON. from somewhere'));
    desk(file, user(alphaDir, '<command-name>/model</command-name>'));
    desk(file, user(alphaDir, [{ type: 'text', text: '[Request interrupted by user]' }]));
    desk(file, user(alphaDir, 'first task'));
    desk(file, assistant(alphaDir, 'an assistant line'));
    appendFileSync(file, 'not json at all\n');
    p.say('second task');
    await p.nextSay('reply', 'Done: second task.');
    assert.equal(p.says('notice').filter((m) => m.text === CHANGED).length, 0);
    assert.equal(spawns(b).length, 1);
  });

  it('catches a desk entry written while a voice turn was running', async (t) => {
    const { b, p, file, alphaDir } = await setup(t);
    await openAlpha(p);
    p.say('do something slow');
    await p.nextState('working');
    await sleep(100);
    desk(file, user(alphaDir, 'typed mid turn'));
    await p.nextSay('reply', 'Done: do something slow.', { timeout: 6000 });
    await p.nextState('idle');
    await sleep(500); // longer than chatSettleMs: the settle must not skip past the desk entry
    p.say('next');
    await p.nextSay('notice', CHANGED);
    await p.nextSay('reply', 'At the desk you said: typed mid turn.');
    await p.nextSay('reply', 'Done: next.');
    assert.equal(spawns(b).length, 2);
  });

  it('sends voice-off to a reloaded process without voice-on when leaving a changed chat', async (t) => {
    const { b, p, file, alphaDir } = await setup(t);
    await openAlpha(p);
    desk(file, user(alphaDir, 'desk change before leaving'));
    p.send({ type: 'new_chat' });
    await p.nextSay('notice', 'Switching to a new chat.');
    await p.nextSay('notice', CHANGED);
    await p.nextSay('reply', 'New chat in alpha. What should we work on?', { timeout: 5000 });
    const s = spawns(b);
    assert.equal(s.length, 3, 'open, reload for voice-off, new chat');
    assert.equal(s[1].args[s[1].args.indexOf('--resume') + 1], 'alpha-1111');
    assert.ok(!s[2].args.includes('--resume'));
    assert.ok(!toClaude(b).some((m) => m.includes('continued at a screen')), 'no voice-on for voice-off');
    const texts = userTexts(file);
    assert.equal(texts.at(-2), 'desk change before leaving');
    assert.match(texts.at(-1), /^\[Earpiece\] Voice mode OFF\./);
    const events = readEvents(driveDirs(b.home)[0]);
    const spawnIdx = events.map((e, i) => (e.source === 'bridge' && e.data.type === 'spawn' ? i : -1)).filter((i) => i >= 0);
    const offIdx = events.findIndex((e) => e.source === 'to_claude' && e.data.message?.content?.startsWith?.('[Earpiece] Voice mode OFF'));
    assert.ok(offIdx > spawnIdx[1] && offIdx < spawnIdx[2], 'voice-off goes to the reloaded process, before the new chat starts');
  });

  it('works for a chat the bridge created (file found by session id)', async (t) => {
    const { b, p } = await setup(t);
    p.say('fix the bug');
    await p.nextSay('reply', 'Done: fix the bug.');
    await p.nextState('idle');
    const id = b.session.chat.id;
    const file = join(b.projects, readdirSync(b.projects, { recursive: true }).find((f) => String(f).endsWith(`${id}.jsonl`)));
    desk(file, user(b.work, 'desk edit on the new chat'));
    p.say('next one');
    await p.nextSay('notice', CHANGED);
    await p.nextSay('reply', 'At the desk you said: desk edit on the new chat.');
    await p.nextSay('reply', 'Done: next one.');
    const s = spawns(b);
    assert.equal(s[1].args[s[1].args.indexOf('--resume') + 1], id);
  });
});

describe('handing back to the desk', () => {
  it('says how to continue at the desk and starts summary.md with resume commands for every chat used', async (t) => {
    const { b, p, alphaDir } = await setup(t);
    await openAlpha(p);
    p.say('task a');
    await p.nextSay('reply', 'Done: task a.');
    await p.nextState('idle');
    p.send({ type: 'new_chat' });
    await p.nextSay('reply', 'New chat in alpha. What should we work on?', { timeout: 5000 });
    await p.nextState('idle');
    p.say('task b');
    await p.nextSay('reply', 'Done: task b.');
    await p.nextState('idle');
    const newId = b.session.chat.id;
    p.control('end_drive');
    await p.nextSay('notice', 'Drive saved. Summary is on the server.');
    await p.nextSay('notice', 'To continue at your desk, open a terminal in alpha and run claude dash c.');
    const summary = join(driveDirs(b.home)[0], 'summary.md');
    await waitUntil(() => existsSync(summary), { timeout: 6000, label: 'summary.md' });
    const text = readFileSync(summary, 'utf8');
    assert.ok(
      text.startsWith(
        `## Continue at your desk\n\n- Walrus memory test: \`cd ${alphaDir} && claude --resume alpha-1111\`\n- task b: \`cd ${alphaDir} && claude --resume ${newId}\`\n\n`,
      ),
      text,
    );
    assert.match(text, /Mock summary \(model haiku/);
  });

  it('keeps the section when the model summary fails, and says no desk line without a chat', async (t) => {
    process.env.MOCK_SUMMARY_FAIL = '1';
    process.env.MOCK_CRASH_ON_START = '1';
    t.after(() => {
      delete process.env.MOCK_SUMMARY_FAIL;
      delete process.env.MOCK_CRASH_ON_START;
    });
    const { b, p } = await setup(t);
    p.say('this crashes before the chat exists');
    await p.nextSay('error', /^Claude Code stopped unexpectedly/);
    await p.nextState('idle');
    assert.equal(b.session.chat, null);
    p.control('end_drive');
    await p.nextSay('notice', 'Drive saved. Summary is on the server.');
    const summary = join(driveDirs(b.home)[0], 'summary.md');
    await waitUntil(() => existsSync(summary), { timeout: 6000, label: 'summary.md' });
    const text = readFileSync(summary, 'utf8');
    assert.ok(text.startsWith('## Continue at your desk\n\nNo chat was opened in this drive.\n\n# Summary failed'), text);
    await sleep(100);
    assert.ok(!p.says('notice').some((m) => m.text.startsWith('To continue at your desk')));
  });
});
