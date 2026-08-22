'use strict';

const { leaveCurrentRoom } = require('./membership');

/**
 * @file Playback synchronisation + disconnect handling.
 *
 * The host is the single source of truth for playback state. Guests never
 * broadcast sync events; the server enforces this by checking room ownership
 * before relaying anything.
 *
 * Wire format:
 *   host emits 'playback:sync' { action: 'play' | 'pause' | 'seek', time }
 *     → every other member of the room receives { action, time }
 */

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {import('../roomStore').RoomStore} store
 */
function registerPlaybackHandlers(io, socket, store) {
  socket.on('playback:sync', ({ action, time }) => {
    const code = store.roomCodeOf(socket.id);
    if (!code) return;

    const room = store.get(code);
    if (!room) return;

    // Only the host may send playback sync commands.
    if (room.hostId !== socket.id) return;

    console.log(`[playback:sync] ${code} — ${action} @ ${time}`);
    socket.to(code).emit('playback:sync', { action, time });
  });
}

/**
 * Tear down membership when a socket drops. Registered on every connection.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {import('../roomStore').RoomStore} store
 */
function registerDisconnectHandler(io, socket, store) {
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);
    leaveCurrentRoom(io, store, socket.id);
  });
}

module.exports = { registerPlaybackHandlers, registerDisconnectHandler };
