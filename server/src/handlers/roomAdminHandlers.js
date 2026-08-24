'use strict';

/**
 * @file Host room administration: visibility (private ⇄ public), locking
 * the door against new joins, and member removal. Public rooms are
 * discoverable via 'room:list'; private rooms are join-only-by-code (the
 * default). Locking a room rejects every incoming join — even with the
 * correct code — until the host unlocks it again.
 *
 * Kicking is a server-initiated leave: the store drops the target, the
 * socket leaves its Socket.IO room, and everyone else sees the standard
 * 'room:member-left' (with `kicked: true`) so client state stays in sync
 * through the same listener as ordinary departures. The removed socket
 * itself gets 'room:kicked' instead and must bounce back to the home page.
 *
 * Wire format:
 *   host emits 'room:set-visibility' { isPublic: boolean }
 *     → ack { ok, isPublic } or { ok, error }
 *     → every member receives 'room:visibility-changed'
 *       { from, displayName, isPublic }        (incl. the host)
 *   host emits 'room:set-locked' { locked: boolean }
 *     → ack { ok, locked } or { ok, error }
 *     → every member receives 'room:lock-changed'
 *       { from, displayName, locked }          (incl. the host)
 *   anyone emits 'room:list'
 *     → ack { ok, rooms: [{ code, name, hostName, memberCount }] }
 *   host emits 'room:kick' { socketId }
 *     → ack { ok } or { ok, error }
 *     → removed socket receives 'room:kicked' { reason? }
 *     → remaining members receive 'room:member-left'
 *       { socketId, displayName, members, kicked: true }
 */

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {import('../roomStore').RoomStore} store
 */
function registerRoomAdminHandlers(io, socket, store) {
  // ── Visibility (host only) ────────────────────────────────────────────────
  socket.on('room:set-visibility', ({ isPublic } = {}, ack) => {
    const code = store.roomCodeOf(socket.id);
    if (!code) {
      return ack?.({ ok: false, error: 'You are not in a room.' });
    }

    const room = store.get(code);
    if (!room) return;

    if (room.hostId !== socket.id) {
      return ack?.({ ok: false, error: 'Only the host can change room visibility.' });
    }

    if (typeof isPublic !== 'boolean') {
      return ack?.({ ok: false, error: 'isPublic must be a boolean.' });
    }

    const stored = store.setRoomVisibility(code, isPublic);
    if (stored === null) return;

    console.log(`[room:set-visibility] ${code} — ${isPublic ? 'public' : 'private'}`);

    io.to(code).emit('room:visibility-changed', {
      from: socket.id,
      displayName: room.members.get(socket.id)?.displayName,
      isPublic,
    });

    ack?.({ ok: true, isPublic });
  });

  // ── Lock the door against new joins (host only) ───────────────────────────
  socket.on('room:set-locked', ({ locked } = {}, ack) => {
    const code = store.roomCodeOf(socket.id);
    if (!code) {
      return ack?.({ ok: false, error: 'You are not in a room.' });
    }

    const room = store.get(code);
    if (!room) return;

    if (room.hostId !== socket.id) {
      return ack?.({ ok: false, error: 'Only the host can lock or unlock the room.' });
    }

    if (typeof locked !== 'boolean') {
      return ack?.({ ok: false, error: 'locked must be a boolean.' });
    }

    const stored = store.setLocked(code, locked);
    if (stored === null) return;

    console.log(`[room:set-locked] ${code} — ${locked ? 'locked' : 'unlocked'}`);

    io.to(code).emit('room:lock-changed', {
      from: socket.id,
      displayName: room.members.get(socket.id)?.displayName,
      locked,
    });

    ack?.({ ok: true, locked });
  });

  // ── Public room discovery ─────────────────────────────────────────────────
  socket.on('room:list', (_, ack) => {
    ack?.({ ok: true, rooms: store.listPublicRooms() });
  });

  // ── Member removal (host only) ────────────────────────────────────────────
  socket.on('room:kick', ({ socketId: targetId } = {}, ack) => {
    const code = store.roomCodeOf(socket.id);
    if (!code) {
      return ack?.({ ok: false, error: 'You are not in a room.' });
    }

    const room = store.get(code);
    if (!room) return;

    if (room.hostId !== socket.id) {
      return ack?.({ ok: false, error: 'Only the host can remove members.' });
    }
    if (typeof targetId !== 'string' || targetId === socket.id) {
      return ack?.({ ok: false, error: 'Invalid member to remove.' });
    }
    if (!room.members.has(targetId)) {
      return ack?.({ ok: false, error: 'That member is not in the room.' });
    }

    const result = store.removeMember(code, targetId);
    if (!result.ok) {
      return ack?.(result);
    }

    console.log(`[room:kick] ${code} — ${result.displayName} (${targetId}) removed by host`);

    // The removed socket leaves the Socket.IO room first so it does not
    // receive the member-left broadcast meant for the survivors.
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.leave(code);
      target.emit('room:kicked', { reason: 'Removed by the host' });
    }

    io.to(code).emit('room:member-left', {
      socketId: targetId,
      displayName: result.displayName,
      members: result.members,
      kicked: true,
    });

    ack?.({ ok: true });
  });
}

module.exports = { registerRoomAdminHandlers };
