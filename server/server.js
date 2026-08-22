const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// ── Express + HTTP ──────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));

const server = http.createServer(app);

// ── Socket.IO ───────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

// ── In-memory room store ────────────────────────────────────────────────────
// rooms: Map<code, Room>
// Room = { code, name, hostId, members: Map<socketId, { displayName, role }> }
const rooms = new Map();

// Reverse lookup: socketId → room code (for disconnect cleanup)
const socketToRoom = new Map();

// Guest counter per room for display-name assignment
const guestCounters = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a serialisable members array from a room's members Map.
 */
function serialiseMembers(room) {
  const list = [];
  for (const [socketId, info] of room.members) {
    list.push({ socketId, displayName: info.displayName, role: info.role });
  }
  return list;
}

/**
 * Remove a socket from whatever room it's in. Returns true if it was in one.
 */
function removeFromRoom(socketId) {
  const code = socketToRoom.get(socketId);
  if (!code) return false;

  const room = rooms.get(code);
  socketToRoom.delete(socketId);
  if (!room) return false;

  room.members.delete(socketId);

  if (room.hostId === socketId) {
    // Host left → destroy room, notify remaining members
    console.log(`[room:${code}] Host disconnected — destroying room`);
    for (const [memberId] of room.members) {
      socketToRoom.delete(memberId);
    }
    io.to(code).emit('room:host-left');
    rooms.delete(code);
    guestCounters.delete(code);
  } else {
    // Regular member left
    io.to(code).emit('room:member-left', {
      socketId,
      members: serialiseMembers(room),
    });
  }

  return true;
}

// ── Socket handlers ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── Create Room ─────────────────────────────────────────────────────────
  socket.on('room:create', ({ name, code }, ack) => {
    if (!name || !code) {
      return ack?.({ ok: false, error: 'Name and code are required.' });
    }

    const upperCode = code.toUpperCase();

    if (rooms.has(upperCode)) {
      return ack?.({ ok: false, error: 'A room with that code already exists.' });
    }

    // Clean up if this socket was in another room
    removeFromRoom(socket.id);

    const room = {
      code: upperCode,
      name,
      hostId: socket.id,
      members: new Map(),
    };
    room.members.set(socket.id, { displayName: 'Host', role: 'host' });
    rooms.set(upperCode, room);
    socketToRoom.set(socket.id, upperCode);
    guestCounters.set(upperCode, 0);

    socket.join(upperCode);
    console.log(`[room:create] ${socket.id} created room "${name}" (${upperCode})`);

    ack?.({
      ok: true,
      roomId: upperCode,
      code: upperCode,
      members: serialiseMembers(room),
    });
  });

  // ── Join Room ───────────────────────────────────────────────────────────
  socket.on('room:join', ({ code }, ack) => {
    if (!code) {
      return ack?.({ ok: false, error: 'Room code is required.' });
    }

    const upperCode = code.toUpperCase();
    const room = rooms.get(upperCode);

    if (!room) {
      return ack?.({ ok: false, error: 'Room not found. Check the code and try again.' });
    }

    // Clean up if this socket was in another room
    removeFromRoom(socket.id);

    // Assign a guest display name
    const guestNum = (guestCounters.get(upperCode) || 0) + 1;
    guestCounters.set(upperCode, guestNum);
    const displayName = `Guest-${guestNum}`;

    room.members.set(socket.id, { displayName, role: 'member' });
    socketToRoom.set(socket.id, upperCode);
    socket.join(upperCode);

    const members = serialiseMembers(room);

    console.log(`[room:join] ${socket.id} (${displayName}) joined room "${room.name}" (${upperCode})`);

    // Notify existing members
    socket.to(upperCode).emit('room:member-joined', {
      socketId: socket.id,
      displayName,
      members,
    });

    ack?.({
      ok: true,
      roomId: upperCode,
      name: room.name,
      code: upperCode,
      members,
    });
  });

  // ── Leave Room ──────────────────────────────────────────────────────────
  socket.on('room:leave', (_, ack) => {
    const code = socketToRoom.get(socket.id);
    if (code) {
      socket.leave(code);
    }
    removeFromRoom(socket.id);
    console.log(`[room:leave] ${socket.id} left`);
    ack?.({ ok: true });
  });

  // ── WebRTC Signaling Relay (future use) ─────────────────────────────────
  socket.on('signal:offer', ({ to, offer }) => {
    if (!to || !offer) return;
    io.to(to).emit('signal:offer', { from: socket.id, offer });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    if (!to || !answer) return;
    io.to(to).emit('signal:answer', { from: socket.id, answer });
  });

  socket.on('signal:ice-candidate', ({ to, candidate }) => {
    if (!to || !candidate) return;
    io.to(to).emit('signal:ice-candidate', { from: socket.id, candidate });
  });

  // ── Playback Sync (host-only) ───────────────────────────────────────────
  socket.on('playback:sync', ({ action, time }) => {
    const code = socketToRoom.get(socket.id);
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    // Only the host may send playback sync commands
    if (room.hostId !== socket.id) return;

    console.log(`[playback:sync] ${code} — ${action} @ ${time}`);
    socket.to(code).emit('playback:sync', { action, time });
  });

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);
    removeFromRoom(socket.id);
  });
});

// ── Health check endpoint ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    connections: io.engine.clientsCount,
  });
});

// ── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  🎉 Party Stream signaling server running on http://localhost:${PORT}\n`);
});
