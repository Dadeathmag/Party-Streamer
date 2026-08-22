'use strict';

/**
 * @file Chat message relay.
 *
 * The server stays a dumb relay: it validates membership + text shape, stamps
 * the sender's identity, then fans the message out to every member of the
 * room INCLUDING the sender. Broadcasting back to the sender keeps a single
 * ordered copy of history on every client — senders render their message
 * when the echo arrives, marking it "own" via the `from` socket id.
 *
 * Messages are never stored server-side; when a room dies its chat dies too.
 * Transport note: this rides Socket.IO for now, like playback:sync, until
 * DataChannels exist — the payload shape is deliberately transport-agnostic.
 *
 * Wire format:
 *   client emits 'chat:message' { text }
 *     → everyone in the room receives 'chat:message'
 *       { from, displayName, text, ts }
 */

const MAX_CHAT_LENGTH = 300;

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {import('../roomStore').RoomStore} store
 */
function registerChatHandlers(io, socket, store) {
  socket.on('chat:message', ({ text } = {}) => {
    const code = store.roomCodeOf(socket.id);
    if (!code) return;

    const member = store.get(code)?.members.get(socket.id);
    if (!member) return;

    if (typeof text !== 'string') return;
    const clean = text.trim().slice(0, MAX_CHAT_LENGTH);
    if (!clean) return;

    console.log(`[chat:message] ${code} — ${member.displayName}: ${clean}`);

    io.to(code).emit('chat:message', {
      from: socket.id,
      displayName: member.displayName,
      text: clean,
      ts: Date.now(),
    });
  });
}

module.exports = { registerChatHandlers };
