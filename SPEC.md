# Earpiece: voice front end for Claude Code (v1 spec)

Earpiece lets one person (the driver) talk to Claude Code running on their server, hands-free and eyes-free. The driver speaks, Claude Code works, and everything Claude says or asks is spoken back.

Two parts:

- **Bridge** (`bridge/`): a Node.js service on the server. It runs Claude Code in headless mode, turns its output into short spoken lines, routes Claude's questions to the driver and saves transcripts. Plain JavaScript (ES modules), Node 22+, **zero npm dependencies**.
- **iPhone app** (`ios/`): SwiftUI, iOS 26+. Microphone, on-device speech-to-text, Apple text-to-speech and turn-taking. A thin client: all agent logic lives in the bridge.

Only text crosses the network. No audio is sent to the server.

```
iPhone app                         Bridge (server)                     Claude Code CLI
mic -> STT -> utterance  --ws-->   session state machine  --stdin-->   claude -p (stream-json)
speaker <- TTS <- say    <--ws--   narrator / question handler <--stdout--  events, control_requests
```

---

## 1. Phone <-> bridge protocol

One WebSocket at `ws://<host>:<port>/ws` (default port 8787). Every frame is one JSON text message with a `type` field.

### Phone -> bridge

| type | fields | meaning |
| --- | --- | --- |
| `hello` | `token`, `last_seq` (int, 0 if none), `client` (string) | First message after connecting. Wrong token -> bridge sends `error` with `code:"auth"` and closes. |
| `utterance` | `text` | Something the driver said that is not a local voice command. |
| `control` | `action` | One of: `cancel`, `stop`, `status`, `repeat`, `pause`, `resume`, `end_drive`. |
| `ping` | none | Keepalive; bridge answers `pong`. |

`pause` and `resume` are handled on the phone (TTS and mic are muted locally), but the phone still sends them so the bridge can log them and hold back non-urgent progress lines while paused.

### Bridge -> phone

| type | fields | meaning |
| --- | --- | --- |
| `welcome` | `drive_id`, `cwd`, `state`, `seq` | Reply to a valid `hello`. Followed by any replayed `say` events (see section 5). |
| `say` | `seq` (int, increasing), `text`, `kind` | Text for the phone to speak. `kind` is one of `ack`, `progress`, `reply`, `question`, `notice`, `error`. |
| `state` | `state`, `cwd` | `state` is one of `idle`, `holding`, `working`, `waiting_for_you`. Sent whenever it changes. |
| `error` | `code`, `message` | Protocol or auth error. |
| `pong` | none | |

Speaking rules for the phone:

- Speak `say` events in `seq` order. Queue them; never speak two at once.
- `kind:"progress"` lines are low priority. Drop a queued progress line if a newer `say` of any kind arrives before it starts playing.
- If the driver starts talking while TTS plays (barge-in), stop speaking immediately and drop the queued `progress` lines. Keep queued `question` and `reply` lines.
- `repeat` re-speaks the last `reply` or `question` line. The phone handles it locally, but also sends `control:repeat` so the bridge can re-send if the phone has nothing.

### States (bridge is the source of truth)

- `idle`: Claude is not working. The next utterance starts a new task.
- `holding`: the bridge has read the task back and is waiting about 3.5 s before sending it to Claude, so the driver can cancel.
- `working`: Claude is running a turn.
- `waiting_for_you`: Claude asked a question or needs a yes or no. The next utterance is the answer.

---

## 2. Voice commands (matched on the phone, before anything is sent)

The phone matches these on the **whole utterance**, lowercased, with punctuation stripped. Anything else is sent as `utterance`.

| Say | Action |
| --- | --- |
| "pause", "hold on", "be quiet" | mute TTS and progress; keep listening for "I'm back"; send `control:pause` |
| "I'm back", "resume", "continue talking" | unmute; send `control:resume` |
| "repeat that", "say that again", "what did you say" | re-speak last reply or question; send `control:repeat` |
| "what are you doing", "status", "where are we" | send `control:status` |
| "stop", "stop the task", "stop working", "abort" | send `control:stop` |
| "cancel", "no", "wait", "never mind" | only while `state == holding`: send `control:cancel`. In other states these words are sent as a normal `utterance` (for example "no" answers a yes or no question). |
| "end drive", "that's all for today", "goodbye earpiece" | send `control:end_drive` |

---

## 3. Bridge behaviour

### 3.1 Utterance handling by state

- **idle**: start the hold window. Say (`ack`): `Heard: <utterance>. Starting.` State goes to `holding` for `HOLD_MS` (3500 ms).
  - `control:cancel` during hold: say `Cancelled.`, back to `idle`.
  - Another `utterance` during hold: append it to the pending task (joined with a space), say `Added: <text>.`, and restart the hold timer.
  - When the hold expires: send the task to Claude, state `working`.
- **holding**: as above.
- **working**: the driver added something mid-task. Queue it and say `Noted. I'll pass that on when this step finishes.` When the turn's `result` arrives, send the queued text as the next user message (several queued lines are joined into one message) and stay `working`.
- **waiting_for_you**: the utterance answers the pending question (section 3.4).

### 3.2 Controls

- `stop`: interrupt Claude (section 4.4). Say `Stopped.` Clear any queued follow-ups and pending question. State `idle`.
- `status`: say one line from the current state, for example `Working on: fix upload timeouts. Last step: running the tests, 40 seconds ago.`, or `Idle in uploader. Ready for a task.`, or `Waiting for your answer: <question>`.
- `repeat`: re-send the last `reply` or `question` line with a new `seq`.
- `end_drive`: if Claude is working, say `Claude is still working. Say stop first, or keep going.` and do nothing. Otherwise finalize the drive (section 6) and say `Drive saved. Summary is on the server.`

### 3.3 Narration (progress lines)

The bridge builds progress lines from Claude's `tool_use` blocks, top-level and subagent alike, using fixed templates:

| Tool | Line |
| --- | --- |
| Read | `Reading <basename>.` |
| Edit, Write, MultiEdit, NotebookEdit | `Editing <basename>.` |
| Grep, Glob | `Searching the code.` |
| Bash | `<input.description>` if present, else `Running a command.` |
| WebSearch | `Searching the web for <query>.` |
| WebFetch | `Reading a web page.` |
| Task or Agent | `Started a helper agent: <input.description>.` |
| TodoWrite | skipped |
| anything else | `Using <tool name>.` |

Throttling:

- Nothing in the first 6 s of a turn.
- After that, at most one progress line every `PROGRESS_INTERVAL_MS` (35 s).
- Each line is the most recent action. If several actions happened since the last line, prefix `<n> steps so far. `.
- No progress lines while paused, holding or waiting_for_you.

### 3.4 Questions and permission requests

Claude asks through `AskUserQuestion`, and auto mode can still escalate a risky action for permission. Both arrive as a `can_use_tool` control request (section 4.3).

**AskUserQuestion.** `input.questions` is an array of `{question, header, options:[{label, description}], multiSelect}`. Ask the questions one at a time:

- Spoken form: `<question> Option one: <label>. Option two: <label>. ...` and, if `multiSelect`, end with `You can pick more than one.` Read labels only, not descriptions. State `waiting_for_you`.
- Matching the answer (case-insensitive):
  1. Number words or digits ("one", "1", "first", "option two", "the second one", "number 3") pick that option.
  2. Otherwise, if the answer contains an option label (or the label contains the answer and the answer is at least 3 characters), pick it.
  3. For multiSelect, collect every option matched by rules 1 and 2. Join the labels with `, `.
  4. Nothing matched: use the driver's words verbatim as a free-text answer.
- Confirm with `ack`: `Got it: <chosen label or "your answer">.`
- When every question is answered, reply allow with `updatedInput = {...input, answers: { [questionText]: answerString, ... }}`.

**Other tools (permission request).** Say (`question` kind): `Claude wants to <summary>. Allow?`, where summary is `run: <description or first 80 chars of command>` for Bash and `use <tool name> on <basename or short input>` otherwise. State `waiting_for_you`.

- Yes-words ("yes", "yeah", "yep", "allow", "go ahead", "do it", "sure", "okay", "ok"): allow, `updatedInput = input`. Say `Allowed.`
- No-words ("no", "nope", "don't", "deny", "stop", "skip"): deny, `message: "The driver said no."`. Say `Denied.`
- Anything else: deny with `message: "The driver replied: <text>"` so Claude can adapt. Say `Passed your reply to Claude.`

Pending questions never time out on their own. If the phone disconnects, the question is re-sent on reconnect.

### 3.5 Final reply of each turn

When a `result` event arrives, take `result.result` (the final text), clean it for speech and say it as `kind:"reply"`:

- Drop fenced code blocks; if any were dropped, add `I left code in the notes.`
- Strip markdown (headings, bold, bullets, tables, links become their text).
- Replace URLs with `a link`. Shorten absolute file paths to their basename.
- Keep at most 3 sentences or 60 words. If cut, end with `The rest is in the notes.`
- Strip the `EARPIECE_SWITCH:` line (section 3.6) before speaking.
- If `is_error` is true, say `Claude hit an error: <short reason>.` with `kind:"error"`.

The full, uncleaned text always goes to the transcript.

### 3.6 Switching folders by voice

The driver says things like "work in the uploader repo". Claude finds the folder itself, then ends its final message with a line on its own:

```
EARPIECE_SWITCH: /absolute/path
```

The bridge strips that line before speaking. If the path exists and is a directory, it says `Switching to <basename>.`, stops the current Claude process cleanly and starts a new one with that `cwd`. The first message to the new process is: `The driver just switched you to this folder. Earlier context: <one-line summary of what they were doing, if any>. Wait for their next instruction; reply only "Ready in <basename>."` The bridge records the new cwd in the drive and in `state`.

### 3.7 Appended system prompt (voice style)

Passed with `--append-system-prompt`; the bridge fills in `<NOTES_PATH>` and `<ROOTS>`:

```
You are being driven by voice through Earpiece. The driver is in a car: they cannot see a screen, cannot type and cannot click. Everything you write in your final message each turn is read aloud by text-to-speech.

Rules:
- Your final message each turn must be 1 to 3 short spoken sentences. No markdown, no code, no file paths, no URLs, no lists. Say what you did and what happens next, like a colleague on a phone call.
- Put anything long (research findings, plans, code snippets, comparisons) in the notes file <NOTES_PATH> (append; markdown is fine there) and say "details are in the notes".
- To ask the driver something, use the AskUserQuestion tool. Ask one question at a time, with at most 3 options, each label 1 to 4 words that are easy to say out loud. Do not ask questions in plain text.
- Prefer acting over asking when the request is clear and the action is safe.
- If the driver asks you to work in a different folder or repository, find it (look under <ROOTS>), then end your final message with a line on its own: EARPIECE_SWITCH: /absolute/path . Do not cd yourself.
- Speech-to-text can mishear technical words. If an instruction looks garbled, ask a short confirming question instead of guessing on anything destructive.
- Never push to a remote, delete branches or delete files outside the working folder unless the driver clearly asked for it in this conversation.
```

---

## 4. Claude Code CLI wire protocol (bridge <-> `claude`)

### 4.1 Launch

```
<CLAUDE_BIN> -p --input-format stream-json --output-format stream-json --verbose \
  --permission-mode auto --permission-prompt-tool stdio \
  --append-system-prompt "<voice style>" [--model <MODEL>] [--resume <session_id>]
```

- Run it with `cwd` set to the current working folder and inherit the environment.
- `CLAUDE_BIN` defaults to `claude` on PATH.
- Keep the process alive for the whole drive. Each driver task is one user message on stdin.
- Read stdout as newline-delimited JSON. Ignore lines that fail to parse, but log them. Log stderr to the drive log.
- After spawning, send an initialize control request (section 4.4) and wait up to 10 s for its response before sending the first user message. If it errors or times out, log it and continue anyway.

### 4.2 Sending a user message (stdin)

```json
{"type":"user","message":{"role":"user","content":"<text>"},"parent_tool_use_id":null,"session_id":"<session id or empty string>"}
```

### 4.3 Events on stdout (handle these; ignore unknown types)

- `{"type":"system","subtype":"init","session_id":"...","cwd":"...","model":"...","permissionMode":"..."}`: remember `session_id`.
- `{"type":"assistant","message":{"content":[ {"type":"text","text":"..."} | {"type":"tool_use","id":"...","name":"Read","input":{...}} ]},"parent_tool_use_id":null|"..."}`: feed `tool_use` blocks to the narrator; log text blocks to the transcript.
- `{"type":"user","message":{"content":[{"type":"tool_result",...}]}}`: transcript only (truncate long results to 500 chars).
- `{"type":"result","subtype":"success"|"error_...","is_error":bool,"result":"<final text>","session_id":"...","total_cost_usd":n,"duration_ms":n}`: the turn ended (section 3.5).
- `{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool","tool_name":"...","input":{...},"tool_use_id":"...","description":"...?"}}`: a question or permission request (section 3.4). Answer on stdin:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow","updatedInput":{...}}}}
{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"deny","message":"..."}}}
```

- Any other `control_request` subtype: answer `{"type":"control_response","response":{"subtype":"error","request_id":"<id>","error":"unsupported by earpiece"}}`.
- `{"type":"control_response","response":{"subtype":"success"|"error","request_id":"<id>",...}}`: the answer to a request the bridge sent.

### 4.4 Requests the bridge sends

- Initialize: `{"type":"control_request","request_id":"<id>","request":{"subtype":"initialize"}}`
- Interrupt: `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}`. If no `result` or `control_response` arrives within 5 s, kill the process (SIGTERM, then SIGKILL after 3 s) and respawn it with `--resume <session_id>` in the same cwd.

### 4.5 Process death

If `claude` exits unexpectedly: say (`error`) `Claude Code stopped unexpectedly. Restarting.`, respawn with `--resume <session_id>` if known, and go `idle`. After 3 crashes within 2 minutes, stop restarting and say `Claude Code keeps crashing. Check the server.`

### 4.6 Verified behaviour and additions (probed against CLI 2.1.325)

The stdio control protocol (sections 4.3 and 4.4) is the one the official Agent SDK uses, but it is not publicly documented for direct CLI use. Keep all CLI wire handling in one module (`bridge/src/claude.js`) so it is easy to adjust.

Verified on a real run: initialize, AskUserQuestion via `can_use_tool` with `updatedInput.answers`, and interrupt (immediate `control_response`, then a `result`). Additions:

- **Unsolicited turns.** Claude can start a turn without a user message, for example when a background command it launched finishes. A `system`/`init` event is emitted at the start of every turn. A `system`/`init` while `idle` means Claude started working on its own: go to `working` (no hold, no ack), narrate, and speak its `result` as a normal reply.
- **Narration source.** `{"type":"system","subtype":"task_summary","detail":"..."}` carries a human-readable description of the current step. Prefer a non-null `detail` over the tool templates in 3.3. `{"type":"system","subtype":"post_turn_summary","status_detail":"..."}` arrives at the end of a turn; keep the latest one for the `status` control.
- **Ignore for state:** `system` subtypes `hook_started`, `hook_response`, `thinking_tokens`, `background_tasks_changed`, `task_started`, `task_updated`, `task_notification`, and top-level `rate_limit_event`.

---

## 5. Reconnection and replay

- The bridge keeps the last 200 `say` events in memory, with their `seq`.
- On `hello` with `last_seq = n`, the bridge replays `say` events with `seq > n`, except `progress` lines. If more than 5 lines would be replayed, it first says (`notice`) `While you were away:` and then replays only `reply`, `question` and `error` lines.
- If a question is pending, it is re-sent last, even if it was already delivered.
- Only one phone connection at a time. A new valid `hello` replaces the old socket, which is closed.
- Claude keeps working while the phone is disconnected.

---

## 6. Drives and transcripts (on the server)

- Data dir: `EARPIECE_HOME` (default `~/.earpiece`). Drives live in `<data dir>/drives/<YYYY-MM-DD_HH-MM-SS>/`.
- A drive starts on the first valid `hello` when no drive is open. It ends on `control:end_drive`, or after 30 minutes with no phone connection and Claude idle.
- Files per drive:
  - `transcript.md`: human-readable, timestamped. Driver lines, spoken lines, Claude's full final texts, tool actions (one line each) and questions with answers.
  - `events.jsonl`: every raw event from the phone and from Claude, one per line, for debugging.
  - `notes.md`: written by Claude itself (see the system prompt).
  - `summary.md`: written when the drive ends. Run `CLAUDE_BIN -p --model haiku --output-format text` with the transcript on stdin and the prompt `Summarize this voice coding session for the driver to read at their desk: what was asked, what was done (files changed, commands run), decisions made, open questions, and suggested next steps. Use short markdown sections.` If that fails, write the error to summary.md instead.

---

## 7. Bridge configuration

Environment variables, overridable by `<EARPIECE_HOME>/config.json` (same names, lowercase without the prefix: `port`, `token`, ...):

| Variable | Default | |
| --- | --- | --- |
| `EARPIECE_PORT` | `8787` | |
| `EARPIECE_HOST` | `0.0.0.0` | |
| `EARPIECE_TOKEN` | none: generated on first start, saved to config.json and printed once | shared secret the phone sends in `hello` |
| `EARPIECE_HOME` | `~/.earpiece` | data dir |
| `EARPIECE_CLAUDE_BIN` | `claude` | |
| `EARPIECE_MODEL` | unset (CLI default) | |
| `EARPIECE_START_DIR` | `~` | cwd for the first Claude process of a drive |
| `EARPIECE_ROOTS` | `~` | where Claude looks for folders the driver names (comma-separated) |
| `EARPIECE_HOLD_MS` | `3500` | |
| `EARPIECE_PROGRESS_INTERVAL_MS` | `35000` | |

`GET /health` returns `{"ok":true,"state":...}` with no auth, for checking reachability from the phone's browser.

---

## 8. iPhone app behaviour

- **Setup screen:** server URL (e.g. `ws://192.168.1.20:8787/ws` or a Tailscale address) and token, saved in UserDefaults (token in Keychain).
- **Main screen:** one big Start/Stop button, the current state, the last spoken line and a short scrolling log. Large text; usable at a glance when parked. No interaction is needed while driving.
- **Start:** configure the audio session, connect the WebSocket, send `hello`, start listening. Stay live until Stop or `end_drive`.
- **Audio session:** `.playAndRecord`, mode `.voiceChat`, options allow Bluetooth HFP and default to speaker when no headset or car is connected. Background mode `audio` so it keeps running with the screen locked. Handle interruptions (calls, Siri, navigation prompts) by pausing and resuming automatically, and handle route changes.
- **Speech-to-text:** `SFSpeechRecognizer` with on-device recognition required when supported, `contextualStrings` loaded from a user-editable word list in settings (repo names, tool names). A turn ends after `1.2 s` of no new partial results (configurable). Ignore results under 2 characters.
- **Echo:** run mic input and TTS output through one `AVAudioEngine` with voice processing enabled, so Claude's voice is not transcribed as the driver. TTS audio comes from `AVSpeechSynthesizer.write(_:toBufferCallback:)` and plays through an `AVAudioPlayerNode` on that same engine.
- **Barge-in:** while TTS plays, if the live transcript reaches 2 or more words, stop TTS and treat the speech as a new driver turn.
- **Text-to-speech:** best-quality installed English voice (premium, then enhanced, then default), rate slightly above default. Voice and rate selectable in settings.
- **Earcons:** a short soft tick when a driver turn is captured and sent, so the driver knows they were heard without waiting for the readback.
- **Connection:** auto-reconnect with backoff (1, 2, 4, 8, max 15 s), resending `hello` with `last_seq`. On first loss, speak `Lost connection to the server. Retrying.` once. On reconnect, speak `Reconnected.`. Ping every 20 s.
- **Siri:** an App Shortcut "Start a drive in Earpiece" (App Intent that opens the app and starts a drive).
- **Privacy strings:** microphone and speech recognition usage descriptions. Local network usage description. ATS: allow arbitrary loads (plain `ws://` to a private or Tailscale address; personal use only).

---

## 9. Backlog (noted, not in scope yet)

- **Stable addresses.** The laptop's address changes between Wi-Fi and hotspot, so the phone loses it. Likely fix: Tailscale on each machine and the phone, using the machine's Tailscale name. Decide together with saved connections.
- **Saved connections.** Several machines (laptop, server), each with its own bridge. The phone keeps a named list and switches between them. Pairing by QR code shown by each bridge, so tokens never need typing. Planned right after continuing chats by voice.
- **Better voices.** Apple Premium voices (Ava) are fine for now. If they are not enough for long drives: Kokoro-82M on the bridge, streaming audio to the phone, with Apple voices as fallback.

---

## 10. Continuing Claude Code chats by voice (v1.1)

This section **overrides** 3.6 (folder switching), 3.7 (appended system prompt), the `--append-system-prompt` flag in 4.1, and the "drive starts on first hello" rule in 6.

### 10.1 What a chat is

A chat is a Claude Code session on the bridge's machine, stored at `~/.claude/projects/<project-dir>/<session-id>.jsonl`. That includes chats from the desktop app's Code tab, the terminal and IDEs. claude.ai web chats are out of scope. Exactly one chat is active in the bridge at a time. A drive can visit several chats.

The driver guarantees a chat is not used in two places at once; the bridge only warns (10.5).

Verified on CLI 2.1.325: `claude -p --resume <id>` continues the same chat in place (same session id, same file), even when started from a different folder.

### 10.2 Listing chats (bridge, `bridge/src/chats.js`)

The file format is undocumented, so keep all of this in one module and fail soft (skip unreadable files).

- Scan `~/.claude/projects/*/*.jsonl` (top level only; skip sub-folders such as `<id>/subagents/`). Override the root with `EARPIECE_CLAUDE_PROJECTS` for tests.
- Only files modified in the last 30 days. Newest first by file mtime. Return at most 20.
- Per file, read line by line (JSON per line, ignore bad lines):
  - `id`: the file name without `.jsonl`.
  - `title`: the last `{"type":"custom-title","customTitle":...}` entry. If none, the text of the first `type:"user"` entry that is not `isMeta`, not a tool result and does not start with `[Earpiece]`, cut to 60 characters. If none, `Untitled chat`.
  - `cwd`: the `cwd` of the last entry that has one (where the chat was last working). `origin_cwd`: the first one.
  - `source`: the `entrypoint` of the last `user` entry (for example `cli`, `claude-desktop`, `sdk-cli`), passed through as-is.
  - `updated_at`: file mtime, ISO 8601.
  - `recently_active`: mtime within the last 120 s and the chat is not the one the bridge itself is running.
- Skip chats with no real user message, and chats whose `cwd` and `origin_cwd` both no longer exist.
- The summary runner (6) must pass `--no-session-persistence`, so summaries never show up as chats.

### 10.3 Protocol additions

Phone -> bridge:

| type | fields | meaning |
| --- | --- | --- |
| `list_chats` | none | Bridge answers with `chats`. |
| `open_chat` | `id` | Switch to that chat (from the screen). |
| `new_chat` | `cwd` (optional) | Start a new chat in `cwd`, or in the current chat's folder, or in `EARPIECE_START_DIR`. |
| `control` | new `action` values: `switch_chat`, `new_chat`, `which_chat` | Voice versions (10.5). |

Bridge -> phone:

| type | fields | meaning |
| --- | --- | --- |
| `chats` | `items`: array of `{id, title, cwd, folder, source, updated_at, recently_active, current}` | `folder` is the basename of `cwd`. `current` is true for the chat the bridge is running. |
| `welcome`, `state` | new field `chat`: `{id, title}` or null | The active chat. |

- A phone may connect, list chats and open one without starting audio. **A drive (6) now starts lazily**: on the first `open_chat`, `new_chat` or `utterance`, not on `hello`.
- `open_chat`, `new_chat` and the voice switch are only allowed while `idle`. Otherwise say (`notice`) `Claude is still working. Say stop first, or wait.` and do nothing.
- An `utterance` with no active chat starts a new chat in `EARPIECE_START_DIR` (the v1 behaviour), then runs as a task.

### 10.4 Voice mode on and off (replaces the appended system prompt)

Claude Code records a chat's system prompt on its first request and reuses it on every resume, so an appended prompt is ignored when continuing a desk chat and would stick forever on a chat started by voice. Voice rules therefore travel as messages inside the chat. Launch `claude` **without** `--append-system-prompt`.

**Opening a chat** (resume or new): spawn with `--resume <id>` (omit for a new chat) and `cwd` = the chat's `cwd` if it exists, else `origin_cwd`, else `EARPIECE_START_DIR`. The first user message is:

```
[Earpiece] Voice mode ON. The driver has stepped away from the screen and is now talking to you by voice from their car through Earpiece. They cannot see a screen, type or click. Everything in your final message each turn is read aloud.
Until you get a "[Earpiece] Voice mode OFF" message:
- Your final message each turn must be 1 to 3 short spoken sentences. No markdown, code, file paths, URLs or lists. Talk like a colleague on a phone call.
- Put anything long (findings, plans, code, comparisons) in the notes file <NOTES_PATH> (append; markdown is fine there) and say "details are in the notes".
- To ask the driver something, use the AskUserQuestion tool: one question at a time, at most 3 options, labels of 1 to 4 easy-to-say words. Never ask questions in plain text.
- Prefer acting over asking when the request is clear and safe.
- If the driver asks to work in a different folder or repository, find it (look under <ROOTS>), then end your final message with a line on its own: EARPIECE_SWITCH: /absolute/path . Do not cd yourself.
- Speech-to-text can mishear technical words. If an instruction looks garbled, ask a short confirming question before anything destructive.
- Never push to a remote, delete branches or delete files outside the working folder unless the driver clearly asked for it while in voice mode.
<FOR AN EXISTING CHAT:> Now reply with a one or two sentence spoken recap of where we left off and what was next.
<FOR A NEW CHAT:> Reply only: New chat in <folder>. What should we work on?
```

The reply is spoken as a normal `reply`. State is `working` while it runs.

**Leaving a chat** (switch, new chat, `end_drive`, the drive's idle timeout, and bridge shutdown when Claude is idle): send

```
[Earpiece] Voice mode OFF. The driver is back at a screen. Use your normal formatting again. Notes from the drive are in <NOTES_PATH>. Reply only: OK.
```

Wait for its `result` (at most 60 s; do not speak it), then close the process (stdin close, then the 4.4 kill fallback). If the bridge crashes, voice-off is not sent; that is accepted.

### 10.5 Choosing chats

**On screen (main path):** the phone shows the chat list before a drive. Tapping a chat starts the drive with that chat open (voice-on and the spoken recap). **New chat** starts the drive with a new chat. During a drive the same list can be opened; tapping sends `open_chat`.

**By voice (during a drive):**

| Say | Phone sends | Bridge does |
| --- | --- | --- |
| "switch chat", "change chat", "other chats", "list chats", "show chats" | `control:switch_chat` | Says (`question`): `Recent chats. One: <title>, <ago>. Two: ... Three: .... Or say new chat.` (top 3, not counting the current chat; titles cut to 8 words; ago like `10 minutes ago`, `2 hours ago`, `yesterday`). State `waiting_for_you`. The answer is matched like 3.4 (number words, then title words). "new chat" starts a new chat. "cancel", "never mind" or "stay" says `Staying in <title>.` |
| "new chat", "start a new chat", "fresh chat" | `control:new_chat` | Voice-off the current chat, open a new chat in the current folder. |
| "which chat", "what chat is this", "which chat am i in" | `control:which_chat` | Says `You're in <title>, in <folder>.` or `No chat open yet.` |

**Recently-active guard:** when opening a chat whose `recently_active` is true, first say (`question`) `This chat was active <ago> on this machine. Continue it anyway?` and wait for yes or no (3.4 yes and no words). No means `Okay, not opening it.` and stay where you were.

Every switch says `Switching to <title>.` before the recap, and is logged in the drive transcript as `Opened chat: <title> (<id>)`.

### 10.6 Folder switching keeps the chat (replaces 3.6)

`EARPIECE_SWITCH: /path` now restarts `claude` with `--resume <current chat id>` and the new `cwd`, so the same chat continues with all its context. After the restart send `[Earpiece] You are now working in <path>. Voice mode is still ON. Reply only: Ready in <basename>.` and speak the reply. Say `Switching to <basename>.` before the restart, as before.

### 10.7 Back at the desk

All voice turns are saved into the chat itself. Whether the desktop app shows them without reopening the chat is untested; the run guide tells the driver to reopen the chat before typing at the desk if it does not.

### 10.8 Changed-elsewhere guard (added after real tests)

Verified on real chats:
- A Claude Code session loads a chat once when it opens it and never re-reads the file.
- `claude --resume` continues from the leaf named by the newest `last-prompt` entry (`leafUuid`), not from the newest line in the file.
- The desktop app continues from its own stored pointer and never sees turns written by other processes. Voice continuity therefore works with the terminal (`claude -c`, `claude --resume`) but not with the desktop app.

The bridge protects its own side:

- **Track what the bridge sent.** Keep the texts of every user message the bridge sent to its current `claude` process for this chat (voice-on, tasks, follow-ups, answers, switch and ready messages, voice-off), and remember how far into the chat file it has already checked (a byte offset, updated after each `result` once the file has stopped growing for about 1 s).
- **Check before every user message** the bridge is about to send to an already-running process for an existing chat: read the chat file from the remembered offset. A **foreign entry** is a `type:"user"` entry whose text is real user text (same rules as titles in 10.2: not `isMeta`, not a tool result, not `<command-...>`) and is not one of the texts the bridge sent.
- **If any foreign entry is found**, say (`notice`) `This chat changed on the laptop. Picking up the latest.` Then:
  1. Close the current process (stdin close, then the 4.4 kill fallback).
  2. Respawn with `--resume <id>` in the same cwd.
  3. Send this message and speak its reply: `[Earpiece] Voice mode ON. <the voice rules from 10.4> The chat continued at a screen since your last voice turn. Reply with one spoken sentence about what changed there.`
  4. Send the pending message.
  Voice-off is the exception: if the pending message is voice-off, skip the voice-on step and just send voice-off to the respawned process.
- Log `Chat changed elsewhere; reloaded.` in the drive transcript.
- This does not help when a terminal session already has the chat open while the driver talks on the phone. That session never reloads. The run guide states the handover rule instead.

### 10.9 Handing back to the desk

- **End-of-drive line:** after `Drive saved. Summary is on the server.`, if a chat was open, also say `To continue at your desk, open a terminal in <folder> and run claude dash c.`
- **summary.md:** starts with a `Continue at your desk` section, one line per chat used in the drive: `cd <cwd> && claude --resume <id>`, with the chat title.
- **Recap wording:** in the voice-on message for an existing chat, replace the last line with: `Now reply with a one or two sentence spoken recap of this conversation's most recent exchange and what was next. Recap the conversation itself, not project files or CLAUDE.md.`

---

## 11. Saved connections, Tailscale and the End drive button (v1.2)

This section replaces the "Saved connections" and "Stable addresses" backlog items in section 9.

### 11.1 Bridge identity

- On first start the bridge generates a stable `bridge_id` (UUID) and saves it in config.json. `name` defaults to the machine's short host name (for example `Harshiths-MacBook-Pro`), overridable as `EARPIECE_NAME` or `name` in config.json.
- `GET /health` (no auth) returns `{"ok":true,"state":...,"name":...,"bridge_id":...}`. `welcome` gains `name` and `bridge_id`.

### 11.2 Addresses and Tailscale

- The bridge lists its reachable addresses in priority order:
  1. Tailscale: any interface with an IPv4 address in 100.64.0.0/10. If a Tailscale CLI is found (`tailscale` on PATH, or `/Applications/Tailscale.app/Contents/MacOS/Tailscale`), also its MagicDNS name from `tailscale status --json` (`Self.DNSName`, trailing dot removed). Failing that, just the IP.
  2. LAN: the other non-internal IPv4 addresses (as today).
- Each address becomes a URL `ws://<host>:<port>/ws`. The startup banner prints them, marking which ones are Tailscale.
- Tailscale addresses stay the same across Wi-Fi, hotspot and mobile data. LAN addresses only work on the same network.

### 11.3 Pairing link and QR code

- The pairing link carries everything the phone needs:
  `earpiece://pair?v=1&name=<name>&id=<bridge_id>&token=<token>&url=<url1>&url=<url2>...` (URL-encoded, Tailscale URLs first).
- On start, and on `npm run pair` (`node bin/pair.js`, which reads config.json and the current addresses), the bridge prints:
  - the link;
  - a QR code of the link in the terminal, drawn with Unicode half blocks. QR encoding is implemented in the bridge with zero dependencies: byte mode, error correction level M, versions 1 to 10, with mask selection. Unit-test it against known vectors.
- The token appears only in that local terminal output, never in logs or files other than config.json.

### 11.4 Saved connections on the phone

- A connection is `{id (= bridge_id), name, urls[], token (Keychain, keyed by id), last_url}`. Several are saved; one is selected.
- **Adding a connection:**
  - Scan the bridge's QR code with the iPhone Camera app. The `earpiece://pair` link opens Earpiece, which shows "Add <name>?" and saves it on confirm. An existing id is updated (urls and token replaced), not duplicated.
  - Or tap "Scan QR" in Earpiece (VisionKit `DataScannerViewController`).
  - Or add one manually (name, URL, token), as today. The existing single server setting migrates into the first saved connection.
- **Switching:** the top of the main screen shows the selected connection's name with a picker listing all saved connections and "Add connection". Switching is allowed only when no drive is live. It disconnects, connects to the other bridge, and refreshes the chat list.
- **Connecting with several URLs:** try `last_url` first, then the rest in order. Check each with `GET /health`, 2 s timeout, and accept the first that answers with the expected `bridge_id`. Remember it as `last_url`. When a live connection drops, re-run the same order on each reconnect attempt, so moving from home Wi-Fi to mobile data falls over to the Tailscale URL.
- **Managing:** a Connections screen lists them (name, which URL last worked). Swipe to delete. Tap to rename or edit URLs and token. "Check" runs the health check on every URL and shows which answer.
- Tailscale on the phone: the guide tells the user to install the Tailscale app and keep its VPN on. If only Tailscale URLs are saved and none answers, the phone shows `Can't reach <name>. Is Tailscale on?`.

### 11.5 End drive button

- During a drive, the main control is a large red **End drive** button, with the subtitle "Hands the chat back to your desk".
- Tapping it shows a confirmation:
  - Title: "End drive?"
  - Body: "Claude switches voice mode off for <chat title>. Continue it at your desk in a terminal: claude -c in <folder>." (Without an open chat: "Ends the drive and saves the summary.")
  - Buttons: End drive / Keep driving.
- On confirm, the phone sends `control:end_drive`, keeps audio running until `drive_ended` arrives (at most 70 s), then stops audio.
- If Claude is still working, the bridge answers with the `error` message `{code:"busy"}` (in addition to its spoken line). The phone then asks "Claude is still working. Stop it and end the drive?" with buttons "Stop and end" / "Keep driving". "Stop and end" sends `{type:"control", action:"end_drive", force:true}`. The bridge interrupts Claude (3.2 stop), then ends the drive normally.
- **New bridge message** after the drive has been finalized (voice-off acknowledged, summary started):
  `drive_ended {drive_id, chats:[{id, title, cwd, folder, resume_cmd}]}`, where `resume_cmd` is `cd <cwd> && claude --resume <id>`.
  The phone shows a **Continue at your desk** card: for each chat its title, folder, the command with a Copy button (Universal Clipboard lets it be pasted on the Mac), and the plain hint "or run claude -c in <folder>". The card stays until dismissed or a new drive starts.
- The voice command "end drive" keeps working and leads to the same `drive_ended` and card.
- The old "Stop" button (stop audio without ending) is removed. "Pause" and "I'm back" by voice cover muting.

---

## 12. Relay with end-to-end encryption (v2)

Goal: the phone reaches the bridge from any network with nothing else installed, no open ports and no VPN. This is built for personal use now, but every choice must hold for a public App Store release: no accounts, the relay operator cannot read or inject traffic, phones can be revoked, abuse is bounded, and the protocol is versioned.

```
iPhone app ──wss──▶ Relay (Cloudflare Worker + Durable Object per bridge) ◀──wss── Bridge (outbound)
        └──────────── Noise IK end-to-end session (relay sees only ciphertext) ────────────┘
```

Direct connections (sections 11.2 to 11.4: LAN, Tailscale) stay as an optional faster path. The relay is the default.

### 12.1 Keys and identities

- **Bridge**, generated on first start and stored in `<EARPIECE_HOME>/keys.json` with mode 0600:
  - `relay_key`: an Ed25519 key pair, used to prove ownership of `bridge_id` to the relay.
  - `noise_key`: an X25519 static key pair for end-to-end sessions.
  - `bridge_id` stays the UUID from 11.1.
- **Phone**, generated once per install and stored in the Keychain: an X25519 static key pair (`phone_key`) and a random `phone_id` (UUID).
- **Paired phones** are stored by the bridge in `<EARPIECE_HOME>/phones.json` (0600): `[{phone_id, name, noise_pub, paired_at, last_seen}]`. **Authorization lives in the bridge, not the relay.**

All keys on the wire and in links are base64url without padding.

### 12.2 Relay protocol (`/v1`)

Every WebSocket message between the relay and a peer is a JSON text frame with a `t` field. Data payloads are base64url strings. Limits:
- Frames up to 1 MB.
- At most 4 phone connections per bridge.
- Idle sockets closed after 90 s without traffic; peers ping every 25 s.
- Per-IP handshake rate limit: 20 new connections per minute.

**Bridge socket:** `wss://<relay>/v1/bridge`
1. The relay sends `{t:"challenge", nonce}` (32 random bytes).
2. The bridge replies `{t:"auth", v:1, bridge_id, pub, sig}`, where `sig` is an Ed25519 signature over the UTF-8 bytes of `earpiece-relay-auth/1:` followed by the raw nonce bytes.
3. The relay routes the socket to the Durable Object named `bridge_id`. The first successful auth for a `bridge_id` stores `pub` (trust on first use). Later auths must use the same `pub`, or the relay closes with code 4003.
4. A new authenticated bridge socket replaces an older one.
5. On success: `{t:"ready"}`.

**Phone socket:** `wss://<relay>/v1/phone/<bridge_id>`
- The Durable Object assigns a connection id `c` (random, 16 bytes) and tells the bridge `{t:"open", c}`.
- Data both ways is `{t:"data", c, d}` (the relay strips or adds `c` on the phone side, so the phone just sends and receives `{t:"data", d}`). Closing is `{t:"close", c}`.
- If the bridge is not connected, the phone gets `{t:"bridge_offline"}` and stays connected. When the bridge connects, the relay sends `{t:"bridge_online"}` and then the bridge gets `open` for every waiting phone.

**What the relay keeps:** only the TOFU public key per `bridge_id` in Durable Object storage. It never logs payloads. It does log, for abuse handling, connection counts, byte counts and IP rate-limit hits, but not content.

`GET /health` returns `{ok:true, v:1}`.

### 12.3 End-to-end session: Noise IK

- Pattern `Noise_IK_25519_ChaChaPoly_SHA256`, implemented exactly as in the Noise Protocol Framework spec (revision 34). Prologue: the ASCII bytes `earpiece/2`. The phone is the initiator and already knows the bridge's static `noise_key` public key from pairing. The bridge is the responder.
- **Message 1 (phone to bridge):** handshake message 1 with a JSON payload:
  - `{phone_id, name, pair_secret?}`
  - `pair_secret` is present only on a first connection after scanning a pairing link.
- **The bridge decides:**
  - If the phone's static key is in `phones.json` (matched by `noise_pub`): accept.
  - Else if `pair_secret` equals the current pairing secret (constant-time compare, unexpired): add the phone to `phones.json`, consume the secret (one use), and accept.
  - Else: reply with handshake message 2 carrying the payload `{ok:false, reason:"not_paired"}`, then close that connection.
- **Message 2 (bridge to phone):** payload `{ok:true, name, bridge_id}`.
- **Transport messages:** each carries one JSON message of the existing phone protocol (`hello`, `welcome`, `say`, …), unchanged. Nonces follow Noise's 64-bit counters. A decryption failure closes the connection.
- **Over the tunnel**, `hello` needs no token: the Noise session already authenticated the phone. Direct WebSocket connections keep the token.
- **Rekey** is not needed: each connection is a new handshake, and sessions are short-lived.
- **Interop vectors:** `earpiece/spec/noise-vectors.json` holds deterministic vectors (fixed static and ephemeral keys, the payloads, both handshake messages, the derived transport keys, and three transport messages each way). It is written by the bridge implementation and must be verified by the Swift implementation's unit tests. If the official Noise test vectors for `Noise_IK_25519_ChaChaPoly_SHA256` (for example from cacophony or snow) are available, the Node implementation also passes those.

### 12.4 Pairing link v2 and phone management

- **Link:** `earpiece://pair?v=2&name=<name>&id=<bridge_id>&relay=<wss url>&key=<bridge noise pub>&secret=<pair_secret>&url=<direct url>...`
  - Direct `url` entries are optional; drop them from the QR first if it would get too large.
  - The QR encoder's maximum version rises to 20.
- **Pairing secret:** 16 random bytes. It is created by `npm run pair` (and printed on bridge start), valid for 10 minutes, and good for one use. It is only ever shown in the local terminal.
- **Bridge commands:**
  - `npm run phones`: lists paired phones.
  - `npm run unpair -- <phone_id or name>`: revokes a phone. Its open sessions are closed immediately.
- **Phone:** "Forget this computer" deletes the connection and its keys reference. It cannot revoke itself on the bridge; the bridge side does that.

### 12.5 Bridge changes

- **Config:**
  - `relay`: a wss URL. If unset, the relay is off. For local testing, `ws://127.0.0.1:8790` or a LAN URL.
  - `direct`: true by default for now; the public build will default to false. When false, only the relay is used.
- **Relay client:** Node's global WebSocket client, outbound, reconnecting with backoff 1/2/4/8/max 30 s plus jitter. Each relay connection `c` that completes Noise becomes a virtual phone connection, handled by the same session code as a direct WebSocket, including replay, one active phone, and drive_ended re-send.
- **Startup banner:** shows `Relay: connected to <host>` or `Relay: not configured`. `/health` adds `relay: "connected" | "connecting" | "off"`.

### 12.6 Phone changes

- **Connection model:** a connection may have relay info (`relay`, `bridge_id`, `bridge_key`), direct URLs plus token, or both.
- **Path choice on connect:**
  - Start the relay handshake.
  - In parallel, health-check the direct URLs with a 1.5 s timeout. If one answers with the right `bridge_id` before the relay handshake finishes, use it.
  - Otherwise use the relay.
- **Status:** the connection screen shows "via relay" or "direct".
- **Messages:**
  - `bridge_offline`: show and speak once during a drive: "Your computer is offline. I'll keep trying."
  - `not_paired`: show "This phone is no longer paired with <name>. Scan its QR code again."
- **Pairing link v2:** handled by the same scheme, the "Add <name>?" sheet and the scanner. v1 links still work as direct-only connections.

### 12.7 The relay itself (`relay/`)

- **Code layout:** runtime-agnostic core logic (routing, limits, auth verification) in plain JS modules, with zero dependencies and unit tests run by `node --test`.
- **Adapters:**
  - `relay/worker/`: a Cloudflare Worker plus Durable Object (class `BridgeRoom`, one per `bridge_id`, using the WebSocket Hibernation API, SQLite-backed storage for the TOFU key). `wrangler.toml` with the Durable Object binding and a `new_sqlite_classes` migration. Must run on the Workers free plan.
  - `relay/node/server.js`: the same protocol as a plain Node server (reusing the bridge's `ws.js` approach, zero dependencies) for local testing and self-hosting. `npm start` runs it on port 8790.
- **Deployment** needs the owner's Cloudflare account: `npx wrangler login`, then `npx wrangler deploy`. The default address is `https://earpiece-relay.<account>.workers.dev`. Wrangler is a dev-time tool only; nothing it installs ships in the relay code.

### 12.8 Public-release notes (design constraints now, work later)

- The relay sees metadata only: bridge ids, connection times, sizes, IPs. The privacy policy must say so.
- Abuse limits: frame size, connections per bridge, per-IP rate, and an optional global kill switch per `bridge_id`.
- Protocol versions in paths (`/v1`), the prologue (`earpiece/2`) and the link (`v=2`) allow upgrades without breaking old phones.
- The Anthropic terms question (third-party apps and consumer plans) must be settled before launch. It does not change this design.

### 12.9 As built (deployed and verified on 2026-11-15)

- **Live relay:** `wss://earpiece-relay.earpiece.workers.dev` (Cloudflare Workers, free plan).
- **Verified end to end:**
  - Pairing by QR, Noise IK and chats from the iPhone, both through the relay with direct connections off and on mobile data.
  - The Node and Swift Noise implementations match `spec/noise-vectors.json` byte for byte. The Node implementation also matches the official cacophony vectors.
- **Protocol details added during the build** (they override 12.2 where different):
  - **Bridge URL:** `/v1/bridge?id=<bridge_id>`. The query parameter is required (HTTP 400 without it), and the `bridge_id` in `auth` must match it (close 4001).
  - **Keepalive:** peers send the text frame `{"t":"ping"}` every 25 s, and the relay answers `{"t":"pong"}`. WebSocket protocol pings do not count as activity. On Workers, pings are auto-answered without waking the Durable Object. A peer that sees no pong for 60 s reconnects.
  - **`bridge_online`** is also sent when a newer bridge socket replaces an older one. The phone always starts a fresh Noise handshake on it.
  - **Fresh connection ids:** every bridge attach gets a new `c` per phone. Data for an unknown `c` is answered with `{t:"close", c}`.
  - **Offline data:** data sent while the bridge is offline is dropped, not queued.
  - **Limits:** `d` is at most 1,048,000 characters; `auth` must arrive within 10 s; a 5th phone may evict one that has been silent for 35 s or more. Close codes 4000 to 4006 are listed in `relay/README.md`.
- **Pairing link:** includes `token=` exactly when it includes direct `url` entries.
- **Bridge startup:** the bridge refuses to start on Node older than 22 (its relay client uses Node's built-in WebSocket).
- **Known limits to fix before a public release:**
  - Noise transport messages are capped at 65,535 bytes. Messages must stay under that, or a fragmentation rule is needed.
  - Deriving `bridge_id` from the bridge's Ed25519 key would remove the trust-on-first-use claim risk.
  - Per-IP rate limiting on Workers is per isolate (best effort).

---

## 13. The voice host (v3): a conversational layer in front of Claude Code

User feedback: the rule-based voice layer (read-backs, templated progress, "Option one…", literal command matching, every utterance treated as a task) is unusable. v3 puts a conversational model, the **host**, between the driver and Claude Code. The host owns the conversation; Claude Code (the **worker**) does the work. Driver choices (2026-11-15):
- Host model: Sonnet.
- Updates at **meaningful moments** only.
- The host answers simple questions **from its own knowledge**.
- It confirms a task only when it is **unclear or risky**.

**No phone change is required.** The phone keeps sending `utterance` and `control`, and keeps speaking `say` lines. Protocol sections 1, 10, 11 and 12 are unchanged.

### 13.1 Host process

- **A second persistent CLI session per drive.** It starts with the drive and ends with it. Launch:
  `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <EARPIECE_HOST_MODEL, default sonnet> --system-prompt <host prompt> --tools "" --mcp-config <bridge MCP endpoint> --strict-mcp-config --allowedTools "mcp__earpiece__*" --no-session-persistence`.
  Add whatever flags keep startup fast and skip the driver's personal hooks and plugins if the CLI allows it without breaking login. Measure the startup time and report it.
- **No file, shell or web tools.** The host has only the Earpiece tools (13.2).
- **`--no-session-persistence`**, so host sessions never appear in the chat list.
- **Config:**
  - `EARPIECE_HOST`: `on` (default) or `off`. `off` keeps the v1/v2 behaviour.
  - `EARPIECE_HOST_MODEL`: default `sonnet`.

### 13.2 Earpiece tools (MCP, served by the bridge)

- **Transport:** a minimal MCP server over HTTP (JSON-RPC 2.0: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`) on 127.0.0.1 with a random port and a random secret header per bridge run. Zero dependencies.
- **Tools.** They return quickly with short JSON or text:
  - `start_task {instruction}`: sends the instruction to the worker. If the worker is busy, it is queued as a follow-up. If no chat is open, it opens a new chat in the start folder first.
  - `get_status {}`: the state, the current task (the last instruction), the elapsed time, the last 5 actions (task_summary details or tool descriptions), any pending worker question, the chat title and the folder.
  - `answer_question {answer}`: answers the worker's pending `AskUserQuestion` or permission request.
    - For AskUserQuestion, pass one or more option labels, or free text. Several labels are allowed for multiSelect. The bridge maps the labels and falls back to free text.
    - For a permission request, pass `"yes"` or `"no"` (or free text, which is passed on as a deny reason).
  - `stop_task {}`: interrupts the worker (3.2 stop).
  - `end_drive {force?}`: as in 11.5. `force` stops a working task first.
  - `list_chats {}`: the top 5 chats (title, folder, relative time).
  - `switch_chat {id? | title?}`: opens that chat. A title is fuzzy-matched; if ambiguous, the tool returns the candidates.
  - `new_chat {folder?}`: opens a new chat.
  - `which_chat {}`: the current chat.

### 13.3 What the host receives

All of these are user messages in the host session, each line tagged:

- `[driver] <text>`: every driver utterance, as raw speech-to-text. The host is told it may be misheard ("and drive" probably means "end drive").
- `[worker started] <instruction>`.
- `[worker question] <question>`, with its options.
- `[worker finished] <full final text>`: the whole result, not cut.
- `[worker error] <reason>`, including usage limits.
- `[worker progress] <task_summary lines since the last digest>`.
- `[event] <text>` for bridge events: chat switched (with the worker's recap), drive ended, phone reconnected, the driver used a phone command (stop, pause, end drive, …).

**When a host turn runs:**
- on every `[driver]` line;
- on worker question, finished and error;
- on chat switched;
- on a progress digest, at most every 60 s while the worker runs and only if the host has said nothing for 60 s.

Messages that arrive while a host turn is running are queued and sent together afterwards. If the driver speaks during a host turn, interrupt the host turn, drop its unspoken text, and send the new `[driver]` line with what was queued.

### 13.4 What gets spoken

- The host's assistant text is streamed, using partial messages. It is cut into sentences, and each finished sentence is sent at once as `say` with kind `reply`. Markdown is stripped as a safety net.
- **Staying silent:** if a host turn's whole text is empty or is exactly `[silent]`, nothing is spoken. This is how it stays quiet on unremarkable progress.
- **Removed when the host is on:**
  - the read-back and hold window (3.1);
  - the templated narrator (3.3);
  - the spoken AskUserQuestion and permission formatting, and answer matching (3.4);
  - the worker's final reply being spoken directly (3.5).
  The host does all of these.
- **Still spoken by the bridge:** connection notices, "Stopped.", the drive-ended lines (10.9) and usage-limit errors when the host itself cannot run.
- **Phone-matched commands** (stop, pause, resume, repeat, end drive, switch chat, new chat, which chat, status) still work directly, so they're instant and deterministic. Each one is also sent to the host as an `[event]` for context. "status" and "which chat" are answered by the host if it is up.

### 13.5 The worker side

- The voice-on message no longer asks the worker to speak in short sentences. It says: the driver is away from the screen and talks to you through a voice assistant that summarizes your results; ask questions only through AskUserQuestion, with short options; don't ask in plain text; write normally (your output stays readable in the chat at the desk); use EARPIECE_SWITCH as before.
- Voice-off stays as it is. Desk continuity (10.8 and 10.9) is unchanged.

### 13.6 Host system prompt (in prompt.js; the gist)

> You are Earpiece, a voice assistant riding along with a driver. You talk with them and run their coding agent, Claude Code, on their computer. You hear them through speech recognition, so words can be wrong; infer the meaning from context and ask only when it really matters. Everything you write is spoken aloud: talk like a sharp, friendly colleague on a phone call, usually one or two short sentences. Never read out code, file paths, URLs, lists or markdown. Answer general questions yourself. Anything that needs their files, commands, the web or their projects goes to Claude Code with start_task, in a clear, complete instruction. Start clear, safe requests right away, and confirm first only when the request is unclear or destructive (deleting, pushing, sending, spending). When Claude Code finishes, tell them the outcome in plain words and what's next. When it asks something, ask the driver naturally and pass their answer with answer_question. Speak up on progress only at meaningful moments (found the cause, tests failed, needs you, done); otherwise reply exactly [silent]. Use get_status when they ask what's happening. They are driving: keep it brief, never ask them to look at a screen, and let them interrupt.

### 13.7 Failure fallback

If the host process cannot start, crashes twice within 2 minutes, or hits the usage limit, say (`notice`) `Voice assistant unavailable. Using basic mode.` and fall back to the v2 behaviour for the rest of the drive. Never leave the driver without a working path.

### 13.8 Known issue (noted 2026-11-16, fix later)

- **What happens:** during the first car test (laptop with the lid closed, on the iPhone hotspot), the bridge's relay connection was declared dead ("no pong for 65 s") several times: 06:37, 06:43, 06:56, 07:17 and 07:58. Most of the time it reconnected within 2 s.
- **Fixed now:** twice, the reconnect attempt hung forever with the status stuck on "connecting", so the phone could not reach the bridge. The cause was that a connect attempt had no timeout. The fix, made 2026-11-16 at 08:0x, is `connectTimeoutMs` (20 s) in `bridge/src/relay.js`: a hung attempt is closed and retried.
- **Still open: the root cause of the frequent pong losses.** Candidates:
  1. hotspot NAT or TCP drops while moving;
  2. the Cloudflare Durable Object's auto-response or idle sweep (an earlier test drop coincided with the relay closing an idle phone);
  3. the Mac's network stack while the lid is closed.
- **To investigate:**
  - log pong round-trip times;
  - compare the relay's `bridge_close` events (Workers logs);
  - test on a stable network with the lid closed;
  - consider a shorter pong timeout (about 35 s) so recovery is faster.
