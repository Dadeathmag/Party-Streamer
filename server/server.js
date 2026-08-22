'use strict';

/**
 * @file Party Stream signaling server — entrypoint.
 *
 * Deliberately tiny: it only wires the modules in src/ together and starts
 * listening. All real logic lives there:
 *
 *   src/config.js            environment-driven settings (port, CORS)
 *   src/roomStore.js         in-memory room state
 *   src/createApp.js         Express app (CORS, /health, static client)
 *   src/socket.js            Socket.IO bootstrap
 *   src/handlers/            socket event handlers, grouped by feature
 */

const http = require('http');

const { PORT, corsOrigin } = require('./src/config');
const { RoomStore } = require('./src/roomStore');
const { createExpressApp } = require('./src/createApp');
const { attachSocketIo } = require('./src/socket');
const { registerHandlers } = require('./src/handlers');

// ── Shared state ──────────────────────────────────────────────────────────────
const store = new RoomStore();

// Assigned right after attachSocketIo; /health reads it lazily so ordering
// between app creation and io creation doesn't matter.
/** @type {import('socket.io').Server | null} */
let io = null;

// ── HTTP layer ────────────────────────────────────────────────────────────────
const app = createExpressApp({
  corsOrigin,
  getStats: () => ({
    status: 'ok',
    rooms: store.size,
    connections: io ? io.engine.clientsCount : 0,
  }),
});

const server = http.createServer(app);

// ── Realtime layer ────────────────────────────────────────────────────────────
io = attachSocketIo(server, corsOrigin);
registerHandlers(io, store);

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  🎉 Party Stream signaling server running on http://localhost:${PORT}\n`);
});
