// chats.js against fixture chat files (SPEC 10.2).

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { chatCwd, findChat, isChatId, isUnder, listChats, publicChat, realUserText } from '../src/chats.js';
import { assistant, tempHome, user, writeChatFile } from './helpers.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let root;
let work;
let other;

before(() => {
  const home = tempHome();
  root = join(home, 'projects');
  work = join(home, 'work');
  other = join(home, 'other');
  mkdirSync(work, { recursive: true });
  mkdirSync(other, { recursive: true });
  const gone = join(home, 'deleted-folder');

  // Custom title (the last one wins), cwd moves from work to other, source from the last user entry.
  writeChatFile(root, {
    id: 'titled',
    ageMs: 5 * MIN,
    entries: [
      user(work, 'set up the project'),
      { type: 'custom-title', customTitle: 'Old name', sessionId: 'titled' },
      assistant(work, 'done'),
      { type: 'custom-title', customTitle: 'Uploader timeouts', sessionId: 'titled' },
      user(other, 'now the other folder', { entrypoint: 'claude-desktop' }),
      { type: 'last-prompt', lastPrompt: 'now the other folder' },
    ],
  });
  // No custom title: skip meta, tool results, our own messages and slash commands; cut to 60 chars.
  writeChatFile(root, {
    id: 'untitled',
    ageMs: 20 * MIN,
    entries: [
      'this line is not json',
      user(work, 'Caveat: local command output follows', { isMeta: true }),
      user(work, [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }]),
      user(work, '[Earpiece] Voice mode ON. The driver has stepped away...'),
      user(work, '<command-name>/model</command-name>'),
      user(work, [{ type: 'text', text: 'Please refactor the payment retry logic so that it backs off exponentially and logs' }]),
      '{"broken": ',
      user(work, 'second message', { entrypoint: 'sdk-cli' }),
    ],
  });
  // Only our own and meta messages: no real user message -> skipped.
  writeChatFile(root, { id: 'only-earpiece', ageMs: 2 * MIN, entries: [user(work, '[Earpiece] Voice mode ON.'), user(work, 'meta', { isMeta: true })] });
  // Both folders gone -> skipped.
  writeChatFile(root, { project: 'proj2', id: 'gone', ageMs: 3 * MIN, entries: [user(gone, 'hello there')] });
  // Last cwd gone but the origin exists -> kept, opens in the origin.
  writeChatFile(root, { project: 'proj2', id: 'moved', ageMs: 30 * MIN, entries: [user(work, 'start here'), user(gone, 'then moved')] });
  // Too old.
  writeChatFile(root, { project: 'proj3', id: 'ancient', ageMs: 40 * DAY, entries: [user(work, 'old work')] });
  // Sub-folders (subagents) and non-chat files are ignored.
  writeChatFile(root, { project: join('proj', 'titled', 'subagents'), id: 'agent-abc', ageMs: MIN, entries: [user(work, 'subagent task')] });
  writeFileSync(join(root, 'proj', 'notes.txt'), 'not a chat');
  writeChatFile(root, { project: 'proj', id: '..bad id', ageMs: MIN, entries: [user(work, 'weird name')] });
  // Active right now.
  writeChatFile(root, { project: 'proj4', id: 'busy', ageMs: 30_000, entries: [user(work, 'in use at the desk')] });
});

describe('listChats', () => {
  it('lists recent chats newest first with the right fields', async () => {
    const items = await listChats({ root });
    assert.deepEqual(items.map((c) => c.id), ['busy', 'titled', 'untitled', 'moved']);
    const titled = items.find((c) => c.id === 'titled');
    assert.equal(titled.title, 'Uploader timeouts');
    // A chat's home is where it started, even if it later worked in another folder.
    assert.equal(titled.cwd, work);
    assert.equal(titled.origin_cwd, work);
    assert.equal(titled.folder, basename(work));
    assert.equal(chatCwd(titled, '/fallback'), work);
    assert.equal(titled.source, 'claude-desktop');
    assert.equal(titled.recently_active, false);
    assert.equal(titled.current, false);
    assert.ok(Math.abs(Date.parse(titled.updated_at) - (Date.now() - 5 * MIN)) < 5000);
  });

  it('builds a title from the first real user message, cut to 60 characters', async () => {
    const c = (await listChats({ root })).find((x) => x.id === 'untitled');
    assert.equal(c.title, 'Please refactor the payment retry logic so that it backs off');
    assert.ok(c.title.length <= 60);
    assert.equal(c.source, 'sdk-cli');
  });

  it('keeps a chat whose last folder is gone and opens it where it started', async () => {
    const c = (await listChats({ root })).find((x) => x.id === 'moved');
    assert.equal(c.cwd, work);
    assert.equal(chatCwd(c, '/fallback'), work);
    assert.equal(chatCwd({ cwd: '/nope/a', origin_cwd: '/nope/b' }, '/fallback'), '/fallback');
  });

  it('marks recently active chats unless the bridge is running them', async () => {
    let busy = (await listChats({ root })).find((x) => x.id === 'busy');
    assert.equal(busy.recently_active, true);
    busy = (await listChats({ root, currentId: 'busy' })).find((x) => x.id === 'busy');
    assert.equal(busy.recently_active, false);
    assert.equal(busy.current, true);
  });

  it('returns at most 20', async () => {
    const big = join(tempHome(), 'projects');
    for (let i = 0; i < 25; i++) writeChatFile(big, { id: `chat-${i}`, ageMs: (i + 1) * MIN, entries: [user(work, `task ${i}`)] });
    const items = await listChats({ root: big });
    assert.equal(items.length, 20);
    assert.equal(items[0].id, 'chat-0');
    assert.equal(items[19].id, 'chat-19');
  });

  it('returns an empty list for a missing root', async () => {
    assert.deepEqual(await listChats({ root: join(tempHome(), 'nope') }), []);
  });

  it('exposes only the protocol fields', async () => {
    const c = (await listChats({ root }))[0];
    assert.deepEqual(Object.keys(publicChat(c)).sort(), ['current', 'cwd', 'folder', 'id', 'recently_active', 'source', 'title', 'updated_at']);
  });
});

describe('findChat and helpers', () => {
  it('finds any chat by id, regardless of age', async () => {
    assert.equal((await findChat({ root, id: 'ancient' })).title, 'old work');
    assert.equal((await findChat({ root, id: 'only-earpiece' })).title, 'Untitled chat');
    assert.equal(await findChat({ root, id: 'missing' }), null);
    assert.equal(await findChat({ root, id: '../etc/passwd' }), null);
  });

  it('validates ids and recognises real user messages', () => {
    assert.equal(isChatId('0f3c9a2e-1b2c-4d5e-8f90-123456789abc'), true);
    assert.equal(isChatId('../x'), false);
    assert.equal(isChatId(''), false);
    assert.equal(realUserText(user(work, '  hi  there ')), 'hi there');
    assert.equal(realUserText(user(work, '[Earpiece] Voice mode OFF.')), null);
    assert.equal(realUserText(user(work, 'x', { isSidechain: true })), null);
    assert.equal(realUserText({ type: 'assistant', message: { content: 'x' } }), null);
  });

  it('hides chats that started inside an excluded folder (old Earpiece drive summaries)', async () => {
    const all = await listChats({ root });
    const hidden = await listChats({ root, excludeDirs: [work] });
    assert.ok(all.length > hidden.length);
    assert.ok(hidden.every((c) => !isUnder(c.origin_cwd, [work])));
    assert.equal(isUnder('/a/b/c', ['/a/b']), true);
    assert.equal(isUnder('/a/bc', ['/a/b']), false);
  });
});
