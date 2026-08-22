# Party Stream — Project Vision & Roadmap

> This is the master vision document. For coding-agent instructions, current
> implementation status, and wire-format reference, see [AGENTS.md](AGENTS.md).
> User-facing run instructions live in [README.md](README.md).

## What Party Stream Is

A small peer-to-peer watch-party web application. A **host** creates a private
room, selects a video stored locally on their device, and watches it together
with a small group of viewers.

```
        HOST
         │
         │ P2P
    ┌────┴────┐
    ▼         ▼
 VIEWER    VIEWER
    │
    ▼
 VIEWER
```

The host is the authority for the watch session. The video stays on the host's
device; media is distributed directly between browsers.

The application should eventually support:

- Local video selection by the host
- Peer-to-peer video distribution
- Peer forwarding/relaying for small groups
- Synchronized playback
- Host-only playback controls
- Real-time text chat
- Voice communication
- Participant list
- Room codes and shareable room URLs
- Mobile browser support

The project is primarily a learning project focused on:

- WebRTC, P2P networking, signaling
- DataChannels and media transfer
- Peer topology and distributed state synchronization
- Browser media APIs

It must NOT behave like a traditional centralized streaming service.

## Core Design Principle: The Signaling Server Is Not the Video Server

The server is only responsible for:

- Creating rooms / joining rooms / tracking participants
- Identifying the host
- Relaying WebRTC signaling messages (offers, answers, ICE candidates)
- Notifying peers when participants join/leave

The server must NOT:

- Receive, store, transcode, proxy, download, or stream the movie

Actual media transfer happens directly between browsers.

## Technology Stack

| Layer    | Choice                                        |
| -------- | --------------------------------------------- |
| Frontend | React + Vite + JavaScript + CSS               |
| Backend  | Node.js + Express + Socket.IO (signaling only)|
| P2P      | WebRTC                                        |
| Future   | WebTorrent may be evaluated for media         |

No Redux or other state-management libraries unless there is a strong reason.
No unnecessary frameworks.

## Constraints & Limits

- Target group size: **1 host + up to ~5 viewers** (`MAX_PEERS_PER_ROOM = 6`,
  configurable). Never optimize for hundreds of viewers.
- Rooms are in-memory (`Map`) — no database. A room exists only while the
  server runs.
- Video formats: whatever the browser's HTML5 `<video>` supports. No
  transcoding, no FFmpeg pipeline in-app.
- The host selects a local file via `URL.createObjectURL(file)`; this local
  source later becomes the origin of P2P distribution.
- Mobile-friendly UI; no keyboard-only or hover-only interactions.

### Room codes

Room codes are 6 characters drawn from an unambiguous alphabet:

```
ABCDEFGHJKLMNPQRSTUVWXYZ23456789
```

(O/0/I/1/L excluded because they are visually confusing.) Codes must be unique
among active rooms. **Target rule:** the *server* generates the code.

## Development Phases & Status

| Phase | Scope                                                        | Status |
| ----- | ------------------------------------------------------------ | ------ |
| 1     | UI: Home (host/join), Room (video, controls, chat, members)  | ✅ Done |
| 2     | Signaling: Node/Socket.IO server, room create/join/leave, disconnect handling, participant tracking, signal relay | ✅ Done — integration-tested |
| 2.5   | Playback sync relay over Socket.IO (`playback:sync`, host-only, ownership verified server-side) | ✅ Done — early Phase 4 mechanics over the wrong transport; migrate to DataChannels in Phase 4 proper |
| 3     | Basic WebRTC: `RTCPeerConnection`, STUN, offer/answer/ICE, DataChannel | ⬜ **Next up** |
| 4     | Playback sync on P2P: host PLAY/PAUSE/SEEK/SKIP via protocol messages; drift handling | ◐ Partial (relay exists; not yet P2P) |
| 5     | Basic video P2P: evaluate media tracks vs MSE vs WebTorrent vs chunked DataChannel; browser memory limits | ⬜ Planned |
| 6     | Peer forwarding: small distribution tree with configurable upload slots | ⬜ Planned |
| 7     | Chat over DataChannels (chat currently Socket.IO-relayed)     | ⬜ Planned |
| 8     | Voice: `getUserMedia()` + WebRTC audio                        | ⬜ Planned |
| 9     | Mobile optimization: bandwidth, memory, battery, recovery, layout | ⬜ Planned |

Phase success conditions:

- **Phase 3**: host and viewer establish a direct WebRTC connection; a
  `"Hello from host"` message crosses a DataChannel.
- **Phase 4**: two browsers stay approximately synchronized under host
  play/pause/seek/skip.
- **Phase 6**: each peer has `parent`, `children[]`, upload capacity
  (`maxChildren ≈ 2`); topology forms a small tree:

```
              HOST
             /    \
            /      \
        VIEWER A  VIEWER B
           |
           |
        VIEWER C
```

Do not build phases out of order: no peer forwarding before basic WebRTC
works; no voice before DataChannels work.

## Conceptual Protocol Messages

Transport-independent message shapes (today Socket.IO relay, tomorrow WebRTC
DataChannels):

```js
{ type: "PLAY",  time: 83.4,  timestamp: Date.now() }
{ type: "PAUSE", time: 91.7,  timestamp: Date.now() }
{ type: "SEEK",  time: 125.2, timestamp: Date.now() }
{ type: "CHAT",  userId, username, text, timestamp }
{ type: "PEER_JOINED" | "PEER_LEFT", ... }
```

Only the host changes shared playback state. Viewer volume stays local.

## Expected Final Architecture

```
             ┌─────────────────────┐
             │   SIGNALING SERVER  │
             │                     │
             │ Room management     │
             │ Peer discovery      │
             │ WebRTC signaling    │
             └──────────┬──────────┘
                        │ signaling only
          ┌─────────────┴─────────────┐
          ▼                           ▼
        HOST                       VIEWERS
          │                           │
          │          WebRTC           │
          ├───────────────────────────┤
          ▼                           ▼
      Video P2P                  DataChannels
                                       ├── Chat
                                       ├── Playback control
                                       └── Presence
```

Later, video flows through a peer tree so the host does not upload N copies.

## Engineering Principles

1. Keep signaling separate from P2P media.
2. Keep UI separate from networking.
3. Keep the room protocol independent from Socket.IO.
4. Do not put all networking logic inside Room.jsx.
5. Do not upload the movie to the server.
6. Do not build peer forwarding before basic WebRTC works.
7. Do not build voice before basic DataChannels work.
8. Do not optimize for large groups (~3–6 participants is the target).
9. Make the system understandable rather than excessively abstract.
10. Development proceeds incrementally, phase by phase.

## Known Deviations from Original Plan (honest status)

These are deliberate or pending corrections — see AGENTS.md before changing them:

1. **Room codes are currently generated client-side** (`Home.jsx`), with the
   server only checking uniqueness. Target rule is server-side generation
   using the unambiguous alphabet above (current base36 generation can emit
   O/0/I/1/L).
2. **No room-size cap enforced yet** — `MAX_PEERS_PER_ROOM` needs adding to
   join validation.
3. **Playback commands ride the signaling transport**, not DataChannels —
   acceptable bridge until Phase 3/4 lands.
4. **Event naming uses `room:*` / `signal:*` / `playback:*`** namespaces rather
   than the originally sketched `create-room` / `webrtc-offer` names. The code
   is authoritative; don't rename without updating every doc.
5. **Chat relays over the signaling transport** (`chat:message` via
   Socket.IO, membership-checked, never stored) instead of DataChannels —
   acceptable bridge until Phase 7; payload shape is transport-independent.
6. **No shareable room URLs yet** (`/room/:code` routing planned but not built).
