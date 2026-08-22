# Party Streamer

Host a watch party: the host streams playback state, guests join with a room code.

## Running the project (development)

1. Install Node.js
2. Install dependencies:

   ```powershell
   npm i --prefix server
   npm i --prefix client
   ```

3. Start the signaling server (terminal 1):

   ```powershell
   npm run dev --prefix server
   ```

4. Start the client dev server, exposed on your LAN so other devices can reach it (terminal 2):

   ```powershell
   npm run dev --prefix client -- --host
   ```

5. Share the **Network** URL Vite prints (e.g. `http://192.168.1.42:5173`) with guests.
   The client connects to Socket.IO via same-origin `/socket.io`, which the dev proxy
   forwards to `http://localhost:3002` — no extra config needed for guests.

## Running without Vite (single origin)

```powershell
npm run build --prefix client
npm start --prefix server
```

Then everyone — host and guests — just opens `http://<your-ip>:3002`.

## Config

| Variable         | Where  | Default                        | Purpose                                                        |
| ---------------- | ------ | ------------------------------ | -------------------------------------------------------------- |
| `PORT`           | server | `3002`                         | Signaling server port                                          |
| `CLIENT_ORIGIN`  | server | reflect request origin         | Comma-separated CORS allowlist, e.g. `http://localhost:5173`   |
| `VITE_SERVER_URL`| client | same origin as page            | Point the client at the server if hosted on different origins  |

Windows Firewall may prompt on first LAN access — allow Node.js on private networks.

## Architecture

Two independent packages: `server/` (Express + Socket.IO, CommonJS) and `client/`
(React + Vite, ESM). They communicate purely over Socket.IO events — see the
wire-format tables in each handler module under `server/src/handlers/`.

### Sync model

The host is the single source of truth for playback. Host interactions emit
`playback:sync` (`play` / `pause` / `seek` + time); the server verifies the
sender owns the room before relaying to everyone else. Guests apply received
commands to their local `<video>` element and never broadcast.

### Server

```
server/
├── server.js                  entrypoint: wires config → app → io → handlers → listen
└── src/
    ├── config.js              PORT + CLIENT_ORIGIN parsing (env-driven)
    ├── roomStore.js           RoomStore class — all room/membership state, no I/O
    ├── createApp.js           Express app: CORS, GET /health, static client/dist
    ├── socket.js              Socket.IO bootstrap (shares CORS config)
    └── handlers/
        ├── index.js           connection dispatcher — registers everything below
        ├── membership.js      shared "leave current room + notify" logic
        ├── roomHandlers.js    room:create / room:join / room:leave
        ├── signalHandlers.js  WebRTC offer/answer/ICE relay (pass-through)
        └── playbackHandlers.js  playback:sync relay (host-only) + disconnect
```

Design rules:

- **RoomStore never touches Socket.IO** — handlers decide what to emit based
  on what the store returns, so state logic stays unit-testable.
- **server.js only wires** — adding a feature area means a new handler module
  registered in `handlers/index.js`; the entrypoint doesn't change.
- **One source of truth for wire format** — documented at the top of each
  handler module.

### Client

```
client/src/
├── main.jsx                   entrypoint (StrictMode + createRoot)
├── App.jsx                    two-page flow (home ⇄ room) + shared useSocket()
├── hooks/
│   └── useSocket.js           single Socket.IO connection + room/sync state
├── lib/
│   └── formatTime.js          pure helpers
├── components/
│   ├── Icons.jsx              inline SVG icon set (currentColor, size prop)
│   ├── VideoStage.jsx         <video> / empty state + members overlay
│   ├── PlayerControls.jsx     seek bar, transport buttons, volume, time
│   ├── ChatPanel.jsx          chat sidebar (relayed via chat:message)
│   └── MembersPopup.jsx       member list overlay
└── pages/
    ├── Home.jsx               host/join forms; delegates networking to App
    └── Room.jsx               orchestrator: playback/chat state + sync wiring
```

Design rules:

- **pages orchestrate, components render** — Room.jsx owns all playback state
  and refs; VideoStage/PlayerControls/ChatPanel are presentational.
- **CSS stays page-scoped** (`Home.css`, `Room.css`) using BEM class names;
  extracted components reuse those classes rather than carrying their own
  stylesheets.
- **Element IDs preserved** (`btn-*`, `input-*`, …) across every refactor so
  any tooling or tests that hook them keep working.

### Socket.IO event reference

| Event                 | Direction        | Payload                              |
| --------------------- | ---------------- | ------------------------------------ |
| `room:create`         | client → server  | `{ name, code, displayName }` → ack  |
| `room:join`           | client → server  | `{ code, displayName }` → ack        |
| `room:leave`          | client → server  | —                                    |
| `room:member-joined`  | server → room    | `{ socketId, displayName, members }` |
| `room:member-left`    | server → room    | `{ socketId, members }`              |
| `room:host-left`      | server → room    | — (room is destroyed)                |
| `playback:sync`       | host → server    | `{ action: 'play'\|'pause'\|'seek', time }` |
| `playback:sync`       | server → guests  | `{ action, time }`                   |
| `chat:message`        | client → server  | `{ text }`                           |
| `chat:message`        | server → room    | `{ from, displayName, text, ts }`    |
| `signal:*`            | client ↔ client  | relayed `{ from, offer/answer/candidate }` |
