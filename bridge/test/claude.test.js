// claude.js against the mock CLI, without the session on top.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, describe, it } from 'node:test';
import { ClaudeProcess, SUMMARY_ARGS, buildArgs, runSummary } from '../src/claude.js';
import { MOCK, tempHome } from './helpers.js';

const procs = [];
function make(opts = {}) {
  const p = new ClaudeProcess({ bin: MOCK, cwd: tempHome(), initTimeoutMs: 2000, interruptTimeoutMs: 500, killGraceMs: 300, closeWaitMs: 200, ...opts });
  procs.push(p);
  return p;
}

afterEach(async () => {
  for (const p of procs.splice(0)) await p.stop({ graceful: false });
  for (const k of ['MOCK_UNKNOWN_CONTROL', 'MOCK_GARBAGE', 'MOCK_IGNORE_INTERRUPT', 'MOCK_SUMMARY_FAIL']) delete process.env[k];
});

describe('buildArgs', () => {
  it('builds the SPEC 4.1 command line', () => {
    assert.deepEqual(buildArgs({}), [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio',
    ]);
    assert.deepEqual(buildArgs({ model: 'opus', resume: 'abc' }).slice(-4), ['--model', 'opus', '--resume', 'abc']);
  });
});

describe('ClaudeProcess', () => {
  it('initializes, runs a turn and reports tool_use, turn_start and result', async () => {
    const p = make();
    const seen = { tools: [], turns: 0, init: null };
    p.on('tool_use', (t) => seen.tools.push(t.name));
    p.on('turn_start', () => seen.turns++);
    p.on('init', (i) => (seen.init = i));
    p.start();
    p.sendUser('hello there');
    const [result] = await once(p, 'result');
    assert.equal(seen.init.ok, true);
    assert.equal(result.result, 'Done: hello there');
    assert.deepEqual(seen.tools, ['Read', 'Grep', 'Bash']);
    assert.equal(seen.turns, 1);
    assert.match(p.sessionId, /^mock-session-/);
  });

  it('answers unknown control requests with an error and logs bad lines', async () => {
    process.env.MOCK_UNKNOWN_CONTROL = '1';
    process.env.MOCK_GARBAGE = '1';
    const p = make();
    const writes = [];
    const bad = [];
    p.on('stdin', (o) => writes.push(o));
    p.on('bad_line', (l) => bad.push(l));
    p.start();
    await p.ready;
    const reply = writes.find((w) => w.type === 'control_response');
    assert.deepEqual(reply, { type: 'control_response', response: { subtype: 'error', request_id: 'mock-unknown-1', error: 'unsupported by earpiece' } });
    assert.deepEqual(bad, ['this line is not json']);
  });

  it('round-trips can_use_tool with allow', async () => {
    const p = make();
    p.on('can_use_tool', (req) => {
      assert.equal(req.toolName, 'AskUserQuestion');
      p.allow(req.requestId, { ...req.input, answers: { [req.input.questions[0].question]: 'Redis' } });
    });
    p.start();
    p.sendUser('ask me something');
    const [result] = await once(p, 'result');
    assert.equal(result.result, 'You chose Redis.');
  });

  it('interrupt resolves true when the CLI answers, false when it does not', async () => {
    const p = make();
    p.start();
    p.sendUser('something slow');
    await once(p, 'tool_use');
    assert.equal(await p.interrupt(), true);
    const [result] = await once(p, 'result');
    assert.equal(result.subtype, 'error_during_execution');

    process.env.MOCK_IGNORE_INTERRUPT = '1';
    const q = make();
    q.start();
    q.sendUser('something slow');
    await once(q, 'tool_use');
    const t0 = Date.now();
    assert.equal(await q.interrupt(), false);
    assert.ok(Date.now() - t0 >= 450);
    const exit = once(q, 'exit');
    await q.stop({ graceful: false });
    const [info] = await exit;
    assert.equal(info.expected, true);
  });

  it('reports an unexpected exit', async () => {
    const p = make();
    p.start();
    p.sendUser('please crash now');
    const [info] = await once(p, 'exit');
    assert.equal(info.expected, false);
    assert.equal(info.code, 3);
  });

  it('reports a missing binary as an exit with an error', async () => {
    const p = make({ bin: '/nonexistent/claude-binary' });
    p.start();
    const [info] = await once(p, 'exit');
    assert.match(info.error, /ENOENT/);
  });
});

describe('runSummary', () => {
  it('passes --no-session-persistence so summaries never become chats', () => {
    assert.deepEqual(SUMMARY_ARGS, ['-p', '--model', 'haiku', '--output-format', 'text', '--no-session-persistence']);
  });

  it('pipes the transcript to `-p --model haiku --output-format text`', async () => {
    const out = await runSummary({ bin: MOCK, transcript: 'x'.repeat(123), cwd: tempHome() });
    assert.match(out, /Mock summary \(model haiku, format text\) of 123 characters/);
    assert.match(out, /Prompt: Summarize this voice coding session/);
  });

  it('rejects with the CLI error', async () => {
    process.env.MOCK_SUMMARY_FAIL = '1';
    await assert.rejects(runSummary({ bin: MOCK, transcript: 'x', cwd: tempHome() }), /summary failed on purpose/);
  });
});
