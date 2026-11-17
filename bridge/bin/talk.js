#!/usr/bin/env node
// Terminal stand-in for the iPhone app, for desk testing the bridge.
// Every typed line is sent as an `utterance`; /commands send controls. `say` lines are printed with
// their kind (and spoken with macOS `say` when --speak is given).
//
//   node bin/talk.js [--url ws://host:8787/ws] [--token TOKEN] [--speak]
//   env: EARPIECE_URL, EARPIECE_TOKEN (else the token is read from <EARPIECE_HOME>/config.json)

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const HELP = `Earpiece desk client
Usage: node bin/talk.js [--url ws://host:port/ws] [--token TOKEN] [--speak]

Type a line and press Enter to send it as something you said.
Controls:
  /cancel  /stop  /status  /repeat  /pause  /resume  /end   (end = end_drive)
Chats:
  /chats          list recent Claude Code chats, numbered
  /open <n|id>    open chat number n from the last /chats, or by id
  /new [folder]   start a new chat (in folder, or the current chat's folder)
  /switch         voice-style chat switch (the bridge asks which one)
  /which          which chat is open
  /quit    leave (the drive stays open on the server)
  /help    this text`;

function parseArgs(argv) {
  const o = { url: null, token: null, speak: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--token') o.token = argv[++i];
    else if (a === '--speak') o.speak = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (/^wss?:\/\//.test(a)) o.url = a;
    else {
      console.error(`Unknown argument: ${a}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return o;
}

function defaultToken() {
  if (process.env.EARPIECE_TOKEN) return process.env.EARPIECE_TOKEN;
  const home = (process.env.EARPIECE_HOME || '~/.earpiece').replace(/^~(?=$|\/)/, homedir());
  const file = join(home, 'config.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')).token ?? null;
  } catch {
    return null;
  }
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}
const url = opts.url || process.env.EARPIECE_URL || `ws://127.0.0.1:${process.env.EARPIECE_PORT || 8787}/ws`;
const token = opts.token || defaultToken();
if (!token) {
  console.error('No token. Pass --token, set EARPIECE_TOKEN, or run the bridge once on this machine.');
  process.exit(2);
}

const CONTROLS = {
  cancel: 'cancel', stop: 'stop', status: 'status', repeat: 'repeat', pause: 'pause', resume: 'resume',
  end: 'end_drive', end_drive: 'end_drive', switch: 'switch_chat', which: 'which_chat',
};
let lastChats = [];
const tty = process.stdout.isTTY;
const color = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const KIND_COLOR = { ack: 36, progress: 90, reply: 32, question: 33, notice: 35, error: 31 };

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: tty ? 'you> ' : '' });
function print(line) {
  if (tty) process.stdout.write('\r\x1b[K');
  process.stdout.write(`${line}\n`);
  if (tty) rl.prompt(true);
}

// ---------------------------------------------------------------- speech (optional)
const canSpeak = opts.speak && process.platform === 'darwin' && spawnSync('which', ['say']).status === 0;
if (opts.speak && !canSpeak) print('(--speak needs the macOS `say` command; printing only)');
let speaking = null;
let speechQueue = [];
let muted = false;

function speak(msg) {
  if (!canSpeak || muted) return;
  // A queued progress line is dropped when anything newer arrives (same rule as the phone).
  speechQueue = speechQueue.filter((m) => m.kind !== 'progress');
  speechQueue.push(msg);
  pump();
}
function pump() {
  if (speaking || !speechQueue.length) return;
  const msg = speechQueue.shift();
  speaking = spawn('say', [msg.text], { stdio: 'ignore' });
  speaking.on('exit', () => {
    speaking = null;
    pump();
  });
  speaking.on('error', () => {
    speaking = null;
  });
}
function bargeIn() {
  speechQueue = speechQueue.filter((m) => m.kind !== 'progress');
  if (speaking) speaking.kill();
}

// ---------------------------------------------------------------- connection
let ws = null;
let lastSeq = 0;
let lastSpoken = null;
let state = 'idle';
let attempt = 0;
let quitting = false;
let everConnected = false;
let pingTimer = null;

let welcomed = false;
const outbox = []; // typed while disconnected; sent after the next welcome

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN && welcomed) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  if (obj.type !== 'ping') {
    outbox.push(obj);
    print(color(90, '(not connected yet; will send when connected)'));
  }
  return false;
}

function connect() {
  ws = new WebSocket(url);
  ws.onopen = () => {
    attempt = 0;
    ws.send(JSON.stringify({ type: 'hello', token, last_seq: lastSeq, client: 'talk.js' }));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ type: 'ping' }), 20_000);
    pingTimer.unref();
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      print(color(31, `(bad message: ${ev.data})`));
      return;
    }
    switch (m.type) {
      case 'welcome':
        print(
          color(
            90,
            `${everConnected ? 'Reconnected' : 'Connected'}: ${m.drive_id ? `drive ${m.drive_id}` : 'no drive yet'}, chat ${m.chat ? `"${m.chat.title}"` : 'none'}, in ${m.cwd}, state ${m.state}, seq ${m.seq}`,
          ),
        );
        everConnected = true;
        welcomed = true;
        state = m.state;
        for (const queued of outbox.splice(0)) send(queued);
        break;
      case 'say': {
        lastSeq = Math.max(lastSeq, m.seq);
        if (m.kind === 'reply' || m.kind === 'question') lastSpoken = m;
        const kind = m.kind.padEnd(8);
        print(`${color(90, `#${m.seq}`)} ${color(KIND_COLOR[m.kind] ?? 0, kind)} ${m.text}`);
        speak(m);
        break;
      }
      case 'state':
        state = m.state;
        print(color(90, `-- state: ${m.state} (${m.cwd})${m.chat ? ` chat "${m.chat.title}"${m.chat.id ? '' : ' (new)'}` : ''}`));
        break;
      case 'chats':
        lastChats = Array.isArray(m.items) ? m.items : [];
        if (!lastChats.length) print(color(90, '(no recent chats)'));
        lastChats.forEach((c, i) => {
          const flags = [c.current ? 'current' : '', c.recently_active ? 'ACTIVE ELSEWHERE' : ''].filter(Boolean).join(', ');
          const when = new Date(c.updated_at).toLocaleString();
          print(`${String(i + 1).padStart(2)}. ${c.title}  ${color(90, `[${c.folder}] ${c.source ?? '?'} ${when} ${c.id}`)}${flags ? ` ${color(33, flags)}` : ''}`);
        });
        break;
      case 'error':
        print(color(31, `!! error ${m.code}: ${m.message}`));
        if (m.code === 'auth') quitting = true;
        break;
      case 'pong':
        break;
      default:
        print(color(90, `(unknown ${m.type}) ${ev.data}`));
    }
  };
  ws.onclose = (ev) => {
    welcomed = false;
    clearInterval(pingTimer);
    if (quitting) {
      process.exit(ev.code === 1008 ? 1 : 0);
    }
    const delay = Math.min(15, 2 ** attempt);
    attempt += 1;
    print(color(31, `-- connection closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''}); retrying in ${delay} s`));
    setTimeout(connect, delay * 1000);
  };
  ws.onerror = () => {}; // onclose follows
}

print(color(90, `Earpiece desk client -> ${url}  (/help for commands)`));
connect();
rl.prompt();

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }
  if (text.startsWith('/')) {
    const cmd = text.slice(1).toLowerCase();
    if (cmd === 'quit' || cmd === 'exit') {
      quitting = true;
      ws?.close();
      setTimeout(() => process.exit(0), 300).unref();
      return;
    }
    if (cmd === 'help') {
      print(HELP);
      return;
    }
    const [word, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    if (word.toLowerCase() === 'chats') {
      send({ type: 'list_chats' });
      rl.prompt();
      return;
    }
    if (word.toLowerCase() === 'open') {
      const n = Number(arg);
      const id = Number.isInteger(n) && n >= 1 && n <= lastChats.length ? lastChats[n - 1].id : arg;
      if (!id) print(color(31, 'Usage: /open <number from /chats | chat id>'));
      else send({ type: 'open_chat', id });
      rl.prompt();
      return;
    }
    if (word.toLowerCase() === 'new') {
      send(arg ? { type: 'new_chat', cwd: arg } : { type: 'new_chat' });
      rl.prompt();
      return;
    }
    const action = CONTROLS[cmd];
    if (!action) {
      print(color(31, `Unknown command ${text}. /help lists them.`));
      return;
    }
    if (action === 'cancel' && state !== 'holding') print(color(90, '(note: the phone only sends cancel while holding)'));
    if (action === 'pause') {
      muted = true;
      bargeIn();
    }
    if (action === 'resume') muted = false;
    if (action === 'repeat' && lastSpoken) {
      print(`${color(90, '(local repeat)')} ${lastSpoken.text}`);
      speak(lastSpoken);
    }
    send({ type: 'control', action });
    rl.prompt();
    return;
  }
  bargeIn();
  send({ type: 'utterance', text });
  rl.prompt();
});

rl.on('close', () => {
  quitting = true;
  ws?.close();
  setTimeout(() => process.exit(0), 300).unref();
});
