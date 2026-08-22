'use strict';

/**
 * @file WebRTC signaling relay.
 *
 * The server never inspects SDP or ICE data — it simply forwards signalling
 * payloads from one socket to another. This is plumbing for future
 * peer-to-peer features (e.g. streaming video directly between peers).
 *
 * Wire format:
 *   client emits 'signal:offer'         { to, offer }     → target receives { from, offer }
 *   client emits 'signal:answer'        { to, answer }    → target receives { from, answer }
 *   client emits 'signal:ice-candidate' { to, candidate } → target receives { from, candidate }
 */

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
function registerSignalHandlers(io, socket) {
  /**
   * Build a validator/forwarder for one signal type.
   * @param {string} eventName  event name used on both sides
   * @param {string} payloadKey key holding the signalling payload
   */
  const relay = (eventName, payloadKey) => {
    socket.on(eventName, ({ to, [payloadKey]: data }) => {
      if (!to || !data) return;
      io.to(to).emit(eventName, { from: socket.id, [payloadKey]: data });
    });
  };

  relay('signal:offer', 'offer');
  relay('signal:answer', 'answer');
  relay('signal:ice-candidate', 'candidate');
}

module.exports = { registerSignalHandlers };
