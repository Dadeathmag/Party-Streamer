'use strict';

/**
 * @file Shared membership helper used by every handler that needs to pull a
 * socket out of its current room and notify the remaining members.
 *
 * Keeping this in one module guarantees create/join/leave/disconnect all
 * produce identical "someone left" semantics.
 */

/**
 * Remove a socket from its current room (if any) and emit the matching
 * Socket.IO events to the members left behind.
 *
 * @param {import('socket.io').Server} io
 * @param {import('../roomStore').RoomStore} store
 * @param {string} socketId
 */
function leaveCurrentRoom(io, store, socketId) {
  const removed = store.removeSocket(socketId);
  if (!removed) return;

  if (removed.destroyed) {
    // Host departed → the whole room dies; tell everyone who was left.
    console.log(`[room:${removed.code}] Host disconnected — destroying room`);
    io.to(removed.code).emit('room:host-left');
  } else {
    io.to(removed.code).emit('room:member-left', {
      socketId,
      members: removed.members,
    });
  }
}

module.exports = { leaveCurrentRoom };
