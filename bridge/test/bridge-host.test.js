// The voice host (SPEC 13) end to end: bridge + mock worker + mock host over the real MCP tools.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { bridge, controlResponses, driveDirs, phone, readEvents, sleep, waitUntil } from './helpers.js';

let b;
let p;
afterEach(async () => {
  p?.close();
  await b?.close();
  b = null;
  p = null;
  delete process.env.MOCK_HOST_CRASH_ON_START;
});

async function start(overrides = {}) {
  b = await bridge({ voiceHost: true, hostModel: 'mock-sonnet', hostProgressMs: 150, ...overrides });
  p = await phone(b);
}

/** User messages the bridge sent to the host, in order. */
function hostInputs() {
  const [dir] = driveDirs(b.home);
  return readEvents(dir)
    .filter((e) => e.source === 'to_host' && e.data.type === 'user')
    .map((e) => e.data.message.content);
}
const workerSpawns = () => readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'bridge' && e.data.type === 'spawn');

test('small talk is answered by the host without starting the worker', async () => {
  await start();
  p.say("hey, what's a mutex in one line?");
  const r = await p.nextSay('reply', /^A mutex is a lock/);
  assert.equal(r.text, 'A mutex is a lock that lets only one thread use a resource at a time.');
  await p.nextSay('reply', 'Anything else?');
  assert.match(hostInputs()[0], /^\[event\] Drive started. Claude Code works in the folder work \(.*\/work\). No chat is open yet; start_task opens one there.\n\[driver\] hey, what's a mutex in one line\?$/);
  assert.equal(hostInputs().length, 1);
  assert.equal(workerSpawns().length, 0);
  assert.equal(p.says('ack').length, 0, 'no read-back');
  assert.equal(b.session.state, 'idle');
  const argv = readEvents(driveDirs(b.home)[0]).find((e) => e.source === 'host' && e.data.type === 'system' && e.data.subtype === 'init');
  assert.equal(argv.data.model, 'mock-sonnet');
  assert.ok(argv.data.tools.includes('mcp__earpiece__start_task'), 'MCP handshake gave the host the Earpiece tools');
});

test('a task goes through start_task and the host summarizes [worker finished]', async () => {
  await start();
  p.say('list the files in this folder');
  await p.nextSay('reply', 'On it.');
  await p.nextState('working');
  await p.nextState('idle');
  await p.nextSay('reply', 'Finished.');
  await p.nextSay('reply', 'Done: list the files in this folder');
  const inputs = hostInputs();
  assert.match(inputs[0], /\n\[driver\] list the files in this folder$/);
  // Grouping varies with timing (a progress digest may land in between); check the order instead.
  const rest = inputs.slice(1).join('\n');
  assert.match(rest, /\[worker started\] list the files in this folder[\s\S]*\[worker finished\] Done: list the files in this folder$/);
  assert.equal(p.says('ack').length, 0);
  assert.equal(p.says('progress').length, 0, 'no narrator lines');
  // The worker got the host-mode voice-on rules (13.5), then the task.
  const toWorker = readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'to_claude' && e.data.type === 'user').map((e) => e.data.message.content);
  assert.match(toWorker[0], /voice assistant that passes on their requests and summarizes your results/);
  assert.doesNotMatch(toWorker[0], /1 to 3 short spoken sentences/);
  assert.equal(toWorker[1], 'list the files in this folder');
});

test("a worker question is asked by the host and answered with answer_question", async () => {
  await start();
  p.say('ask me which database to use');
  await p.nextSay('reply', 'On it.');
  await p.nextState('waiting_for_you');
  await p.nextSay('reply', 'Claude Code asks: Which database should I use?');
  assert.equal(p.says('question').length, 0, 'the bridge does not read the options');
  assert.match(hostInputs().at(-1), /(?:^|\n)\[worker question\] Which database should I use\? Options: Postgres \(Relational, the usual choice\); SQLite \(A single file\); Redis \(In-memory\)\.$/);
  p.say('use sqlite');
  await p.nextSay('reply', 'Got it, SQLite.');
  await p.nextSay('reply', 'Finished.');
  await p.nextSay('reply', 'You chose SQLite.');
  const allow = controlResponses(driveDirs(b.home)[0]).find((r) => r.response?.behavior === 'allow');
  assert.deepEqual(allow.response.updatedInput.answers, { 'Which database should I use?': 'SQLite' });
});

test('a garbled "and drive" ends the drive through end_drive', async () => {
  await start();
  p.say('list the files');
  await p.nextSay('reply', /^Finished\./);
  p.say('and drive');
  await p.nextSay('notice', 'Drive saved. Summary is on the server.');
  const ended = await p.next({ type: 'drive_ended' });
  assert.equal(ended.chats.length, 1);
  await waitUntil(() => b.session.host === null, { label: 'host stopped' });
  assert.equal(p.says('reply').filter((s) => /silent/i.test(s.text)).length, 0);
});

test('unremarkable progress stays [silent]; a phone command reaches the host as [event]', async () => {
  await start();
  p.say('do the slow job');
  await p.nextSay('reply', 'On it.');
  await waitUntil(() => hostInputs().some((l) => l.includes('[worker progress]')), { label: 'progress digest' });
  await p.nextSay('reply', 'Done: do the slow job', { timeout: 6000 });
  const digest = hostInputs().find((l) => l.includes('[worker progress]'));
  assert.match(digest, /\[worker progress\] (Working through the slow job|.*\.)/);
  assert.equal(p.says().filter((s) => /silent/i.test(s.text) || s.kind === 'progress').length, 0);
  // Phone commands still work directly and are also told to the host.
  p.control('pause');
  p.control('status');
  await p.nextSay('reply', /^Status: idle, task do the slow job\./);
  const last = hostInputs().at(-1);
  assert.match(last, /\[event\] The driver used the phone command "pause"; the bridge handled it\.\n\[event\] The driver asked for a status update/);
});

test('barge-in interrupts the host turn and drops its unspoken text', async () => {
  await start();
  p.say('tell me a long story, slow host');
  await p.nextSay('reply', 'This is sentence number 1 of a long answer.');
  p.say('hello again');
  await p.nextSay('reply', /^A mutex is a lock/);
  const told = p.says('reply').filter((s) => s.text.startsWith('This is sentence')).length;
  assert.ok(told < 10, `only the sentences before the barge-in were spoken (${told})`);
  const events = readEvents(driveDirs(b.home)[0]);
  assert.ok(events.some((e) => e.source === 'to_host' && e.data.request?.subtype === 'interrupt'), 'interrupt sent to the host');
  assert.equal(hostInputs().at(-1), '[driver] hello again');
  await sleep(300);
  assert.equal(p.says('reply').filter((s) => s.text.startsWith('This is sentence')).length, told);
});

test('a host that cannot start falls back to basic mode for the drive', async () => {
  process.env.MOCK_HOST_CRASH_ON_START = '1';
  await start();
  p.say('list the files');
  await p.nextSay('notice', 'Voice assistant unavailable. Using basic mode.');
  // The utterance the host never answered goes through the v2 path.
  await p.nextSay('ack', 'Heard: list the files. Starting.');
  await p.nextSay('reply', 'Done: list the files.');
  p.say('and another thing');
  await p.nextSay('ack', 'Heard: and another thing. Starting.');
  assert.equal(p.says('notice').filter((s) => s.text.startsWith('Voice assistant')).length, 1);
});

test('a host that crashes twice within 2 minutes falls back', async () => {
  await start();
  p.say('hello there');
  await p.nextSay('reply', 'Anything else?');
  p.say('please crash host now');
  await p.nextSay('notice', 'Voice assistant unavailable. Using basic mode.', { timeout: 6000 });
  await p.nextSay('ack', 'Heard: please crash host now. Starting.');
  assert.equal(b.session.host, null);
});

test('host off keeps the v2 behaviour (read-back, spoken reply) and starts no host', async () => {
  b = await bridge({ voiceHost: false });
  p = await phone(b);
  p.say('list the files');
  await p.nextSay('ack', 'Heard: list the files. Starting.');
  await p.nextSay('reply', 'Done: list the files.');
  assert.equal(b.session.host, null);
  assert.equal(b.session.mcp, null);
  assert.equal(readEvents(driveDirs(b.home)[0]).filter((e) => e.source === 'to_host').length, 0);
});
