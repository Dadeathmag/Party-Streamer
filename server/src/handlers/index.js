'use strict';

/**
 * @file Handler registry.
 *
 * The only module that needs to know the full set of socket events. Adding a
 * new feature area means creating a handler module and registering it here —
 * server.js never changes.
 */

const { registerRoomHandlers } = require('./roomHandlers');
const { registerSignalHandlers } = require('./signalHandlers');
const {
  registerPlaybackHandlers,
  registerDisconnectHandler,
} = require('./playbackHandlers');

/**
 * Attach all event handlers to every incoming connection.
 *
 * @param {import('socket.io').Server} io
 * @param {import('../roomStore').RoomStore} store
 */
function registerHandlers(io, store) {
  io.on('connection', (socket) => {
    console.log(`[connect] ${socket.id}`);

    registerRoomHandlers(io, socket, store);
    registerSignalHandlers(io, socket);
    registerPlaybackHandlers(io, socket, store);
    registerDisconnectHandler(io, socket, store);
  });
}

module.exports = { registerHandlers };
