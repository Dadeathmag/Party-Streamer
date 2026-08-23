# AGENTS.md — Instructions for Coding Agents

Read [project.md](project.md) first for the vision and phase roadmap. This file
describes how the codebase actually works today and the rules for changing it.

## Project Snapshot

Party Stream is a P2P watch-party app: a host streams playback state (and
eventually media itself) peer-to-peer; guests join with a 6-character room
code. The server is **signaling only** — it must never receive, store, or
proxy video.

Current status: Phases 1–2 complete (UI + signaling, integration-tested), plus
early Phase 4 mechanics (`playback:sync` relayed via Socket.IO, host-only) and
chat relayed via Socket.IO (`chat:message`, membership-checked). Members now
carry client-supplied display names. **Phase 3 (basic WebRTC) is done** — the
host holds an `RTCPeerConnection` + DataChannel toward each viewer, and the
selected video is distributed as P2P chunks with progressive MSE playback
(early Phase 5 mechanics). **Next task is Phase 4 proper** — see bottom of
this file. No peer forwarding yet.

## Repository Map

Two independent npm packages. Server is CommonJS; client is ESM.

```
server/                          CommonJS, port 3002
├── server.js                    entrypoint: wires config → app → io → handlers → listen
├── test_signaling.js            end-to-end Socket.IO integration tests (npm test)
└── src/
    ├── config.js                PORT + CLIENT_ORIGIN parsing (env-driven)
    ├── roomStore.js             RoomStore class — all room/membership state, NO I/O,
    │                            no Socket.IO imports. Maps: rooms, socketToRoom
    │                            (reverse index), guestCounters ("Guest-N" names)
    ├── createApp.js             Express app: CORS, GET /health, serves client/dist
    ├── socket.js                Socket.IO bootstrap (shares CORS config)
    └── handlers/
        ├── index.js             connection dispatcher — registers everything below
        ├── membership.js        shared "leave current room + notify" logic
        ├── roomHandlers.js      room:create / room:join / room:leave (+ acks)
        ├── signalHandlers.js    WebRTC offer/answer/ICE blind pass-through relay
        ├── playbackHandlers.js  playback:sync relay (host-only) + disconnect teardown
        └── chatHandlers.js      chat:message relay (membership-checked, no storage)

client/                          React 19 + Vite, ESM
├── vite.config.js               dev proxy: /socket.io → http://localhost:3002
└── src/
    ├── main.jsx                 entrypoint (StrictMode + createRoot)
    ├── App.jsx                  two-page flow (home ⇄ room) + single useSocket()
    │                            and usePeerNetwork() mount
    ├── hooks/
    │   ├── useSocket.js         ALL Socket.IO logic: connection lifecycle, room
    │                            create/join/leave, members state, playback sync
    │                            send/receive, chat send/receive, onHostLeft,
    │                            signal:* passthrough (sendSignal / onSignal)
    │   └── usePeerNetwork.js    P2P glue: one Peer per remote member reconciled
    │                            against the members list; host chunked-upload of
    │                            the selected video (late joiners auto-served);
    │                            guest FileReceiver wiring + transfer status
    ├── network/
    │   ├── roomProtocol.js      transport-independent DataChannel message types
    │   │                        (FILE_OFFER/ACCEPT/COMPLETE/ABORT) + chunk/backpressure
    │   │                        constants; JSON strings = control, ArrayBuffer = bytes
    │   ├── peer.js              per-peer RTCPeerConnection wrapper (STUN, host is
    │                            permanent offerer, reliable ordered DataChannel,
    │                            ICE queueing, drain-wait backpressure helper)
    │   ├── fileSender.js        lazy File.slice() streaming with bufferedAmount
    │                            high/low-water pause-resume, accept timeout, abort
    │   └── fileReceiver.js      handshake counterpart: progressive MSE append or
    │                            Blob fallback assembly → object URL for <video>
    ├── lib/
    │   ├── formatTime.js        pure helpers
    │   └── msePlayer.js         MediaSource wrapper (isTypeSupported gate, queued
    │                            appendBuffer on updateend, endOfStream, destroy)
    ├── components/              presentational only:
    │   ├── Icons.jsx            inline SVG set (currentColor, size prop)
    │   ├── VideoStage.jsx       always-mounted <video> + empty-state/receiving
    │   │                        overlay + members popup
    │   ├── PlayerControls.jsx   seek bar, transport buttons, volume, time
    │   ├── ChatPanel.jsx        chat sidebar (LOCAL-ONLY state for now)
    │   └── MembersPopup.jsx     member list overlay (fed by live members prop)
    └── pages/
        ├── Home.jsx             mode state machine (null|host|join); generates room
        │                        code CLIENT-side (see Known Gaps); delegates
        │                        networking to App
        └── Room.jsx             orchestrator: owns playback state + refs, applies
                                 incoming sync to local <video>, emits sync on
                                 host interactions, hands file to sendFile() and
                                 registers the video element with usePeerNetwork
```

## Wire Format Reference (Socket.IO)

One source of truth per handler lives at the top of each module in
`server/src/handlers/`. Summary:

### Client → Server (all room ops use acknowledgment callbacks)

| Event              | Payload                                        | Ack response |
| ------------------ | ---------------------------------------------- | ------------ |
| `room:create`      | `{ name, code, displayName }`                  | `{ ok: true, roomId, code, members }` or `{ ok: false, error }` |
| `room:join`        | `{ code, displayName }`                        | `{ ok: true, roomId, name, code, members }` |
| `room:leave`       | —                                              | `{ ok: true }` |
| `playback:sync`    | `{ action: 'play'\|'pause'\|'seek', time }`    | none (fire-and-forget) |
| `chat:message`     | `{ text }`                                     | none (fire-and-forget) |
| `signal:offer`     | `{ to, offer }`                                | none |
| `signal:answer`    | `{ to, answer }`                               | none |
| `signal:ice-candidate` | `{ to, candidate }`                        | none |

Server-side enforcement:

- Codes are upper-cased before lookup; duplicate codes rejected on create;
  unknown codes rejected on join.
- `displayName` is optional on create/join; blank/missing falls back to
  "Host" / "Guest-N". Duplicates inside a room get a numeric suffix
  ("Alex 2"). Names are trimmed and capped at 24 chars server-side.
- `playback:sync` is silently dropped unless the sender is that room's host.
- `chat:message` requires membership; text is trimmed, capped at 300 chars,
  and never stored — the room's history lives only in clients.
- Signal relays are blind: the server never inspects SDP/ICE payloads.
- Disconnect always runs `leaveCurrentRoom`; if the leaver was the host the
  room is destroyed and every member gets `room:host-left`.

### Server → Client

| Event                 | Payload                                    | Audience      |
| --------------------- | ------------------------------------------ | ------------- |
| `room:member-joined`  | `{ socketId, displayName, members }`       | room          |
| `room:member-left`    | `{ socketId, displayName, members }`       | room          |
| `room:host-left`      | — (room destroyed)                         | room          |
| `playback:sync`       | `{ action, time }`                         | everyone else |
| `chat:message`        | `{ from, displayName, text, ts }`          | whole room incl. sender |
| `signal:offer`        | `{ from, offer }`                          | target peer   |
| `signal:answer`       | `{ from, answer }`                         | target peer   |
| `signal:ice-candidate`| `{ from, candidate }`                      | target peer   |

Chat echo note: because the sender receives their own message back, clients
append chat history from exactly one place (the `chat:message` listener) and
mark messages "own" via `from === myId`.

Client behavior contract (in `useSocket.js`): every mutating call awaits
`ensureConnected()` first (revives auto-reconnect if exhausted, 5s timeout),
then resolves the ack. Components never touch the raw socket — they consume
the hook's returned API.

## Engineering Rules (must follow)

1. **The server never receives media.** No upload endpoints, no proxying, no
   transcoding — ever.
2. **`RoomStore` never imports Socket.IO.** Handlers decide what to emit based
   on what the store returns; this keeps state logic unit-testable.
3. **`server.js` only wires.** New feature areas = new handler module
   registered in `handlers/index.js`. Don't grow the entrypoint.
4. **Document wire format atop each handler module** (existing pattern).
5. **Pages orchestrate, components render.** Room.jsx owns playback/chat state
   and refs; components under `components/` are presentational.
6. **Networking stays out of Room.jsx internals** — it flows through
   `useSocket` props/callbacks.
7. **Protocol messages stay transport-independent.** When Phase 3 lands,
   introduce `client/src/network/roomProtocol.js` defining message types
   (`PLAY`, `PAUSE`, `SEEK`, `CHAT`, …) so they survive the Socket.IO →
   DataChannel migration.
8. **The host is authoritative.** Guests apply received sync commands to their
   local `<video>` and never broadcast sync. Server enforces ownership.
9. **No Redux/state libraries, no new frameworks, no DB, no transcoder.**
10. **Incremental phases only** — don't jump to peer forwarding or voice
    before their prerequisites exist.

## Code Conventions Observed Here

- Server: `'use strict'`, CommonJS, JSDoc types, `@file` header comments.
- Client: ESM, JSX function components with prop-type JSDoc comments.
- CSS: page-scoped stylesheets (`Home.css`, `Room.css`) using BEM class names;
  extracted components reuse those classes rather than carrying own sheets.
- **Element IDs are stable API** (`btn-*`, `input-*`, `mode-selection`,
  …) — preserve them across refactors so tooling/tests keep working.
- Console logs on the server use `[handler-name]` prefixes.

## Commands (PowerShell)

```powershell
# Install
npm i --prefix server
npm i --prefix client

# Dev — terminal 1 (signaling server, port 3002)
npm run dev --prefix server

# Dev — terminal 2 (client, LAN-exposed so guests can reach it)
npm run dev --prefix client -- --host

# Tests (server integration suite — run after ANY server change)
npm test --prefix server

# Lint (client)
npm run lint --prefix client

# Single-origin production-style run (no Vite):
npm run build --prefix client
npm start --prefix server     # then open http://<your-ip>:3002 for everyone
```

Config (env vars): `PORT` (server, default 3002), `CLIENT_ORIGIN`
(comma-separated CORS allowlist; unset = reflect origin, convenient for LAN),
`VITE_SERVER_URL` (client; empty = same-origin).

## Verification Checklist (manual, two browser tabs)

1. Host tab: Home → "Host a Room" → name → Start Party → room code displayed,
   member count 1.
2. Guest tab: Join with the code → both tabs show 2 members in Members popup.
3. Close guest tab → host drops to 1 member.
4. Close host tab → guest receives `room:host-left` and returns home cleanly.
5. Host selects local video, plays/pauses/seeks → guest's video mirrors the
   action (currently over the Socket.IO relay).
6. With the video still selected, watch the guest tab: "Receiving …%" overlay
   appears, then the video becomes playable (MSE) or assembles and swaps in
   (Blob fallback for non-MSE formats). A guest joining AFTER selection gets
   the file automatically once its DataChannel opens.

Automated equivalent: `npm test --prefix server` covers the whole event
surface including non-host sync rejection and host-disconnect teardown.
Client P2P transfer has no automated tests yet — verify manually per step 6.

## Known Gaps / Planned Fixes

Do not silently change these without updating project.md's deviation list:

1. **Room code generation is client-side** (`Home.jsx` `generateCode()`,
   base36) and can emit visually ambiguous characters (O/0/I/1/L). Target:
   server-generated codes from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.
2. **No max-room-size cap yet** — add configurable `MAX_PEERS_PER_ROOM ≈ 6`
   check to join validation.
3. **Chat relays over Socket.IO** — works end-to-end today but moves to
   DataChannels in Phase 7 (payload shape already transport-independent).
4. **Playback sync rides the signaling transport** — migrate onto
   DataChannels (Phase 4 proper; the channels already exist).
5. **No shareable room URLs** (`/room/:code`) yet.
6. **Video transfer memory ceiling** — guests retain every chunk until
   completion (enables transparent MSE→Blob fallback), so RAM use peaks at
   ~file size; multi-GB files are impractical until chunks spill to OPFS.
7. **Seeking beyond buffered data stalls** on guests mid-transfer (no range
   requests yet); full seek works after FILE_COMPLETE.

## Next Task: Phase 4 proper — Playback sync over DataChannels

Scope:

1. Extend `network/roomProtocol.js` with PLAY / PAUSE / SEEK message types.
2. Host broadcasts sync commands over each viewer's DataChannel instead of
   the `playback:sync` Socket.IO relay; server relay stays temporarily as
   fallback until parity is proven.
3. Drift handling: periodic host time beacons, soft-correct viewers.

Do NOT start peer forwarding (Phase 6), chat transport migration (Phase 7),
or voice (Phase 8) before this works.
