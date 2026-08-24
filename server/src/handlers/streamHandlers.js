'use strict';

/**
 * @file Streaming-mode selection. The host picks how media reaches viewers:
 *
 *   'p2p'  — progressive P2P chunked streaming (default; MSE playback starts
 *            while chunks are still in flight)
 *   'full' — full transfer: guests receive the entire file before playback
 *   'url'  — every client loads a shared direct media URL themselves; no P2P
 *            transfer at all (the server still never touches the media)
 *
 * The chosen mode is stored on the room so late joiners learn it via their
 * room:join ack, and changes are broadcast to everyone INCLUDING the host —
 * like chat:message, clients apply state from exactly one listener.
 *
 * Wire format:
 *   host emits 'stream:set-mode' { type: 'p2p'|'full'|'url', url? }
 *     → ack { ok: true, mode } or { ok: false, error }
 *     → every member receives 'stream:mode-changed'
 *       { from, displayName, type, url }   (url only set for type 'url')
 */

const STREAM_TYPES = new Set(['p2p', 'full', 'url']);
const MAX_URL_LENGTH = 2048;
const HTTP_URL_PATTERN = /^https?:\/\//i;

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {import('../roomStore').RoomStore} store
 */
function registerStreamHandlers(io, socket, store) {
  socket.on('stream:set-mode', ({ type, url } = {}, ack) => {
    const code = store.roomCodeOf(socket.id);
    if (!code) {
      return ack?.({ ok: false, error: 'You are not in a room.' });
    }

    const room = store.get(code);
    if (!room) return;

    // Only the host may change the streaming mode.
    const member = room.members.get(socket.id);
    if (!member || room.hostId !== socket.id) {
      return ack?.({ ok: false, error: 'Only the host can change the streaming mode.' });
    }

    if (typeof type !== 'string' || !STREAM_TYPES.has(type)) {
      return ack?.({ ok: false, error: 'Unknown streaming mode.' });
    }

    let cleanUrl = null;
    if (type === 'url') {
      if (
        typeof url !== 'string' ||
        !HTTP_URL_PATTERN.test(url.trim())
      ) {
        return ack?.({ ok: false, error: 'A valid http(s) media URL is required.' });
      }
      cleanUrl = url.trim().slice(0, MAX_URL_LENGTH);
    }

    const mode = store.setStreamMode(code, { type, url: cleanUrl });

    console.log(`[stream:set-mode] ${code} — ${type}${cleanUrl ? ` ${cleanUrl}` : ''}`);

    io.to(code).emit('stream:mode-changed', {
      from: socket.id,
      displayName: member.displayName,
      type,
      url: cleanUrl,
    });

    ack?.({ ok: true, mode });
  });
}

module.exports = { registerStreamHandlers };
