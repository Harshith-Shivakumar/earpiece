# Earpiece relay

Lets the iPhone app reach the bridge from any network: both connect outbound to the relay, which pairs them up by `bridge_id` and forwards opaque `d` payloads. The phone and bridge run a Noise IK session end to end (SPEC 12.3), so the relay only ever sees ciphertext.

```
core/     protocol logic: parsing, auth check, room state machine, limits (zero dependencies)
node/     plain Node 22 server (local testing, self-hosting)
worker/   Cloudflare Worker + Durable Object BridgeRoom (production)
test/     node --test
```

## Run locally

```sh
cd relay
npm start          # http://0.0.0.0:8790, TOFU keys in memory
npm test
```

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_PORT` | `8790` | Port |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `RELAY_STATE` | unset | JSON file that keeps TOFU keys across restarts (written with mode 0600) |
| `RELAY_TRUST_PROXY` | unset | `1` to take the client IP from the last `X-Forwarded-For` entry. Set it only behind exactly one reverse proxy. |

Point the bridge at it with `relay: "ws://127.0.0.1:8790"` (or a LAN address). iOS requires `wss://` for anything that isn't local, so to self-host for real, put the Node server behind a TLS proxy such as Caddy and set `RELAY_TRUST_PROXY=1`.

## Deploy to Cloudflare (owner only)

Needs your Cloudflare account. The free plan is enough: SQLite-backed Durable Objects, WebSocket Hibernation.

```sh
cd relay/worker
npx wrangler login
npx wrangler deploy
```

The relay is then at `https://earpiece-relay.<account>.workers.dev`. Set the bridge's `relay` to `wss://earpiece-relay.<account>.workers.dev`. Wrangler is a dev-time tool: it bundles `worker/index.js` with `core/`, and nothing it installs ships in the relay. Watch the logs with `npx wrangler tail` or in the dashboard (Workers Logs is enabled in `wrangler.toml`).

## Protocol summary (`/v1`, SPEC 12.2)

Every message is a JSON text frame with a `t` field. Binary values are base64url without padding.

**Bridge:** `wss://<relay>/v1/bridge?id=<bridge_id>`. The `?id=` lets the Worker pick the room before auth, and the `bridge_id` in `auth` must match it.

1. relay → `{t:"challenge", nonce}` (32 bytes)
2. bridge → `{t:"auth", v:1, bridge_id, pub, sig}`: `pub` is the 32-byte Ed25519 key, `sig` is a 64-byte Ed25519 signature over the UTF-8 bytes of `earpiece-relay-auth/1:` followed by the raw nonce bytes. It must arrive within 10 s.
3. relay → `{t:"ready"}`, then `{t:"open", c}` for each phone already waiting.
4. After that: relay → `open`, `data {c,d}`, `close {c}`. Bridge → `data {c,d}`, `close {c}`.

**Phone:** `wss://<relay>/v1/phone/<bridge_id>`

- Phone → `{t:"data", d}` and `{t:"close"}`. Relay → `{t:"data", d}`, `{t:"close"}` (sent just before a 1000 close when the bridge ends the session), `{t:"bridge_offline"}` and `{t:"bridge_online"}`.
- While the bridge is online, a new phone gets nothing from the relay and should send Noise message 1 right away.
- `bridge_online` means a new bridge socket is attached and any earlier end-to-end session is gone, so the phone starts a new handshake. It is also sent when a newer bridge socket replaces an older one.
- Data sent while the bridge is offline is dropped.

**Both:**

- Keepalive: send the exact text `{"t":"ping"}` every 25 s; the relay answers `{"t":"pong"}`. The ping counts as traffic for the 90 s idle timeout. The Node server also answers WebSocket protocol ping frames, but they don't count as activity, because the Worker cannot see them. On the Worker, the runtime answers pings without waking the Durable Object.
- `bridge_id` is the bridge's UUID. Case is ignored.
- Unknown `t` values are ignored, for forward compatibility.

**Connection ids:** `c` is 16 random bytes. A phone gets a new `c` each time it is opened to a bridge socket, so the bridge never sees the same `c` twice.

**Limits:** frames up to 1 MiB, `d` up to 1,048,000 characters. At most 4 phones per bridge: a fifth is closed with 4004, unless one of the four has been silent for 35 s or more, in which case that stale one is evicted. Sockets are closed after 90 s without a message. Each IP may open 20 new connections per minute; more get HTTP 429.

**Close codes**

| Code | Meaning |
| --- | --- |
| 1000 | Closed normally, or the bridge closed this phone's session |
| 1001 | Relay shutting down |
| 1003 | Binary frame |
| 1009 | Frame or `d` too large |
| 1011 | Relay storage error |
| 4000 | Malformed message, or a message sent before `ready` |
| 4001 | Auth failed: bad signature, bad field, unsupported `v`, or `bridge_id` differs from `?id=` |
| 4002 | Replaced by a newer bridge socket |
| 4003 | `pub` differs from the key first seen for this `bridge_id` (TOFU) |
| 4004 | Room full (4 phones) |
| 4005 | Idle for 90 s, or evicted as stale |
| 4006 | No valid auth within 10 s |

## Privacy

- The relay never decrypts, parses or logs `d` payloads.
- It stores one thing: the TOFU public key per `bridge_id` (Durable Object SQLite storage, or `RELAY_STATE` for the Node server).
- It sees metadata: bridge ids, connection times, message sizes and client IPs. The public privacy policy must say so (SPEC 12.8).
- Its logs hold metadata only: connection and close events with byte counts and durations, auth failures, rate-limit hits (with the IP), and rooms that were full. Rooms appear in logs as the first 8 characters of the `bridge_id`.

## Abuse limits and known gaps

- Bounded: frame size, phones per bridge, idle time, auth time, and new connections per IP.
- **Rate limiting on Workers is best effort.** The limiter is an in-memory map per Worker isolate. Cloudflare runs many isolates in many locations, so a client spread across them can exceed 20 per minute. For stronger limits, add a Cloudflare WAF rate-limiting rule on `/v1/*` or the Workers Rate Limiting binding. Per-room caps, the auth timeout and idle limits still apply inside each Durable Object.
- **TOFU squatting:** the first key to authenticate claims a `bridge_id` for good. `bridge_id` is a random UUID shared only in the pairing link, so this needs a leaked id. Recovery is a new `bridge_id`. On 4003 the bridge should say so loudly instead of retrying silently.
- **Room squatting:** anyone who knows a `bridge_id` can hold phone slots. Noise stops them from reading or injecting anything, and live phones (pinging every 25 s) cannot be evicted, but a squatter can keep new phones out.
- Not built yet (SPEC 12.8): a global kill switch per `bridge_id`.
