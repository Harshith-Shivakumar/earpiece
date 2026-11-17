// The minimal HTTP MCP server for the voice host (SPEC 13.2).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { McpServer } from '../src/mcp.js';

let mcp;
const calls = [];
before(async () => {
  mcp = new McpServer({
    secret: 's3cret',
    tools: [
      { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, handler: (a) => (calls.push(a), { said: a.text }) },
      { name: 'plain', description: 'Text result', handler: () => 'just text' },
      { name: 'boom', description: 'Throws', handler: () => { throw new Error('it broke'); } },
    ],
  });
  await mcp.start();
});
after(() => mcp.close());

async function post(body, { secret = 's3cret', path = '/mcp', method = 'POST', raw = false } = {}) {
  const r = await fetch(`http://127.0.0.1:${mcp.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(secret ? { 'X-Earpiece-Secret': secret } : {}) },
    body: method === 'POST' ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type'), body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
}

test('config points the CLI at 127.0.0.1 with the secret header', () => {
  const cfg = JSON.parse(mcp.mcpConfig());
  assert.deepEqual(cfg.mcpServers.earpiece, { type: 'http', url: `http://127.0.0.1:${mcp.port}/mcp`, headers: { 'X-Earpiece-Secret': 's3cret' } });
});

test('initialize echoes the protocol version and announces tools', async () => {
  const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't' } } });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.equal(r.body.id, 1);
  assert.equal(r.body.result.protocolVersion, '2025-11-25');
  assert.ok(r.body.result.capabilities.tools);
  assert.equal(r.body.result.serverInfo.name, 'earpiece');
});

test('notifications and client responses get 202 with no body', async () => {
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await post({ jsonrpc: '2.0', id: 9, result: {} })).status, 202);
});

test('ping, tools/list and tools/call', async () => {
  assert.deepEqual((await post({ jsonrpc: '2.0', id: 2, method: 'ping' })).body.result, {});
  const list = (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).body.result.tools;
  assert.deepEqual(list.map((t) => t.name), ['echo', 'plain', 'boom']);
  assert.deepEqual(list[1].inputSchema, { type: 'object', properties: {} });
  const r = await post({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
  assert.equal(r.body.id, 'a');
  assert.deepEqual(r.body.result, { content: [{ type: 'text', text: '{"said":"hi"}' }], isError: false });
  assert.deepEqual(calls.at(-1), { text: 'hi' });
  const p = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'plain' } });
  assert.equal(p.body.result.content[0].text, 'just text');
});

test('a throwing tool is a tool error, an unknown tool or method a JSON-RPC error', async () => {
  const b = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(b.body.result.isError, true);
  assert.equal(b.body.result.content[0].text, 'it broke');
  assert.equal((await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).body.error.code, -32602);
  assert.equal((await post({ jsonrpc: '2.0', id: 7, method: 'server/discover' })).body.error.code, -32601);
  assert.equal((await post({ jsonrpc: '2.0', id: 8 })).body.error.code, -32600);
});

test('batches, bad JSON, GET, wrong path and wrong secret', async () => {
  const batch = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.body, [{ jsonrpc: '2.0', id: 1, result: {} }]);
  const bad = await post('{nope', { raw: true });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, -32700);
  assert.equal((await post(null, { method: 'GET' })).status, 405);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { path: '/other' })).status, 404);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { secret: 'wrong' })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { secret: null })).status, 401);
});
