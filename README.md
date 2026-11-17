# Earpiece

Talk to Claude Code on your server while you drive. You speak, Claude works, and everything it says or asks is spoken back. No screen, no tapping.

- `bridge/`: Node.js service that runs Claude Code headless (zero npm dependencies, Node 22+).
- `ios/`: the iPhone app (iOS 26+).
- `SPEC.md`: how the two talk to each other and how every voice flow behaves.

---

## Part 1: run it with this laptop as the server

### 1. Start the bridge

As a background service (recommended on macOS; keeps running without a terminal or the Claude app, restarts itself if it crashes, does not start by itself at login):

```bash
~/Downloads/earpiece/bridge/bin/earpiece start
```

```bash
~/Downloads/earpiece/bridge/bin/earpiece stop
```

Also `restart`, `status`, `logs` (follow the log) and `pair` (show the pairing QR code). The log is `~/.earpiece/bridge.log`. To keep the Mac awake with the lid closed, use Amphetamine (closed-display mode) or `sudo pmset -a disablesleep 1` (undo with `0`); the service only prevents idle sleep.

Or in the foreground, in a terminal:

```bash
cd ~/Downloads/earpiece/bridge
caffeinate -i npm start
```

- On start it prints the bridge's **name**, its addresses (Tailscale ones marked and listed first), and a **QR code** for pairing the phone. To show the QR code again at any time: `npm run pair` in the bridge folder. The token lives in `~/.earpiece/config.json`.
- Needs **Node 22 or newer** (the bridge refuses to start on older versions). If `node --version` shows an older one, run `nvm install 22 && nvm alias default 22`.
- `caffeinate -i` stops the Mac from idle-sleeping while the bridge runs. Keep the lid open and the charger in; a closed lid on battery still sleeps.
- If macOS asks whether `node` may accept incoming connections, click **Allow**.

Optional settings in `~/.earpiece/config.json` (restart the bridge after editing):

```json
{
  "token": "keep-the-generated-one",
  "start_dir": "~/code",
  "roots": "~/code,~/Downloads",
  "model": "sonnet"
}
```

- `start_dir`: the folder Claude starts in each drive.
- `roots`: where Claude looks when you say "work in the uploader repo".
- `model`: `sonnet` uses less of your plan than `opus`. Leave it out to use your Claude Code default.

### 2. Test at your desk without the phone

In a second terminal:

```bash
cd ~/Downloads/earpiece/bridge && npm run talk -- --speak
```

Type what you would say. `--speak` reads Claude's lines aloud with the Mac's voice. Controls: `/stop`, `/status`, `/repeat`, `/cancel`, `/end`, `/quit`.

### 3. Install the app on your iPhone

1. Open `~/Downloads/earpiece/ios/Earpiece.xcodeproj` in Xcode.
2. Select the **Earpiece** target, then **Signing & Capabilities**:
   - **Team**: your Apple ID.
   - **Bundle Identifier**: change `com.example.earpiece` to something unique, for example `com.yourname.earpiece`.
3. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** (it restarts the phone).
4. Plug the iPhone in, pick it as the run destination in Xcode, press **Cmd-R**.
5. With a free Apple ID: on the phone, trust the profile under **Settings → General → VPN & Device Management**. Free installs expire after 7 days; a paid developer account ($99/year) lasts a year.
6. For a better voice: **Settings → Accessibility → Spoken Content → Voices → English**, download a **Premium** voice. Earpiece picks the best installed one.

### 4. The relay (how the phone reaches the laptop from anywhere)

The bridge connects out to a small relay on Cloudflare (`relay/`), and the phone connects to the same relay, so it works on any network, including mobile data, with nothing else installed and no ports opened. Everything between phone and bridge is end-to-end encrypted (Noise protocol); the relay only passes messages it cannot read and logs only connection counts and byte counts.

- The relay address lives in `~/.earpiece/config.json` as `"relay": "wss://earpiece-relay.<subdomain>.workers.dev"`. The bridge banner shows `Relay: connected to …`.
- Deploying or updating the relay (owner only): `cd relay/worker && npx wrangler deploy` (first time: `npx wrangler login`). See `relay/README.md`.
- On the same Wi-Fi as the laptop the phone connects directly (faster); everywhere else it uses the relay. The connection screen shows which.
- Tailscale still works as an extra direct address but is no longer needed.

### 5. Pair the phone

1. Show a QR code with `npm run pair` in the bridge folder (also printed when the bridge starts). Point the iPhone **Camera** at it and tap the Earpiece banner; Earpiece asks "Add <name>?"; tap **Add**. (Or in Earpiece: connection picker at the top, **Add connection**, **Scan QR**.) The code works once and expires after 10 minutes. It contains the relay address, the bridge's public key and, for the home Wi-Fi shortcut, the laptop's local address.
2. Allow the microphone, speech recognition, local network and camera prompts.
3. The connection uses the home Wi-Fi shortcut when it answers quickly and the relay otherwise. List or revoke paired phones on the bridge with `npm run phones` and `npm run unpair -- <name>`.

Several bridges (this laptop, your server) can be saved. Switch between them with the picker at the top of the main screen (only when no drive is running). Edit, check or delete them on the Connections screen.


---

## How to use it

Before you pull out, pick a chat on the phone: tap one of your recent Claude Code chats to continue it, or **New chat**. Earpiece says "Switching to <title>." and gives a one or two sentence recap. After that it is all voice. (Tapping **Start** without picking a chat starts a new chat with your first task.)

- **Just talk.** A voice assistant (the "host", a Claude model) runs the conversation. It answers general questions itself, hands anything that needs your files, commands or the web to Claude Code, and tells you the outcome in plain words. It asks first only when a request is unclear or risky (deleting, pushing, sending).
- **While Claude Code works**, keep talking: "what's it doing?", "also run the tests", "forget that". It speaks up on its own only at meaningful moments (found the cause, tests failed, needs you, done).
- **Questions from Claude Code** come as a normal question ("Should I call it plans or roadmap?"); answer in your own words.
- **Chats and folders**: "switch to the uploader chat", "start a new chat", "which chat am I in?", "work in the uploader repo".
- **Instant phone commands** (work even if the assistant is slow): "stop", "pause" / "I'm back", "repeat that", "end drive".
- **Settings**: `EARPIECE_HOST_MODEL` (default `sonnet`) picks the assistant's model; `EARPIECE_VOICE_HOST=off` returns to the older fixed-phrase mode. If the assistant fails, Earpiece says "Voice assistant unavailable. Using basic mode." and keeps working.
- **Interrupt**: start talking while Claude is speaking; it stops and listens.
- If the signal drops, Claude keeps working. When the phone reconnects you hear what you missed.

### Desk to car and back: one side at a time

A Claude Code session reads a chat once when it opens it and never re-reads it. If the terminal and the phone have the same chat open at the same time, each side misses what the other said, and the chat splits into two branches. So hand over in order:

- **Desk to car:** exit the terminal session first (`/exit` or Ctrl-D), then pick the chat on the phone.
- **Car to desk:** tap the red **End drive** button (or say "end drive"). Ending the drive is what hands the chat back: Claude switches voice mode off, and the phone shows a **Continue at your desk** card with the exact command and a Copy button (paste it on the Mac with Universal Clipboard). If Claude is still working you can choose "Stop and end" or "Keep driving". Then, in the chat's folder:

```bash
claude -c
```

`claude -c` continues the most recent chat in that folder, which is the one you just used by voice. Use `claude --resume` to pick a different chat. The drive's `summary.md` lists the exact `claude --resume <id>` command for every chat you used.

- **Use the terminal, not the desktop app, at the desk** for chats you also use by voice. The desktop app continues from its own last message and never sees voice turns; typing there splits the chat.
- If you type in the terminal while a drive is still open, the bridge notices before its next voice turn, says "This chat changed on the laptop. Picking up the latest.", and reloads the chat. It cannot help the other way round: a terminal session that is already open never sees what you say on the phone.

After the drive, everything is on the server in `~/.earpiece/drives/<date-time>/`:

- `summary.md`: how to continue each chat at your desk, then what you asked, what was done, decisions, open questions, next steps.
- `transcript.md`: the full conversation and every action Claude took.
- `notes.md`: long output Claude saved for you (research, plans, code).
- `events.jsonl`: raw log for debugging.

**Usage:** this uses your Claude plan, not extra billing. It draws on the same 5-hour and weekly limits as your other Claude use. If you hit a limit, Earpiece says so and tells you when it resets.

---

## Part 2: run the bridge on your server

Two ways, both installed by one script. Pick one per server:

- **Docker:** nothing to install but Docker. Claude Code runs its commands inside the container, which has git, Python 3, Node 22 and build tools, plus your NVIDIA GPUs when the NVIDIA Container Toolkit is present. It edits your real files (your home folder is mounted), but your server's own conda environments and system tools are not inside it.
- **Direct:** Claude Code uses your server's real tools, environments and GPUs. The script installs Node 22 for your user with nvm (no sudo) and a systemd user service.

Requirements for both: Claude Code already installed and logged in on the server (`claude` works in a terminal), and a Linux user whose home holds your projects.

### 1. Get the code onto the server

The repository is private, so either clone it with the GitHub CLI (`gh auth login` once):

```bash
gh repo clone Harshith-Shivakumar/earpiece ~/earpiece
```

or copy it from your Mac:

```bash
rsync -a --exclude node_modules --exclude .git ~/Downloads/earpiece/ <you>@<server>:~/earpiece/
```

### 2. Install (pick one)

```bash
~/earpiece/server/install.sh docker
```

```bash
~/earpiece/server/install.sh direct
```

The script:

- checks Claude Code and its login;
- writes `~/.earpiece/config.json` with the relay address and relay-only mode (nothing listens for the phone on the server);
- links an `earpiece` command into `~/.local/bin`;
- builds and starts the container, or installs and starts the service.

In Docker mode, GPUs are added automatically when `nvidia-smi` works (`--no-gpu` turns that off). Edit `start_dir` and `roots` in `~/.earpiece/config.json` to point at your projects, then `earpiece restart`.

For the direct install, so the service keeps running after you log out, run once:

```bash
sudo loginctl enable-linger $USER
```

### 3. Pair your phone

```bash
earpiece pair
```

Scan the QR code with the iPhone Camera. The server is added as another connection next to your Mac; switch between them at the top of the app. The chat list shows the server's Claude Code chats (everything in the server's `~/.claude/projects`), and continuing one by voice works the same way. At the server's terminal, continue a chat with `claude -c` in its folder.

### 4. Everyday commands

```bash
earpiece start
```

```bash
earpiece stop
```

Also `earpiece restart`, `earpiece status` and `earpiece logs`. These work the same on the Mac, in Docker and with the direct install.

### 5. Updating

```bash
cd ~/earpiece && git pull && earpiece restart
```

In Docker mode, rebuild after pulling instead of restarting:

```bash
cd ~/earpiece/server && docker compose $(cat ~/.earpiece/compose-files) up -d --build
```

## Safety notes

- Claude runs in **auto mode** with your user's access on the server. Risky actions are still escalated to you as a spoken yes or no. Keep production credentials and repos you would not want touched by a misheard instruction out of `roots`.
- The read-back window exists because speech recognition mishears technical words. Listen to it.
- Tap **Start** while parked. Everything after that is designed to need no screen.

## Development

```bash
cd ~/Downloads/earpiece/bridge && npm test
```

```bash
cd ~/Downloads/earpiece/ios && xcodebuild -project Earpiece.xcodeproj -scheme Earpiece -destination 'generic/platform=iOS Simulator' build
```
