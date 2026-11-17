#!/usr/bin/env node
// Test double for the Claude Code CLI. Speaks the SPEC section 4 stream-json control protocol
// over stdin/stdout. Behaviour is driven by words in the user message:
//   "slow"        many tool_use steps (MOCK_SLOW_STEPS, default 40), with task_summary events
//   "ask me"      AskUserQuestion (single select); with "multi": multiSelect; with "twice": 2 questions
//   "permission"  a Bash permission request
//   "switch to X" final text ends with "EARPIECE_SWITCH: X"
//   "code please" final text contains a fenced code block
//   "crash"       exits with code 3 in the middle of the turn
//   "background"  ~MOCK_BACKGROUND_MS (2000) after the result, starts an unsolicited turn
//   "limit"       rate_limit_event (rejected) and an error result
// Messages starting with "[Earpiece]" (voice on/off, folder switch) are answered directly:
//   "... spoken recap ..."      -> "Recap: we were working on <last real user message in this chat>."
//   "... continued at a screen" -> "At the desk you said: <last real user message in this chat>."
//   "You are now working in X"  -> "Ready in <basename of this process's cwd>."
//   "... Reply only: <text>"    -> <text>
// Env: MOCK_STEP_MS, MOCK_IGNORE_INTERRUPT, MOCK_CRASH_ON_START, MOCK_UNKNOWN_CONTROL,
//      MOCK_GARBAGE, MOCK_SUMMARY_FAIL,
//      MOCK_ARGV_LOG     append {pid, argv, cwd, resume, sessionId} as one JSON line per start
//      MOCK_PROJECTS_DIR emulate chat files like the real CLI: <dir>/<project>/<session id>.jsonl,
//                        appended in place when started with --resume <id> (from any cwd)
// Summary mode (`-p` without --input-format): reads stdin, prints a markdown summary.
// Host mode (started with --mcp-config, SPEC 13): plays the voice host. It does the MCP handshake
// against the URL and secret header from --mcp-config, then answers tagged lines (see hostMode).

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const STEP = Number(process.env.MOCK_STEP_MS ?? 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (has('-p') && !has('--input-format')) {
  await summaryMode();
} else if (has('--mcp-config')) {
  hostMode();
} else {
  streamMode();
}

async function summaryMode() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  if (process.env.MOCK_SUMMARY_FAIL) {
    process.stderr.write('mock: summary failed on purpose\n');
    process.exit(2);
  }
  const prompt = argv[argv.length - 1] ?? '';
  process.stdout.write(
    `# Drive summary\n\nMock summary (model ${opt('--model')}, format ${opt('--output-format')}) of ${input.length} characters.\nPrompt: ${prompt.slice(0, 40)}\n`,
  );
}

function streamMode() {
  if (process.env.MOCK_CRASH_ON_START) {
    process.stderr.write('mock: crashing on start\n');
    setTimeout(() => process.exit(4), 20);
    return;
  }
  const sessionId = opt('--resume') ?? `mock-session-${randomBytes(4).toString('hex')}`;
  const cwd = process.cwd();
  if (process.env.MOCK_ARGV_LOG) {
    appendFileSync(process.env.MOCK_ARGV_LOG, `${JSON.stringify({ pid: process.pid, argv, cwd, resume: opt('--resume') ?? null, sessionId })}\n`);
  }

  // Chat file emulation (only when MOCK_PROJECTS_DIR is set). Created on the first message.
  const projects = process.env.MOCK_PROJECTS_DIR;
  let chatFile = null;
  function findChatFile() {
    if (!projects) return null;
    if (chatFile) return chatFile;
    if (existsSync(projects)) {
      for (const d of readdirSync(projects)) {
        const f = join(projects, d, `${sessionId}.jsonl`);
        if (existsSync(f)) return (chatFile = f);
      }
    }
    const dir = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    return (chatFile = join(dir, `${sessionId}.jsonl`));
  }
  function record(entry) {
    const f = findChatFile();
    if (f) appendFileSync(f, `${JSON.stringify({ ...entry, cwd, sessionId, timestamp: new Date().toISOString() })}\n`);
  }
  function lastRealUserText() {
    const f = findChatFile();
    if (!f || !existsSync(f)) return null;
    let last = null;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(line);
        const c = e.message?.content;
        if (e.type === 'user' && typeof c === 'string' && !c.startsWith('[Earpiece]')) last = c;
      } catch {
        /* skip */
      }
    }
    return last;
  }
  const pending = new Map();
  const queue = [];
  let busy = false;
  let turn = null;
  let reqCounter = 0;
  let stdinClosed = false;

  if (process.env.MOCK_GARBAGE) process.stdout.write('this line is not json\n');
  if (process.env.MOCK_UNKNOWN_CONTROL) {
    out({ type: 'control_request', request_id: 'mock-unknown-1', request: { subtype: 'hook_callback', callback_id: 'x' } });
  }
  process.on('SIGTERM', () => process.exit(0));

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'control_request') {
      const sub = msg.request?.subtype;
      if (sub === 'initialize') {
        out({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' });
        out({
          type: 'control_response',
          response: { subtype: 'success', request_id: msg.request_id, response: { commands: [], models: [] } },
        });
        return;
      }
      if (sub === 'interrupt') {
        if (process.env.MOCK_IGNORE_INTERRUPT) return;
        if (turn) turn.interrupted = true;
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
        return;
      }
      out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'mock: unsupported' } });
      return;
    }
    if (msg.type === 'control_response') {
      const r = msg.response ?? {};
      out({ type: 'system', subtype: 'mock_saw_response', response: r });
      const cb = pending.get(r.request_id);
      if (cb) {
        pending.delete(r.request_id);
        cb(r);
      }
      return;
    }
    if (msg.type === 'user') {
      queue.push(msg);
      pump();
    }
  });
  rl.on('close', () => {
    stdinClosed = true;
    if (!busy) process.exit(0);
  });

  function ask(request) {
    reqCounter += 1;
    const id = `mock-req-${reqCounter}`;
    out({ type: 'control_request', request_id: id, request });
    return new Promise((resolve) => pending.set(id, resolve));
  }

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const msg = queue.shift();
      turn = { interrupted: false };
      if (msg.__background) await backgroundTurn();
      else await runTurn(msg, turn);
      turn = null;
    }
    busy = false;
    if (stdinClosed) process.exit(0);
  }

  function startTurn() {
    out({ type: 'system', subtype: 'init', session_id: sessionId, cwd, model: 'mock-model', permissionMode: opt('--permission-mode'), tools: ['Read', 'Bash'] });
  }

  function result(t0, text, extra = {}) {
    record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
    out({ type: 'system', subtype: 'post_turn_summary', status_category: 'completed', status_detail: `handled: ${text.slice(0, 40)}`, needs_action: '' });
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: sessionId,
      total_cost_usd: 0.0012,
      duration_ms: Date.now() - t0,
      num_turns: 1,
      permission_denials: [],
      ...extra,
    });
  }

  function interruptedResult(t0) {
    out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId, duration_ms: Date.now() - t0 });
  }

  async function backgroundTurn() {
    const t0 = Date.now();
    out({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed' });
    startTurn();
    await sleep(STEP);
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Read', input: { file_path: join(cwd, 'build.log') } }] }, parent_tool_use_id: null });
    await sleep(STEP);
    result(t0, 'The background build finished and it passed.');
  }

  async function runTurn(msg, t) {
    const text = typeof msg.message?.content === 'string' ? msg.message.content : JSON.stringify(msg.message?.content ?? '');
    const lower = text.toLowerCase();
    const t0 = Date.now();
    // Read the recap source before this message is recorded.
    const recapOf = text.startsWith('[Earpiece]') ? lastRealUserText() : null;
    record({ type: 'user', entrypoint: 'sdk-cli', isSidechain: false, message: { role: 'user', content: text } });
    startTurn();

    if (text.startsWith('[Earpiece]')) {
      await sleep(STEP);
      if (text.includes('continued at a screen')) return result(t0, `At the desk you said: ${recapOf ?? 'nothing'}.`);
      if (text.includes('spoken recap')) return result(t0, `Recap: we were working on ${recapOf ?? 'nothing yet'}.`);
      if (text.includes('You are now working in')) return result(t0, `Ready in ${basename(cwd)}.`);
      const m = text.match(/Reply only: (.*)$/m);
      return result(t0, m ? m[1].trim() : 'OK.');
    }
    if (lower.includes('limit')) {
      await sleep(STEP);
      out({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', isUsingOverage: false },
      });
      await sleep(STEP);
      return out({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "You've hit your limit · resets 4:30pm",
        api_error_status: 429,
        session_id: sessionId,
        duration_ms: Date.now() - t0,
      });
    }

    const tools = [
      ['Read', { file_path: join(cwd, 'src', 'app.js') }],
      ['Grep', { pattern: 'timeout' }],
      ['Bash', { command: 'npm test', description: 'Run the tests' }],
      ['TodoWrite', { todos: [] }],
    ];
    const steps = lower.includes('slow') ? Number(process.env.MOCK_SLOW_STEPS ?? 40) : 3;
    for (let i = 0; i < steps; i++) {
      await sleep(STEP);
      if (t.interrupted) return interruptedResult(t0);
      if (lower.includes('crash') && i === 1) {
        process.stderr.write('mock: crashing on purpose\n');
        process.exit(3);
      }
      if (lower.includes('slow') && i === 5) out({ type: 'system', subtype: 'task_summary', detail: 'Working through the slow job' });
      const [name, input] = tools[i % tools.length];
      const id = `toolu_${i}`;
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null, session_id: sessionId });
      out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(800) }] }, parent_tool_use_id: null, session_id: sessionId });
    }

    if (lower.includes('ask me')) {
      const db = {
        question: 'Which database should I use?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'Postgres', description: 'Relational, the usual choice' },
          { label: 'SQLite', description: 'A single file' },
          { label: 'Redis', description: 'In-memory' },
        ],
      };
      let questions = [db];
      if (lower.includes('multi')) {
        questions = [{
          question: 'Which checks should I run?',
          header: 'Checks',
          multiSelect: true,
          options: [{ label: 'Unit tests', description: 'fast' }, { label: 'Lint', description: 'style' }, { label: 'Type check', description: 'tsc' }],
        }];
      } else if (lower.includes('twice')) {
        questions = [db, { question: 'Should I add an index?', header: 'Index', multiSelect: false, options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] }];
      }
      const input = { questions };
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ask', name: 'AskUserQuestion', input }] }, parent_tool_use_id: null });
      const r = await ask({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: 'toolu_ask', requires_user_interaction: true });
      if (t.interrupted) return interruptedResult(t0);
      const res = r.response ?? {};
      if (res.behavior === 'allow') return result(t0, `You chose ${Object.values(res.updatedInput?.answers ?? {}).join(' and ')}.`);
      return result(t0, `Okay, skipping the question. ${res.message ?? ''}`);
    }

    if (lower.includes('permission')) {
      const input = { command: 'rm -rf /tmp/earpiece-mock/build', description: 'Delete the build folder' };
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_perm', name: 'Bash', input }] }, parent_tool_use_id: null });
      const r = await ask({ subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: 'toolu_perm', description: 'Delete the build folder' });
      if (t.interrupted) return interruptedResult(t0);
      const res = r.response ?? {};
      if (res.behavior === 'allow') return result(t0, 'Deleted the build folder.');
      return result(t0, `I did not delete it. ${res.message ?? ''}`);
    }

    const sw = text.match(/switch to (\S+)/i);
    if (sw) return result(t0, `Found the folder.\nEARPIECE_SWITCH: ${sw[1]}`);

    if (lower.includes('code please')) {
      return result(t0, 'Here is the fix for /Users/someone/project/src/upload.js.\n\n```js\nconsole.log(1)\n```\n\nAll done, see https://example.com/docs for more.');
    }

    if (lower.includes('background')) {
      // Queued like a message so it never overlaps a real turn, but no user message is involved.
      setTimeout(() => {
        queue.unshift({ __background: true });
        pump();
      }, Number(process.env.MOCK_BACKGROUND_MS ?? 2000));
      return result(t0, 'I started the build in the background.');
    }

    return result(t0, `Done: ${text}`);
  }
}

// ---------------------------------------------------------------- host mode (SPEC 13)
// Each user message holds tagged lines. The mock answers the most important one:
//   [driver] ... "mutex" / "hello"   small talk, answered without tools
//   [driver] ... "and drive"         end_drive (force when MOCK_HOST_FORCE_END is set)
//   [driver] ... "slow host"         a long reply streamed slowly (for barge-in)
//   [driver] ... "crash host"        exits with code 5 mid-turn
//   [driver] ... "sqlite"/"postgres" answer_question with that label
//   [driver] ... "yes please"        answer_question "yes"
//   [driver] ... "status"            get_status, then says the state
//   [driver] anything else           start_task with the text, says "On it."
//   [worker question] Q              "Claude Code asks: Q"
//   [worker finished] X              "Finished. X"
//   [worker error] X                 "Problem: X"
//   [worker progress] X              "[silent]" streamed in pieces ("important" in X: speaks)
//   [event] ... status / which chat / Chat switched   get_status / which_chat / a recap line
//   anything else                    "[silent]"
// Env: MOCK_HOST_CRASH_ON_START, MOCK_HOST_DELTA_MS (default 5).
function hostMode() {
  if (process.env.MOCK_HOST_CRASH_ON_START) {
    process.stderr.write('mock host: crashing on start\n');
    setTimeout(() => process.exit(4), 20);
    return;
  }
  const sessionId = `mock-host-${randomBytes(4).toString('hex')}`;
  const cfg = JSON.parse(opt('--mcp-config'));
  const server = Object.values(cfg.mcpServers)[0];
  const DELTA = Number(process.env.MOCK_HOST_DELTA_MS ?? 5);
  let rpcId = 0;
  const rpc = async (method, params, notify = false) => {
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params };
    const r = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...server.headers },
      body: JSON.stringify(body),
    });
    if (notify) return r.status;
    const j = await r.json();
    if (j.error) throw new Error(`mcp ${method}: ${j.error.message}`);
    return j.result;
  };
  const handshake = (async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock-host', version: '1' } });
    await rpc('notifications/initialized', {}, true);
    return (await rpc('tools/list', {})).tools.map((t) => `mcp__earpiece__${t.name}`);
  })();
  handshake.catch((err) => process.stderr.write(`mock host: MCP handshake failed: ${err.message}\n`));

  const queue = [];
  let busy = false;
  let turn = null;
  let stdinClosed = false;
  process.on('SIGTERM', () => process.exit(0));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'control_request') {
      const sub = msg.request?.subtype;
      if (sub === 'interrupt' && turn) turn.interrupted = true;
      const ok = sub === 'initialize' || sub === 'interrupt';
      out({ type: 'control_response', response: ok ? { subtype: 'success', request_id: msg.request_id, response: {} } : { subtype: 'error', request_id: msg.request_id, error: 'mock: unsupported' } });
      return;
    }
    if (msg.type === 'user') {
      queue.push(msg);
      pump();
    }
  });
  rl.on('close', () => {
    stdinClosed = true;
    if (!busy) process.exit(0);
  });

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      turn = { interrupted: false };
      await hostTurn(queue.shift().message?.content ?? '', turn);
      turn = null;
    }
    busy = false;
    if (stdinClosed) process.exit(0);
  }

  const se = (event) => out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null });

  async function speak(t, text, { chunk = 7, delay = DELTA } = {}) {
    se({ type: 'message_start', message: { role: 'assistant', content: [] } });
    se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (let i = 0; i < text.length; i += chunk) {
      if (t.interrupted) return false;
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } });
      await sleep(delay);
    }
    se({ type: 'content_block_stop', index: 0 });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: sessionId });
    se({ type: 'message_stop' });
    return true;
  }

  async function tool(name, args) {
    const id = `toolu_host_${++rpcId}`;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__earpiece__${name}`, input: args }] }, parent_tool_use_id: null, session_id: sessionId });
    const r = await rpc('tools/call', { name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] }, parent_tool_use_id: null, session_id: sessionId });
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function hostTurn(content, t) {
    const t0 = Date.now();
    const tools = await handshake.catch(() => []);
    out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: opt('--model'), tools, mcp_servers: [{ name: 'earpiece', status: tools.length ? 'connected' : 'failed' }] });
    const lines = String(content).split('\n');
    const last = (tag) => [...lines].reverse().find((l) => l.startsWith(`[${tag}]`))?.slice(tag.length + 2).trim();
    const driver = last('driver');
    const finished = last('worker finished');
    const question = last('worker question');
    const error = last('worker error');
    const progress = last('worker progress');
    const event = last('event');
    let reply = '[silent]';
    const low = (driver ?? '').toLowerCase();
    if (driver !== undefined) {
      if (low.includes('crash host')) {
        await sleep(10);
        process.stderr.write('mock host: crashing on purpose\n');
        process.exit(5);
      } else if (low.includes('mutex') || low.includes('hello')) {
        reply = 'A mutex is a lock that lets only one thread use a resource at a time. Anything else?';
      } else if (low.includes('and drive')) {
        const r = await tool('end_drive', process.env.MOCK_HOST_FORCE_END ? { force: true } : {});
        reply = r.ok ? '[silent]' : 'Claude Code is still working. Should I stop it?';
      } else if (low.includes('slow host')) {
        const long = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} of a long answer.`).join(' ');
        if (!(await speak(t, long, { chunk: 12, delay: 30 }))) return interrupted(t0);
        return done(t0, long);
      } else if (low.includes('sqlite') || low.includes('postgres')) {
        const r = await tool('answer_question', { answer: low.includes('sqlite') ? 'SQLite' : 'Postgres' });
        reply = r.ok ? `Got it, ${r.answered}.` : 'There is no question waiting.';
      } else if (low.includes('yes please')) {
        const r = await tool('answer_question', { answer: 'yes' });
        reply = r.ok ? 'Okay, allowed.' : 'There is no question waiting.';
      } else if (low.includes('status')) {
        const r = await tool('get_status', {});
        reply = `Claude Code is ${r.state}.`;
      } else {
        const r = await tool('start_task', { instruction: driver });
        reply = r.queued ? 'Queued that.' : 'On it.';
      }
    } else if (question !== undefined) {
      reply = `Claude Code asks: ${question.split(' Options:')[0]}`;
    } else if (finished !== undefined) {
      reply = `Finished. ${finished}`;
    } else if (error !== undefined) {
      reply = `Problem: ${error}`;
    } else if (event !== undefined && /status/.test(event)) {
      const r = await tool('get_status', {});
      reply = `Status: ${r.state}, task ${r.task ?? 'none'}.`;
    } else if (event !== undefined && /which chat/.test(event)) {
      const r = await tool('which_chat', {});
      reply = r.chat ? `You are in ${r.chat}.` : 'No chat yet.';
    } else if (event !== undefined && /Chat switched/.test(event)) {
      reply = `Switched. ${event.split('says: ')[1] ?? ''}`;
    } else if (progress !== undefined && /important/i.test(progress)) {
      reply = `Update: ${progress}`;
    }
    if (t.interrupted) return interrupted(t0);
    if (!(await speak(t, reply, { chunk: reply === '[silent]' ? 4 : 7 }))) return interrupted(t0);
    return done(t0, reply);
  }

  function done(t0, text) {
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, duration_ms: Date.now() - t0 });
  }

  function interrupted(t0) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId, duration_ms: Date.now() - t0 });
  }
}
