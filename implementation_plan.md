# Signaling Server + Client Socket Integration

Implement the Socket.IO signaling server and wire it into the existing React frontend. No UI redesign — only add networking logic behind the existing components.

## Proposed Changes

### Server — Node.js + Socket.IO

#### [MODIFY] [package.json](file:///c:/Code/Party-Streamer/server/package.json)
- Add `express`, `socket.io`, `cors`, `uuid` dependencies
- Add `"start": "node server.js"` and `"dev": "node --watch server.js"` scripts

#### [MODIFY] [server.js](file:///c:/Code/Party-Streamer/server/server.js)
Implement the full signaling server. The server maintains an in-memory `rooms` Map. Each room stores:
- `code` (6-char room identifier)
- `name` (display name)
- `hostId` (socket ID of the host)
- `members` (Map of `socketId → { displayName, role }`)

**Socket events handled:**

| Client → Server | Server → Client | Description |
|---|---|---|
| `room:create` `{ name, code }` | `room:created` `{ roomId, code, members }` | Host creates a room; server validates code uniqueness |
| `room:join` `{ code }` | `room:joined` `{ roomId, name, code, members }` | Peer joins by code; all members get `room:member-joined` |
| `room:leave` | `room:member-left` `{ socketId }` | Clean departure |
| *(disconnect)* | `room:member-left` `{ socketId }` | Ungraceful departure; if host leaves, `room:host-left` is broadcast and room is destroyed |
| `signal:offer` `{ to, offer }` | `signal:offer` `{ from, offer }` | WebRTC offer relay (future) |
| `signal:answer` `{ to, answer }` | `signal:answer` `{ from, answer }` | WebRTC answer relay (future) |
| `signal:ice-candidate` `{ to, candidate }` | `signal:ice-candidate` `{ from, candidate }` | ICE candidate relay (future) |
| `playback:sync` `{ action, time }` | `playback:sync` `{ action, time }` | Host → peers playback sync (play/pause/seek) |

**Error handling:** All mutating events return acknowledgment callbacks with `{ ok, error }`. Room-not-found, code-already-taken, and not-authorized errors are handled.

**Security notes:**
- CORS restricted to `http://localhost:5173` (Vite dev) in dev mode
- Playback sync events are only accepted from the room's host socket

---

### Client — Socket Hook + Component Wiring

#### [NEW] [useSocket.js](file:///c:/Code/Party-Streamer/client/src/hooks/useSocket.js)
A custom React hook that encapsulates all Socket.IO logic:
- Connects to `http://localhost:3001` on mount, disconnects on unmount
- Exposes: `socket`, `connected`, `members`, `error`
- Methods: `createRoom(name, code)`, `joinRoom(code)`, `leaveRoom()`, `sendPlaybackSync(action, time)`
- Listens for `room:member-joined`, `room:member-left`, `room:host-left`, `playback:sync`
- Returns a stable object reference via `useMemo`

#### [MODIFY] [App.jsx](file:///c:/Code/Party-Streamer/client/src/App.jsx)
- Import and use `useSocket` hook
- On `handleEnterRoom`: call `socket.createRoom()` or `socket.joinRoom()` depending on role; navigate to Room only on success callback
- On `handleLeaveRoom`: call `socket.leaveRoom()` before resetting state
- Pass `socket`, `connected`, `members`, `error` down to `Room`

#### [MODIFY] [Home.jsx](file:///c:/Code/Party-Streamer/client/src/pages/Home.jsx)
**Minimal changes — no UI redesign.** Only:
- Accept an optional `error` prop and display it as a small inline message below the form if present (e.g. "Room not found" or "Code already in use")
- Accept `connecting` prop to disable submit button and show a loading state while Socket.IO negotiates

#### [MODIFY] [Room.jsx](file:///c:/Code/Party-Streamer/client/src/pages/Room.jsx)
**Minimal changes — no UI redesign.** Only:
- Accept `socket`, `connected`, `members` as new props
- Replace the hard-coded members popup with the live `members` array
- Replace the hard-coded member count `2` with `members.length`
- When the host triggers play/pause/seek, also call `sendPlaybackSync(action, time)` so peers will eventually receive sync
- Listen for incoming `playback:sync` events (as a non-host) and apply them to the local `<video>` element
- On `room:host-left`, show a brief toast/notice and call `onLeave`

---

### Dev Tooling

#### [MODIFY] [vite.config.js](file:///c:/Code/Party-Streamer/client/vite.config.js)
- Add a proxy entry so `/socket.io` requests are forwarded to `http://localhost:3001` during dev — this avoids CORS issues without any extra config

---

## Open Questions

> [!IMPORTANT]
> **Display names:** Currently the frontend doesn't collect a username — hosts are shown as "Host" and joiners as "You". Should I:
> - **(A)** Keep it this way for now (anonymous, server assigns "Host" / "Guest-1", "Guest-2", etc.)
> - **(B)** Add a username input field to the Home page forms?
>
> I'll default to **(A)** unless you say otherwise.

> [!NOTE]
> **Server port:** I'll use port `3001` for the signaling server (Vite runs on `5173`). Let me know if you prefer a different port.

## Verification Plan

### Automated Tests
- None yet (no test framework in the project). Verification will be manual.

### Manual Verification
1. Start the server: `cd server && npm start`
2. Start the client: `cd client && npm run dev`
3. **Test host flow:** Open browser → "Host a Room" → enter name → "Start Party" → verify room is created, member count shows `1`, room code is displayed
4. **Test join flow:** Open a second browser tab → "Join a Room" → enter the room code → "Join Party" → verify both tabs show `2` members in the members popup
5. **Test leave/disconnect:** Close the joiner tab → verify host tab drops to `1` member. Close the host tab → verify joiner gets `room:host-left` and returns to home screen
6. **Test playback sync:** Host selects a video and presses play → verify joiner receives the sync event (visible in browser console logs for now, since actual P2P streaming isn't wired yet)
