// Bridge integration for SPEC 10: listing and opening chats, voice mode on/off, choosing chats
// by voice, the recently-active guard, and the lazy drive start.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mkdirSync } from 'node:fs';
import { bridge, controlResponses, driveDirs, phone, readEvents, user, assistant, waitUntil, writeChatFile } from './helpers.js';

const BUSY = 'Claude is still working. Say stop first, or wait.';
const MIN = 60_000;

async function setup(t, overrides = {}) {
  const b = await bridge({ holdMs: 60, ...overrides });
  t.after(() => b.close());
  const dirs = {
    alpha: join(b.home, 'alpha'),
    uploader: join(b.home, 'repos', 'uploader'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const files = {
    busy: writeChatFile(b.projects, { project: 'p-busy', id: 'busy-4444', ageMs: 30_000, entries: [{ type: 'custom-title', customTitle: 'Desk work in progress' }, user(b.work, 'typing at the desk')] }),
    alpha: writeChatFile(b.projects, {
      project: 'p-alpha',
      id: 'alpha-1111',
      ageMs: 10 * MIN,
      entries: [user(dirs.alpha, 'remember the walrus'), assistant(dirs.alpha, 'ok'), { type: 'custom-title', customTitle: 'Walrus memory test' }],
    }),
    beta: writeChatFile(b.projects, { project: 'p-beta', id: 'beta-2222', ageMs: 2 * 60 * MIN, entries: [user(dirs.uploader, 'Fix the uploader timeouts', { entrypoint: 'claude-desktop' })] }),
    gamma: writeChatFile(b.projects, { project: 'p-gamma', id: 'gamma-3333', ageMs: 26 * 60 * MIN, entries: [{ type: 'custom-title', customTitle: 'Payment retries' }, user(b.work, 'retry payments')] }),
  };
  const p = await phone(b);
  return { b, p, dirs, files };
}

function chatEntries(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const userTexts = (path) => chatEntries(path).filter((e) => e.type === 'user').map((e) => (typeof e.message.content === 'string' ? e.message.content : ''));
const spawns = (b) => readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'bridge' && e.data.type === 'spawn').map((e) => e.data);

async function open(p, id, title) {
  p.send({ type: 'open_chat', id });
  await p.nextSay('notice', `Switching to ${title}.`);
  const reply = await p.nextSay('reply', null, { timeout: 5000 });
  await p.nextState('idle');
  return reply;
}

describe('listing chats', () => {
  it('lists chats before any drive and starts nothing', async (t) => {
    const { b, p, dirs } = await setup(t);
    p.send({ type: 'list_chats' });
    const { items } = await p.next({ type: 'chats' });
    assert.deepEqual(items.map((c) => c.id), ['busy-4444', 'alpha-1111', 'beta-2222', 'gamma-3333']);
    const alpha = items[1];
    assert.deepEqual(
      { title: alpha.title, cwd: alpha.cwd, folder: alpha.folder, source: alpha.source, recently_active: alpha.recently_active, current: alpha.current },
      { title: 'Walrus memory test', cwd: dirs.alpha, folder: 'alpha', source: 'cli', recently_active: false, current: false },
    );
    assert.equal(items[0].recently_active, true);
    assert.equal(items[2].title, 'Fix the uploader timeouts');
    assert.equal(items[2].source, 'claude-desktop');
    assert.equal(driveDirs(b.home).length, 0);
  });
});

describe('opening chats', () => {
  it('resumes a chat in place with voice mode on and speaks the recap', async (t) => {
    const { b, p, dirs, files } = await setup(t);
    p.send({ type: 'open_chat', id: 'alpha-1111' });
    await p.nextSay('notice', 'Switching to Walrus memory test.');
    const st = await p.next((m) => m.type === 'state' && m.chat?.id === 'alpha-1111', { label: 'state with chat' });
    assert.equal(st.state, 'working');
    assert.equal(st.cwd, dirs.alpha);
    assert.equal(st.chat.title, 'Walrus memory test');
    assert.equal((await p.nextSay('reply')).text, 'Recap: we were working on remember the walrus.');
    await p.nextState('idle');

    const [spawn] = spawns(b);
    assert.equal(spawn.cwd, dirs.alpha);
    assert.equal(spawn.args[spawn.args.indexOf('--resume') + 1], 'alpha-1111');
    assert.ok(!spawn.args.includes('--append-system-prompt'));
    const transcript = readFileSync(join(driveDirs(b.home)[0], 'transcript.md'), 'utf8');
    assert.ok(transcript.includes('Opened chat: Walrus memory test (alpha-1111)'));

    p.say('add a test for it');
    await p.nextSay('reply', 'Done: add a test for it.');
    const texts = userTexts(files.alpha);
    assert.equal(texts[0], 'remember the walrus');
    assert.match(texts[1], /^\[Earpiece\] Voice mode ON\. [\s\S]*Now reply with a one or two sentence spoken recap of this conversation's most recent exchange and what was next\. Recap the conversation itself, not project files or CLAUDE\.md\.$/);
    assert.equal(texts[2], 'add a test for it');
    const all = readdirSync(b.projects, { recursive: true }).filter((f) => String(f).endsWith('alpha-1111.jsonl'));
    assert.equal(all.length, 1, 'continued in the same file, not a copy');

    const p2 = await phone(b);
    assert.deepEqual(p2.messages.find((m) => m.type === 'welcome').chat, { id: 'alpha-1111', title: 'Walrus memory test' });
  });

  it('new_chat sends voice-off to the old chat first, then starts a new chat in its folder', async (t) => {
    const { b, p, dirs, files } = await setup(t);
    await open(p, 'alpha-1111', 'Walrus memory test');
    p.send({ type: 'new_chat' });
    await p.nextSay('notice', 'Switching to a new chat.');
    assert.equal((await p.nextSay('reply', null, { timeout: 5000 })).text, 'New chat in alpha. What should we work on?');
    await p.nextState('idle');
    assert.ok(!p.says('reply').some((m) => m.text === 'OK.'), 'the voice-off reply is never spoken');

    const entries = chatEntries(files.alpha);
    const lastUser = entries.filter((e) => e.type === 'user').at(-1).message.content;
    assert.match(lastUser, /^\[Earpiece\] Voice mode OFF\. The driver is back at a screen\. .*Reply only: OK\.$/);
    assert.equal(entries.at(-1).message.content[0].text, 'OK.');

    const events = readEvents(driveDirs(b.home)[0]);
    const offAt = events.findIndex((e) => e.source === 'to_claude' && e.data.message?.content?.startsWith?.('[Earpiece] Voice mode OFF'));
    const spawnAt = events.findIndex((e, i) => i > 0 && e.source === 'bridge' && e.data.type === 'spawn' && !e.data.args.includes('--resume'));
    assert.ok(offAt > 0 && spawnAt > offAt, 'voice-off goes out before the new chat starts');
    const s = spawns(b);
    assert.equal(s[1].cwd, dirs.alpha);
    assert.ok(!s[1].args.includes('--resume'));
    assert.match(b.session.chat.id, /^mock-session-/);

    p.say('build the importer');
    await p.nextSay('reply', 'Done: build the importer.');
    const st = p.messages.filter((m) => m.type === 'state').at(-1);
    assert.equal(st.chat.title, 'build the importer', 'a new chat is named after its first task');
  });

  it('open_chat, new_chat and switch_chat are refused while Claude works', async (t) => {
    const { p } = await setup(t);
    p.say('do something slow');
    await p.nextState('working');
    p.send({ type: 'open_chat', id: 'alpha-1111' });
    await p.nextSay('notice', BUSY);
    p.send({ type: 'new_chat' });
    await p.nextSay('notice', BUSY);
    p.control('switch_chat');
    await p.nextSay('notice', BUSY);
    p.control('which_chat');
    assert.equal((await p.nextSay('notice')).text, "You're in do something slow, in work.");
  });

  it('asks before opening a recently active chat', async (t) => {
    const { b, p } = await setup(t);
    p.send({ type: 'open_chat', id: 'busy-4444' });
    const q = await p.nextSay('question');
    assert.match(q.text, /^This chat was active (just now|\d+ seconds ago) on this machine\. Continue it anyway\?$/);
    await p.nextState('waiting_for_you');
    p.say('no');
    await p.nextSay('ack', 'Okay, not opening it.');
    await p.nextState('idle');
    assert.equal(b.session.chat, null);
    p.send({ type: 'open_chat', id: 'busy-4444' });
    await p.nextSay('question');
    p.say('yes');
    await p.nextSay('notice', 'Switching to Desk work in progress.');
    assert.equal((await p.nextSay('reply')).text, 'Recap: we were working on typing at the desk.');
  });

  it('handles bad, unknown and current chat ids', async (t) => {
    const { p } = await setup(t);
    p.send({ type: 'open_chat', id: '../../etc' });
    assert.equal((await p.next({ type: 'error' })).code, 'bad_message');
    p.send({ type: 'open_chat', id: 'nope-0000' });
    await p.nextSay('notice', "I couldn't find that chat.");
    await open(p, 'alpha-1111', 'Walrus memory test');
    p.send({ type: 'open_chat', id: 'alpha-1111' });
    await p.nextSay('notice', "You're already in Walrus memory test.");
  });
});

describe('choosing chats by voice', () => {
  it('lists three other chats and opens by number, by title words or a new chat; stay keeps the chat', async (t) => {
    const { b, p, dirs } = await setup(t);
    p.control('which_chat');
    await p.nextSay('notice', 'No chat open yet.');
    await open(p, 'alpha-1111', 'Walrus memory test');
    p.control('which_chat');
    await p.nextSay('notice', "You're in Walrus memory test, in alpha.");

    p.control('switch_chat');
    const q = await p.nextSay('question');
    assert.match(q.text, /^Recent chats\. One: Desk work in progress, just now\. Two: Fix the uploader timeouts, 2 hours ago\. Three: Payment retries, (yesterday|\d+ days ago)\. Or say new chat\.$/);
    await p.nextState('waiting_for_you');
    p.say('never mind');
    await p.nextSay('ack', 'Staying in Walrus memory test.');
    await p.nextState('idle');

    p.control('switch_chat');
    await p.nextSay('question', /^Recent chats/);
    p.say('banana');
    await p.nextSay('question', /^Sorry, I didn't catch which chat\. Recent chats/);
    p.say('number two');
    await p.nextSay('notice', 'Switching to Fix the uploader timeouts.');
    await p.nextSay('reply', 'Recap: we were working on Fix the uploader timeouts.');
    await p.nextState('idle');
    assert.equal(b.session.chat.id, 'beta-2222');
    assert.equal(b.session.cwd, dirs.uploader);

    p.control('switch_chat');
    await p.nextSay('question', /^Recent chats/);
    p.say('the payment one');
    await p.nextSay('notice', 'Switching to Payment retries.');
    await p.nextState('idle');

    // The chat we left a moment ago is not "recently active": that write was ours.
    p.control('switch_chat');
    await p.nextSay('question', /^Recent chats/);
    p.say('walrus');
    const next = await p.nextSay();
    assert.deepEqual([next.kind, next.text], ['notice', 'Switching to Walrus memory test.']);
    await p.nextState('idle');

    p.control('switch_chat');
    await p.nextSay('question', /^Recent chats/);
    p.say('start a new chat');
    await p.nextSay('notice', 'Switching to a new chat.');
    await p.nextSay('reply', 'New chat in alpha. What should we work on?');
  });

  it('control new_chat starts a new chat in the current folder', async (t) => {
    const { p } = await setup(t);
    await open(p, 'beta-2222', 'Fix the uploader timeouts');
    p.control('new_chat');
    await p.nextSay('notice', 'Switching to a new chat.');
    await p.nextSay('reply', 'New chat in uploader. What should we work on?');
  });

  it('"new chat" is an ordinary answer to every other question', async (t) => {
    const { b, p } = await setup(t);
    p.say('ask me which database');
    await p.nextSay('question', /^Which database/);
    p.say('new chat');
    await p.nextSay('ack', 'Got it: your answer.');
    await p.nextSay('reply');
    await p.nextState('idle');
    const answers = controlResponses(driveDirs(b.home)[0]).filter((r) => r.response?.updatedInput?.answers).at(-1);
    assert.deepEqual(answers.response.updatedInput.answers, { 'Which database should I use?': 'new chat' });

    p.say('needs permission');
    await p.nextSay('question', /^Claude wants to/);
    p.say('start a new chat');
    await p.nextSay('ack', 'Passed your reply to Claude.');
    await p.nextSay('reply');
    await p.nextState('idle');

    p.send({ type: 'open_chat', id: 'busy-4444' });
    await p.nextSay('question', /^This chat was active/);
    p.say('fresh chat');
    await p.nextSay('ack', 'Okay, not opening it.');
  });
});

describe('implicit chats, drive end and shutdown', () => {
  it('a task with no chat opens a new chat in the start folder and does not speak the greeting', async (t) => {
    const { b, p } = await setup(t);
    p.say('fix the bug');
    const st = await p.next((m) => m.type === 'state' && m.state === 'working');
    assert.equal(st.chat.title, 'fix the bug');
    await p.nextSay('reply', 'Done: fix the bug.');
    await p.nextState('idle');
    assert.equal(p.says('reply').length, 1);
    const id = b.session.chat.id;
    assert.match(id, /^mock-session-/);
    const file = join(b.projects, readdirSync(b.projects, { recursive: true }).find((f) => String(f).endsWith(`${id}.jsonl`)));
    let texts = userTexts(file);
    assert.match(texts[0], /^\[Earpiece\] Voice mode ON\.[\s\S]*Reply only: New chat in work\. What should we work on\?$/);
    assert.equal(texts[1], 'fix the bug');

    p.control('end_drive');
    await p.nextSay('notice', 'Drive saved. Summary is on the server.');
    await waitUntil(() => userTexts(file).length === 3, { label: 'voice-off in the chat' });
    texts = userTexts(file);
    assert.match(texts[2], /^\[Earpiece\] Voice mode OFF\./);
    await waitUntil(() => readdirSync(driveDirs(b.home)[0]).includes('summary.md'), { timeout: 6000, label: 'summary' });
    assert.equal(b.session.chat, null);
    assert.equal(p.messages.filter((m) => m.type === 'state').at(-1).chat, null);
  });

  it('a graceful shutdown while idle sends voice-off', async (t) => {
    const { b, p, files } = await setup(t);
    await open(p, 'alpha-1111', 'Walrus memory test');
    await b.close();
    assert.match(userTexts(files.alpha).at(-1), /^\[Earpiece\] Voice mode OFF\./);
  });

  it('the idle timeout ends the drive with voice-off', async (t) => {
    const { b, p, files } = await setup(t, { driveIdleMs: 300 });
    await open(p, 'alpha-1111', 'Walrus memory test');
    p.close();
    await waitUntil(() => /Voice mode OFF/.test(userTexts(files.alpha).at(-1)), { timeout: 5000, label: 'voice-off after idle timeout' });
    await waitUntil(() => driveDirs(b.home).length && readdirSync(driveDirs(b.home)[0]).includes('summary.md'), { timeout: 6000, label: 'summary' });
  });
});
