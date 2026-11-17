import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Narrator, describeTool } from '../src/narrator.js';

describe('describeTool', () => {
  it('uses the fixed templates', () => {
    assert.equal(describeTool('Read', { file_path: '/a/b/server.js' }), 'Reading server.js.');
    assert.equal(describeTool('MultiEdit', { file_path: '/a/b/c.ts' }), 'Editing c.ts.');
    assert.equal(describeTool('NotebookEdit', { notebook_path: '/a/n.ipynb' }), 'Editing n.ipynb.');
    assert.equal(describeTool('Glob', { pattern: '**/*.js' }), 'Searching the code.');
    assert.equal(describeTool('Bash', { command: 'npm test', description: 'Run the unit tests' }), 'Run the unit tests.');
    assert.equal(describeTool('Bash', { command: 'ls' }), 'Running a command.');
    assert.equal(describeTool('WebSearch', { query: 'node websocket rfc' }), 'Searching the web for node websocket rfc.');
    assert.equal(describeTool('WebFetch', { url: 'https://x.y' }), 'Reading a web page.');
    assert.equal(describeTool('Task', { description: 'Review the diff' }), 'Started a helper agent: Review the diff.');
    assert.equal(describeTool('Agent', { description: 'Find usages' }), 'Started a helper agent: Find usages.');
    assert.equal(describeTool('TodoWrite', {}), null);
    assert.equal(describeTool('LSP', {}), 'Using LSP.');
  });
});

function setup(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const lines = [];
  let speak = true;
  const n = new Narrator({ delayMs: 6000, intervalMs: 35_000, emit: (l) => lines.push(l), canSpeak: () => speak, ...opts });
  return { n, lines, tick: (ms) => t.mock.timers.tick(ms), setSpeak: (v) => (speak = v) };
}

describe('Narrator throttling', () => {
  it('says nothing in the first 6 s, then the latest action with a step count', (t) => {
    const { n, lines, tick } = setup(t);
    n.startTurn();
    n.onToolUse('Read', { file_path: '/x/a.js' });
    tick(1000);
    n.onToolUse('Grep', {});
    tick(1000);
    n.onToolUse('Bash', { description: 'Run the tests' });
    assert.deepEqual(lines, []);
    tick(4000);
    assert.deepEqual(lines, ['3 steps so far. Run the tests.']);
  });

  it('allows at most one line per interval and no prefix for a single action', (t) => {
    const { n, lines, tick } = setup(t);
    n.startTurn();
    tick(7000);
    n.onToolUse('Read', { file_path: '/x/a.js' });
    assert.deepEqual(lines, ['Reading a.js.']);
    tick(1000);
    n.onToolUse('Read', { file_path: '/x/b.js' });
    tick(10_000);
    n.onToolUse('Edit', { file_path: '/x/b.js' });
    assert.equal(lines.length, 1);
    tick(24_000);
    assert.deepEqual(lines, ['Reading a.js.', '3 steps so far. Editing b.js.']);
    tick(35_000);
    n.onToolUse('Read', { file_path: '/x/c.js' });
    assert.deepEqual(lines.at(-1), 'Reading c.js.');
  });

  it('skips TodoWrite entirely', (t) => {
    const { n, lines, tick } = setup(t);
    n.startTurn();
    n.onToolUse('TodoWrite', {});
    tick(10_000);
    assert.deepEqual(lines, []);
  });

  it('holds lines while it cannot speak and catches up on poke', (t) => {
    const { n, lines, tick, setSpeak } = setup(t);
    n.startTurn();
    setSpeak(false);
    n.onToolUse('Read', { file_path: '/x/a.js' });
    tick(7000);
    assert.deepEqual(lines, []);
    setSpeak(true);
    n.poke();
    assert.deepEqual(lines, ['Reading a.js.']);
  });

  it('prefers a task_summary that arrived since the last line', (t) => {
    const { n, lines, tick } = setup(t);
    n.startTurn();
    n.onToolUse('Bash', { command: 'sleep 30' });
    n.onTaskSummary('Sleeping 30 seconds then echo done');
    n.onToolUse('Read', { file_path: '/x/a.js' });
    tick(6000);
    assert.deepEqual(lines, ['2 steps so far. Sleeping 30 seconds then echo done.']);
    tick(35_000);
    n.onToolUse('Read', { file_path: '/x/b.js' });
    assert.equal(lines.at(-1), 'Reading b.js.', 'falls back to templates once the summary was used');
    n.onTaskSummary(null);
    assert.equal(lines.length, 2);
  });

  it('endTurn cancels anything pending and clearPending drops old actions', (t) => {
    const { n, lines, tick } = setup(t);
    n.startTurn();
    n.onToolUse('Read', { file_path: '/x/a.js' });
    n.endTurn();
    tick(10_000);
    assert.deepEqual(lines, []);
    n.startTurn();
    n.onToolUse('Read', { file_path: '/x/a.js' });
    n.clearPending();
    tick(10_000);
    assert.deepEqual(lines, []);
    assert.equal(n.lastAction.line, 'Reading a.js.');
  });
});
