// Bridge integration: protocol, auth, hold window, follow-ups, controls, narration, transcripts.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Phone, bridge, driveDirs, phone, readEvents, sleep, waitUntil } from './helpers.js';

async function withBridge(t, overrides) {
  const b = await bridge(overrides);
  t.after(() => b.close());
  return b;
}

describe('protocol and auth', () => {
  it('serves /health without auth', async (t) => {
    const b = await withBridge(t);
    const res = await fetch(`http://127.0.0.1:${b.port}/health`);
    const health = await res.json();
    assert.deepEqual(health, { ok: true, state: 'idle', name: b.config.name, bridge_id: b.config.bridgeId, relay: 'off' });
    assert.match(health.bridge_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(health.name.length > 0);
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/nope`)).status, 404);
  });

  it('rejects a wrong token with error auth and closes', async (t) => {
    const b = await withBridge(t);
    const p = await new Phone(b.url).connect();
    p.hello({ token: 'wrong' });
    const err = await p.next({ type: 'error' });
    assert.equal(err.code, 'auth');
    await p.waitClosed();
    assert.equal(driveDirs(b.home).length, 0, 'no drive is opened for a rejected phone');
  });

  it('rejects messages before hello', async (t) => {
    const b = await withBridge(t);
    const p = await new Phone(b.url).connect();
    p.say('hello?');
    const err = await p.next({ type: 'error' });
    assert.equal(err.code, 'auth');
    await p.waitClosed();
  });

  it('answers ping before and after hello', async (t) => {
    const b = await withBridge(t);
    const p = await new Phone(b.url).connect();
    p.send({ type: 'ping' });
    await p.next({ type: 'pong' });
    p.hello();
    const w = await p.next({ type: 'welcome' });
    assert.equal(w.state, 'idle');
    assert.equal(w.cwd, b.work);
    assert.equal(w.drive_id, null, 'no drive until a chat opens or the driver speaks');
    assert.equal(w.chat, null);
    p.send({ type: 'ping' });
    await p.next({ type: 'pong' });
  });

  it('survives malformed phone messages', async (t) => {
    const b = await withBridge(t);
    const p = await phone(b);
    for (const bad of ['not json', '[]', '{}', '{"type":42}', '{"type":"utterance"}', '{"type":"control","action":"explode"}', '{"type":"warp"}', 'null']) {
      p.send(bad);
      const err = await p.next({ type: 'error' });
      assert.ok(['bad_json', 'bad_message'].includes(err.code), `${bad} -> ${err.code}`);
    }
    p.ws.send(new Uint8Array([1, 2, 3]));
    assert.equal((await p.next({ type: 'error' })).code, 'bad_message');
    p.send({ type: 'ping' });
    await p.next({ type: 'pong' });
    assert.equal(p.closed, null);
  });

  it('replaces the old socket when a new phone says hello', async (t) => {
    const b = await withBridge(t);
    const a = await phone(b);
    const c = await phone(b);
    await a.waitClosed();
    assert.equal(a.closed.code, 4000);
    c.send({ type: 'ping' });
    await c.next({ type: 'pong' });
    assert.equal(driveDirs(b.home).length, 0, 'hello alone never starts a drive');
  });
});

describe('hold window', () => {
  it('reads the task back, waits, then works and replies', async (t) => {
    const b = await withBridge(t);
    const p = await phone(b);
    p.say('fix the upload timeouts.');
    assert.equal((await p.nextSay('ack')).text, 'Heard: fix the upload timeouts. Starting.');
    await p.nextState('holding');
    await p.nextState('working');
    const reply = await p.nextSay('reply');
    assert.equal(reply.text, 'Done: fix the upload timeouts.');
    await p.nextState('idle');
  });

  it('cancel during the hold drops the task', async (t) => {
    const b = await withBridge(t, { holdMs: 400 });
    const p = await phone(b);
    p.say('delete everything');
    await p.nextState('holding');
    p.control('cancel');
    assert.equal((await p.nextSay('ack', 'Cancelled.')).kind, 'ack');
    await p.nextState('idle');
    await sleep(600);
    assert.equal(p.says('reply').length, 0, 'nothing was sent to Claude');
    const sent = readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'to_claude' && e.data.type === 'user');
    assert.equal(sent.length, 0);
  });

  it('a second utterance during the hold is appended and restarts the timer', async (t) => {
    const b = await withBridge(t, { holdMs: 300 });
    const p = await phone(b);
    p.say('add a retry');
    await p.nextState('holding');
    await sleep(200);
    p.say('to the uploader');
    assert.equal((await p.nextSay('ack', /^Added/)).text, 'Added: to the uploader.');
    const t0 = Date.now();
    await p.nextState('working');
    assert.ok(Date.now() - t0 >= 200, 'hold timer restarted');
    assert.equal((await p.nextSay('reply')).text, 'Done: add a retry to the uploader.');
  });

  it('cancel arriving just after the hold expired still cancels the task', async (t) => {
    const b = await withBridge(t, { holdMs: 100, cancelGraceMs: 1500 });
    const p = await phone(b);
    p.say('something slow please');
    await p.nextState('working');
    p.control('cancel');
    await p.nextSay('ack', 'Cancelled.');
    await p.nextState('idle');
    await sleep(400);
    assert.equal(p.says('reply').length, 0);
    assert.equal(p.says('error').length, 0, 'the interrupted result is not spoken');
  });

  it('cancel with nothing to cancel says so', async (t) => {
    const b = await withBridge(t);
    const p = await phone(b);
    p.control('cancel');
    await p.nextSay('notice', 'Nothing to cancel.');
  });
});

describe('while working', () => {
  it('queues follow-ups and sends them as one message after the result', async (t) => {
    const b = await withBridge(t, { holdMs: 80 });
    const p = await phone(b);
    p.say('do something slow');
    await p.nextState('working');
    p.say('also add tests');
    await p.nextSay('ack', "Noted. I'll pass that on when this step finishes.");
    p.say('and update the readme');
    await p.nextSay('ack', /^Noted/);
    assert.equal((await p.nextSay('reply', /slow/, { timeout: 6000 })).text, 'Done: do something slow.');
    assert.equal((await p.nextSay('reply')).text, 'Done: also add tests and update the readme.');
    await p.nextState('idle');
    const states = p.messages.filter((m) => m.type === 'state').map((m) => m.state).filter((st, i, a) => st !== a[i - 1]);
    assert.deepEqual(states, ['holding', 'working', 'idle'], 'stays working between the two turns');
  });

  it('narrates progress with step counts, never during the first quiet period', async (t) => {
    const b = await withBridge(t, { holdMs: 50, progressDelayMs: 150, progressIntervalMs: 250 });
    const p = await phone(b);
    p.say('do something slow');
    await p.nextState('working');
    const startedAt = Date.now();
    const first = await p.nextSay('progress', null, { timeout: 3000 });
    assert.ok(Date.now() - startedAt >= 120, 'quiet at the start of the turn');
    assert.match(first.text, /^\d+ steps so far\. /);
    await p.nextSay('reply', null, { timeout: 6000 });
    const progress = p.says('progress');
    assert.ok(progress.length >= 2, `got ${progress.length} progress lines`);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].seq > progress[i - 1].seq);
    assert.ok(progress.some((m) => m.text.endsWith('Working through the slow job.')), 'task_summary detail is used');
  });

  it('holds back progress lines while paused', async (t) => {
    const b = await withBridge(t, { holdMs: 50, progressDelayMs: 50, progressIntervalMs: 100 });
    const p = await phone(b);
    p.control('pause');
    p.say('do something slow');
    await p.nextSay('reply', null, { timeout: 6000 });
    assert.equal(p.says('progress').length, 0);
    p.control('resume');
    p.say('do something slow again');
    await p.nextSay('reply', /again/, { timeout: 6000 });
    assert.ok(p.says('progress').length > 0);
  });

  it('end_drive while working is refused', async (t) => {
    const b = await withBridge(t, { holdMs: 50 });
    const p = await phone(b);
    p.say('do something slow');
    await p.nextState('working');
    p.control('end_drive');
    await p.nextSay('notice', 'Claude is still working. Say stop first, or keep going.');
    assert.equal(driveDirs(b.home).length, 1);
    assert.equal(existsSync(join(driveDirs(b.home)[0], 'summary.md')), false);
  });
});

describe('status and repeat', () => {
  it('status describes each state', async (t) => {
    const b = await withBridge(t, { holdMs: 300 });
    const p = await phone(b);
    p.control('status');
    assert.equal((await p.nextSay('notice')).text, 'Idle in work. Ready for a task.');
    p.say('do something slow');
    await p.nextState('holding');
    p.control('status');
    assert.equal((await p.nextSay('notice')).text, 'About to start: do something slow. Say cancel to drop it.');
    await p.nextState('working');
    await waitUntil(() => b.session.narrator.lastAction, { label: 'first step of the task' });
    p.control('status');
    assert.match((await p.nextSay('notice')).text, /^Working on: do something slow\. Last step: [a-z].*, (just now|\d+ seconds ago)\.$/);
    await p.nextSay('reply', null, { timeout: 6000 });
    p.control('status');
    assert.equal((await p.nextSay('notice')).text, 'Idle in work. Last turn: handled: Done: do something slow. Ready for a task.');
  });

  it('repeat re-sends the last reply with a new seq', async (t) => {
    const b = await withBridge(t);
    const p = await phone(b);
    p.control('repeat');
    await p.nextSay('notice', 'Nothing to repeat yet.');
    p.say('say hi');
    const reply = await p.nextSay('reply');
    p.control('repeat');
    const again = await p.nextSay('reply');
    assert.equal(again.text, reply.text);
    assert.ok(again.seq > reply.seq);
  });
});

describe('replies and transcripts', () => {
  it('speaks a cleaned reply and keeps the full text in the transcript', async (t) => {
    const b = await withBridge(t);
    const p = await phone(b);
    p.say('code please');
    const reply = await p.nextSay('reply');
    assert.equal(reply.text, 'Here is the fix for upload.js. All done, see a link for more. I left code in the notes.');
    const transcript = readFileSync(join(driveDirs(b.home)[0], 'transcript.md'), 'utf8');
    assert.ok(transcript.includes('```js\nconsole.log(1)\n```'), 'full final text with code');
    assert.ok(transcript.includes('/Users/someone/project/src/upload.js'));
  });

  it('end_drive writes transcript, events, notes and summary', async (t) => {
    const b = await withBridge(t);
    const p = await phone(b);
    p.say('fix the bug');
    await p.nextSay('reply');
    await p.nextState('idle');
    p.control('end_drive');
    await p.nextSay('notice', 'Drive saved. Summary is on the server.');
    const dir = driveDirs(b.home)[0];
    await waitUntil(() => existsSync(join(dir, 'summary.md')), { timeout: 6000, label: 'summary.md' });
    const transcript = readFileSync(join(dir, 'transcript.md'), 'utf8');
    for (const s of ['**Driver:** fix the bug', '**Earpiece** (ack): Heard: fix the bug. Starting.', 'Tool: Read ', 'Tool: Bash npm test', 'Claude, final reply', 'Done: fix the bug', 'Result: xxx', 'Ended ']) {
      assert.ok(transcript.includes(s), `transcript has ${s}`);
    }
    assert.ok(!/Result: x{501}/.test(transcript), 'tool results truncated to 500 chars');
    const events = readEvents(dir);
    assert.ok(events.some((e) => e.source === 'phone' && e.data.type === 'utterance' && e.data.text === 'fix the bug'));
    assert.ok(!JSON.stringify(events).includes('test-token-123'), 'the token never reaches the drive files');
    assert.ok(events.some((e) => e.source === 'claude' && e.data.type === 'result'));
    assert.ok(events.some((e) => e.source === 'to_claude' && e.data.type === 'user'));
    const spawn = events.find((e) => e.source === 'bridge' && e.data.type === 'spawn').data;
    assert.ok(!spawn.args.includes('--append-system-prompt'), 'voice rules travel as a message, not a system prompt');
    const sent = events.filter((e) => e.source === 'to_claude' && e.data.type === 'user').map((e) => e.data.message.content);
    assert.match(sent[0], /^\[Earpiece\] Voice mode ON\./);
    assert.ok(sent[0].includes(join(dir, 'notes.md')), 'notes path filled in');
    assert.ok(sent[0].includes(b.home), 'roots filled in');
    assert.ok(sent[0].endsWith('Reply only: New chat in work. What should we work on?'));
    assert.equal(sent[1], 'fix the bug');
    assert.match(sent.at(-1), /^\[Earpiece\] Voice mode OFF\. .*Reply only: OK\.$/);
    assert.equal(p.says('reply').length, 1, 'neither the greeting nor the voice-off reply is spoken');
    assert.ok(existsSync(join(dir, 'notes.md')));
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Mock summary \(model haiku/);
    // A new utterance after the drive ended opens a new drive.
    p.say('next task');
    await p.nextSay('reply', /next task/);
    assert.equal(driveDirs(b.home).length, 2);
  });

  it('writes the summary error when summarising fails', async (t) => {
    process.env.MOCK_SUMMARY_FAIL = '1';
    t.after(() => delete process.env.MOCK_SUMMARY_FAIL);
    const b = await withBridge(t);
    const p = await phone(b);
    p.say('quick task');
    await p.nextSay('reply');
    await p.nextState('idle');
    p.control('end_drive');
    await p.nextSay('notice', /^Drive saved/);
    const dir = driveDirs(b.home)[0];
    await waitUntil(() => existsSync(join(dir, 'summary.md')), { timeout: 6000, label: 'summary.md' });
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Summary failed[\s\S]*summary failed on purpose/);
  });

  it('ends the drive after the idle timeout with no phone', async (t) => {
    const b = await withBridge(t, { driveIdleMs: 300 });
    const p = await phone(b);
    p.say('quick task');
    await p.nextSay('reply');
    await p.nextState('idle');
    p.close();
    await waitUntil(() => existsSync(join(driveDirs(b.home)[0], 'summary.md')), { timeout: 5000, label: 'idle drive end' });
    assert.match(readFileSync(join(driveDirs(b.home)[0], 'transcript.md'), 'utf8'), /Ended .*no phone connection/);
  });
});
