// Bridge integration: stop/interrupt, interrupt timeout, folder switch, replay, crashes,
// unsolicited turns and usage limits.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Phone, bridge, driveDirs, phone, readEvents, sleep, waitUntil } from './helpers.js';

async function setup(t, overrides = {}) {
  const b = await bridge({ holdMs: 60, ...overrides });
  t.after(() => b.close());
  const p = await phone(b);
  return { b, p };
}

const spawns = (b) => readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'bridge' && e.data.type === 'spawn').map((e) => e.data);

describe('stop', () => {
  it('interrupts Claude, clears follow-ups and does not speak the interrupted result', async (t) => {
    const { b, p } = await setup(t);
    p.say('do something slow');
    await p.nextState('working');
    p.say('and then this');
    await p.nextSay('ack', /^Noted/);
    p.control('stop');
    await p.nextSay('ack', 'Stopped.');
    await p.nextState('idle');
    await sleep(500);
    assert.equal(p.says('reply').length, 0);
    assert.equal(p.says('error').length, 0);
    const events = readEvents(driveDirs(b.home)[0]);
    assert.ok(events.some((e) => e.source === 'to_claude' && e.data.request?.subtype === 'interrupt'));
    const tasks = events.filter((e) => e.source === 'to_claude' && e.data.type === 'user' && !e.data.message.content.startsWith('[Earpiece]'));
    assert.equal(tasks.length, 1, 'follow-up was dropped');
    assert.equal(spawns(b).length, 1, 'no respawn when the interrupt is answered');
  });

  it('a task still queued behind a stopped turn stays silent even after the grace period', async (t) => {
    const { b, p } = await setup(t, { staleGraceMs: 100 });
    process.env.MOCK_STEP_MS = '60'; // a slower greeting, so the stop lands while it runs
    t.after(() => delete process.env.MOCK_STEP_MS);
    p.say('do something slow');
    await p.nextState('working');
    await waitUntil(() => b.session.pendingSends + (b.session.turnActive ? 1 : 0) === 2, { label: 'greeting running, task queued' });
    p.control('stop');
    await p.nextSay('ack', 'Stopped.');
    await sleep(3500); // the queued slow task runs to the end well after staleGraceMs
    assert.equal(p.says('reply').length, 0);
    assert.equal(p.says('error').length, 0);
  });

  it('kills and respawns with --resume when the interrupt is not answered', async (t) => {
    process.env.MOCK_IGNORE_INTERRUPT = '1';
    t.after(() => delete process.env.MOCK_IGNORE_INTERRUPT);
    const { b, p } = await setup(t, { interruptTimeoutMs: 400 });
    p.say('do something slow');
    await p.nextState('working');
    // Stop only once the slow task's own turn runs: if the new chat's greeting turn were still
    // pending, its result would count as the interrupt being answered (SPEC 4.4) and nothing respawns.
    await waitUntil(() => b.session.turnActive && b.session.pendingSends === 0 && b.session.silentResults === 0, { label: 'task turn running' });
    p.control('stop');
    await p.nextSay('ack', 'Stopped.');
    await waitUntil(() => spawns(b).length === 2, { timeout: 4000, label: 'respawn' });
    const second = spawns(b)[1];
    const i = second.args.indexOf('--resume');
    assert.ok(i > 0, 'respawned with --resume');
    assert.match(second.args[i + 1], /^mock-session-/);
    assert.equal(second.cwd, b.work);
    assert.equal(p.says('error').length, 0, 'a deliberate kill is not a crash');
    delete process.env.MOCK_IGNORE_INTERRUPT;
    p.say('a fresh task');
    assert.equal((await p.nextSay('reply', null, { timeout: 5000 })).text, 'Done: a fresh task.');
  });
});

describe('EARPIECE_SWITCH', () => {
  it('keeps the chat: respawns with --resume <same id> in the new cwd and sends the ready message', async (t) => {
    const { b, p } = await setup(t);
    const target = join(b.home, 'repos', 'uploader');
    mkdirSync(target, { recursive: true });
    p.say(`work in the uploader repo, switch to ${target}`);
    assert.equal((await p.nextSay('reply')).text, 'Found the folder.');
    assert.equal((await p.nextSay('notice')).text, 'Switching to uploader.');
    const st = await p.next((m) => m.type === 'state' && m.cwd === target, { label: 'state with new cwd' });
    assert.equal(st.state, 'working');
    assert.equal((await p.nextSay('reply', null, { timeout: 5000 })).text, 'Ready in uploader.');
    await p.nextState('idle');
    const s = spawns(b);
    assert.equal(s.length, 2);
    assert.equal(s[1].cwd, target);
    const chatId = b.session.chat.id;
    assert.match(chatId, /^mock-session-/);
    assert.equal(s[1].args[s[1].args.indexOf('--resume') + 1], chatId, 'same chat continues');
    assert.equal(st.chat.id, chatId);
    const last = readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'to_claude' && e.data.type === 'user').at(-1).data.message.content;
    assert.equal(last, `[Earpiece] You are now working in ${target}. Voice mode is still ON. Reply only: Ready in uploader.`);
    p.control('status');
    assert.match((await p.nextSay('notice')).text, /^Idle in uploader\./);
  });

  it('says so when the folder does not exist', async (t) => {
    const { p } = await setup(t);
    p.say('switch to /definitely/not/here');
    await p.nextSay('reply', 'Found the folder.');
    assert.equal((await p.nextSay('notice')).text, "I couldn't find the folder here.");
    await p.nextState('idle');
  });
});

describe('reconnect and replay', () => {
  it('replays missed non-progress lines after last_seq', async (t) => {
    const { b, p } = await setup(t);
    p.say('do something slow');
    await p.nextState('working');
    const seenSeq = p.lastSeq;
    p.close();
    await sleep(100);
    // Claude keeps working while the phone is away.
    await waitUntil(() => b.session.state === 'idle', { timeout: 6000, label: 'turn to finish while away' });
    const p2 = await new Phone(b.url).connect();
    p2.hello({ last_seq: seenSeq });
    const w = await p2.next({ type: 'welcome' });
    assert.equal(w.state, 'idle');
    const replayed = await p2.nextSay('reply');
    assert.equal(replayed.text, 'Done: do something slow.');
    assert.ok(replayed.seq > seenSeq);
    await sleep(200);
    assert.equal(p2.says('progress').length, 0, 'progress lines are not replayed');
  });

  it('with more than 5 missed lines, says "While you were away:" and replays only replies, questions and errors', async (t) => {
    const { b, p } = await setup(t);
    for (const task of ['one', 'two', 'three']) {
      p.say(`task ${task}`);
      await p.nextSay('reply', new RegExp(task));
      await p.nextState('idle');
    }
    const p2 = await new Phone(b.url).connect();
    p2.hello({ last_seq: 0 });
    await p2.next({ type: 'welcome' });
    await sleep(300);
    const kinds = p2.says().map((m) => [m.kind, m.text]);
    assert.deepEqual(kinds, [
      ['notice', 'While you were away:'],
      ['reply', 'Done: task one.'],
      ['reply', 'Done: task two.'],
      ['reply', 'Done: task three.'],
    ]);
    const seqs = p2.says().map((m) => m.seq);
    assert.deepEqual([...seqs].sort((x, y) => x - y), seqs, 'seq increases in send order');
  });

  it('re-sends a pending question last, even if it was delivered', async (t) => {
    const { b, p } = await setup(t);
    p.say('ask me which database');
    const q = await p.nextSay('question');
    p.close();
    await sleep(100);
    const p2 = await new Phone(b.url).connect();
    p2.hello({ last_seq: q.seq });
    const w = await p2.next({ type: 'welcome' });
    assert.equal(w.state, 'waiting_for_you');
    const again = await p2.nextSay('question');
    assert.equal(again.text, q.text);
    p2.say('three');
    await p2.nextSay('reply', 'You chose Redis.');
  });

  it('jumps seq forward when the phone is ahead (bridge restarted)', async (t) => {
    const b = await bridge();
    t.after(() => b.close());
    const p = await new Phone(b.url).connect();
    p.hello({ last_seq: 5000 });
    const w = await p.next({ type: 'welcome' });
    assert.equal(w.seq, 5000);
    p.say('hi');
    assert.ok((await p.nextSay('ack')).seq > 5000);
  });
});

describe('Claude Code crashes', () => {
  it('restarts with --resume after an unexpected exit', async (t) => {
    const { b, p } = await setup(t);
    p.say('first task');
    await p.nextSay('reply');
    p.say('please crash');
    await p.nextSay('error', 'Claude Code stopped unexpectedly. Restarting.');
    await p.nextState('idle');
    await waitUntil(() => spawns(b).length === 2, { label: 'restart' });
    const args = spawns(b)[1].args;
    assert.match(args[args.indexOf('--resume') + 1], /^mock-session-/);
    p.say('after the restart');
    await p.nextSay('reply', 'Done: after the restart.');
  });

  it('gives up after 3 crashes within 2 minutes', async (t) => {
    process.env.MOCK_CRASH_ON_START = '1';
    t.after(() => delete process.env.MOCK_CRASH_ON_START);
    const { b, p } = await setup(t);
    // Nothing is spawned until there is a chat; each task starts one, and each crashes.
    p.say('task one');
    await p.nextSay('error', 'Claude Code stopped unexpectedly. Restarting.');
    await p.nextState('idle');
    p.say('task two');
    await p.nextSay('error', 'Claude Code stopped unexpectedly. Restarting.');
    await p.nextState('idle');
    p.say('task three');
    await p.nextSay('error', 'Claude Code keeps crashing. Check the server.');
    await sleep(300);
    assert.equal(spawns(b).length, 3, 'no automatic fourth start');
    p.control('status');
    assert.match((await p.nextSay('notice')).text, /Claude Code is not running/);
    // A new task tries again.
    delete process.env.MOCK_CRASH_ON_START;
    p.say('try again');
    await p.nextSay('reply', 'Done: try again.', { timeout: 5000 });
  });
});

describe('turns Claude starts on its own', () => {
  it('goes working without an ack and speaks the result as a reply', async (t) => {
    process.env.MOCK_BACKGROUND_MS = '400';
    t.after(() => delete process.env.MOCK_BACKGROUND_MS);
    const { p } = await setup(t);
    p.say('start the build in the background');
    await p.nextSay('reply', 'I started the build in the background.');
    await p.nextState('idle');
    const acksBefore = p.says('ack').length;
    await p.nextState('working', { timeout: 3000 });
    p.control('status');
    assert.match((await p.nextSay('notice')).text, /^Claude is working on something on its own\./);
    await p.nextSay('reply', 'The background build finished and it passed.');
    await p.nextState('idle');
    assert.equal(p.says('ack').length, acksBefore, 'no hold, no ack');
  });
});

describe('usage limits', () => {
  it('announces the limit once with the reset time, goes idle and adds it to status', async (t) => {
    const { p } = await setup(t);
    p.say('hit the limit');
    const err = await p.nextSay('error');
    assert.match(err.text, /^You've hit your Claude usage limit\. It resets at \d{1,2}:\d{2} (AM|PM)( tomorrow)?\.$/);
    await p.nextState('idle');
    await sleep(200);
    assert.equal(p.says('error').length, 1, 'the error result is not spoken a second time');
    p.control('status');
    assert.match((await p.nextSay('notice')).text, /Ready for a task\. Usage limit resets at \d{1,2}:\d{2} (AM|PM)/);
  });
});
