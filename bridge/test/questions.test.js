import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyYesNo, formatQuestion, matchAnswer, permissionSummary } from '../src/questions.js';

const DB = [
  { label: 'Postgres', description: 'Relational' },
  { label: 'SQLite', description: 'File' },
  { label: 'Redis', description: 'Cache' },
];

describe('formatQuestion', () => {
  it('reads labels only, numbered', () => {
    assert.equal(
      formatQuestion({ question: 'Which database?', options: DB, multiSelect: false }),
      'Which database? Option one: Postgres. Option two: SQLite. Option three: Redis.',
    );
  });
  it('adds the multi-select hint', () => {
    assert.match(formatQuestion({ question: 'Which checks', options: DB, multiSelect: true }), /^Which checks\? .* You can pick more than one\.$/);
  });
});

describe('matchAnswer (single select)', () => {
  const pick = (a) => matchAnswer(a, DB, false).answer;
  it('matches number words, digits and ordinals', () => {
    assert.equal(pick('one'), 'Postgres');
    assert.equal(pick('2'), 'SQLite');
    assert.equal(pick('first'), 'Postgres');
    assert.equal(pick('option two'), 'SQLite');
    assert.equal(pick('the second one'), 'SQLite');
    assert.equal(pick('number 3'), 'Redis');
    assert.equal(pick('Option to.'), 'SQLite', 'STT homophone after "option"');
  });
  it('matches labels, case-insensitively, inside a sentence', () => {
    assert.equal(pick('let us go with redis please'), 'Redis');
    assert.equal(pick('SQLITE'), 'SQLite');
  });
  it('matches when the label contains the answer (3+ chars)', () => {
    assert.equal(pick('post'), 'Postgres');
    const short = matchAnswer('po', DB, false);
    assert.equal(short.free, true);
  });
  it('falls back to free text', () => {
    const m = matchAnswer('use whatever the team uses today', DB, false);
    assert.equal(m.free, true);
    assert.equal(m.answer, 'use whatever the team uses today');
  });
  it('ignores numbers in long free text unless cued', () => {
    assert.equal(matchAnswer('I think we should run two replicas for safety here', DB, false).free, true);
    assert.equal(pick('I think we should go with option three for this one'), 'Redis');
  });
  it('prefers an exact label even if it contains a number', () => {
    const opts = [{ label: 'Python 3' }, { label: 'Python 2' }];
    assert.equal(matchAnswer('python 2', opts, false).answer, 'Python 2');
  });
});

describe('matchAnswer (multiSelect)', () => {
  const CHECKS = [{ label: 'Unit tests' }, { label: 'Lint' }, { label: 'Type check' }];
  it('collects numbers and labels, joined with ", " in option order', () => {
    assert.equal(matchAnswer('one and three', CHECKS, true).answer, 'Unit tests, Type check');
    assert.equal(matchAnswer('type check and lint', CHECKS, true).answer, 'Lint, Type check');
    assert.equal(matchAnswer('the first one and lint', CHECKS, true).answer, 'Unit tests, Lint');
  });
  it('does not double count a label inside a longer label', () => {
    const opts = [{ label: 'Redis' }, { label: 'Redis cluster' }];
    assert.equal(matchAnswer('redis cluster', opts, true).answer, 'Redis cluster');
  });
});

describe('classifyYesNo', () => {
  it('recognises yes words', () => {
    for (const s of ['yes', 'Yeah.', 'yep', 'allow', 'go ahead', 'do it', 'sure', 'okay', 'OK!', 'yes please', 'yeah go ahead']) {
      assert.equal(classifyYesNo(s), 'yes', s);
    }
  });
  it('recognises no words', () => {
    for (const s of ['no', 'nope', "don't", 'deny', 'stop', 'skip', 'no thanks', "don't do that", 'do not']) {
      assert.equal(classifyYesNo(s), 'no', s);
    }
  });
  it('treats anything else as a reply', () => {
    for (const s of ['yes but only in the test folder', 'use the staging database instead', 'maybe', '']) {
      assert.equal(classifyYesNo(s), 'other', s);
    }
  });
});

describe('permissionSummary', () => {
  it('summarises Bash with the description or the command', () => {
    assert.equal(permissionSummary('Bash', { command: 'rm -rf build', description: 'Delete the build folder' }), 'run: Delete the build folder');
    assert.equal(permissionSummary('Bash', { command: `echo ${'x'.repeat(100)}` }).length, 'run: '.length + 80);
  });
  it('summarises other tools with a basename or short input', () => {
    assert.equal(permissionSummary('Write', { file_path: '/Users/me/app/.env', content: 'x' }), 'use Write on .env');
    assert.equal(permissionSummary('WebFetch', { url: 'https://docs.example.com/x' }), 'use WebFetch on docs.example.com');
    assert.equal(permissionSummary('mcp__github__create_issue', { title: 'Bug' }), 'use github create issue on Bug');
  });
});
