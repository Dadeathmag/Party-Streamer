'use strict';

/**
 * @file Socket.IO bootstrap.
 *
 * Single place where the Socket.IO server is constructed, so CORS stays in
 * sync with the Express app (both read from src/config.js).
 */

const { Server } = require('socket.io');

/**
 * Attach a Socket.IO server to an existing HTTP server.
 *
 * @param {import('http').Server} httpServer
 * @param {{ origin: string[] | boolean }} corsOrigin
 *   Same setting the Express app uses (see src/config.js).
 * @returns {import('socket.io').Server}
 */
function attachSocketIo(httpServer, corsOrigin) {
  return new Server(httpServer, {
    cors: {
      ...corsOrigin,
      methods: ['GET', 'POST'],
    },
  });
}

module.exports = { attachSocketIo };
