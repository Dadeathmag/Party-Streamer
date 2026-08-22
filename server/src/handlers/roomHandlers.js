'use strict';

const { leaveCurrentRoom } = require('./membership');

/**
 * @file Room lifecycle handlers: creating, joining, and leaving rooms.
 *
 * Wire format (client ↔ server):
 *   client emits 'room:create' { name, code }            → ack { ok, roomId, code, members }
 *   client emits 'room:join'   { code }                  → ack { ok, roomId, name, code, members }
 *   client emits 'room:leave'                            → ack { ok }
 * server emits 'room:member-joined' { socketId, displayName, members }
 * server emits 'room:member-left'   { socketId, members }
 * server emits 'room:host-left'
 */

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {import('../roomStore').RoomStore} store
 */
function registerRoomHandlers(io, socket, store) {
  // ── Create Room ───────────────────────────────────────────────────────────
  socket.on('room:create', ({ name, code }, ack) => {
    if (!name || !code) {
      return ack?.({ ok: false, error: 'Name and code are required.' });
    }

    const upperCode = code.toUpperCase();

    if (store.get(upperCode)) {
      return ack?.({ ok: false, error: 'A room with that code already exists.' });
    }

    // If this socket was in another room, drop out of it first.
    leaveCurrentRoom(io, store, socket.id);

    const result = store.createHostRoom({ name, code: upperCode, hostId: socket.id });
    socket.join(upperCode);

    console.log(`[room:create] ${socket.id} created room "${name}" (${upperCode})`);

    ack?.({
      ok: true,
      roomId: upperCode,
      code: upperCode,
      members: result.members,
    });
  });

  // ── Join Room ─────────────────────────────────────────────────────────────
  socket.on('room:join', ({ code }, ack) => {
    if (!code) {
      return ack?.({ ok: false, error: 'Room code is required.' });
    }

    const upperCode = code.toUpperCase();

    if (!store.get(upperCode)) {
      return ack?.({ ok: false, error: 'Room not found. Check the code and try again.' });
    }

    // If this socket was in another room, drop out of it first.
    leaveCurrentRoom(io, store, socket.id);

    const result = store.joinGuest({ code: upperCode, socketId: socket.id });
    socket.join(upperCode);

    console.log(
      `[room:join] ${socket.id} (${result.displayName}) joined room "${result.room.name}" (${upperCode})`
    );

    // Tell everyone already in the room about the newcomer.
    socket.to(upperCode).emit('room:member-joined', {
      socketId: socket.id,
      displayName: result.displayName,
      members: result.members,
    });

    ack?.({
      ok: true,
      roomId: upperCode,
      name: result.room.name,
      code: upperCode,
      members: result.members,
    });
  });

  // ── Leave Room ────────────────────────────────────────────────────────────
  socket.on('room:leave', (_, ack) => {
    const code = store.roomCodeOf(socket.id);
    if (code) {
      socket.leave(code);
    }
    leaveCurrentRoom(io, store, socket.id);
    console.log(`[room:leave] ${socket.id} left`);
    ack?.({ ok: true });
  });
}

module.exports = { registerRoomHandlers };
