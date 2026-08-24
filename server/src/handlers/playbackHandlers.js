'use strict';

const { leaveCurrentRoom } = require('./membership');

/**
 * @file Playback synchronisation + disconnect handling.
 *
 * The host is the single source of truth for playback state. Guests never
 * broadcast sync events; the server enforces this by checking room ownership
 * before relaying anything.
 *
 * NOTE (Phase 4): playback sync now rides the host's WebRTC DataChannels
 * first; this Socket.IO relay remains only as a fallback until DataChannel
 * parity is proven. Clients tag commands with a monotonic `seq` so guests
 * that receive one over both transports apply it exactly once.
 *
 * Wire format:
 *   host emits 'playback:sync' { action: 'play'|'pause'|'seek', time, seq? }
 *     → every other member of the room receives { action, time, seq? }
 */

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {import('../roomStore').RoomStore} store
 */
function registerPlaybackHandlers(io, socket, store) {
  socket.on('playback:sync', ({ action, time, seq }) => {
    const code = store.roomCodeOf(socket.id);
    if (!code) return;

    const room = store.get(code);
    if (!room) return;

    // Only the host may send playback sync commands.
    if (room.hostId !== socket.id) return;

    console.log(`[playback:sync] ${code} — ${action} @ ${time}`);
    const payload = typeof seq === 'number' ? { action, time, seq } : { action, time };
    socket.to(code).emit('playback:sync', payload);
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
