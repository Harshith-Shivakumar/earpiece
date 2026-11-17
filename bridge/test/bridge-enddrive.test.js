// Bridge integration for SPEC 11.1 (identity in welcome) and the bridge side of 11.5:
// the busy error, end_drive with force, drive_ended and its replay on the next hello.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Phone, assistant, bridge, driveDirs, phone, sleep, user, waitUntil, writeChatFile } from './helpers.js';

const MIN = 60_000;

async function setup(t, overrides = {}) {
  const b = await bridge({ holdMs: 60, ...overrides });
  t.after(() => b.close());
  const spaced = join(b.home, 'my project');
  mkdirSync(spaced, { recursive: true });
  writeChatFile(b.projects, {
    project: 'p-alpha',
    id: 'alpha-1111',
    ageMs: 10 * MIN,
    entries: [user(spaced, 'remember the walrus'), assistant(spaced, 'ok'), { type: 'custom-title', customTitle: 'Walrus memory test' }],
  });
  const p = await phone(b);
  return { b, p, spaced };
}

async function openAlpha(p) {
  p.send({ type: 'open_chat', id: 'alpha-1111' });
  await p.nextSay('notice', 'Switching to Walrus memory test.');
  await p.nextSay('reply');
  await p.nextState('idle');
}

describe('identity', () => {
  it('welcome carries name and bridge_id', async (t) => {
    const { b, p } = await setup(t);
    const w = p.messages.find((m) => m.type === 'welcome');
    assert.equal(w.name, b.config.name);
    assert.equal(w.bridge_id, b.config.bridgeId);
    const saved = JSON.parse(readFileSync(join(b.home, 'config.json'), 'utf8'));
    assert.equal(saved.bridge_id, b.config.bridgeId, 'persisted like the token');
  });
});

describe('end drive', () => {
  it('while Claude works: speaks the line and sends error busy, and the drive stays open', async (t) => {
    const { b, p } = await setup(t);
    p.say('do something slow');
    await p.nextState('working');
    p.control('end_drive');
    await p.nextSay('notice', 'Claude is still working. Say stop first, or keep going.');
    const err = await p.next({ type: 'error' });
    assert.deepEqual(err, { type: 'error', code: 'busy', message: 'Claude is still working. Say stop first, or keep going.' });
    await sleep(200);
    assert.ok(!p.messages.some((m) => m.type === 'drive_ended'));
    assert.equal(existsSync(join(driveDirs(b.home)[0], 'summary.md')), false);
  });

  it('with force: stops Claude, sends voice-off after the stopped turn, then ends with drive_ended', async (t) => {
    const { b, p, spaced } = await setup(t);
    await openAlpha(p);
    p.say('do something slow');
    await p.nextState('working');
    await waitUntil(() => b.session.narrator.lastAction, { label: 'task running' });
    p.send({ type: 'control', action: 'end_drive', force: true });
    await p.nextSay('ack', 'Stopped.');
    await p.nextSay('notice', 'Drive saved. Summary is on the server.');
    await p.nextSay('notice', 'To continue at your desk, open a terminal in my project and run claude dash c.');
    const ended = await p.next({ type: 'drive_ended' }, { timeout: 6000 });
    assert.equal(ended.drive_id, driveDirs(b.home)[0].split('/').pop());
    assert.deepEqual(ended.chats, [
      { id: 'alpha-1111', title: 'Walrus memory test', cwd: spaced, folder: 'my project', resume_cmd: `cd '${spaced}' && claude --resume alpha-1111` },
    ]);
    const transcript = readFileSync(join(driveDirs(b.home)[0], 'transcript.md'), 'utf8');
    assert.ok(transcript.includes('Voice mode off acknowledged: OK.'), 'the stopped turn\'s result was not taken for the voice-off reply');
    assert.equal(p.says('reply').filter((m) => /slow/.test(m.text)).length, 0, 'the stopped task is not spoken');
  });

  it('drive_ended lists every chat used, in order of first use, once each', async (t) => {
    const { b, p, spaced } = await setup(t);
    await openAlpha(p);
    p.send({ type: 'new_chat' });
    await p.nextSay('reply', 'New chat in my project. What should we work on?', { timeout: 5000 });
    await p.nextState('idle');
    p.say('task b');
    await p.nextSay('reply', 'Done: task b.');
    await p.nextState('idle');
    const newId = b.session.chat.id;
    await openAlpha(p); // back to the first chat
    p.control('end_drive');
    const ended = await p.next({ type: 'drive_ended' }, { timeout: 6000 });
    assert.deepEqual(ended.chats.map((c) => [c.id, c.title]), [['alpha-1111', 'Walrus memory test'], [newId, 'task b']]);
    assert.equal(ended.chats[1].resume_cmd, `cd '${spaced}' && claude --resume ${newId}`);
    // The summary's first section uses the same command.
    const summary = join(driveDirs(b.home)[0], 'summary.md');
    await waitUntil(() => existsSync(summary), { timeout: 6000, label: 'summary' });
    assert.ok(readFileSync(summary, 'utf8').includes(`- Walrus memory test: \`cd '${spaced}' && claude --resume alpha-1111\``));
  });

  it('with no drive open: says so and still sends drive_ended so the phone stops waiting', async (t) => {
    const { p } = await setup(t);
    p.control('end_drive');
    await p.nextSay('notice', 'No drive is open.');
    assert.deepEqual(await p.next({ type: 'drive_ended' }), { type: 'drive_ended', drive_id: null, chats: [] });
  });
});

describe('drive_ended replay', () => {
  it('is sent once on the next hello when the phone was gone', async (t) => {
    const { b, p } = await setup(t);
    p.say('quick task');
    await p.nextSay('reply');
    await p.nextState('idle');
    p.control('end_drive');
    await p.nextSay('notice', /^Drive saved/);
    p.close(); // gone before the drive is finalized
    await waitUntil(() => b.session.pendingDriveEnded, { timeout: 6000, label: 'drive finalized' });
    const p2 = await new Phone(b.url).connect();
    p2.hello({ last_seq: p.lastSeq });
    await p2.next({ type: 'welcome' });
    const ended = await p2.next({ type: 'drive_ended' });
    assert.equal(ended.chats.length, 1);
    p2.close();
    const p3 = await phone(b);
    await sleep(200);
    assert.ok(!p3.messages.some((m) => m.type === 'drive_ended'), 'only once');
  });

  it('is sent again when the socket it went out on was replaced soon after', async (t) => {
    const { b, p } = await setup(t, { driveEndedConfirmMs: 3000 });
    p.say('quick task');
    await p.nextSay('reply');
    await p.nextState('idle');
    p.control('end_drive');
    await p.next({ type: 'drive_ended' }, { timeout: 6000 });
    const p2 = await phone(b); // replaces p within the confirm window
    await p2.next({ type: 'drive_ended' });
  });

  it('is not sent again once it was delivered', async (t) => {
    const { b, p } = await setup(t, { driveEndedConfirmMs: 200 });
    p.say('quick task');
    await p.nextSay('reply');
    await p.nextState('idle');
    p.control('end_drive');
    await p.next({ type: 'drive_ended' }, { timeout: 6000 });
    await sleep(400);
    p.close();
    await sleep(100);
    const p2 = await phone(b);
    await sleep(200);
    assert.ok(!p2.messages.some((m) => m.type === 'drive_ended'));
  });

  it('is dropped when a new drive starts', async (t) => {
    const { b, p } = await setup(t);
    p.say('quick task');
    await p.nextSay('reply');
    await p.nextState('idle');
    p.control('end_drive');
    await p.nextSay('notice', /^Drive saved/);
    p.close();
    await waitUntil(() => b.session.pendingDriveEnded, { timeout: 6000, label: 'drive finalized' });
    b.session.onUtterance('start another drive'); // a new drive opens before the phone is back
    assert.equal(b.session.pendingDriveEnded, null);
  });
});
