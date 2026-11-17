// Bridge integration: AskUserQuestion and permission requests (SPEC 3.4).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bridge, controlResponses, driveDirs, phone, waitUntil } from './helpers.js';

async function setup(t, overrides = {}) {
  const b = await bridge({ holdMs: 60, ...overrides });
  t.after(() => b.close());
  const p = await phone(b);
  return { b, p };
}

const lastAllow = async (b) =>
  waitUntil(() => controlResponses(driveDirs(b.home)[0]).filter((r) => r.response?.behavior).at(-1), { label: 'control_response' });

describe('AskUserQuestion', () => {
  it('asks with labels only, matches a number word and answers with updatedInput.answers', async (t) => {
    const { b, p } = await setup(t);
    p.say('ask me which database');
    const q = await p.nextSay('question');
    assert.equal(q.text, 'Which database should I use? Option one: Postgres. Option two: SQLite. Option three: Redis.');
    await p.nextState('waiting_for_you');
    p.say('the second one');
    assert.equal((await p.nextSay('ack')).text, 'Got it: SQLite.');
    await p.nextState('working');
    assert.equal((await p.nextSay('reply')).text, 'You chose SQLite.');
    const resp = await lastAllow(b);
    assert.equal(resp.subtype, 'success');
    assert.equal(resp.response.behavior, 'allow');
    assert.deepEqual(resp.response.updatedInput.answers, { 'Which database should I use?': 'SQLite' });
    assert.equal(resp.response.updatedInput.questions.length, 1, 'original input is kept');
  });

  it('matches a label inside a sentence', async (t) => {
    const { p } = await setup(t);
    p.say('ask me which database');
    await p.nextSay('question');
    p.say("let's use redis");
    assert.equal((await p.nextSay('ack')).text, 'Got it: Redis.');
    assert.equal((await p.nextSay('reply')).text, 'You chose Redis.');
  });

  it('passes free text through verbatim', async (t) => {
    const { b, p } = await setup(t);
    p.say('ask me which database');
    await p.nextSay('question');
    p.say('whatever the billing service already uses');
    assert.equal((await p.nextSay('ack')).text, 'Got it: your answer.');
    const resp = await lastAllow(b);
    assert.equal(resp.response.updatedInput.answers['Which database should I use?'], 'whatever the billing service already uses');
  });

  it('collects several options for multiSelect', async (t) => {
    const { b, p } = await setup(t);
    p.say('ask me multi checks');
    const q = await p.nextSay('question');
    assert.match(q.text, /You can pick more than one\.$/);
    p.say('one and type check');
    assert.equal((await p.nextSay('ack')).text, 'Got it: Unit tests, Type check.');
    const resp = await lastAllow(b);
    assert.deepEqual(resp.response.updatedInput.answers, { 'Which checks should I run?': 'Unit tests, Type check' });
  });

  it('asks several questions one at a time', async (t) => {
    const { b, p } = await setup(t);
    p.say('ask me twice');
    await p.nextSay('question', /^Which database/);
    p.say('postgres');
    await p.nextSay('ack', 'Got it: Postgres.');
    const q2 = await p.nextSay('question');
    assert.equal(q2.text, 'Should I add an index? Option one: Yes. Option two: No.');
    p.control('status');
    assert.equal((await p.nextSay('notice')).text, `Waiting for your answer: ${q2.text}`);
    p.say('no');
    await p.nextSay('ack', 'Got it: No.');
    await p.nextSay('reply', 'You chose Postgres and No.');
    const resp = await lastAllow(b);
    assert.deepEqual(resp.response.updatedInput.answers, { 'Which database should I use?': 'Postgres', 'Should I add an index?': 'No' });
  });

  it('repeat re-sends the pending question', async (t) => {
    const { p } = await setup(t);
    p.say('ask me which database');
    const q = await p.nextSay('question');
    p.control('repeat');
    const again = await p.nextSay('question');
    assert.equal(again.text, q.text);
    assert.ok(again.seq > q.seq);
  });
});

describe('permission requests', () => {
  it('yes allows with the original input', async (t) => {
    const { b, p } = await setup(t);
    p.say('needs permission');
    const q = await p.nextSay('question');
    assert.equal(q.text, 'Claude wants to run: Delete the build folder. Allow?');
    await p.nextState('waiting_for_you');
    p.say('yeah go ahead');
    await p.nextSay('ack', 'Allowed.');
    await p.nextState('working');
    await p.nextSay('reply', 'Deleted the build folder.');
    const resp = await lastAllow(b);
    assert.deepEqual(resp.response, { behavior: 'allow', updatedInput: { command: 'rm -rf /tmp/earpiece-mock/build', description: 'Delete the build folder' } });
  });

  it('no denies', async (t) => {
    const { b, p } = await setup(t);
    p.say('needs permission');
    await p.nextSay('question');
    p.say('nope');
    await p.nextSay('ack', 'Denied.');
    await p.nextSay('reply', 'I did not delete it. The driver said no.');
    const resp = await lastAllow(b);
    assert.deepEqual(resp.response, { behavior: 'deny', message: 'The driver said no.' });
  });

  it('anything else is passed to Claude as the reply', async (t) => {
    const { b, p } = await setup(t);
    p.say('needs permission');
    await p.nextSay('question');
    p.say('only delete the cache folder');
    await p.nextSay('ack', 'Passed your reply to Claude.');
    const resp = await lastAllow(b);
    assert.deepEqual(resp.response, { behavior: 'deny', message: 'The driver replied: only delete the cache folder' });
  });

  it('stop while waiting denies the request, interrupts and goes idle', async (t) => {
    const { b, p } = await setup(t);
    p.say('needs permission');
    await p.nextSay('question');
    p.control('stop');
    await p.nextSay('ack', 'Stopped.');
    await p.nextState('idle');
    const resp = await lastAllow(b);
    assert.deepEqual(resp.response, { behavior: 'deny', message: 'The driver stopped the task.' });
    p.say('a fresh task');
    assert.equal((await p.nextSay('reply', null, { timeout: 5000 })).text, 'Done: a fresh task.');
    assert.equal(p.says('reply').length, 1, 'the stopped turn was never spoken');
  });
});
