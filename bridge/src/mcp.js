// A minimal MCP server over HTTP for the voice host (SPEC 13.2). Zero dependencies.
// JSON-RPC 2.0 over POST with application/json responses only (no SSE): initialize,
// notifications/initialized, tools/list, tools/call, ping. GET returns 405 (no server stream),
// a notification (or a client response) returns 202. Bound to 127.0.0.1 on a random port; every
// request must carry the per-run secret header.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export const MCP_PATH = '/mcp';
export const SECRET_HEADER = 'x-earpiece-secret';
const LATEST_VERSION = '2025-06-18';

function sameSecret(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

export class McpServer {
  /**
   * @param {object} o
   * @param {Array<{name:string, description:string, inputSchema?:object, handler:(args:object)=>any}>} o.tools
   * @param {string} [o.secret]
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ tools = [], secret = randomBytes(24).toString('hex'), name = 'earpiece', version = '0.1.0', host = '127.0.0.1', port = 0, log = () => {}, maxBody = 1024 * 1024 } = {}) {
    this.secret = secret;
    this.info = { name, version };
    this.host = host;
    this.wantPort = port;
    this.port = null;
    this.log = log;
    this.maxBody = maxBody;
    this.tools = new Map();
    for (const t of tools) this.tools.set(t.name, t);
    this.server = null;
  }

  get url() {
    return `http://${this.host}:${this.port}${MCP_PATH}`;
  }

  /** The --mcp-config JSON string for the CLI. */
  mcpConfig(serverName = 'earpiece') {
    return JSON.stringify({ mcpServers: { [serverName]: { type: 'http', url: this.url, headers: { 'X-Earpiece-Secret': this.secret } } } });
  }

  start() {
    if (this.server) return Promise.resolve(this.port);
    this.server = http.createServer((req, res) => {
      this._onRequest(req, res).catch((err) => {
        this.log(`mcp: ${err?.stack ?? err}`);
        if (!res.headersSent) this._json(res, 500, rpcError(null, -32603, 'Internal error'));
      });
    });
    this.server.keepAliveTimeout = 65_000;
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.wantPort, this.host, () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  close() {
    const s = this.server;
    if (!s) return Promise.resolve();
    this.server = null;
    return new Promise((r) => {
      s.close(() => r());
      s.closeAllConnections?.();
    });
  }

  _json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  async _onRequest(req, res) {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://mcp').pathname;
    } catch {
      /* 404 below */
    }
    if (pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
      return;
    }
    if (!sameSecret(req.headers[SECRET_HEADER], this.secret)) {
      req.resume();
      this._json(res, 401, rpcError(null, -32001, 'Unauthorized'));
      return;
    }
    if (req.method !== 'POST') {
      req.resume();
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' });
      res.end('Method not allowed\n');
      return;
    }
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > this.maxBody) {
        this._json(res, 413, rpcError(null, -32600, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    }
    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      this._json(res, 400, rpcError(null, -32700, 'Parse error'));
      return;
    }
    if (Array.isArray(msg)) {
      if (!msg.length) return this._json(res, 400, rpcError(null, -32600, 'Invalid Request'));
      const out = (await Promise.all(msg.map((m) => this.handle(m)))).filter(Boolean);
      if (!out.length) return void this._accepted(res);
      return this._json(res, 200, out);
    }
    const reply = await this.handle(msg);
    if (!reply) return void this._accepted(res);
    this._json(res, 200, reply);
  }

  _accepted(res) {
    res.writeHead(202);
    res.end();
  }

  /** One JSON-RPC message. Returns the response object, or null for notifications and client responses. */
  async handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
    const isRequest = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method !== 'string') {
      // A response from the client (we never send requests) or garbage.
      if (isRequest && (msg.result !== undefined || msg.error !== undefined)) return null;
      return rpcError(msg.id, -32600, 'Invalid Request');
    }
    if (!isRequest) return null; // notifications/initialized, notifications/cancelled, ...
    const id = msg.id;
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    switch (msg.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion) ? params.protocolVersion : LATEST_VERSION;
        return rpcResult(id, { protocolVersion: asked, capabilities: { tools: { listChanged: false } }, serverInfo: this.info });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          })),
        });
      case 'tools/call': {
        const tool = this.tools.get(params.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}`);
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          const value = await tool.handler(args);
          const text = typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true });
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          this.log(`mcp tool ${tool.name} failed: ${err?.stack ?? err}`);
          return rpcResult(id, { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  }
}
